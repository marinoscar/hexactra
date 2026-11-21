import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { ANDROID_IDENTITY_SOURCE, APP_NAME, CLI_NAME, REPO_SLUG } from '@app/shared';
import { androidCommand } from '@marinoscar/platform-cli/android';
import type { CreateCliOptions } from '@marinoscar/platform-cli';

import { appsCommand } from './apps.command.js';
import { BRAND_TUI_MENU_ROOT, BRAND_TUI_THEME } from './brand.js';
import { agentCommand } from './agent/agent.command.js';
import { agentScreen } from './agent/agent.tui.js';
import { withAndroidPreflight } from './android-checkout.js';
import { androidScreen } from './android.tui.js';
import { devCommand } from './dev.command.js';
import { EDGE_WEBSOCKETS_STEPS } from './edge-websockets.step.js';
import { FABRIC_CONNECT_STEPS } from './fabric-connect.step.js';
import { bundledHostCommand } from './bundled-host.command.js';
import { fabricCommand } from './fabric.command.js';
import { fleetCommand } from './fleet.command.js';
import { inboxCommand } from './inbox.command.js';
import { questionsCommand } from './questions.command.js';
import { inboxScreen } from './inbox.tui.js';
import { HEXACTRA_TUI_MENU } from './menu.js';
import { mcpCommand } from './mcp.command.js';
import { fleetScreen } from './fleet.tui.js';
import { connectionsCommand } from './connections.command.js';
import { memoriesCommand } from './memories.command.js';
import { policiesCommand } from './policies.command.js';
import { usageCommand } from './usage.command.js';
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
    // Whether the bundled browser host runs (#343): see bundledHostProfile.
    COMPOSE_PROFILES: { generate: 'bundled-host-profile', autoGenerate: true },
    HEXACTRA_FABRIC_OTLP_ENDPOINT: { allowBlank: true },
    // The built-in secrets store (E37.5) is switched on in Administration → Secrets (#711), never in .env. Its key is the
    // one deployment secret it needs: generated without a question, like the operator token, and never replaced once set.
    // SECRETS_STORE_KEY_PREVIOUS (a rotation) stays a variable you add by hand. The callback address may stay blank.
    SECRETS_STORE_KEY: { secret: true, generate: 'base64-32', autoGenerate: true },
    SECRETS_STORE_CALLBACK_URL: { allowBlank: true },
  },
} as const;

/**
 * `COMPOSE_PROFILES` on the first deploy that knows it (#343): browsers belong
 * on nodes at home (docs/nodes.md), so a NEW deployment runs no bundled host
 * (`none`, a profile nothing uses). A deployment that already has the bundled
 * host's profiles (its `fabric-host-data` volume) keeps it (`bundled-host`),
 * and so does one where Docker cannot be asked. Set it yourself in
 * infra/compose/.env to switch: `bundled-host` on, `none` off.
 */
export function bundledHostProfile(volumes: () => string | null = dockerVolumes): string {
  const list = volumes();
  if (list === null) return 'bundled-host';
  return /(^|[_-])fabric-host-data$/m.test(list) ? 'bundled-host' : 'none';
}

function dockerVolumes(): string | null {
  const r = spawnSync('docker', ['volume', 'ls', '--format', '{{.Name}}'], { encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout) : null;
}

export const BUNDLED_HOST_GENERATOR = { kind: 'bundled-host-profile', generate: () => bundledHostProfile() };

/**
 * The CLI is `@marinoscar/platform-cli`, composed with this app's identity
 * (packages/shared/identity.json): the binary name seeds `~/.<name>/` and the
 * `<NAME>_` environment prefix. Add app commands through `extraCommands`.
 */
export const APP_CLI_OPTIONS: CreateCliOptions = {
  identity: { name: CLI_NAME, displayName: `${APP_NAME} CLI`, productName: APP_NAME, repoSlug: REPO_SLUG },
  version: readVersion(),
  // `android`: build, version and release the Android app (apps/android) through the platform's group,
  // behind this app's folder check (#478): the app is in console/, and a build needs `npm ci` there.
  extraCommands: [bundledHostCommand, devCommand, fabricCommand, fleetCommand, agentCommand, runsCommand, policiesCommand, usageCommand, memoriesCommand, connectionsCommand, appsCommand, inboxCommand, questionsCommand, mcpCommand, withAndroidPreflight(androidCommand({ identity: ANDROID_IDENTITY_SOURCE }))],
  tuiScreens: [inboxScreen, runsScreen, fleetScreen, agentScreen, androidScreen],
  // The hexactra brand (docs/brand): its colours, and the Trace mark with the wordmark atop the menu.
  tuiTheme: BRAND_TUI_THEME,
  tuiMenuRoot: BRAND_TUI_MENU_ROOT,
  // The grouped root menu, different logged in and logged out (#357): menu.ts.
  tuiMenu: HEXACTRA_TUI_MENU,
  // This app lives in console/ of the hexactra repository: `deploy install`
  // and `deploy update` clone the whole repository (git stays at its root)
  // and run compose from console/infra/compose, whose fabric overlay builds
  // the Rust images from the repository root.
  deploy: { appDir: 'console' },
  // Connect the console to the bundled fabric at the end of install and update (#309).
  // Forward the remote desktop WebSockets at the shared host proxy (#359).
  deploySteps: [...EDGE_WEBSOCKETS_STEPS, ...FABRIC_CONNECT_STEPS],
  // The MCP endpoint's tools may wait up to 200 s (run_wait, ask_human): the shared host proxy of a VPS
  // otherwise cuts a request at 60 s. The app's own nginx gives it 300 s too (infra/nginx/app.d/locations/mcp.conf, #465).
  proxy: { streamPaths: [{ path: '/api/mcp', timeoutSeconds: 300 }] },
  envGenerators: [BUNDLED_HOST_GENERATOR],
  envSpecFragments: [FABRIC_ENV_FRAGMENT],
};
