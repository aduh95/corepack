import {UsageError}                      from 'clipanion';
import fs                                from 'fs';
import path                              from 'path';
import semverSatisfies                   from 'semver/functions/satisfies';
import semverValid                       from 'semver/functions/valid';
import {parseEnv}                        from 'util';

import type {PreparedPackageManagerInfo} from './Engine';
import * as debugUtils                   from './debugUtils';
import type {NodeError}                  from './nodeUtils';
import * as nodeUtils                    from './nodeUtils';
import {isSupportedPackageManager}       from './types';
import type {LocalEnvFile, Descriptor}   from './types';

const nodeModulesRegExp = /[\\/]node_modules[\\/](@[^\\/]*[\\/])?([^@\\/][^\\/]*)$/;

export function parseSpec(raw: unknown, source: string, {enforceExactVersion = true} = {}): Descriptor {
  if (typeof raw !== `string`)
    throw new UsageError(`Invalid package manager specification in ${source}; expected a string`);

  const atIndex = raw.indexOf(`@`);

  if (atIndex === -1 || atIndex === raw.length - 1) {
    if (enforceExactVersion)
      throw new UsageError(`No version specified for ${raw} in "packageManager" of ${source}`);

    const name = atIndex === -1 ? raw : raw.slice(0, -1);
    if (!isSupportedPackageManager(name))
      throw new UsageError(`Unsupported package manager specification (${name})`);

    return {
      name, range: `*`,
    };
  }

  const name = raw.slice(0, atIndex);
  const range = raw.slice(atIndex + 1);

  const isURL = URL.canParse(range);
  if (!isURL) {
    if (enforceExactVersion && !semverValid(range))
      throw new UsageError(`Invalid package manager specification in ${source} (${raw}); expected a semver version${enforceExactVersion ? `` : `, range, or tag`}`);

    if (!isSupportedPackageManager(name)) {
      throw new UsageError(`Unsupported package manager specification (${raw})`);
    }
  } else if (isSupportedPackageManager(name) && process.env.COREPACK_ENABLE_UNSAFE_CUSTOM_URLS !== `1`) {
    throw new UsageError(`Illegal use of URL for known package manager. Instead, select a specific version, or set COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=1 in your environment (${raw})`);
  }


  return {
    name,
    range,
  };
}

type CorepackPackageJSON = {
  packageManager?: string;
  devEngines?: { packageManager?: DevEngineDependency };
};

interface DevEngineDependency {
  name: string;
  version: string;
}
function parsePackageJSON(packageJSONContent: CorepackPackageJSON, localEnv?: LocalEnvFile) {
  if (packageJSONContent.devEngines?.packageManager) {
    const {packageManager} = packageJSONContent.devEngines;

    if (Array.isArray(packageManager))
      throw new UsageError(`Providing several package managers is currently not supported`);

    let {version} = packageManager;
    if (!version)
      throw new UsageError(`Providing no version nor ranger for package manager is currently not supported`);

    const localEnvKey = `COREPACK_DEV_ENGINES_${packageManager.name.toUpperCase()}`;
    const localEnvVersion = localEnv?.[localEnvKey];
    if (localEnvVersion) {
      if (!semverSatisfies(localEnvVersion, version))
        throw new UsageError(`Local env key ${localEnvKey} defines a value of ${localEnvVersion} which does not match the version defined in package.json devEngines.packageManager of ${version}`);

      debugUtils.log(`Using ${localEnvVersion} defined in .corepack.env`);
      version = localEnvVersion;
    } else {
      const {packageManager: pm} = packageJSONContent;
      if (pm?.startsWith(`${packageManager.name}@`) && semverSatisfies(pm.slice(packageManager.name.length + 1), version)) {
        return pm;
      }
    }


    return `${packageManager.name}@${version}`;
  }

  return packageJSONContent.packageManager;
}

export async function setLocalPackageManager(cwd: string, info: PreparedPackageManagerInfo) {
  const lookup = await loadSpec(cwd);

  const content = lookup.type !== `NoProject`
    ? await fs.promises.readFile(lookup.target, `utf8`)
    : ``;

  const {data, indent} = nodeUtils.readPackageJson(content);

  const previousPackageManager = data.packageManager ?? `unknown`;
  data.packageManager = `${info.locator.name}@${info.locator.reference}`;

  const newContent = nodeUtils.normalizeLineEndings(content, `${JSON.stringify(data, null, indent)}\n`);
  await fs.promises.writeFile(lookup.target, newContent, `utf8`);

  return {
    previousPackageManager,
  };
}

export type LoadSpecResult =
    | {type: `NoProject`, target: string}
    | {type: `NoSpec`, target: string}
    | {type: `Found`, target: string, spec: Descriptor};

export async function loadSpec(initialCwd: string): Promise<LoadSpecResult> {
  let nextCwd = initialCwd;
  let currCwd = ``;

  let selection: {
    data: any;
    manifestPath: string;
    localEnv?: LocalEnvFile;
  } | null = null;

  while (nextCwd !== currCwd && (!selection || !selection.data.packageManager)) {
    currCwd = nextCwd;
    nextCwd = path.dirname(currCwd);

    if (nodeModulesRegExp.test(currCwd))
      continue;

    const manifestPath = path.join(currCwd, `package.json`);
    debugUtils.log(`Checking ${manifestPath}`);
    let content: string;
    try {
      content = await fs.promises.readFile(manifestPath, `utf8`);
    } catch (err) {
      if ((err as NodeError)?.code === `ENOENT`) continue;
      throw err;
    }

    let data;
    try {
      data = JSON.parse(content);
    } catch {}

    if (typeof data !== `object` || data === null)
      throw new UsageError(`Invalid package.json in ${path.relative(initialCwd, manifestPath)}`);

    let localEnv: LocalEnvFile | undefined;
    const envFilePath = path.join(currCwd, `.corepack.env`);
    debugUtils.log(`Checking ${envFilePath}`);
    try {
      localEnv = {...process.env, ...parseEnv(await fs.promises.readFile(envFilePath, `utf8`))};
    } catch (err) {
      if ((err as NodeError)?.code !== `ENOENT`)
        throw err;

      localEnv = process.env;
    }

    selection = {data, manifestPath, localEnv};
  }

  if (selection === null)
    return {type: `NoProject`, target: path.join(initialCwd, `package.json`)};

  const rawPmSpec = parsePackageJSON(selection.data, selection.localEnv);
  if (typeof rawPmSpec === `undefined`)
    return {type: `NoSpec`, target: selection.manifestPath};

  return {
    type: `Found`,
    target: selection.manifestPath,
    spec: parseSpec(rawPmSpec, path.relative(initialCwd, selection.manifestPath)),
  };
}
