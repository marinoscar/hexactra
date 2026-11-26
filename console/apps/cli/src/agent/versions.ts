import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ExecResult } from './agent.js';

/**
 * Which agent and which Chrome extension a node runs (E49.5, #963), for
 * `hexactra agent status` and the TUI's Agent screen. Read on this machine
 * only: the installed bundle's own files, and the agent's journal for the
 * extension that last connected. Anything unreadable is `null` (unknown),
 * never an error: status must always print.
 */
export interface NodeVersions {
  /** From the bundle's `BUNDLE.json`. */
  agent: { version: string; commit: string } | null;
  /** The extension the bundle ships (`extension/manifest.json`). */
  extension: string | null;
  /** The extension that last connected to the agent, from its journal. `null`: none found or the journal is unreadable. */
  connected: { version: string; at: string } | null;
}

type Exec = (argv: string[], opts?: { interactive?: boolean }) => ExecResult;

const CONNECTED = /browser extension connected.*version=Some\("([^"]+)"\)/;

function readJson(file: string): Record<string, unknown> | null {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The agent and extension versions of an unpacked bundle directory. */
export function bundleVersions(dir: string | null): Pick<NodeVersions, 'agent' | 'extension'> {
  if (!dir) return { agent: null, extension: null };
  const info = readJson(join(dir, 'BUNDLE.json'));
  const manifest = readJson(join(dir, 'extension', 'manifest.json'));
  const version = typeof info?.version === 'string' ? info.version : null;
  const commit = typeof info?.commit === 'string' ? info.commit : null;
  return {
    agent: version && commit ? { version, commit } : null,
    extension: typeof manifest?.version === 'string' && manifest.version ? manifest.version : null,
  };
}

/** The last `browser extension connected … version=Some("…")` line of journal output (`-o short-iso`). */
export function lastConnected(journal: string): NodeVersions['connected'] {
  let found: NodeVersions['connected'] = null;
  for (const line of journal.split('\n')) {
    const m = CONNECTED.exec(line);
    if (m) found = { version: m[1]!, at: line.split(' ', 1)[0] ?? '' };
  }
  return found;
}

/**
 * The extension that last connected to an agent unit. `scope` is `user` for the
 * attended agent (a systemd user unit) and `system` for the unattended node,
 * whose journal needs sudo or the adm group: the plain read is tried first,
 * then `sudo -n` (never a password prompt).
 */
export function connectedExtension(exec: Exec, unit: string, scope: 'user' | 'system'): NodeVersions['connected'] {
  const base = ['journalctl', ...(scope === 'user' ? ['--user'] : []), '-u', unit, '--no-pager', '-o', 'short-iso'];
  // `--grep` keeps the read short on a long journal; a journalctl without pattern support gets the recent lines instead.
  const attempts = [
    [...base, '--grep', 'browser extension connected', '-n', '1'],
    [...base, '-n', '5000'],
  ];
  for (const argv of attempts) {
    for (const full of scope === 'system' ? [argv, ['sudo', '-n', ...argv]] : [argv]) {
      let r: ExecResult;
      try {
        r = exec(full);
      } catch {
        continue;
      }
      const hit = lastConnected(r.stdout);
      if (hit) return hit;
    }
  }
  return null;
}

/** Compares dotted versions (`0.2.0.111`); a missing part counts as 0. */
export function versionAtLeast(have: string, want: string): boolean {
  const a = have.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const b = want.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/** The words for both versions, shared by `agent status` and the TUI. `older`: the connected extension is older than the bundle's. */
export function describeVersions(v: NodeVersions): { agent: string; extension: string; older: boolean; connected: boolean } {
  const agent = v.agent ? `${v.agent.version} (${v.agent.commit.slice(0, 7)})` : 'unknown (the installed bundle has no BUNDLE.json)';
  let extension = v.extension ?? 'unknown';
  const older = !!(v.connected && v.extension && !versionAtLeast(v.connected.version, v.extension));
  if (v.connected) {
    extension += `, connected ${v.connected.version} at ${v.connected.at}${older ? ' (older: the browser has not restarted since the update)' : ''}`;
  } else {
    extension += ', no connection found in the agent log (none yet, or the log is not readable)';
  }
  return { agent, extension, older, connected: !!v.connected };
}

/** The `Agent:` and `Extension:` lines of a status block, labels padded to `width` to line up with the block. */
export function versionLines(v: NodeVersions, width: number): string[] {
  const d = describeVersions(v);
  return [`${'Agent:'.padEnd(width)}${d.agent}`, `${'Extension:'.padEnd(width)}${d.extension}`];
}
