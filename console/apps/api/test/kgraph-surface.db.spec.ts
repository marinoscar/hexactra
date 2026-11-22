// E46.13 (#787) the surface graph end to end, against a real database (helpers as in kgraph-replay.db.spec.ts). E46.9 (#783) against a real database: a reuse-mode task run replays its procedure inside the ordinary run. Every call goes through
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

describe('the surface graph (#787)', () => {
  let owner: { userId: string; token: string };
  let admin: { token: string };
  beforeAll(async () => {
    admin = await login(`kgsur-admin-${stamp}@example.test`, 'admin');
    owner = await login(`kgsur-owner-${stamp}@example.test`);
    await patch(admin.token, '/system-settings', { kgraph: { enabled: true, auditEvery: 0 } });
    await patch(owner.token, '/user-settings', { kgraph: { enabled: true } });
  });
  afterAll(async () => {
    await patch(admin.token, '/system-settings', { kgraph: { enabled: false, auditEvery: 10 } });
  });
  const go = { selector: '#go', selectors: ['#go', 'form > button:nth-child(2)'], role: 'button', name: 'Search', tag: 'button', inputType: 'submit', anchor: 'Find pens' };
  const fabricWith = (els: Record<string, unknown>[]) => {
    const f = fakeSecretsFabric('https://shop.example.test/start');
    f.page.inputs = [{ selector: '#q', tag: 'input' }, { selector: '#go', tag: 'button' }];
    f.surface.push(...els);
    return f;
  };

  it('learns a click as an element and replays it after the element id changed; two look-alikes hand over', async () => {
    const db = prisma.forUser({ userId: owner.userId });
    const t = await db.task.create({ data: { userId: owner.userId, name: 'Pens', goal: 'Search the shop for blue pens', confirmRiskyActions: false } });
    await prisma.kgTaskSettings.create({ data: { taskId: t.id, userId: owner.userId, mode: 'learn' } });
    const first = (await db.run.create({ data: { userId: owner.userId, taskId: t.id, goal: 'Search the shop for blue pens' } })).id;
    const learn = scriptedAi([[['navigate', { url: 'https://shop.example.test/pens', reason: 'open' }], ['click', { selector: '#go', reason: 'search' }], ['finish', { success: true, result: 'Found.' }]]]);
    expect(await runnerOf(fabricWith([go]), learn.ai).advance(first, owner.userId, null)).toBe('succeeded');
    const trace = await prisma.kgTrace.findFirstOrThrow({ where: { runId: first, tool: 'click' } });
    expect((trace.post as { element?: unknown }).element).toMatchObject({ role: 'button', name: 'Search', anchor: 'Find pens' });
    expect(await prisma.kgNode.count({ where: { userId: owner.userId, type: 'Element' } })).toBeGreaterThanOrEqual(1);
    expect(await app.get(KgraphCompileService).compileRun(owner.userId, first)).toBe('compiled');
    await prisma.kgTaskSettings.update({ where: { taskId: t.id }, data: { mode: 'reuse' } });

    // The site changed the button's id and its place; its role, name and anchor are the same.
    const second = (await db.run.create({ data: { userId: owner.userId, taskId: t.id, goal: 'Search the shop for blue pens' } })).id;
    const f2 = fabricWith([{ ...go, selector: '#search-2026', selectors: ['#search-2026', 'div > button:nth-child(5)'] }]);
    const s2 = scriptedAi([]);
    expect(await runnerOf(f2, s2.ai).advance(second, owner.userId, null)).toBe('succeeded');
    expect(s2.runTools).not.toHaveBeenCalled();
    expect(f2.actions.filter((a) => a.type === 'click').map((a) => a.selector)).toEqual(['#search-2026']);
    expect(f2.actions.filter((a) => a.type === 'navigate')).toHaveLength(1);

    // Two equally good buttons: nothing is clicked by the procedure; the agent takes over.
    const third = (await db.run.create({ data: { userId: owner.userId, taskId: t.id, goal: 'Search the shop for blue pens' } })).id;
    const f3 = fabricWith([{ ...go, selector: '#a', selectors: ['#a'] }, { ...go, selector: '#b', selectors: ['#b'] }]);
    const s3 = scriptedAi([[['finish', { success: true, result: 'Agent.' }]]]);
    await runnerOf(f3, s3.ai).advance(third, owner.userId, null);
    expect(f3.actions.filter((a) => a.type === 'click')).toHaveLength(0);
    expect(JSON.stringify(s3.inputs[0])).toContain('did not match');
  });
});
