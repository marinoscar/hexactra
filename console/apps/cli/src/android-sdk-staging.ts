import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { CLI_NAME } from '@app/shared';

// =============================================================================
// Where `android doctor --fix` stages the SDK download (#480)
// =============================================================================
//
// The platform's installer extracts the command-line tools under the system
// temporary directory and renames them into the SDK directory. A rename cannot
// cross filesystems, so with `/tmp` on tmpfs or its own partition the install
// stops with EXDEV. Until the installer copies in that case, this app stages
// the download next to the SDK instead: the installer reads `TMPDIR` when it
// runs, so setting it before the command is enough.
// =============================================================================

export interface SdkStagingContext {
  env?: NodeJS.ProcessEnv | undefined;
  home?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  /** The system temporary directory (`os.tmpdir()`). */
  tmp?: string | undefined;
  exists?: ((path: string) => boolean) | undefined;
  /** The filesystem a path is on (`stat.dev`), or `undefined` when it cannot be read. */
  device?: ((path: string) => number | undefined) | undefined;
}

const defaultDevice = (path: string) => {
  try {
    return statSync(path).dev;
  } catch {
    return undefined;
  }
};

/** Android Studio's default SDK directory, as the platform's doctor looks for it. */
function androidStudioSdkDir(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string {
  if (platform === 'darwin') return join(home, 'Library', 'Android', 'sdk');
  if (platform === 'win32') return join(env['LOCALAPPDATA']?.trim() || join(home, 'AppData', 'Local'), 'Android', 'Sdk');
  return join(home, 'Android', 'Sdk');
}

/**
 * The SDK directory `doctor --fix` installs into, in the platform's order: the
 * first that exists of `ANDROID_HOME`, `ANDROID_SDK_ROOT`, the managed
 * `~/.hexactra/android-sdk` and Android Studio's; with none, the explicit
 * variable, else the managed directory.
 */
export function sdkInstallRoot(ctx: SdkStagingContext = {}): string {
  const env = ctx.env ?? process.env;
  const home = ctx.home ?? homedir();
  const exists = ctx.exists ?? existsSync;
  const explicit = [env['ANDROID_HOME']?.trim(), env['ANDROID_SDK_ROOT']?.trim()].filter((root): root is string => Boolean(root));
  const managed = join(home, `.${CLI_NAME}`, 'android-sdk');
  const candidates = [...explicit, managed, androidStudioSdkDir(ctx.platform ?? process.platform, home, env)];
  return candidates.find((root) => exists(root)) ?? explicit[0] ?? managed;
}

/** `path` itself when it exists, else its nearest existing parent. */
function existingAncestor(path: string, exists: (path: string) => boolean): string {
  let current = resolve(path);
  while (!exists(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

/**
 * The directory to stage in, or `undefined` when the temporary directory is
 * already on the SDK's filesystem (or either cannot be read: then the platform
 * behaves as it always did). It is beside or inside what already exists, so
 * creating it never changes which SDK directory the doctor picks.
 */
export function sdkStagingDir(ctx: SdkStagingContext = {}): string | undefined {
  const exists = ctx.exists ?? existsSync;
  const device = ctx.device ?? defaultDevice;
  const anchor = existingAncestor(sdkInstallRoot(ctx), exists);
  const [sdkDevice, tmpDevice] = [device(anchor), device(ctx.tmp ?? tmpdir())];
  if (sdkDevice === undefined || tmpDevice === undefined || sdkDevice === tmpDevice) return undefined;
  return join(anchor, '.android-sdk-staging');
}

/**
 * Before `android doctor --fix`: stage on the SDK's filesystem when the
 * temporary directory is on another one. Returns the cleanup to run at exit.
 */
export function stageSdkDownloadNearSdk(ctx: SdkStagingContext & { warn?: (line: string) => void } = {}): (() => void) | undefined {
  const staging = sdkStagingDir(ctx);
  if (staging === undefined) return undefined;
  const env = ctx.env ?? process.env;
  mkdirSync(staging, { recursive: true });
  // TMPDIR on POSIX; TEMP and TMP are what os.tmpdir() reads on Windows.
  for (const name of (ctx.platform ?? process.platform) === 'win32' ? ['TEMP', 'TMP'] : ['TMPDIR']) env[name] = staging;
  (ctx.warn ?? ((line: string) => void process.stderr.write(`${line}\n`)))(
    `Staging the Android SDK download in ${staging}: the temporary directory is on another filesystem than the SDK.`,
  );
  return () => rmSync(staging, { recursive: true, force: true });
}
