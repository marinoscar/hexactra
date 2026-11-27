// The TypeScript SDK (packages/sdk) against the live API:
// 1. packages/sdk/openapi.json is the document the API serves (regenerate
//    with UPDATE_SDK_OPENAPI=1, then `npm run generate --workspace=@hexactra/console-sdk`);
// 2. the SDK's example runs end to end against a real listening API.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';

const SPEC = resolve(__dirname, '../../../packages/sdk/openapi.json');

let app: NestFastifyApplication;
let base = '';

/**
 * The served document without what changes per build: the version, and the
 * build number the description quotes. `deploy update` bumps the version and
 * commits it, so a snapshot holding it would break CI on every deploy.
 */
function normalized(doc: { info?: { version?: string; description?: string } }) {
  const description = doc.info?.description?.replace(/\(build `[^`]*`\)/g, '(build `0.0.0`)');
  return JSON.stringify({ ...doc, info: { ...doc.info, version: '0.0.0', ...(description === undefined ? {} : { description }) } }, null, 2) + '\n';
}

beforeAll(async () => {
  app = await createApp({ docs: true });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
});
afterAll(async () => {
  await app?.close();
});

describe('the console SDK', () => {
  it('ships the OpenAPI document the API serves', async () => {
    const served = normalized(await (await fetch(`${base}/api/openapi.json`)).json());
    if (process.env.UPDATE_SDK_OPENAPI === '1') writeFileSync(SPEC, served);
    expect(readFileSync(SPEC, 'utf8')).toBe(served);
  });

  it('runs its example against the API', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `sdk-${Date.now()}@example.test`, role: 'contributor' } });
    const token = new URL(String(res.headers.location)).searchParams.get('token')!;
    // The built SDK's example, run the way a user runs it.
    const { stdout } = await promisify(execFile)(process.execPath, [resolve(__dirname, '../../../packages/sdk/dist/examples/tasks.js')], {
      env: { ...process.env, HEXACTRA_CONSOLE_URL: base, HEXACTRA_TOKEN: token },
      timeout: 60_000,
    });
    const out = JSON.parse(stdout.trim().split('\n').pop()!) as Record<string, unknown> & { listed: number };
    expect(out.listed).toBeGreaterThanOrEqual(1);
    expect(out.updatedGoal).toBe('Find the cheapest fare to Lisbon in March');
    // The typed helpers of #432: schedules.preview, tasks.create with schedules, pause and resume, runs.list, runs.deleteMany.
    expect(out).toMatchObject({
      preview: 'Monday to Friday at 09:00',
      refused: 'CRON_TOO_FREQUENT',
      scheduleState: ['active', 'paused', 'active'],
      page: { items: 0, nextCursor: null },
      deleted: 0,
    });
  });

  it('runs a task with parameters: the amount only, and one form when it is missing (#552)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `sdk-params-${Date.now()}@example.test`, role: 'contributor' } });
    const token = new URL(String(res.headers.location)).searchParams.get('token')!;
    const { stdout } = await promisify(execFile)(process.execPath, [resolve(__dirname, '../../../packages/sdk/dist/examples/task-parameters.js')], {
      env: { ...process.env, HEXACTRA_CONSOLE_URL: base, HEXACTRA_TOKEN: token },
      timeout: 60_000,
    });
    const out = JSON.parse(stdout.trim().split('\n').pop()!) as Record<string, unknown>;
    expect(out).toMatchObject({
      parameters: ['amount', 'phone_number', 'account_last_4'],
      startedInputs: ['amount:provided', 'phone_number:default', 'account_last_4:default'],
      waitingStatus: 'waiting_human',
      formFields: ['amount'],
      refused: 400,
    });
  });

  it('saves a task with outputs and reads what its runs returned (E39.5, #600)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `sdk-outputs-${Date.now()}@example.test`, role: 'contributor' } });
    const token = new URL(String(res.headers.location)).searchParams.get('token')!;
    const { stdout } = await promisify(execFile)(process.execPath, [resolve(__dirname, '../../../packages/sdk/dist/examples/task-outputs.js')], {
      env: { ...process.env, HEXACTRA_CONSOLE_URL: base, HEXACTRA_TOKEN: token },
      timeout: 60_000,
    });
    const out = JSON.parse(stdout.trim().split('\n').pop()!) as Record<string, unknown>;
    expect(out).toMatchObject({
      outputKeys: ['confirmation_number', 'amount_paid', 'paid_on', 'remaining_balance', 'account'],
      sensitiveKeys: ['account'],
      runOutputLabels: ['Confirmation number', 'Amount paid', 'Paid on', 'Remaining balance', 'Account'],
      runOutputsComplete: null,
      columns: ['confirmation_number', 'amount_paid', 'paid_on', 'remaining_balance', 'account'],
      historyRuns: 0,
      nextCursor: null,
      refused: 400,
    });
  });

  it('round-trips agent policies: create, update, export, import and run under one', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `sdk-pol-${Date.now()}@example.test`, role: 'contributor' } });
    const token = new URL(String(res.headers.location)).searchParams.get('token')!;
    const { stdout } = await promisify(execFile)(process.execPath, [resolve(__dirname, '../../../packages/sdk/dist/examples/policies.js')], {
      env: { ...process.env, HEXACTRA_CONSOLE_URL: base, HEXACTRA_TOKEN: token },
      timeout: 60_000,
    });
    const out = JSON.parse(stdout.trim().split('\n').pop()!) as Record<string, string | number>;
    expect(out).toMatchObject({ editedVersion: 2, editedMaxActions: 45, exported: 1, listed: 6 });
    expect(String(out.importedName)).toMatch(/^Cheap fares \d+ \(2\)$/);
    expect(out.taskPolicyId).toBe(out.policyId);
    // The runs exist under the policies the example named.
    const runs = (await (await fetch(`${base}/api/runs`, { headers: { authorization: `Bearer ${token}` } })).json()) as { data: { id: string }[] };
    expect(runs.data.map((r) => r.id)).toEqual(expect.arrayContaining([String(out.runId), String(out.taskRunId)]));
  });

  it('exports a run as its trace file (#542), written where the example runs', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `sdk-export-${Date.now()}@example.test`, role: 'contributor' } });
    const token = new URL(String(res.headers.location)).searchParams.get('token')!;
    const cwd = mkdtempSync(join(tmpdir(), 'sdk-export-'));
    const { stdout } = await promisify(execFile)(process.execPath, [resolve(__dirname, '../../../packages/sdk/dist/examples/run-export.js')], {
      env: { ...process.env, HEXACTRA_CONSOLE_URL: base, HEXACTRA_TOKEN: token },
      cwd,
      timeout: 60_000,
    });
    const out = JSON.parse(stdout.trim().split('\n').pop()!) as { runId: string; file: string; type: string; formatVersion: number; steps: number };
    expect(out).toMatchObject({ type: 'hexactra.run-trace', formatVersion: 2 });
    expect(out.file).toBe(`hexactra-run-${out.runId.slice(0, 8)}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`);
    const file = JSON.parse(readFileSync(join(cwd, out.file), 'utf8')) as { run: { id: string } };
    expect(file.run.id).toBe(out.runId);
    expect(stdout).not.toContain(token);
  });

  it('reads run statistics (E53.4, #1072)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `sdk-stats-${Date.now()}@example.test`, role: 'contributor' } });
    const token = new URL(String(res.headers.location)).searchParams.get('token')!;
    const { stdout } = await promisify(execFile)(process.execPath, [resolve(__dirname, '../../../packages/sdk/dist/examples/run-stats.js')], {
      env: { ...process.env, HEXACTRA_CONSOLE_URL: base, HEXACTRA_TOKEN: token, HEXACTRA_EXAMPLE_START: '1' },
      timeout: 60_000,
    });
    const out = JSON.parse(stdout.trim().split('\n').pop()!) as { runs: number; groups: number; groupBy: string; truncated: boolean };
    expect(out).toMatchObject({ runs: 1, groups: 1, groupBy: 'task', truncated: false });
    expect(stdout).toContain('No task: 1 runs');
    expect(stdout).not.toContain(token);
  });
});
