// E46.23 (#797) export and import against a real database (helpers as in kgraph-replay.db.spec.ts). E46.9 (#783) against a real database: a reuse-mode task run replays its procedure inside the ordinary run. Every call goes through
// executeTool (each one reaches the observer the wrapper calls), no model call for call steps, ordinary step rows; a mismatch hands over to
// the loop with one note; Stop before a step ends it; the site gate refuses a replayed navigate outside the allowed sites; a commit step
// whose intent was left open is never sent again; with the mode off nothing of this is entered.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';
import { procedureVersionSchema, type ProcedureVersionInput } from '@marinoscar/hexactra-kgraph';

import { KgraphAfterRun } from '../src/kgraph/kgraph-compile.job';
import { KgraphCompileService } from '../src/kgraph/kgraph-compile.service';
import { KgraphEnabledService } from '../src/kgraph/kgraph-enabled.service';
import { PrismaProcedureStore } from '../src/kgraph/prisma-procedure-store';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { QuestionEvents } from '../src/questions/question-events';
import { QuestionsService } from '../src/questions/questions.service';
import { GoalRunnerService } from '../src/runner/goal-runner.service';
import { TasksService } from '../src/tasks/tasks.service';
import { fakeSecretsFabric, type SecretsFabric } from './support/fake-secrets-fabric';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;
const workerMode = process.env.JOBS_WORKER_MODE;

beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app?.close();
});

async function login(email: string, role: 'contributor' | 'admin' = 'contributor') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { userId: me.json<{ data: { id: string } }>().data.id, token };
}
const patch = (token: string, url: string, payload: object) => app.inject({ method: 'PATCH', url: `/api${url}`, headers: { authorization: `Bearer ${token}` }, payload });

type Call = [name: string, args: Record<string, unknown>];
type Tool = { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> };
function scriptedAi(scripts: Call[][]) {
  const inputs: unknown[] = [];
  const runTools = jest.fn(async (req: { tools: Tool[]; input: unknown; onStep?: (s: unknown) => void }) => {
    inputs.push(req.input);
    let step = 0;
    for (const [name, args] of scripts.shift() ?? []) {
      const t = req.tools.find((x) => x.tool.name === name);
      if (t) await t.execute(args, { userId: 'u' });
      req.onStep?.({ step: ++step, response: { usage: { inputTokens: 10, outputTokens: 5 } }, calls: [] });
    }
    return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
  });
  return { ai: { forUser: () => ({ runTools }) } as unknown as AiService, runTools, inputs };
}
const notifier = { finished: jest.fn(), needsYou: jest.fn(), started: jest.fn(), savedLoginUsed: jest.fn(), savedApprovalsUsed: jest.fn(), overBudget: jest.fn() };
function runnerOf(fabric: SecretsFabric, ai: AiService, kgraph = true) {
  const questions = new QuestionsService(prisma, fabric.client, { enqueue: async () => undefined } as never, new QuestionEvents());
  const r = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, notifier as never, questions);
  if (kgraph) {
    r.kgraph = app.get(KgraphEnabledService);
    r.kgraphAfterRun = app.get(KgraphAfterRun);
    r.kgraphStore = app.get(PrismaProcedureStore);
  }
  return r;
}

describe('export and import (#797)', () => {
  let owner: { userId: string; token: string };
  let admin: { token: string };
  beforeAll(async () => {
    admin = await login(`kgtr-admin-${stamp}@example.test`, 'admin');
    owner = await login(`kgtr-owner-${stamp}@example.test`);
    await patch(admin.token, '/system-settings', { kgraph: { enabled: true, auditEvery: 0, pacing: 'fast' } });
    await patch(owner.token, '/user-settings', { kgraph: { enabled: true } });
  });
  afterAll(async () => {
    await patch(admin.token, '/system-settings', { kgraph: { enabled: false, auditEvery: 10 } });
  });
  const req = (method: 'GET' | 'POST' | 'DELETE' | 'PUT', url: string, payload?: object) => app.inject({ method, url: `/api${url}`, headers: { authorization: `Bearer ${owner.token}` }, ...(payload ? { payload } : {}) });
  const CARD = '4111 1111 1111 1111';

  it('round trip: export (no secrets or ids), purge, import, approve, verify; the procedure replays', async () => {
    const db = prisma.forUser({ userId: owner.userId });
    const t = await db.task.create({ data: { userId: owner.userId, name: 'Pens', goal: 'Search the shop for blue pens', confirmRiskyActions: false, allowedDomains: ['shop.example.test'] } });
    await prisma.kgTaskSettings.create({ data: { taskId: t.id, userId: owner.userId, mode: 'reuse' } });
    const store = app.get(PrismaProcedureStore);
    const now = new Date().toISOString();
    await store.putProcedure({ id: `kgp-tr-${t.id}`, owner: owner.userId, task: t.id, name: 'Pens', activeVersion: null, createdAt: now, updatedAt: now });
    await store.putVersion(owner.userId, procedureVersionSchema.parse({ id: `kgv-tr-${t.id}`, procedure: `kgp-tr-${t.id}`, number: 1, state: 'active', changeClass: 'initial', sourceRun: null, parent: null, createdAt: now, entry: 's1', sites: [{ id: 'site:example.test', domain: 'example.test' }], steps: [
      { id: 's1', kind: 'call', label: 'open', tool: 'navigate', commitClass: true, sites: ['site:example.test'], args: { url: { kind: 'literal', value: 'https://shop.example.test/pens' }, reason: { kind: 'literal', value: 'open' } } },
      { id: 's2', kind: 'call', label: 'type', tool: 'type_text', args: { selector: { kind: 'literal', value: '#q' }, text: { kind: 'literal', value: CARD }, submit: { kind: 'literal', value: false } } },
    ] }));

    const exp = await req('GET', '/kgraph/export');
    expect(exp.statusCode).toBe(200);
    expect(exp.headers['content-disposition']).toMatch(/hexactra-kgraph-\d{8}\.json/);
    for (const marker of [CARD, owner.userId, t.id, `kgv-tr-${t.id}`]) expect(exp.body).not.toContain(marker);
    const file = JSON.parse(exp.body);

    expect((await req('DELETE', '/kgraph')).statusCode).toBe(200);
    const imp = await req('POST', '/kgraph/import', { file });
    expect(imp.statusCode).toBe(201);
    const { imported, skipped } = imp.json<{ data: { imported: { taskId: string; versionId: string; reviewId: string }[]; skipped: unknown[] } }>().data;
    expect(skipped).toEqual([]);
    const [one] = imported;
    // A new task in learn mode with the owner's defaults: no allowed sites, no connection, no saved approval from the file.
    const task = await prisma.task.findUniqueOrThrow({ where: { id: one!.taskId } });
    expect(task.allowedDomains).toEqual([]);
    expect(await prisma.taskConnection.count({ where: { taskId: one!.taskId } })).toBe(0);
    expect(await prisma.approvalRule.count({ where: { userId: owner.userId } })).toBe(0);
    expect((await prisma.kgTaskSettings.findUniqueOrThrow({ where: { taskId: one!.taskId } })).mode).toBe('learn');
    expect((await store.getVersion(owner.userId, one!.versionId))).toMatchObject({ state: 'candidate', changeClass: 'sensitive' });

    // Not active, not even chosen, before the owner's approval.
    await prisma.kgTaskSettings.update({ where: { taskId: one!.taskId }, data: { mode: 'reuse' } });
    const before = (await db.run.create({ data: { userId: owner.userId, taskId: one!.taskId, goal: task.goal, inputs: { values: { 'import-1': { value: 'blue pens', source: 'provided', label: 'x' } }, sensitive: [] } } })).id;
    const fBefore = fakeSecretsFabric('https://shop.example.test/start');
    await runnerOf(fBefore, scriptedAi([[['finish', { success: true, result: 'AI.' }]]]).ai).advance(before, owner.userId, null);
    expect(fBefore.actions.filter((a) => a.type === 'navigate')).toHaveLength(0);

    expect((await req('POST', `/kgraph/reviews/${one!.reviewId}/answer`, { approve: true })).statusCode).toBe(200);
    // The verification run asks before the commit-class step; approved, it finishes and the version becomes active.
    const run = (await db.run.create({ data: { userId: owner.userId, taskId: one!.taskId, goal: task.goal, inputs: { values: { 'import-1': { value: 'blue pens', source: 'provided', label: 'x' } }, sensitive: [] } } })).id;
    const f = fakeSecretsFabric('https://shop.example.test/start');
    f.page.inputs = [{ selector: '#q', tag: 'input' }];
    expect(await runnerOf(f, scriptedAi([]).ai).advance(run, owner.userId, null)).toBe('waiting_human');
    f.answer([...f.handoffs.values()][0]!, { value: 'approve' });
    expect(await runnerOf(f, scriptedAi([]).ai).advance(run, owner.userId, null)).toBe('succeeded');
    expect((await store.getVersion(owner.userId, one!.versionId))!.state).toBe('active');
    expect(f.actions.filter((a) => a.type === 'navigate')).toHaveLength(1);
  });

  it('refuses a malformed file, a newer format version and an over-limit file, importing nothing', async () => {
    const tasksBefore = await prisma.task.count({ where: { userId: owner.userId } });
    for (const file of [{ kind: 'nope' }, { kind: 'hexactra.kgraph', formatVersion: 99, exportedAt: 'x', procedures: [] }, { kind: 'hexactra.kgraph', formatVersion: 1, exportedAt: 'x', procedures: Array.from({ length: 51 }, () => ({})) }]) {
      const r = await req('POST', '/kgraph/import', { file });
      expect([r.statusCode, r.json<{ code?: string; error?: { code?: string } }>().code ?? r.json<{ error?: { code?: string } }>().error?.code]).toEqual([400, 'KGRAPH_IMPORT_INVALID']);
    }
    expect(await prisma.task.count({ where: { userId: owner.userId } })).toBe(tasksBefore);
  });
});
