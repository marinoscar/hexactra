// The recipes in docs/recipes/ against the real agent frameworks: each
// framework's own CLI reads the committed recipe file, connects to the
// console's MCP endpoint and lists its tools.
//
// The frameworks are installed only in CI's agent-clients step, which sets
// AGENT_CLIENTS_SMOKE=1: then a missing CLI fails the test instead of
// skipping it. Elsewhere the suite is skipped.
import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
