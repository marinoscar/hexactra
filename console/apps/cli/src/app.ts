import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { ANDROID_IDENTITY_SOURCE, APP_NAME, CLI_NAME, REPO_SLUG } from '@app/shared';
import { androidCommand, androidTuiScreen } from '@marinoscar/platform-cli/android';
import type { CreateCliOptions } from '@marinoscar/platform-cli';

import { BRAND_TUI_MENU_ROOT, BRAND_TUI_THEME } from './brand.js';
import { fabricCommand } from './fabric.command.js';
import { fleetCommand } from './fleet.command.js';
import { inboxCommand } from './inbox.command.js';
import { questionsCommand } from './questions.command.js';
import { inboxScreen } from './inbox.tui.js';
import { mcpCommand } from './mcp.command.js';
import { fleetScreen } from './fleet.tui.js';
import { runsCommand } from './runs.command.js';
import { runsScreen } from './runs.tui.js';

/** This CLI's version: apps/cli/package.json, or `0.0.0-unknown` in an unusual install. */
function readVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return manifest.version || '0.0.0-unknown';
  } catch {
    return '0.0.0-unknown';
  }
}

/**
 * How `deploy install` / `deploy update` fill this app's own keys
 * (infra/compose/app.env.example): the fabric's secrets are only read by the
 * stack, so they are generated without a question, like the platform's
 * STACK_AGENT_TOKEN. A real value already in .env is never replaced.
 */
export const FABRIC_ENV_FRAGMENT = {
  id: 'hexactra-fabric',
  metadata: {
    // app.fabric.compose.yml refuses to start without it (`:?`).
    HEXACTRA_FABRIC_OPERATOR_TOKEN: { secret: true, generate: 'hex-32', autoGenerate: true },
    // noVNC passwords are at most 8 characters.
    HEXACTRA_VIEWER_PASSWORD: { secret: true, generate: 'viewer-8', autoGenerate: true },
    HEXACTRA_FABRIC_OTLP_ENDPOINT: { allowBlank: true },
  },
} as const;

/** 8 URL-safe characters from 6 random bytes: the noVNC password limit. */
export const VIEWER_PASSWORD_GENERATOR = { kind: 'viewer-8', generate: () => randomBytes(6).toString('base64url') };

/**
 * The CLI is `@marinoscar/platform-cli`, composed with this app's identity
 * (packages/shared/identity.json): the binary name seeds `~/.<name>/` and the
 * `<NAME>_` environment prefix. Add app commands through `extraCommands`.
 */
export const APP_CLI_OPTIONS: CreateCliOptions = {
  identity: { name: CLI_NAME, displayName: `${APP_NAME} CLI`, productName: APP_NAME, repoSlug: REPO_SLUG },
  version: readVersion(),
  // `android`: build, version and release the Android app (apps/android) through the platform's group.
  extraCommands: [fabricCommand, fleetCommand, runsCommand, inboxCommand, questionsCommand, mcpCommand, androidCommand({ identity: ANDROID_IDENTITY_SOURCE })],
  tuiScreens: [inboxScreen, runsScreen, fleetScreen, androidTuiScreen],
  // The hexactra brand (docs/brand): its colours, and the Trace mark with the wordmark atop the menu.
  tuiTheme: BRAND_TUI_THEME,
  tuiMenuRoot: BRAND_TUI_MENU_ROOT,
  // This app lives in console/ of the hexactra repository: `deploy install`
  // and `deploy update` clone the whole repository (git stays at its root)
  // and run compose from console/infra/compose, whose fabric overlay builds
  // the Rust images from the repository root.
  deploy: { appDir: 'console' },
  envGenerators: [VIEWER_PASSWORD_GENERATOR],
  envSpecFragments: [FABRIC_ENV_FRAGMENT],
};
