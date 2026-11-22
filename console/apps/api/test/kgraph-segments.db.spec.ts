// E46.18 (#792) per-segment reuse against a real database (helpers as in kgraph-replay.db.spec.ts). E46.9 (#783) against a real database: a reuse-mode task run replays its procedure inside the ordinary run. Every call goes through
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

describe('per-segment reuse (#792)', () => {
  let owner: { userId: string; token: string };
  let admin: { token: string };
  beforeAll(async () => {
    admin = await login(`kgseg-admin-${stamp}@example.test`, 'admin');
    owner = await login(`kgseg-owner-${stamp}@example.test`);
    await patch(admin.token, '/system-settings', { kgraph: { enabled: true, auditEvery: 0, pacing: 'fast' } });
    await patch(owner.token, '/user-settings', { kgraph: { enabled: true } });
  });
  afterAll(async () => {
    await patch(admin.token, '/system-settings', { kgraph: { enabled: false, auditEvery: 10 } });
  });

  it('a break in segment 2: the agent finishes that part, then segments 3 and 4 replay in the same run', async () => {
    const db = prisma.forUser({ userId: owner.userId });
    const t = await db.task.create({ data: { userId: owner.userId, name: 'Pens', goal: 'Search the shop for blue pens', confirmRiskyActions: false } });
    await prisma.kgTaskSettings.create({ data: { taskId: t.id, userId: owner.userId, mode: 'reuse' } });
    const store = app.get(PrismaProcedureStore);
    const now = new Date().toISOString();
    await store.putProcedure({ id: `kgp-seg-${t.id}`, owner: owner.userId, task: t.id, name: 'Pens', activeVersion: null, createdAt: now, updatedAt: now });
    const click = (id: string, el: string, segment: string) => ({ id, kind: 'call', label: id, tool: 'click', element: el, segment, args: { selector: { kind: 'literal', value: `#${el}` }, reason: { kind: 'literal', value: id } } });
    const steps = [
      { id: 's1', kind: 'call', label: 'open', tool: 'navigate', segment: 'seg1', args: { url: { kind: 'literal', value: 'https://shop.example.test/pens' }, reason: { kind: 'literal', value: 'open' } }, sites: ['site:example.test'] },
      click('s2', 'filters', 'seg2'),
      click('s3', 'blue', 'seg3'),
      click('s4', 'buy-list', 'seg4'),
    ];
    const el = (id: string, label: string) => ({ id, screen: 'sc:1', role: 'button', label, selectors: [`#${id}`] });
    await store.putVersion(owner.userId, procedureVersionSchema.parse({ id: `kgv-seg-${t.id}`, procedure: `kgp-seg-${t.id}`, number: 1, state: 'active', changeClass: 'initial', sourceRun: null, parent: null, createdAt: now, entry: 's1', steps, edges: steps.slice(1).map((s, i) => ({ type: 'then', from: steps[i]!.id, to: s.id })), sites: [{ id: 'site:example.test', domain: 'example.test' }], screens: [{ id: 'sc:1', site: 'site:example.test', label: 'shop' }], elements: [el('filters', 'Filters'), el('blue', 'Blue'), el('buy-list', 'Add to list')] }));
    const run = (await db.run.create({ data: { userId: owner.userId, taskId: t.id, goal: 'Search the shop for blue pens' } })).id;
    const f = fakeSecretsFabric('https://shop.example.test/start');
    // "Filters" is gone (the site moved it into a menu); "Blue" and "Add to list" are there.
    f.surface.push({ selector: '#menu', selectors: ['#menu'], role: 'button', name: 'Menu', tag: 'button', inputType: null, anchor: null }, { selector: '#blue', selectors: ['#blue'], role: 'button', name: 'Blue', tag: 'button', inputType: null, anchor: null }, { selector: '#buy-list', selectors: ['#buy-list'], role: 'button', name: 'Add to list', tag: 'button', inputType: null, anchor: null });
    // Rung 4 asks once (the model names nothing), then the agent opens the menu (segment 2's part) and stops; segment 3 resumes.
    const s = scriptedAi([[], [['click', { selector: '#menu', reason: 'open the filters menu' }]]]);
    expect(await runnerOf(f, s.ai).advance(run, owner.userId, null)).toBe('succeeded');
    expect(f.actions.filter((a) => a.type === 'click').map((a) => a.selector)).toEqual(['#menu', '#blue', '#buy-list']);
    expect(s.runTools).toHaveBeenCalledTimes(2);
    const memory = (await prisma.run.findUniqueOrThrow({ where: { id: run } })).transcript as { kgraphReplay?: { handBacks?: number } };
    expect(memory.kgraphReplay?.handBacks).toBe(1);
  });

  it('a second successful learn run that diverges merges into one candidate with a branch; a same-path run does not', async () => {
    const db = prisma.forUser({ userId: owner.userId });
    const t = await db.task.create({ data: { userId: owner.userId, name: 'Balance', goal: 'Read my balance', confirmRiskyActions: false } });
    await prisma.kgTaskSettings.create({ data: { taskId: t.id, userId: owner.userId, mode: 'learn' } });
    const ev = (runId: string, seq: number, tool: string, url: string | null, selector: string | null, path: string) => ({ userId: owner.userId, runId, seq, tool, family: 'browser', ok: true, outcome: 'ran', bindings: url ? { url: { kind: 'literal', value: url } } : { selector: { kind: 'literal', value: selector } }, post: { host: 'shop.example.test', path } });
    const learnRun = async (trace: (runId: string) => object[]) => {
      const id = (await db.run.create({ data: { userId: owner.userId, taskId: t.id, goal: 'Read my balance', status: 'succeeded' } })).id;
      await prisma.kgTrace.createMany({ data: trace(id) as never });
      return id;
    };
    const compiler = app.get(KgraphCompileService);
    const a = await learnRun((r) => [ev(r, 1, 'navigate', 'https://shop.example.test/account', null, '/account'), ev(r, 2, 'click', null, '#download', '/account')]);
    expect(await compiler.compileRun(owner.userId, a)).toBe('compiled');
    const same = await learnRun((r) => [ev(r, 1, 'navigate', 'https://shop.example.test/account', null, '/account'), ev(r, 2, 'click', null, '#download', '/account')]);
    expect(await compiler.compileRun(owner.userId, same)).toBe('skipped_has_version');
    const b = await learnRun((r) => [ev(r, 1, 'navigate', 'https://shop.example.test/account', null, '/whats-new'), ev(r, 2, 'click', null, '#continue', '/account'), ev(r, 3, 'click', null, '#download', '/account')]);
    expect(await compiler.compileRun(owner.userId, b)).toBe('branched');
    const proc = await app.get(PrismaProcedureStore).findProcedureForTask(owner.userId, t.id);
    const versions = await app.get(PrismaProcedureStore).listVersions(owner.userId, proc!.id);
    expect(versions.map((v) => v.state)).toEqual(['candidate', 'retired']);
    expect(versions[0]!.steps.some((s) => s.kind === 'branch')).toBe(true);
  });
});
