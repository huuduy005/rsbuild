import fs from 'node:fs';
import path, { posix } from 'node:path';
import type { StatsCompilation, StatsValue } from '@rspack/core';
import deepmerge from 'deepmerge';
import color from 'picocolors';
import type RspackChain from 'rspack-chain';
import type {
  Compiler as WebpackCompiler,
  MultiCompiler as WebpackMultiCompiler,
} from 'webpack';
import { formatStatsMessages } from './client/format';
import { DEFAULT_ASSET_PREFIX } from './constants';
import { logger } from './logger';
import type {
  FilenameConfig,
  MultiStats,
  NodeEnv,
  NormalizedConfig,
  NormalizedEnvironmentConfig,
  RsbuildTarget,
  Rspack,
  Stats,
  StatsError,
} from './types';

export const rspackMinVersion = '0.7.0';

export const getNodeEnv = () => process.env.NODE_ENV as NodeEnv;
export const setNodeEnv = (env: NodeEnv): void => {
  process.env.NODE_ENV = env;
};
export const isDev = (): boolean => getNodeEnv() === 'development';
export const isProd = (): boolean => getNodeEnv() === 'production';

export const isNil = (o: unknown): o is undefined | null =>
  o === undefined || o === null;

export const isFunction = (func: unknown): func is (...args: any[]) => any =>
  typeof func === 'function';

export const isObject = (obj: unknown): obj is Record<string, any> =>
  Object.prototype.toString.call(obj) === '[object Object]';

export const isPlainObject = (o: unknown): o is Record<string, any> => {
  if (isObject(o) === false) return false;

  // If has modified constructor
  const ctor = (o as Record<string, any>).constructor;
  if (ctor === undefined) return true;

  // If has modified prototype
  const prot = ctor.prototype;
  if (isObject(prot) === false) return false;

  // If constructor does not have an Object-specific method

  // biome-ignore lint/suspicious/noPrototypeBuiltins: <explanation>
  if (prot.hasOwnProperty('isPrototypeOf') === false) {
    return false;
  }

  // Most likely a plain Object
  return true;
};

export const castArray = <T>(arr?: T | T[]): T[] => {
  if (arr === undefined) {
    return [];
  }
  return Array.isArray(arr) ? arr : [arr];
};

export const cloneDeep = <T>(value: T): T => {
  if (value === null || value === undefined) {
    return value;
  }
  return deepmerge<T>({}, value, {
    isMergeableObject: isPlainObject,
  });
};

const compareSemver = (version1: string, version2: string) => {
  const parts1 = version1.split('.').map(Number);
  const parts2 = version2.split('.').map(Number);
  const len = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < len; i++) {
    const item1 = parts1[i] ?? 0;
    const item2 = parts2[i] ?? 0;
    if (item1 > item2) {
      return 1;
    }
    if (item1 < item2) {
      return -1;
    }
  }

  return 0;
};

export const isSatisfyRspackVersion = async (
  originalVersion: string,
): Promise<boolean> => {
  let version = originalVersion;

  // The nightly version of rspack is to append `-canary-abc` to the current version
  if (version.includes('-canary')) {
    version = version.split('-canary')[0];
  }

  if (version && /^[\d\.]+$/.test(version)) {
    return compareSemver(version, rspackMinVersion) >= 0;
  }

  // ignore other unstable versions
  return true;
};

/**
 * Add node polyfill tip when failed to resolve node built-in modules.
 */
const hintNodePolyfill = (message: string): string => {
  if (!message.includes(`Can't resolve`)) {
    return message;
  }

  const matchArray = message.match(/Can't resolve '(\w+)'/);
  if (!matchArray) {
    return message;
  }

  const moduleName = matchArray[1];
  const nodeModules = [
    'assert',
    'buffer',
    'child_process',
    'cluster',
    'console',
    'constants',
    'crypto',
    'dgram',
    'dns',
    'domain',
    'events',
    'fs',
    'http',
    'https',
    'module',
    'net',
    'os',
    'path',
    'punycode',
    'process',
    'querystring',
    'readline',
    'repl',
    'stream',
    '_stream_duplex',
    '_stream_passthrough',
    '_stream_readable',
    '_stream_transform',
    '_stream_writable',
    'string_decoder',
    'sys',
    'timers',
    'tls',
    'tty',
    'url',
    'util',
    'vm',
    'zlib',
  ];

  if (moduleName && nodeModules.includes(moduleName)) {
    const tips = [
      `Tip: "${moduleName}" is a built-in Node.js module and cannot be imported in client-side code.`,
      `Check if you need to import Node.js module. If needed, you can use "@rsbuild/plugin-node-polyfill".`,
    ];
    return `${message}\n\n${color.yellow(tips.join('\n'))}`;
  }

  return message;
};

function formatErrorMessage(errors: string[]) {
  const messages = errors.map((error) => hintNodePolyfill(error));
  const text = `${messages.join('\n\n')}\n`;
  const title = color.bold(color.red('Compile error: '));

  if (!errors.length) {
    return `${title}\n${color.yellow(`For more details, please setting 'stats.errors: true' `)}`;
  }

  const tip = color.yellow(
    'Failed to compile, check the errors for troubleshooting.',
  );

  return `${title}\n${tip}\n${text}`;
}

export const getAllStatsErrors = (
  statsData: StatsCompilation,
): Rspack.StatsError[] | undefined => {
  // stats error + childCompiler error
  // only append child errors when stats error does not exist, because some errors will exist in both stats and childCompiler
  if (statsData.errorsCount && statsData.errors?.length === 0) {
    return statsData.children?.reduce<StatsError[]>(
      (errors, curr) => errors.concat(curr.errors || []),
      [],
    );
  }

  return statsData.errors;
};

export const getAllStatsWarnings = (
  statsData: StatsCompilation,
): Rspack.StatsError[] | undefined => {
  if (statsData.warningsCount && statsData.warnings?.length === 0) {
    return statsData.children?.reduce<StatsError[]>(
      (warnings, curr) => warnings.concat(curr.warnings || []),
      [],
    );
  }

  return statsData.warnings;
};

export function getStatsOptions(
  compiler: Parameters<typeof isMultiCompiler>[0],
): StatsValue | undefined {
  if (isMultiCompiler(compiler)) {
    return {
      children: compiler.compilers.map((compiler) =>
        compiler.options ? compiler.options.stats : undefined,
      ),
    } as unknown as StatsValue;
  }

  return compiler.options ? (compiler.options.stats as StatsValue) : undefined;
}

export function formatStats(
  stats: Stats | MultiStats,
  options: StatsValue = {},
): {
  message?: string;
  level?: string;
} {
  const statsData = stats.toJson(
    typeof options === 'object'
      ? {
          preset: 'errors-warnings',
          children: true,
          ...options,
        }
      : options,
  );

  const { errors, warnings } = formatStatsMessages(
    {
      errors: getAllStatsErrors(statsData),
      warnings: getAllStatsWarnings(statsData),
    },
    // display verbose messages in debug mode
    logger.level === 'verbose',
  );

  if (stats.hasErrors()) {
    return {
      message: formatErrorMessage(errors),
      level: 'error',
    };
  }

  if (warnings.length) {
    const title = color.bold(color.yellow('Compile Warning: \n'));

    return {
      message: `${title}${warnings.join('\n\n')}\n`,
      level: 'warning',
    };
  }

  return {};
}

export const removeLeadingSlash = (s: string): string => s.replace(/^\/+/, '');
export const removeTailingSlash = (s: string): string => s.replace(/\/+$/, '');
export const addTrailingSlash = (s: string): string =>
  s.endsWith('/') ? s : `${s}/`;

export const formatPublicPath = (
  publicPath: string,
  withSlash = true,
): string => {
  // 'auto' is a magic value in Rspack and we should not add trailing slash
  if (publicPath === 'auto') {
    return publicPath;
  }

  return withSlash
    ? addTrailingSlash(publicPath)
    : removeTailingSlash(publicPath);
};

export const getPublicPathFromChain = (
  chain: RspackChain,
  withSlash = true,
): string => {
  const publicPath = chain.output.get('publicPath');

  if (typeof publicPath === 'string') {
    return formatPublicPath(publicPath, withSlash);
  }

  return formatPublicPath(DEFAULT_ASSET_PREFIX, withSlash);
};

export const getPublicPathFromCompiler = (
  compiler: Rspack.Compiler,
): string => {
  const { publicPath } = compiler.options.output;

  if (typeof publicPath === 'string') {
    // 'auto' is a magic value in Rspack and behave like `publicPath: ""`
    if (publicPath === 'auto') {
      return '';
    }
    return publicPath.endsWith('/') ? publicPath : `${publicPath}/`;
  }

  // publicPath function is not supported yet, fallback to default value
  return DEFAULT_ASSET_PREFIX;
};

export const isFileSync = (filePath: string): boolean | undefined => {
  try {
    return fs.statSync(filePath, { throwIfNoEntry: false })?.isFile();
  } catch (_) {
    return false;
  }
};

export function isEmptyDir(path: string): boolean {
  const files = fs.readdirSync(path);
  return files.length === 0 || (files.length === 1 && files[0] === '.git');
}

/**
 * Find first already exists file.
 * @param files - Absolute file paths with extension.
 * @returns The file path if exists, or false if no file exists.
 */
export const findExists = (files: string[]): string | false => {
  for (const file of files) {
    if (isFileSync(file)) {
      return file;
    }
  }
  return false;
};

export async function pathExists(path: string): Promise<boolean> {
  return fs.promises
    .access(path)
    .then(() => true)
    .catch(() => false);
}

export async function isFileExists(file: string): Promise<boolean> {
  return fs.promises
    .access(file, fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);
}

export async function emptyDir(dir: string): Promise<void> {
  if (!(await pathExists(dir))) {
    return;
  }

  try {
    for (const file of await fs.promises.readdir(dir)) {
      await fs.promises.rm(path.resolve(dir, file), {
        recursive: true,
        force: true,
      });
    }
  } catch (err) {
    logger.debug(`Failed to empty dir: ${dir}`);
    logger.debug(err);
  }
}

const urlJoin = (base: string, path: string) => {
  const fullUrl = new URL(base);
  fullUrl.pathname = posix.join(fullUrl.pathname, path);
  return fullUrl.toString();
};

// Can be replaced with URL.canParse when we drop support for Node.js 16
export const canParse = (url: string): boolean => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

export const ensureAssetPrefix = (
  url: string,
  assetPrefix: string = DEFAULT_ASSET_PREFIX,
): string => {
  // The use of an absolute URL without a protocol is technically legal,
  // however it cannot be parsed as a URL instance, just return it.
  // e.g. str is //example.com/foo.js
  if (url.startsWith('//')) {
    return url;
  }

  // If str is an complete URL, just return it.
  // Only absolute url with hostname & protocol can be parsed into URL instance.
  // e.g. str is https://example.com/foo.js
  if (canParse(url)) {
    return url;
  }

  // 'auto' is a magic value in Rspack and behave like `publicPath: ""`
  if (assetPrefix === 'auto') {
    return url;
  }

  if (assetPrefix.startsWith('http')) {
    return urlJoin(assetPrefix, url);
  }

  if (assetPrefix.startsWith('//')) {
    return urlJoin(`https:${assetPrefix}`, url).replace('https:', '');
  }

  return posix.join(assetPrefix, url);
};

export function getFilename(
  config: NormalizedConfig | NormalizedEnvironmentConfig,
  type: 'js',
  isProd: boolean,
  isServer?: boolean,
): NonNullable<FilenameConfig['js']>;
export function getFilename(
  config: NormalizedConfig | NormalizedEnvironmentConfig,
  type: Exclude<keyof FilenameConfig, 'js'>,
  isProd: boolean,
  isServer?: boolean,
): string;
export function getFilename(
  config: NormalizedConfig | NormalizedEnvironmentConfig,
  type: keyof FilenameConfig,
  isProd: boolean,
  isServer?: boolean,
) {
  const { filename, filenameHash } = config.output;

  const getHash = () => {
    if (typeof filenameHash === 'string') {
      return filenameHash ? `.[${filenameHash}]` : '';
    }
    return filenameHash ? '.[contenthash:8]' : '';
  };

  const hash = getHash();

  switch (type) {
    case 'js':
      return filename.js ?? `[name]${isProd && !isServer ? hash : ''}.js`;
    case 'css':
      return filename.css ?? `[name]${isProd ? hash : ''}.css`;
    case 'svg':
      return filename.svg ?? `[name]${hash}.svg`;
    case 'font':
      return filename.font ?? `[name]${hash}[ext]`;
    case 'image':
      return filename.image ?? `[name]${hash}[ext]`;
    case 'media':
      return filename.media ?? `[name]${hash}[ext]`;
    default:
      throw new Error(`unknown key ${type} in "output.filename"`);
  }
}

export function partition<T>(
  array: T[],
  predicate: (value: T) => boolean,
): [T[], T[]] {
  const truthy: T[] = [];
  const falsy: T[] = [];

  for (const value of array) {
    if (predicate(value)) {
      truthy.push(value);
    } else {
      falsy.push(value);
    }
  }

  return [truthy, falsy];
}

export const applyToCompiler = (
  compiler: Rspack.Compiler | Rspack.MultiCompiler,
  apply: (c: Rspack.Compiler, index: number) => void,
): void => {
  if (isMultiCompiler(compiler)) {
    compiler.compilers.forEach(apply);
  } else {
    apply(compiler, 0);
  }
};

export const upperFirst = (str: string): string =>
  str ? str.charAt(0).toUpperCase() + str.slice(1) : '';

export function debounce<T extends (...args: any[]) => void>(
  func: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => {
      func(...args);
    }, wait);
  };
}

// Determine if the string is a URL
export const isURL = (str: string): boolean =>
  str.startsWith('http') || str.startsWith('//:');

export const createVirtualModule = (content: string) =>
  `data:text/javascript,${content}`;

export const isRegExp = (obj: any): obj is RegExp =>
  Object.prototype.toString.call(obj) === '[object RegExp]';

export function isWebTarget(target: RsbuildTarget | RsbuildTarget[]): boolean {
  const targets = castArray(target);
  return targets.includes('web') || target.includes('web-worker');
}

export const isMultiCompiler = <
  C extends Rspack.Compiler | WebpackCompiler = Rspack.Compiler,
  M extends Rspack.MultiCompiler | WebpackMultiCompiler = Rspack.MultiCompiler,
>(
  compiler: C | M,
): compiler is M => {
  return compiler.constructor.name === 'MultiCompiler';
};

export const onCompileDone = (
  compiler: Rspack.Compiler | Rspack.MultiCompiler,
  onDone: (stats: Rspack.Stats | Rspack.MultiStats) => Promise<void>,
  MultiStatsCtor: new (stats: Rspack.Stats[]) => Rspack.MultiStats,
): void => {
  // The MultiCompiler of Rspack does not supports `done.tapPromise`,
  // so we need to use the `done` hook of `MultiCompiler.compilers` to implement it.
  if (isMultiCompiler(compiler)) {
    const { compilers } = compiler;
    const compilerStats: Rspack.Stats[] = [];
    let doneCompilers = 0;

    for (let index = 0; index < compilers.length; index++) {
      const compiler = compilers[index];
      const compilerIndex = index;
      let compilerDone = false;

      compiler.hooks.done.tapPromise('rsbuild:done', async (stats) => {
        if (!compilerDone) {
          compilerDone = true;
          doneCompilers++;
        }

        compilerStats[compilerIndex] = stats;

        if (doneCompilers === compilers.length) {
          await onDone(new MultiStatsCtor(compilerStats));
        }
      });

      compiler.hooks.invalid.tap('rsbuild:done', () => {
        if (compilerDone) {
          compilerDone = false;
          doneCompilers--;
        }
      });
    }
  } else {
    compiler.hooks.done.tapPromise('rsbuild:done', onDone);
  }
};

export function pick<T, U extends keyof T>(
  obj: T,
  keys: ReadonlyArray<U>,
): Pick<T, U> {
  return keys.reduce(
    (ret, key) => {
      if (obj[key] !== undefined) {
        ret[key] = obj[key];
      }
      return ret;
    },
    {} as Pick<T, U>,
  );
}

export const camelCase = (input: string): string =>
  input.replace(/[-_](\w)/g, (_, c) => c.toUpperCase());

export const prettyTime = (seconds: number): string => {
  const format = (time: string) => color.bold(time);

  if (seconds < 10) {
    const digits = seconds >= 0.01 ? 2 : 3;
    return `${format(seconds.toFixed(digits))} s`;
  }

  if (seconds < 60) {
    return `${format(seconds.toFixed(1))} s`;
  }

  const minutes = seconds / 60;
  return `${format(minutes.toFixed(2))} m`;
};
