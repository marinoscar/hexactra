// The recipes in docs/recipes/ against the real agent frameworks: each
// framework's own CLI reads the committed recipe file, connects to the
// console's MCP endpoint and lists its tools.
//
// The frameworks are installed only in CI's agent-clients step, which sets
// AGENT_CLIENTS_SMOKE=1: then a missing CLI fails the test instead of
// skipping it. Elsewhere the suite is skipped.
//
// Claude Code and the MCP Inspector CLI (#468) run the same way with a
// personal access token (no vendor account, no API key): each is pinned
// below and run through `npx` at that version unless CLAUDE_BIN /
// MCP_INSPECTOR_BIN names a binary. Under AGENT_CLIENTS_SMOKE=1 an
// unavailable CLI fails the test; with CLIENT_CLIS_SMOKE=1 (a developer's
// machine) it is skipped with the reason logged; otherwise skipped.
import { execFile, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';

const run = promisify(execFile);
const required = process.env.AGENT_CLIENTS_SMOKE === '1';
const recipes = resolve(__dirname, '../../../docs/recipes');
const suite = required ? describe : describe.skip;

let app: NestFastifyApplication;
let base = '';
let token = '';
let home = '';

function bin(name: string, envVar: string): string {
  return process.env[envVar] || name;
}

async function exec(cmd: string, args: string[], extraEnv: Record<string, string>) {
  try {
    const r = await run(cmd, args, {
      env: { ...process.env, HOME: home, HEXACTRA_CONSOLE_URL: base, HEXACTRA_TOKEN: token, NO_COLOR: '1', ...extraEnv },
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, out: `${r.stdout}\n${r.stderr}` };
  } catch (e) {
    const err = e as { code?: number | string; stdout?: string; stderr?: string };
    if (err.code === 'ENOENT') throw new Error(`${cmd} is not installed; CI's agent-clients step installs it`);
    return { code: Number(err.code ?? 1), out: `${err.stdout ?? ''}\n${err.stderr ?? ''}` };
  }
}

suite('agent framework recipes (real CLIs)', () => {
  beforeAll(async () => {
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
    const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `agent-clients-${Date.now()}@example.test`, role: 'contributor' } });
    token = new URL(String(res.headers.location)).searchParams.get('token')!;
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hexactra-agent-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('Hermes Agent connects with docs/recipes/hermes.config.yaml', async () => {
    const dir = join(home, '.hermes');
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(recipes, 'hermes.config.yaml'), join(dir, 'config.yaml'));
    const r = await exec(bin('hermes', 'HERMES_BIN'), ['mcp', 'test', 'hexactra'], { HERMES_HOME: dir });
    // `hermes mcp test` exits 0 on failure too, so read what it found.
    expect(r.out).toMatch(/Connected/);
    const n = Number(/Tools discovered: (\d+)/.exec(r.out)?.[1] ?? 0);
    expect(n).toBeGreaterThan(10);
    expect(r.out).toMatch(/run_goal/);
  }, 180_000);

  it('OpenClaw connects with docs/recipes/openclaw.json', async () => {
    const dir = join(home, '.openclaw');
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(recipes, 'openclaw.json'), join(dir, 'openclaw.json'));
    const r = await exec(bin('openclaw', 'OPENCLAW_BIN'), ['mcp', 'probe', 'hexactra', '--json'], {
      OPENCLAW_STATE_DIR: dir,
      OPENCLAW_CONFIG_PATH: join(dir, 'openclaw.json'),
    });
    if (r.code !== 0) throw new Error(`exit ${r.code}:\n${r.out}`);
    const report = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1)) as { servers: Record<string, { tools: number }>; tools: string[] };
    expect(report.servers.hexactra.tools).toBeGreaterThan(10);
    expect(report.tools).toEqual(expect.arrayContaining(['hexactra__run_goal', 'hexactra__inbox_answer', 'hexactra__browser_request_human']));
  }, 180_000);

  it('Pi connects with docs/recipes/pi.mcp.json', async () => {
    const dir = join(home, '.pi', 'agent');
    mkdirSync(dir, { recursive: true });
    // Pi expands ${VAR} in headers but not in the URL: the recipe carries a
    // placeholder host that the reader replaces with their console's.
    const recipe = readFileSync(join(recipes, 'pi.mcp.json'), 'utf8');
    expect(recipe).toContain('https://console.example.test/api/mcp');
    writeFileSync(join(dir, 'mcp.json'), recipe.replace('https://console.example.test', base));
    // `pi mcp list` connects to every server and exits 1 when one is not connected.
    const r = await exec(bin('pi', 'PI_BIN'), ['mcp', 'list'], {});
    if (r.code !== 0) throw new Error(`exit ${r.code}:\n${r.out}`);
    expect(r.out).toMatch(/hexactra/);
    expect(r.out).toMatch(/connected/i);
  }, 180_000);
});

// --- Claude Code and the MCP Inspector CLI (#468) ------------------------------------------

/** The versions the recipes in docs/hosted-clients.md were checked against. */
export const CLAUDE_CODE_VERSION = '2.1.327';
export const MCP_INSPECTOR_VERSION = '2.15.0';

/** npm's cache outside the per-test HOME, so npx does not download again for every test. */
const npmCache = process.env.npm_config_cache || join(homedir(), '.npm');

interface Cli {
  label: string;
  cmd: string;
  pre: string[];
  /** Why it cannot run here, or null. */
  unavailable: string | null;
}

/**
 * Installs `pkg@version` into a cached prefix and returns its bin, running the package's own
 * `install.cjs` when it ships one (Claude Code fetches its native binary there, and an npm that
 * skips install scripts, as CI's does, leaves it out).
 */
function installedBin(pkg: string, version: string, bin: string): { cmd: string; error: string | null } {
  const prefix = join(tmpdir(), 'hexactra-agent-clis', `${pkg.replace(/[@/]/g, '_')}-${version}`);
  const cmd = join(prefix, 'node_modules', '.bin', bin);
  const env = { ...process.env, npm_config_cache: npmCache, npm_config_ignore_scripts: 'false' };
  if (!existsSync(cmd)) {
    mkdirSync(prefix, { recursive: true });
    const r = spawnSync('npm', ['install', '--prefix', prefix, '--no-save', '--no-audit', '--no-fund', `${pkg}@${version}`], { encoding: 'utf8', timeout: 300_000, env });
    if (r.status !== 0) return { cmd, error: `npm install ${pkg}@${version} exited ${r.status}: ${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim().slice(0, 400)}` };
  }
  const script = join(prefix, 'node_modules', ...pkg.split('/'), 'install.cjs');
  if (existsSync(script)) {
    const r = spawnSync(process.execPath, [script], { cwd: join(prefix, 'node_modules', ...pkg.split('/')), encoding: 'utf8', timeout: 300_000, env });
    if (r.status !== 0) return { cmd, error: `${script} exited ${r.status}: ${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim().slice(0, 400)}` };
  }
  return { cmd, error: null };
}

/** A pinned CLI: the binary named by `envVar` (it must report `version`), or `npx` at that version (or, with `bin`, an installed copy). */
function pinnedCli(label: string, envVar: string, pkg: string, version: string, versionArgs: string[], bin?: string): Cli {
  const named = process.env[envVar];
  let cmd = named || 'npx';
  let pre = named ? [] : ['--yes', `${pkg}@${version}`];
  const wanted = required || process.env.CLIENT_CLIS_SMOKE === '1';
  if (!wanted) return { label, cmd, pre, unavailable: 'set CLIENT_CLIS_SMOKE=1 to run it here (CI sets AGENT_CLIENTS_SMOKE=1)' };
  if (!named && bin) {
    const installed = installedBin(pkg, version, bin);
    if (installed.error) return { label, cmd: installed.cmd, pre: [], unavailable: installed.error };
    cmd = installed.cmd;
    pre = [];
  }
  const probe = spawnSync(cmd, [...pre, ...versionArgs], { encoding: 'utf8', timeout: 300_000, env: { ...process.env, npm_config_cache: npmCache, NO_COLOR: '1' } });
  const out = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
  if (probe.error) return { label, cmd, pre, unavailable: `${cmd} could not run: ${probe.error.message}` };
  if (probe.status !== 0) return { label, cmd, pre, unavailable: `${cmd} ${[...pre, ...versionArgs].join(' ')} exited ${probe.status}: ${out.trim().slice(0, 400)}` };
  if (!out.includes(version)) return { label, cmd, pre, unavailable: `${label} reports "${out.trim().slice(0, 80)}", not the pinned ${version}` };
  return { label, cmd, pre, unavailable: null };
}

const claudeCode = pinnedCli('Claude Code', 'CLAUDE_BIN', '@anthropic-ai/claude-code', CLAUDE_CODE_VERSION, ['--version'], 'claude');
const inspector = pinnedCli('MCP Inspector', 'MCP_INSPECTOR_BIN', '@modelcontextprotocol/inspector', MCP_INSPECTOR_VERSION, ['--version']);

/** Runs when the CLI is available; under AGENT_CLIENTS_SMOKE=1 always runs (and fails when it is not). Never a pass for a test that did not run. */
function cliTest(cli: Cli): jest.It {
  if (cli.unavailable === null || required) return it;
  // eslint-disable-next-line no-console
  console.warn(`agent-clients: skipping the ${cli.label} smoke test: ${cli.unavailable}`);
  return it.skip;
}

const cliSuite = claudeCode.unavailable === null || inspector.unavailable === null || required ? describe : describe.skip;

cliSuite('Claude Code and the MCP Inspector CLI (real CLIs, a personal access token)', () => {
  let cliApp: NestFastifyApplication;
  let url = '';
  let pat = '';
  let cliHome = '';

  beforeAll(async () => {
    cliApp = await createApp();
    await cliApp.listen(0, '127.0.0.1');
    const addr = cliApp.getHttpServer().address() as { port: number };
    url = `http://127.0.0.1:${addr.port}/api/mcp`;
    const res = await cliApp.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `hosted-clis-${Date.now()}@example.test`, role: 'contributor' } });
    const session = new URL(String(res.headers.location)).searchParams.get('token')!;
    // A personal access token, as docs/hosted-clients.md tells a Claude Code user without OAuth to make one.
    const made = await cliApp.inject({ method: 'POST', url: '/api/pat', headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json' }, payload: JSON.stringify({ name: 'CLI smoke', durationValue: 1, durationUnit: 'days' }) });
    if (made.statusCode !== 201) throw new Error(`creating a personal access token: ${made.statusCode} ${made.body}`);
    pat = (JSON.parse(made.body) as { data: { token: string } }).data.token;
  });
  afterAll(async () => {
    await cliApp?.close();
  });
  beforeEach(() => {
    cliHome = mkdtempSync(join(tmpdir(), 'hexactra-cli-'));
  });
  afterEach(() => {
    rmSync(cliHome, { recursive: true, force: true });
  });

  async function runCli(cli: Cli, args: string[]) {
    if (cli.unavailable !== null) throw new Error(`${cli.label} is not available: ${cli.unavailable}`);
    try {
      const r = await run(cli.cmd, [...cli.pre, ...args], {
        cwd: cliHome,
        env: { ...process.env, HOME: cliHome, npm_config_cache: npmCache, HEXACTRA_TOKEN: pat, NO_COLOR: '1', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        timeout: 180_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      return { code: 0, out: `${r.stdout}\n${r.stderr}` };
    } catch (e) {
      const err = e as { code?: number | string; stdout?: string; stderr?: string };
      return { code: Number(err.code ?? 1), out: `${err.stdout ?? ''}\n${err.stderr ?? ''}` };
    }
  }

  cliTest(claudeCode)(`Claude Code ${CLAUDE_CODE_VERSION}: claude mcp add --transport http … then claude mcp list shows it connected`, async () => {
    const add = await runCli(claudeCode, ['mcp', 'add', '--transport', 'http', 'hexactra', url, '--header', `Authorization: Bearer ${pat}`]);
    if (add.code !== 0) throw new Error(`claude mcp add exited ${add.code}:\n${add.out}`);
    const list = await runCli(claudeCode, ['mcp', 'list']);
    if (list.code !== 0) throw new Error(`claude mcp list exited ${list.code}:\n${list.out}`);
    const line = list.out.split('\n').find((l) => l.startsWith('hexactra'));
    expect(line).toBeDefined();
    expect(line).toContain(url);
    expect(line).toMatch(/Connected/);
    expect(list.out).not.toContain(pat);
  }, 300_000);

  cliTest(inspector)(`MCP Inspector ${MCP_INSPECTOR_VERSION} --cli: tools/list over Streamable HTTP`, async () => {
    const r = await runCli(inspector, ['--cli', url, '--transport', 'http', '--method', 'tools/list', '--header', `Authorization: Bearer ${pat}`]);
    if (r.code !== 0) throw new Error(`inspector exited ${r.code}:\n${r.out}`);
    const json = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1)) as { tools: Array<{ name: string; annotations?: Record<string, unknown> }> };
    expect(json.tools.length).toBeGreaterThan(10);
    expect(json.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['run_goal', 'run_wait', 'inbox_answer', 'browser_open']));
    for (const t of json.tools) expect(t.annotations).toMatchObject({ readOnlyHint: expect.any(Boolean), destructiveHint: expect.any(Boolean) });

    // Without the header: the 401 makes the Inspector want to sign in (OAuth), which a headless run refuses.
    const anon = await runCli(inspector, ['--cli', url, '--transport', 'http', '--method', 'tools/list']);
    expect(anon.code).not.toBe(0);
    expect(anon.out).toMatch(/auth_required|401|nauthori[sz]ed/);
  }, 300_000);
});
