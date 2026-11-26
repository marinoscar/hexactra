// `hexactra agent status` shows which agent and which extension a node runs
// (E49.5, #963), attended and unattended, read on the machine itself.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { unattendedStatus, type AgentDeps, type AgentStatus, type ExecResult, type UnattendedStatus } from './agent.js';
import { statusLines, unattendedLines } from './agent.command.js';
import { agentPaths } from './paths.js';
import { UNITS } from './unattended.js';
import { EXTENSION_ID } from './googleChrome.js';
import { bundleVersions, connectedExtension, describeVersions, lastConnected, releasedExtension, versionAtLeast, type NodeVersions } from './versions.js';

const CONNECTED_LINE = (at: string, v: string) =>
  `${at} mini-pc hexactra-agent[812]: INFO hexactra_agent::browser: browser extension connected version=Some("${v}") profile="default"`;

function bundleDir(root: string, o: { version?: string; commit?: string; extension?: string | null; bundleJson?: boolean } = {}): string {
  const dir = join(root, `${o.version ?? '0.2.0'}-${(o.commit ?? '540d2c1460d5').slice(0, 7)}`);
  mkdirSync(join(dir, 'extension'), { recursive: true });
  if (o.bundleJson !== false) writeFileSync(join(dir, 'BUNDLE.json'), JSON.stringify({ name: 'b', version: o.version ?? '0.2.0', commit: o.commit ?? '540d2c1460d5', files: {} }));
  if (o.extension !== null) writeFileSync(join(dir, 'extension', 'manifest.json'), JSON.stringify({ manifest_version: 3, version: o.extension ?? '0.2.0.111' }));
  return dir;
}

/** A fake exec answering journalctl reads; records every call. */
function journal(answer: (argv: string[]) => ExecResult) {
  const calls: string[][] = [];
  return {
    calls,
    exec: (argv: string[]): ExecResult => {
      calls.push(argv);
      return answer(argv);
    },
  };
}
const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });

describe('reading the versions on the node', () => {
  it('reads the agent and the bundled extension from the bundle', () => {
    const dir = bundleDir(mkdtempSync(join(tmpdir(), 'hx-ver-')));
    expect(bundleVersions(dir)).toEqual({ agent: { version: '0.2.0', commit: '540d2c1460d5' }, extension: '0.2.0.111' });
  });

  it('reads a missing or broken bundle as unknown, never an error', () => {
    const root = mkdtempSync(join(tmpdir(), 'hx-ver-'));
    expect(bundleVersions(null)).toEqual({ agent: null, extension: null });
    expect(bundleVersions(join(root, 'nope'))).toEqual({ agent: null, extension: null });
    const dir = bundleDir(root, { bundleJson: false, extension: null });
    writeFileSync(join(dir, 'BUNDLE.json'), '{not json');
    expect(bundleVersions(dir)).toEqual({ agent: null, extension: null });
  });

  it('takes the last extension connection in the journal, with its time', () => {
    const text = [CONNECTED_LINE('2026-11-25T10:00:00+0000', '0.2.0.104'), 'other line', CONNECTED_LINE('2026-11-26T02:10:03+0000', '0.2.0.111')].join('\n');
    expect(lastConnected(text)).toEqual({ version: '0.2.0.111', at: '2026-11-26T02:10:03+0000' });
    expect(lastConnected('-- No entries --')).toBeNull();
  });

  it("reads the attended agent's user journal", () => {
    const j = journal(() => ok(CONNECTED_LINE('2026-11-26T02:10:03+0000', '0.2.0.111')));
    expect(connectedExtension(j.exec, 'hexactra-agent.service', 'user')).toEqual({ version: '0.2.0.111', at: '2026-11-26T02:10:03+0000' });
    expect(j.calls).toEqual([['journalctl', '--user', '-u', 'hexactra-agent.service', '--no-pager', '-o', 'short-iso', '--grep', 'browser extension connected', '-n', '1']]);
  });

  it("reads the unattended node's system journal, with sudo -n when the plain read shows nothing", () => {
    const j = journal((argv) => ok(argv[0] === 'sudo' ? CONNECTED_LINE('2026-11-26T02:10:03+0000', '0.2.0.111') : '-- No entries --'));
    expect(connectedExtension(j.exec, UNITS.agent, 'system')).toMatchObject({ version: '0.2.0.111' });
    expect(j.calls.map((a) => a.slice(0, 3))).toEqual([
      ['journalctl', '-u', 'hexactra-node-agent.service'],
      ['sudo', '-n', 'journalctl'],
    ]);
  });

  it('falls back to recent lines when journalctl has no --grep, and reports unknown when nothing is readable', () => {
    const noGrep = journal((argv) => (argv.includes('--grep') ? { code: 1, stdout: '', stderr: 'Compiled without pattern matching support' } : ok(CONNECTED_LINE('t', '0.2.0.111'))));
    expect(connectedExtension(noGrep.exec, 'hexactra-agent.service', 'user')).toMatchObject({ version: '0.2.0.111' });
    expect(noGrep.calls[1]).toContain('5000');
    const throws = journal(() => {
      throw new Error('journalctl: not found');
    });
    expect(connectedExtension(throws.exec, UNITS.agent, 'system')).toBeNull();
    expect(throws.calls).toHaveLength(4);
  });

  it("reads the released version from the updates.xml the Chrome policy names, and anything else as unknown", async () => {
    const root = mkdtempSync(join(tmpdir(), 'hx-ver-'));
    const policy = join(root, 'hexactra.json');
    const url = 'https://github.com/marinoscar/hexactra/releases/download/agent-latest/updates.xml';
    writeFileSync(policy, JSON.stringify({ ExtensionSettings: { [EXTENSION_ID]: { installation_mode: 'force_installed', update_url: url } } }));
    const xml = `<?xml version='1.0' encoding='UTF-8'?><gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'><app appid='${EXTENSION_ID}'><updatecheck codebase='https://x/hexactra-extension.crx' version='0.2.0.111' /></app></gupdate>`;
    const asked: string[] = [];
    const fetch = async (u: string) => {
      asked.push(u);
      return { ok: true, status: 200, text: async () => xml, arrayBuffer: async () => new ArrayBuffer(0) };
    };
    expect(await releasedExtension(policy, fetch)).toBe('0.2.0.111');
    expect(asked).toEqual([url]);
    // No policy, a failed request, a request that never answers, or another document: unknown.
    expect(await releasedExtension(join(root, 'none.json'), fetch)).toBeNull();
    expect(await releasedExtension(policy, async () => ({ ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }))).toBeNull();
    expect(await releasedExtension(policy, () => new Promise(() => undefined), 20)).toBeNull();
    expect(await releasedExtension(policy, async () => ({ ok: true, status: 200, text: async () => '<html>login</html>', arrayBuffer: async () => new ArrayBuffer(0) }))).toBeNull();
  });

  it('compares dotted versions', () => {
    expect(versionAtLeast('0.2.0.111', '0.2.0.104')).toBe(true);
    expect(versionAtLeast('0.2.0.104', '0.2.0.111')).toBe(false);
    expect(versionAtLeast('0.2.0', '0.2.0.0')).toBe(true);
    expect(versionAtLeast('0.10.0', '0.9.9')).toBe(true);
  });

  it('flags a connected extension older than the bundled one', () => {
    const v: NodeVersions = { agent: { version: '0.2.0', commit: '540d2c1460d5' }, extension: '0.2.0.111', connected: { version: '0.2.0.104', at: 't' } };
    expect(describeVersions(v)).toMatchObject({ older: true, extension: '0.2.0.111 (bundled), connected 0.2.0.104 at t (older: the browser takes the new one when it next starts; check again after the next run)' });
  });

  it("compares with the release Chrome installs by policy, not the bundle's unstamped copy (the owner's node after an update)", () => {
    // The bundle's manifest says 0.2.0; the policy installs 0.2.0.111; the browser last connected with the old 0.2.0.106.
    const v: NodeVersions = { agent: { version: '0.2.0', commit: '540d2c1460d5' }, extension: '0.2.0', released: '0.2.0.111', connected: { version: '0.2.0.106', at: '2026-11-25T18:57:55-06:00' } };
    expect(describeVersions(v)).toMatchObject({ older: true });
    expect(describeVersions(v).extension).toBe('0.2.0.111 (latest release), connected 0.2.0.106 at 2026-11-25T18:57:55-06:00 (older: the browser takes the new one when it next starts; check again after the next run)');
    expect(describeVersions({ ...v, connected: { version: '0.2.0.111', at: 't' } })).toMatchObject({ older: false, extension: '0.2.0.111 (latest release), connected 0.2.0.111 at t' });
  });
});

const VERSIONS: NodeVersions = { agent: { version: '0.2.0', commit: '540d2c1460d5' }, extension: '0.2.0.111', connected: { version: '0.2.0.111', at: '2026-11-26T02:10:03+0000' } };

describe('agent status text', () => {
  it('shows both versions for the attended agent', () => {
    const s: AgentStatus = {
      installed: true,
      activeBundle: '/x',
      state: { name: 'mini-pc', agentUrl: 'https://c/fabric', browser: '/x', maxBrowsers: 1, version: '0.2.0', commit: '540d2c1460d5', hostId: '0123456789abcdef', browserKind: 'google-chrome', chromeVersion: '142', service: true, installedAt: '', updatedAt: '' },
      service: { active: 'active', sub: 'running' },
      fleet: { id: 'h', name: 'mini-pc', online: true, browserConnected: true },
      fleetError: null,
      versions: VERSIONS,
    };
    const lines = statusLines(s);
    expect(lines).toContain('Agent:     0.2.0 (540d2c1)');
    expect(lines).toContain('Extension: 0.2.0.111 (bundled), connected 0.2.0.111 at 2026-11-26T02:10:03+0000');
    // The block's values line up.
    expect(new Set(lines.map((l) => l.indexOf(l.trim().split(/\s+/)[1]!)))).toEqual(new Set([11]));
  });

  it('shows both versions for an unattended-only node, which had neither', () => {
    const u: UnattendedStatus = {
      installed: true,
      state: { hostId: 'fedcba9876543210', name: 'AI-MARIN-LINUX', agentUrl: 'u', display: 90, maxBrowsers: 2, resolution: '1920x1080', gpu: null, bundle: '0.2.0-540d2c1', installedAt: '', updatedAt: '' },
      units: { [UNITS.agent]: 'active' },
      versions: { ...VERSIONS, connected: null },
    };
    const lines = unattendedLines(u);
    expect(lines).toContain('Agent:      0.2.0 (540d2c1)');
    expect(lines).toContain('Extension:  0.2.0.111 (bundled), no connection found in the agent log (none yet, or the log is not readable)');
  });
});

describe('unattendedStatus', () => {
  it("reads the node's recorded bundle and its own agent's journal", () => {
    const home = mkdtempSync(join(tmpdir(), 'hx-ver-'));
    const paths = agentPaths({ XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config') }, home);
    bundleDir(paths.versionsDir);
    mkdirSync(paths.agentDir, { recursive: true });
    writeFileSync(
      join(paths.agentDir, 'unattended.json'),
      JSON.stringify({ hostId: 'fedcba9876543210', name: 'n', agentUrl: 'u', display: 90, maxBrowsers: 1, resolution: '1920x1080', gpu: null, bundle: '0.2.0-540d2c1', installedAt: '', updatedAt: '' }),
    );
    const j = journal((argv) => ok(argv.includes('journalctl') && argv.includes(UNITS.agent) ? CONNECTED_LINE('2026-11-26T02:10:03+0000', '0.2.0.111') : 'active'));
    const u = unattendedStatus({ paths, exec: j.exec } as unknown as AgentDeps);
    expect(u.versions).toEqual(VERSIONS);
  });
});
