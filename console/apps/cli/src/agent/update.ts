// `hexactra agent update`, end to end (#902): the one routine the command and the terminal UI run. The person types one command and
// does nothing else:
//   1. the new agent bundle is installed and the agent services restart (the attended user service, the unattended node);
//   2. on an attended node, the person's Google Chrome is restarted (gracefully, its tabs restored) so Chrome loads the new extension,
//      which its enterprise policy fetches within seconds of starting;
//   3. the command waits for the extension to connect to the agent again and checks its version;
//   4. it says what is running now.
// An unattended node's browsers are the agent's own: restarting the agent closes them, and each starts with the new extension at its
// next run.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fetchAndActivate, readState, updateAgent, updateTargets, updateUnattended, type AgentDeps } from './agent.js';
import { UNIT_NAME } from './paths.js';
import { readUnattended } from './unattended.js';

/** How long the extension has to connect again after Chrome restarts. */
export const EXTENSION_WAIT_MS = 120_000;
const POLL_MS = 2_000;
const CHROME_EXIT_WAIT_MS = 20_000;
const CHROME_BINARY = '/opt/google/chrome/chrome';

export interface UpdateOptions {
  bundle?: string;
  version?: string;
  force?: boolean;
  /** sudo may ask for a password on the terminal (the command); the TUI asks first and passes false. */
  interactive?: boolean;
}

/** `0.2.0.81` against `0.2.0`: at least as new, by the numeric parts both have. */
export function atLeast(have: string, want: string): boolean {
  const a = have.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const b = want.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < b.length; i++) {
    if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i]!;
  }
  return true;
}

/** The extension version the active bundle carries (`extension/manifest.json`), or null. */
export function bundledExtensionVersion(d: Pick<AgentDeps, 'paths'>): string | null {
  const file = join(d.paths.current, 'extension', 'manifest.json');
  if (!existsSync(file)) return null;
  try {
    return String((JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? '') || null;
  } catch {
    return null;
  }
}

/** The last extension version the agent logged as connected (`browser extension connected version=Some("…")`), since `since`. */
export function connectedExtensionVersion(d: Pick<AgentDeps, 'exec'>, since: Date): string | null {
  const r = d.exec(['journalctl', '--user', '-u', UNIT_NAME, '--since', since.toISOString().replace('T', ' ').replace(/\..*$/, ''), '--no-pager', '-o', 'cat']);
  let found: string | null = null;
  for (const line of r.stdout.split('\n')) {
    const m = /browser extension connected.*version=Some\("([^"]+)"\)/.exec(line);
    if (m) found = m[1]!;
  }
  return found;
}

/** The person's running Google Chrome: its main processes (not the renderers, `--type=…`). */
export function mainChromePids(d: Pick<AgentDeps, 'exec'>): number[] {
  const r = d.exec(['ps', '-u', String(process.getuid?.() ?? ''), '-o', 'pid=,args=']);
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+\s+\S*\/(google-chrome|chrome)(\s|$)/.test(l) && /\/opt\/google\/chrome\/chrome|google-chrome/.test(l) && !/--type=/.test(l))
    .map((l) => Number.parseInt(l, 10));
}

/**
 * Restarts the person's Google Chrome so it loads the new extension: a graceful stop (SIGTERM, Chrome saves the session), then Chrome
 * again with `--restore-last-session`, detached from this command, on the person's display. Starts it when it was not running.
 */
export async function restartPersonChrome(d: AgentDeps): Promise<void> {
  const pids = mainChromePids(d);
  if (pids.length) {
    d.log('Restarting Google Chrome so it loads the new extension (your tabs are restored)…');
    for (const pid of pids) d.exec(['kill', '-TERM', String(pid)]);
    for (let waited = 0; waited < CHROME_EXIT_WAIT_MS && mainChromePids(d).length; waited += 500) await d.sleep(500);
  } else {
    d.log('Starting Google Chrome so the extension connects…');
  }
  const env = d.env ?? process.env;
  const display = env.DISPLAY || ':0';
  const browser = existsSync(CHROME_BINARY) ? CHROME_BINARY : 'google-chrome';
  // setsid -f: Chrome outlives this command and its terminal.
  d.exec(['env', `DISPLAY=${display}`, 'setsid', '-f', browser, '--restore-last-session']);
}

/** Waits for the extension to connect again, as new as `want`. Returns the version it connected with, or null. */
export async function waitForExtension(d: AgentDeps, since: Date, want: string | null, timeoutMs = EXTENSION_WAIT_MS): Promise<string | null> {
  let last: string | null = null;
  for (let waited = 0; waited <= timeoutMs; waited += POLL_MS) {
    last = connectedExtensionVersion(d, since);
    if (last && (!want || atLeast(last, want))) return last;
    await d.sleep(POLL_MS);
  }
  return last;
}

/** The whole update. Returns the lines that say what runs now (the command prints them; the TUI shows them). */
export async function updateEverything(d: AgentDeps, o: UpdateOptions = {}): Promise<string[]> {
  const targets = updateTargets(d);
  const interactive = o.interactive !== false;
  const out: string[] = [];
  const started = new Date(Date.now() - 1000);
  const before = readState(d.paths);
  if (targets.attended) await updateAgent(d, o);
  else if (targets.unattended) await fetchAndActivate(d, o);
  updateUnattended(d, interactive);

  const want = bundledExtensionVersion(d);
  const state = readState(d.paths);
  if (state) out.push(`Agent ${state.version} (${state.commit.slice(0, 7)})`);

  if (targets.attended && state && state.attended && state.browserKind === 'google-chrome') {
    const changed = !before || before.commit !== state.commit;
    const known = connectedExtensionVersion(d, new Date(0));
    if (changed || o.force || !known || (want && !atLeast(known, want))) {
      await restartPersonChrome(d);
      const got = await waitForExtension(d, started, want);
      if (got && (!want || atLeast(got, want))) out.push(`Extension ${got} connected`);
      else if (got) {
        throw new Error(
          `Chrome is running the extension ${got}, older than ${want}. Chrome had not fetched the new one yet: run \`hexactra agent update\` again in a few minutes. ` +
            'If it stays old, `hexactra agent doctor` checks the Chrome policy.',
        );
      } else {
        throw new Error('The extension did not connect to the agent after Chrome restarted. Run `hexactra agent doctor`; it checks Chrome, the policy and the native host.');
      }
    } else {
      out.push(`Extension ${known} connected (already current)`);
    }
  } else if (targets.attended && state) {
    // The agent starts its own browser (Chrome for Testing, a custom browser): the restart closed it, and the next one has the new extension.
    out.push('The browser restarts with the new extension at its next run');
  }
  if (readUnattended(d.paths.agentDir)) out.push("Unattended node updated: its browsers restarted and start with the new extension at their next run");
  for (const line of out) d.log(line);
  return out;
}
