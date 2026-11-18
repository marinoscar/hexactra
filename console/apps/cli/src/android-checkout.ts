import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { CLI_NAME } from '@app/shared';
import { envVar } from '@marinoscar/platform-cli';
import type { Command } from 'commander';

import { stageSdkDownloadNearSdk } from './android-sdk-staging.js';

// =============================================================================
// Where the Android app is, and whether it can be built (#478)
// =============================================================================
//
// The platform's `android` group looks for `apps/android` in the current
// directory and its parents. This app lives in `console/` of the hexactra
// repository, so from the repository root that lookup finds nothing, and a
// clone without `npm ci` in `console/` fails a minute into Gradle, after the
// version was already bumped. Both are checked here, before the platform's
// command runs:
//
//   - a checkout found one level down (`console/apps/android`) is handed to
//     the platform through `HEXACTRA_REPO_ROOT`, with a line saying so;
//   - no checkout at all is said up front (`doctor` otherwise goes on to
//     install an SDK the person cannot use from that directory);
//   - `build` and `release` stop when the platform's Android library is not
//     installed, naming the command that installs it.
// =============================================================================

/** The app's directory inside the hexactra repository (the same one `deploy` uses). */
export const CONSOLE_DIR = 'console';

const ANDROID_APP_DIR = join('apps', 'android');

/** The platform's Android library, as `apps/android/settings.gradle.kts` resolves it. */
export const PLATFORM_CORE_DIR = join('node_modules', '@marinoscar', 'platform-infra', 'android', 'platform-core');

export interface AndroidCheckout {
  /** The directory that holds `apps/android`; `undefined` when there is none. */
  root: string | undefined;
  /** Found as `console/` of a directory, rather than as the directory itself. */
  nested: boolean;
  /** `HEXACTRA_REPO_ROOT` was set, so the current directory was not searched. */
  explicit: boolean;
}

export interface AndroidCheckoutContext {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  isDirectory?: ((path: string) => boolean) | undefined;
  isFile?: ((path: string) => boolean) | undefined;
}

const stat = (path: string) => {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
};
const defaultIsDirectory = (path: string) => stat(path)?.isDirectory() === true;
const defaultIsFile = (path: string) => stat(path)?.isFile() === true;

/** `HEXACTRA_REPO_ROOT`: the platform's variable that points the android commands at a checkout. */
export const repoRootEnvVar = () => envVar('REPO_ROOT');

/** The checkout in `dir`: itself, or its `console/`. */
function checkoutAt(dir: string, isDirectory: (path: string) => boolean): Pick<AndroidCheckout, 'root' | 'nested'> | undefined {
  if (isDirectory(join(dir, ANDROID_APP_DIR))) return { root: dir, nested: false };
  const nested = join(dir, CONSOLE_DIR);
  if (isDirectory(join(nested, ANDROID_APP_DIR))) return { root: nested, nested: true };
  return undefined;
}

/**
 * Find the Android app from the current directory: in it or a parent (what the
 * platform finds too), or in `console/` of it or a parent (the repository
 * root, `crates/`, `docs/`…). An explicit `HEXACTRA_REPO_ROOT` is not second-guessed,
 * except that the repository root is accepted for `console/`.
 */
export function locateAndroidCheckout(ctx: AndroidCheckoutContext = {}): AndroidCheckout {
  const env = ctx.env ?? process.env;
  const isDirectory = ctx.isDirectory ?? defaultIsDirectory;
  const explicit = env[repoRootEnvVar()]?.trim();
  if (explicit) {
    const found = checkoutAt(resolve(explicit), isDirectory);
    return { root: found?.root, nested: found?.nested ?? false, explicit: true };
  }
  let current = resolve(ctx.cwd ?? process.cwd());
  for (;;) {
    const found = checkoutAt(current, isDirectory);
    if (found) return { ...found, explicit: false };
    const parent = dirname(current);
    if (parent === current) return { root: undefined, nested: false, explicit: false };
    current = parent;
  }
}

/**
 * Locate the checkout and, when it is one level down, point the platform at
 * it. Returns what was found, so the caller can say it.
 */
export function applyAndroidCheckout(ctx: AndroidCheckoutContext = {}): AndroidCheckout {
  const checkout = locateAndroidCheckout(ctx);
  if (checkout.root !== undefined && checkout.nested) (ctx.env ?? process.env)[repoRootEnvVar()] = checkout.root;
  return checkout;
}

/** Said when the app was found in `console/` rather than in the current directory's own tree. */
export function nestedCheckoutNote(root: string): string {
  return `Using the Android app in ${root} (the console is the ${CONSOLE_DIR}/ directory of the repository).`;
}

/** Said when there is no Android app here at all. */
export function noCheckoutMessage(checkout: AndroidCheckout, cwd: string): string {
  return checkout.explicit
    ? `${repoRootEnvVar()} does not point at the hexactra repository: no ${ANDROID_APP_DIR} or ${join(CONSOLE_DIR, ANDROID_APP_DIR)} in it. ` +
        `Set it to your clone, or unset it and run ${CLI_NAME} from inside the clone.`
    : `${cwd} is not inside the hexactra repository, so there is no Android app to build here. ` +
        `Run ${CLI_NAME} from your clone (its root or its ${CONSOLE_DIR}/ directory), or set ${repoRootEnvVar()} to the clone.`;
}

/**
 * Why a build cannot work in this checkout, or `undefined` when it can: Gradle
 * includes the platform's Android library from the console's `node_modules`.
 */
export function missingDependenciesMessage(root: string, ctx: AndroidCheckoutContext = {}): string | undefined {
  const isFile = ctx.isFile ?? defaultIsFile;
  if (isFile(join(root, PLATFORM_CORE_DIR, 'build.gradle.kts'))) return undefined;
  return (
    `The console's dependencies are not installed in ${root}: the Android build needs ${join(root, PLATFORM_CORE_DIR)}. ` +
    `Run \`cd ${root} && npm ci\`, then run this again.`
  );
}

/** The subcommands that build, and so need the dependencies installed. */
const BUILDS = new Set(['build', 'release']);

/**
 * Check the folder before any `android` subcommand runs. Registered as a
 * `preAction` hook on the platform's group, so it also runs before the version
 * bump that `release` starts with.
 */
export function androidPreflight(subcommand: string, ctx: AndroidCheckoutContext & { warn?: (line: string) => void } = {}): void {
  const warn = ctx.warn ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const cwd = resolve(ctx.cwd ?? process.cwd());
  const checkout = applyAndroidCheckout(ctx);
  if (checkout.root === undefined) {
    // Only the doctor goes on without a checkout; the others stop with the platform's own error.
    if (subcommand === 'doctor') warn(`⚠ ${noCheckoutMessage(checkout, cwd)}`);
    return;
  }
  if (checkout.nested && !checkout.explicit) warn(nestedCheckoutNote(checkout.root));
  const missing = missingDependenciesMessage(checkout.root, ctx);
  if (missing === undefined) return;
  if (BUILDS.has(subcommand)) throw new Error(missing);
  if (subcommand === 'doctor') warn(`⚠ ${missing}`);
}

/** The first subcommand under `android` (`keystore init` is `keystore`). */
function subcommandUnder(group: Command, action: Command): string {
  let current = action;
  while (current.parent !== null && current.parent !== group) current = current.parent;
  return current.name();
}

/** Wrap the platform's `android` registration with the folder check. */
export function withAndroidPreflight(register: (program: Command) => void): (program: Command) => void {
  return (program) => {
    register(program);
    const group = program.commands.find((command) => command.name() === 'android');
    group?.hook('preAction', (_this, action) => {
      const subcommand = subcommandUnder(group, action);
      androidPreflight(subcommand);
      // `doctor --fix` downloads the SDK: keep its staging on the SDK's filesystem (#480).
      const options = action.opts<{ fix?: boolean; dryRun?: boolean }>();
      if (subcommand === 'doctor' && options.fix === true && options.dryRun !== true) {
        const cleanup = stageSdkDownloadNearSdk();
        if (cleanup !== undefined) process.once('exit', cleanup);
      }
    });
  };
}
