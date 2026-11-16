// The node's desktop-input dependencies (#373, epic #366).
//
// The host agent drives the node's X11 desktop itself for `desktop_*`
// actions (native file pickers, OS dialogs, other windows): `xdotool` for
// the pointer and keyboard, ImageMagick (`import`, or `xwd` + `convert`)
// for full-screen captures. `hexactra agent install` and `update` install
// them wherever the agent has an X11 desktop to drive.
import type { AgentDeps } from './agent.js';
import type { PrivilegedStep } from './googleChrome.js';

/** Debian/Ubuntu packages the desktop driver needs. */
export const DESKTOP_INPUT_PACKAGES = ['xdotool', 'imagemagick'] as const;

/** What each package is for, as the install explains it. */
export const DESKTOP_INPUT_WHY = 'the agent uses the whole desktop: native file pickers and dialogs, other windows';

/** The packages of `wanted` that dpkg does not report as installed. */
export function missingPackages(d: Pick<AgentDeps, 'exec'>, wanted: readonly string[]): string[] {
  return wanted.filter((p) => d.exec(['dpkg', '-s', p]).code !== 0);
}

/** The privileged step installing `packages` (none when nothing is missing). */
export function aptInstallStep(packages: readonly string[], why: string): PrivilegedStep[] {
  if (packages.length === 0) return [];
  return [{ what: `install ${packages.join(', ')} (${why})`, argv: ['apt-get', 'install', '-y', '--no-install-recommends', ...packages] }];
}
