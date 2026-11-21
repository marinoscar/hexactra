// Running a benchmark end to end (E44.3, #741) against a real, migrated database: the service, the `benchmark.advance` job, the run
// starter, the scripted owner and the grader are the application's own; the trial runs are driven by the real goal runner with a
// scripted model and the in-memory fabric of the replay kit (test/replay/fake-fabric.ts). The "browser" is each challenge's solver
// (test/support/benchmark-solvers.ts), making the site's real HTTP calls with `app.inject` while the scripted model holds the run.
//
// The job worker is off for this spec (`JOBS_WORKER_MODE=off`): the spec plays the worker, one pass at a time, which is also how it
// proves that a pass may run twice.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';
import type { Job } from '@marinoscar/platform-api/jobs';

import { BenchmarkGrader } from '../src/benchmark/benchmark-grader';
import { BENCHMARK_ADVANCE_JOB, BenchmarkAdvanceHandler } from '../src/benchmark/benchmark.jobs';
import { BenchmarkQuestionListener } from '../src/benchmark/benchmark-question-listener';
import { BenchmarkRunner } from '../src/benchmark/benchmark-runner.service';
import { BenchmarkSiteAddress } from '../src/benchmark/benchmark-site-address';
import { DEFAULT_BENCHMARK_SETTINGS } from '../src/benchmark/benchmark.settings';
import type { BenchmarkTrialView, BenchmarkView } from '../src/benchmark/benchmarks.schemas';
import { BenchmarksService } from '../src/benchmark/benchmarks.service';
import { hashTrialToken } from '../src/benchmark/site/trial-state.service';
import { SUITE, challengeById } from '../src/benchmark/suite/registry';
import type { OwnerRule } from '../src/benchmark/suite/types';
import { FabricClient, FabricError } from '../src/fabric/fabric.client';
import { createApp } from '../src/main';
import { PolicyResolver } from '../src/policies';
import { PrismaService } from '../src/prisma/prisma.service';
import { QuestionsService } from '../src/questions/questions.service';
import { GoalRunnerService } from '../src/runner/goal-runner.service';
import { TasksService } from '../src/tasks/tasks.service';
import { fakeFabric as kitFakeFabric } from './replay/fake-fabric';
import { createGradedBenchmark } from './support/benchmark-fixtures';
import { SOLVERS, SiteBrowser, type SiteResult, type SiteTransport } from './support/benchmark-solvers';

const SITE_BASE = 'https://bench.example.test/benchmark';
const SITE_HOST = 'bench.example.test';
const HOST_ID = '00000000-0000-4000-8000-0000000000c1';
const stamp = `${Date.now()}`;

let app: NestFastifyApplication;
let prisma: PrismaService;
let service: BenchmarksService;
let handler: BenchmarkAdvanceHandler;
let goal: GoalRunnerService;
let fabric: ReturnType<typeof kitFakeFabric>;
let hosts: Record<string, unknown>[] = [];
const created: string[] = [];

type Call = (name: string, args: Record<string, unknown>) => Promise<string>;
interface Scene {
  trial: { id: string; challengeId: string; policyRef: string; trialIndex: number; seed: string };
  token: string;
  /** 1 for the run's first chunk, 2 for the one after its first answer, and so on. */
  chunk: number;
  runId: string;
  /** The names of the tools the model was offered. */
  tools: string[];
  /** Completes the challenge on the site like a browser would, and returns the answer. */
  solve(): Promise<string>;
}
type Play = (call: Call, scene: Scene) => Promise<void>;

/** Opens the site, completes the challenge and reports the answer. */
const honest: Play = async (call, scene) => {
  await call('navigate', { url: `${SITE_BASE}/t/${scene.token}/`, reason: 'open the site' });
  await call('finish', { success: true, result: await scene.solve() });
};
let play: Play = honest;
const chunks = new Map<string, number>();
const offered = new Map<string, string[]>();

async function send(token: string, method: 'GET' | 'POST', path: string, body?: { form: Record<string, string> } | { json: unknown }): Promise<SiteResult> {
  const res = await app.inject({
    method,
    url: `/api/benchmark-site/t/${token}/${path}`,
    ...(body && 'form' in body ? { headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(body.form).toString() } : {}),
    ...(body && 'json' in body ? { headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body.json) } : {}),
  });
  return { status: res.statusCode, type: String(res.headers['content-type'] ?? ''), body: res.body, location: res.headers.location as string | undefined };
}

/** The scripted model: one `runTools` call is one chunk of a trial run, found by the token in the goal it was given. */
const runTools = async (req: { tools: { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> }[]; onStep?: (s: unknown) => void; input: unknown }) => {
  const token = /\/t\/([A-Za-z0-9_-]{43})/.exec(JSON.stringify(req.input))?.[1];
  if (!token) throw new Error('the scripted model was given a goal without a trial address');
  const trial = await prisma.benchmarkTrial.findUniqueOrThrow({ where: { tokenHash: hashTrialToken(token) } });
  const chunk = (chunks.get(trial.id) ?? 0) + 1;
  chunks.set(trial.id, chunk);
  offered.set(trial.id, req.tools.map((t) => t.tool.name));
  let step = 0;
  const call: Call = async (name, args) => {
    const tool = req.tools.find((t) => t.tool.name === name);
    if (!tool) throw new Error(`the model was not offered ${name}`);
    const out = String(await tool.execute(args, { userId: 'u' }));
    req.onStep?.({ step: ++step, response: { usage: { inputTokens: 100, outputTokens: 10 } }, calls: [] });
    return out;
  };
  const transport: SiteTransport = (method, path, body) => send(token, method, path, body);
  await play(call, { trial, token, chunk, runId: trial.runId!, tools: offered.get(trial.id)!, solve: () => SOLVERS[trial.challengeId]!(new SiteBrowser(transport), trial.seed, { wait: () => undefined }) });
  return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
};

async function login(name: string, role = 'org_admin'): Promise<{ id: string; headers: { authorization: string } }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const headers = { authorization: `Bearer ${token}` };
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers });
  return { id: me.json<{ data: { id: string } }>().data.id, headers };
}

/** One pass of the job, as a worker would run it. */
const pass = (benchmarkId: string) => handler.process({ id: 'job-in-test', payload: { benchmarkId } } as unknown as Job);
const benchmarkRow = (id: string) => prisma.benchmark.findUniqueOrThrow({ where: { id } });
const trialsOf = (id: string) => prisma.benchmarkTrial.findMany({ where: { benchmarkId: id }, orderBy: [{ startedAt: 'asc' }, { id: 'asc' }] });
const isOver = (status: string) => !['queued', 'running'].includes(status);

/** Plays the queue until the benchmark ends: a pass, then one advance of the live trial's run. */
async function drive(benchmarkId: string, userId: string, until: () => Promise<boolean> = async () => false): Promise<void> {
  for (let i = 0; i < 80; i++) {
    await pass(benchmarkId);
    if (await until()) return;
    const live = await prisma.benchmarkTrial.findFirst({ where: { benchmarkId, status: 'running' } });
    if (!live) {
      if (isOver((await benchmarkRow(benchmarkId)).status)) return;
      continue;
    }
    const run = live.runId ? await prisma.run.findUnique({ where: { id: live.runId }, select: { status: true } }) : null;
    if (run && !['succeeded', 'failed', 'cancelled'].includes(run.status)) await goal.advance(live.runId!, userId, null);
  }
  throw new Error(`benchmark ${benchmarkId} did not end`);
}

async function start(user: { id: string }, dto: Partial<Parameters<BenchmarksService['start']>[1]> = {}): Promise<BenchmarkView> {
  const b = await service.start({ id: user.id, activeOrgId: null }, { policies: [{ ref: 'builtin:balanced' }], challengeIds: ['nav-lookup'], trials: 1, profile: `p${created.length}-${stamp.slice(-6)}`, ...dto });
  created.push(b.id);
  return b;
}

/** Gives a challenge of the suite rules for the length of a test. */
function withOwner(challengeId: string, rules: OwnerRule[]): () => void {
  const challenge = challengeById(challengeId)!;
  const before = challenge.owner;
  challenge.owner = () => rules;
  return () => void (challenge.owner = before);
}

const workerMode = process.env.JOBS_WORKER_MODE;

beforeAll(async () => {
  // No worker claims the queued passes and runs behind the spec's back (it would drive them with the real model service).
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  service = app.get(BenchmarksService);
  handler = app.get(BenchmarkAdvanceHandler);

  // The application's fabric client answers from the in-memory fabric, with the two handoff routes the kit leaves to each spec.
  fabric = kitFakeFabric((impl) => jest.fn(impl));
  const client = app.get(FabricClient);
  jest.spyOn(client, 'request').mockImplementation((async (method: string, path: string, opts: { body?: Record<string, unknown> } = {}) => {
    if (method === 'GET' && path === '/v1/hosts') return { hosts };
    const handoff = /^\/v1\/handoffs\/([^/]+)\/(respond|cancel)$/.exec(path);
    if (method === 'POST' && handoff) {
      const h = fabric.handoffs.get(handoff[1]!);
      if (!h || h.status !== 'pending') throw new FabricError('api', 'handoff_resolved', 409, 'handoff_resolved');
      if (handoff[2] === 'cancel') h.status = 'cancelled';
      else Object.assign(h, { status: 'completed', response: { outcome: opts.body!.outcome, value: opts.body!.value, value_withheld: opts.body!.secret !== undefined, channel: opts.body!.channel, by: opts.body!.answered_by, answered_at: new Date().toISOString() } });
      return {};
    }
    return fabric.request(method, path, opts);
  }) as never);
  // A deployment whose nodes reach the console at a public name: the default of a test process is localhost, which is refused.
  jest.spyOn(app.get(BenchmarkSiteAddress), 'settingsNow').mockResolvedValue({ ...DEFAULT_BENCHMARK_SETTINGS, siteBaseUrl: SITE_BASE });

  const notifier = { needsYou: async () => undefined, finished: async () => undefined };
  goal = new GoalRunnerService(prisma, app.get(TasksService), client, { forUser: () => ({ runTools }) } as unknown as AiService, notifier as never, app.get(QuestionsService), undefined, app.get(PolicyResolver));
});
afterEach(() => {
  play = honest;
  hosts = [];
});
afterAll(async () => {
  if (created.length) {
    await prisma.benchmark.updateMany({ where: { id: { in: created }, status: { in: ['queued', 'running'] } }, data: { status: 'cancelled' } });
    await prisma.job.deleteMany({ where: { type: BENCHMARK_ADVANCE_JOB, subjectId: { in: created } } });
    await prisma.benchmark.deleteMany({ where: { id: { in: created } } });
  }
  jest.restoreAllMocks();
  await app?.close();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
});

describe('a benchmark, end to end', () => {
  it('runs two challenges under two policies twice each as ordinary runs, grades every trial from the site, and can be advanced or graded twice', async () => {
    const admin = await login('bench-e2e');
    const outputs: string[] = [];
    // One cell lies: it claims success without doing the work. And the first trial tries to leave the site.
    play = async (call, scene) => {
      if (scene.trial.challengeId === 'nav-lookup' && scene.trial.policyRef === 'builtin:economy' && scene.trial.trialIndex === 1) {
        await call('navigate', { url: `${SITE_BASE}/t/${scene.token}/`, reason: 'open the site' });
        return void (await call('finish', { success: true, result: 'The status is Shipped, Delivered, Pending, Cancelled and Processing.' }));
      }
      if (outputs.length === 0) outputs.push(await call('navigate', { url: 'https://elsewhere.example.test/', reason: 'look elsewhere' }));
      await honest(call, scene);
    };

    const res = await app.inject({ method: 'POST', url: '/api/benchmarks', headers: admin.headers, payload: { name: 'Two by two', challengeIds: ['form-multistep', 'nav-lookup'], policies: [{ ref: 'builtin:economy' }, { ref: 'builtin:balanced', label: 'Standard' }], trials: 2, capUsd: 3, profile: `e2e-${stamp.slice(-6)}` } });
    expect(res.statusCode).toBe(201);
    const started = res.json<{ data: BenchmarkView }>().data;
    created.push(started.id);
    expect(started).toMatchObject({
      name: 'Two by two',
      status: 'queued',
      suiteKey: SUITE.key,
      suiteVersion: SUITE.version,
      // The suite's own order, whatever order the challenges were named in; the label defaults to the policy's name.
      config: { challengeIds: ['nav-lookup', 'form-multistep'], policies: [{ ref: 'builtin:economy', label: 'Economy' }, { ref: 'builtin:balanced', label: 'Standard' }], trials: 2, hostId: null, capUsd: 3, trialTimeoutMinutes: 15 },
      spentUsd: 0,
      progress: { total: 8, pending: 8, running: 0, graded: 0, skipped: 0 },
      commit: null,
    });
    expect(started.appVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect('orgId' in started.config).toBe(false);
    // Nothing ran in the request: the first pass is a queued job.
    expect(await prisma.job.count({ where: { type: BENCHMARK_ADVANCE_JOB, subjectId: started.id, reason: 'benchmark_started' } })).toBe(1);
    expect(await prisma.run.count({ where: { userId: admin.id } })).toBe(0);
    expect(await prisma.auditEvent.findFirst({ where: { action: 'benchmarks.started', targetId: started.id } })).toMatchObject({ actorUserId: admin.id, targetType: 'benchmark', meta: { runs: 8, policies: 2, challenges: 2, trials: 2, capUsd: 3 } });

    await drive(started.id, admin.id);

    const done = (await app.inject({ method: 'GET', url: `/api/benchmarks/${started.id}`, headers: admin.headers })).json<{ data: BenchmarkView }>().data;
    expect(done.status).toBe('completed');
    expect(done.progress).toEqual({ total: 8, pending: 0, running: 0, graded: 8, skipped: 0, pass: 7, fail: 1, error: 0, unsupported: 0 });
    expect(done.startedAt).not.toBeNull();
    expect(done.finishedAt).not.toBeNull();

    const trials = (await app.inject({ method: 'GET', url: `/api/benchmarks/${started.id}/trials`, headers: admin.headers })).json<{ data: { items: BenchmarkTrialView[] } }>().data.items;
    // The policies alternate: attempt by attempt, challenge by challenge, one policy after the other.
    expect(trials.map((t) => `${t.trialIndex} ${t.challengeId} ${t.policyLabel}`)).toEqual([
      '0 nav-lookup Economy', '0 nav-lookup Standard', '0 form-multistep Economy', '0 form-multistep Standard',
      '1 nav-lookup Economy', '1 nav-lookup Standard', '1 form-multistep Economy', '1 form-multistep Standard',
    ]);
    const rows = await trialsOf(started.id);
    expect(rows.map((r) => r.id)).toEqual(trials.map((t) => t.id));
    for (const t of trials) {
      expect(t.status).toBe('graded');
      expect(t.checks!.length).toBeGreaterThan(0);
      expect(t).toMatchObject({ category: challengeById(t.challengeId)!.category, challengeTitle: challengeById(t.challengeId)!.title, stopReason: 'finished', costUsd: 0, questions: 0, escalations: 0 });
      expect(t.steps).toBeGreaterThan(0);
      expect(t.modelCalls).toBeGreaterThan(0);
      expect(t.inputTokens).toBeGreaterThan(0);
      expect(t.durationMs).toBeGreaterThanOrEqual(0);
      expect(t.runId).not.toBeNull();
      expect(Object.keys(t)).not.toEqual(expect.arrayContaining(['seed']));
    }
    // Tokens, cost and the models of each run are on the trial, and summed on the benchmark.
    for (const t of trials) {
      const run = await prisma.run.findUniqueOrThrow({ where: { id: t.runId! } });
      expect([t.inputTokens, t.outputTokens, t.cachedInputTokens, t.modelCalls, t.costUsd, t.costKnown]).toEqual([run.inputTokens, run.outputTokens, run.cachedInputTokens, run.modelCalls, Number(run.costUsd), run.costKnown]);
      const spec = (run.policySnapshot as { spec: { models: { startTier: string; maxTier: string } } }).spec.models;
      expect(t.models).toMatchObject({ startTier: spec.startTier, maxTier: spec.maxTier, finalTier: run.currentTier });
      expect(t.models!.tiers[0]!.tier).toBe(spec.startTier);
      expect(t.model).toBe(t.models!.model);
    }
    const sum = (pick: (t: BenchmarkTrialView) => number | null) => trials.reduce((n, t) => n + (pick(t) ?? 0), 0);
    expect(done.totals).toEqual({ inputTokens: sum((t) => t.inputTokens), outputTokens: sum((t) => t.outputTokens), cachedInputTokens: sum((t) => t.cachedInputTokens), modelCalls: sum((t) => t.modelCalls), costUsd: done.spentUsd, costKnown: trials.every((t) => t.costKnown === true) });
    expect(done.totals.inputTokens).toBeGreaterThan(0);
    expect(started.totals).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, modelCalls: 0, costUsd: 0, costKnown: true });

    // A claimed success with a wrong state is a fail with `claimedSuccess: true`.
    const liar = trials[4]!;
    expect(liar).toMatchObject({ verdict: 'fail', failureReason: 'wrong_result', claimedSuccess: true });
    expect(liar.checks!.some((c) => !c.pass)).toBe(true);
    expect(trials.filter((t) => t !== liar).every((t) => t.verdict === 'pass' && t.failureReason === null && t.claimedSuccess === true && t.checks!.every((c) => c.pass))).toBe(true);
    expect((await app.inject({ method: 'GET', url: `/api/benchmarks/${started.id}/trials?verdict=fail`, headers: admin.headers })).json<{ data: { items: BenchmarkTrialView[] } }>().data.items.map((t) => t.id)).toEqual([liar.id]);

    // Each trial is an ordinary run of the administrator, limited to the challenge site, with nothing of theirs attached.
    const runs = await prisma.run.findMany({ where: { id: { in: trials.map((t) => t.runId!) } } });
    expect(runs).toHaveLength(8);
    for (const run of runs) {
      const trial = rows.find((r) => r.runId === run.id)!;
      expect(run).toMatchObject({ userId: admin.id, trigger: 'benchmark', origin: 'system', taskId: null, conversationId: null, hostId: null, hostFallback: false, policyRef: trial.policyRef, policySource: 'run', appLimits: null, clientId: null });
      expect(run.context).toEqual({ benchmark: { benchmarkId: started.id, trialId: trial.id, allowedDomains: [SITE_HOST], confirmRiskyActions: false } });
      expect(run.goal).toMatch(new RegExp(`^Open ${SITE_BASE}/t/[A-Za-z0-9_-]{43}/`));
      const snapshot = run.policySnapshot as { ref: string; source: string; connections?: unknown; appLimits?: unknown };
      expect(snapshot).toMatchObject({ ref: trial.policyRef, source: 'run' });
      expect(snapshot.connections).toBeUndefined();
      expect([run.usedSavedLogins, run.usedSavedIdentity, run.usedSavedCards, run.memoryIds]).toEqual([null, null, null, []]);
      expect((trial.policySnapshot as { ref: string }).ref).toBe(trial.policyRef);
      // No connection, saved login, identity detail or card was offered to the model.
      expect(offered.get(trial.id)!.filter((n) => /^(mail_|calendar_|docs_|sheet_|connections_list|file_upload|saved_|sign_in_with_saved_login|fill_from_identity|pay_with_saved_card|type_saved_code|propose_saving_login|declare_charge|confirm_charge)/.test(n))).toEqual([]);
      // The site is closed and its token gone; the state stays for the record.
      expect(trial.tokenHash).toBeNull();
      expect(trial.siteState).not.toBeNull();
    }
    // The browser is told the same limit, and the gate refused the page outside it.
    const sessions = (fabric.request as unknown as jest.Mock).mock.calls.filter(([m, p]: unknown[]) => m === 'POST' && p === '/v1/sessions').map(([, , o]: unknown[]) => (o as { body: { allowed_domains?: string[] } }).body);
    expect(sessions.length).toBeGreaterThanOrEqual(8);
    expect(sessions.slice(-8).every((s) => JSON.stringify(s.allowed_domains) === JSON.stringify([SITE_HOST]))).toBe(true);
    expect(outputs[0]).toMatch(/not allowed for this task/);
    expect(fabric.actions.some((a) => String(a.url ?? '').includes('elsewhere.example.test'))).toBe(false);
    // A trial run stays out of the owner's ordinary run list.
    expect((await app.inject({ method: 'GET', url: '/api/runs', headers: admin.headers })).body).not.toContain('"trigger":"benchmark"');
    expect((await app.inject({ method: 'GET', url: '/api/runs?trigger=benchmark&limit=50', headers: admin.headers })).body.match(/"trigger":"benchmark"/g)).toHaveLength(8);

    // Advancing and grading again change nothing.
    const before = JSON.stringify([await benchmarkRow(started.id), await trialsOf(started.id)]);
    await pass(started.id);
    await pass(started.id);
    expect(await app.get(BenchmarkGrader).gradeTrial(rows[0]!.id)).toBe(false);
    await app.get(BenchmarkGrader).onRunEnd(rows[0]!.runId!);
    expect(await app.get(BenchmarkRunner).advance(started.id)).toBe('ended');
    expect(JSON.stringify([await benchmarkRow(started.id), await trialsOf(started.id)])).toBe(before);

    // The list, and who may read it.
    const list = (await app.inject({ method: 'GET', url: '/api/benchmarks', headers: admin.headers })).json<{ data: { items: BenchmarkView[]; total: number } }>().data;
    expect(list.total).toBe(1);
    expect(list.items[0]).toEqual(done);
    const other = await login('bench-other');
    expect((await app.inject({ method: 'GET', url: `/api/benchmarks/${started.id}`, headers: other.headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/benchmarks/${started.id}/trials`, headers: other.headers })).statusCode).toBe(404);
    const member = await login('bench-member', 'contributor');
    expect((await app.inject({ method: 'GET', url: '/api/benchmarks', headers: member.headers })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/benchmarks/suite', headers: member.headers })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/benchmarks', headers: member.headers, payload: { policies: [{ ref: 'builtin:balanced' }] } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/benchmarks' })).statusCode).toBe(401);
  }, 120_000);
});

describe('the scripted owner', () => {
  it('answers a scripted question as the owner and the run continues; a question nobody scripted ends the trial as asked_person; nothing is saved', async () => {
    const admin = await login('bench-owner');
    const restore = withOwner('nav-lookup', [{ kind: 'confirmation', input: 'confirm', match: 'open the customer list', answer: { type: 'approve' } }]);
    try {
      play = async (call, scene) => {
        if (scene.trial.trialIndex === 0) {
          if (scene.chunk === 1) return void (await call('request_human', { kind: 'confirmation', prompt: 'May I open the customer list?', input: 'confirm', choices: null }));
          return honest(call, scene);
        }
        // The same question a second time is a new trial: its rule answers again. Then one nobody scripted.
        if (scene.chunk === 1) return void (await call('request_human', { kind: 'confirmation', prompt: 'May I open the customer list?', input: 'confirm', choices: null }));
        await call('request_human', { kind: 'other', prompt: 'Which customer did you mean?', input: 'text', choices: null });
      };
      const b = await start(admin, { trials: 2 });
      // The listener queues a pass when a trial run asks; it ignores every other run.
      await drive(b.id, admin.id, async () => (await prisma.question.count({ where: { ownerUserId: admin.id } })) > 0);
      expect(await prisma.job.count({ where: { type: BENCHMARK_ADVANCE_JOB, subjectId: b.id, reason: 'benchmark_question' } })).toBe(1);
      expect(await app.get(BenchmarkQuestionListener).asked('00000000-0000-4000-8000-00000000dead')).toBe(false);
      await drive(b.id, admin.id);

      const [first, second] = await trialsOf(b.id);
      expect(first).toMatchObject({ status: 'graded', verdict: 'pass', failureReason: null, questions: 1, claimedSuccess: true });
      expect(second).toMatchObject({ status: 'graded', verdict: 'fail', failureReason: 'asked_person', questions: 2, claimedSuccess: false, stopReason: 'cancelled' });
      expect((await benchmarkRow(b.id)).status).toBe('completed');
      expect(await prisma.run.findUnique({ where: { id: second!.runId! }, select: { status: true, stopReason: true } })).toEqual({ status: 'cancelled', stopReason: 'cancelled' });

      const questions = await prisma.question.findMany({ where: { ownerUserId: admin.id }, orderBy: { createdAt: 'asc' } });
      expect(questions.map((q) => [q.runId === first!.runId ? 1 : 2, q.input, q.status, q.answeredChannel, q.answeredByUserId === admin.id])).toEqual([
        [1, 'confirm', 'answered', 'benchmark', true],
        [2, 'confirm', 'answered', 'benchmark', true],
        [2, 'text', 'cancelled', null, false],
      ]);
      for (const q of questions.slice(0, 2)) {
        const response = q.response as Record<string, unknown>;
        expect(response).toMatchObject({ outcome: 'completed', value: 'approve', channel: 'benchmark', by: `user:${admin.id}` });
        expect(response.ruleId).toBeUndefined();
        expect(response.remember).toBeUndefined();
        expect(response.memoryId).toBeUndefined();
      }
      // The scripted owner created no saved approval, memory, connection or secret, and the runs used none.
      expect(await prisma.approvalRule.count({ where: { userId: admin.id } })).toBe(0);
      expect(await prisma.memory.count({ where: { userId: admin.id } })).toBe(0);
      expect(await prisma.connection.count({ where: { userId: admin.id } })).toBe(0);
      expect(await prisma.secretsConnection.count({ where: { userId: admin.id } })).toBe(0);
      expect(await prisma.secretsActivity.count({ where: { userId: admin.id } })).toBe(0);
      expect(await prisma.auditEvent.count({ where: { actorUserId: admin.id, action: { startsWith: 'approval' } } })).toBe(0);
    } finally {
      restore();
    }
  }, 120_000);

  it('never answers with "remember", even when a rule matches a question that offers it', async () => {
    const admin = await login('bench-remember');
    const answer = jest.spyOn(app.get(QuestionsService), 'answer');
    const restore = withOwner('nav-lookup', [{ input: 'credentials', answer: { type: 'credentials', username: 'person.a', password: 'fixture-pass-1' } }]);
    try {
      play = async (call, scene) => {
        if (scene.chunk === 1) return void (await call('request_human', { kind: 'login', prompt: 'Sign in to the site', input: 'credentials', choices: null, remember_label: 'Keep me signed in' }));
        await honest(call, scene);
      };
      const b = await start(admin);
      await drive(b.id, admin.id);
      expect((await trialsOf(b.id))[0]).toMatchObject({ verdict: 'pass', questions: 1 });
      expect(answer).toHaveBeenCalledTimes(1);
      const [actor, , input, opts] = answer.mock.calls[0]!;
      expect(actor).toEqual({ id: admin.id, activeOrgId: null });
      expect(input).toEqual({ outcome: 'completed', value: 'person.a', secret: 'fixture-pass-1' });
      expect(opts).toEqual({ channel: 'benchmark', rememberAllowed: false });
      // The password went to the fabric only: it is in no row.
      const q = await prisma.question.findFirstOrThrow({ where: { ownerUserId: admin.id } });
      expect(JSON.stringify(q)).not.toContain('fixture-pass-1');
      expect(q.response).toMatchObject({ value: 'person.a', valueWithheld: true });
      expect((q.response as { remember?: boolean }).remember).toBeUndefined();
      expect(JSON.stringify(await prisma.run.findMany({ where: { userId: admin.id } }))).not.toContain('fixture-pass-1');
    } finally {
      restore();
      answer.mockRestore();
    }
  }, 120_000);
});

describe('the spend cap, the timeout, cancel and a node that is down', () => {
  it('starts no new trial once the cap is spent: the rest is skipped with the reason `cap`', async () => {
    const admin = await login('bench-cap');
    play = async (call, scene) => {
      // The run's cost as the runner would have counted it from priced model calls.
      await prisma.run.update({ where: { id: scene.runId }, data: { costUsd: 0.6 } });
      await honest(call, scene);
    };
    const b = await start(admin, { trials: 3, capUsd: 1 });
    await drive(b.id, admin.id);
    const done = await service.get(admin.id, b.id);
    expect(done).toMatchObject({ status: 'completed', spentUsd: 1.2, progress: { total: 3, graded: 2, pass: 2, skipped: 1, pending: 0 } });
    expect((await trialsOf(b.id)).map((t) => [t.status, t.verdict, t.failureReason, t.runId === null])).toEqual(expect.arrayContaining([['skipped', 'skipped', 'cap', true]]));
    expect((await service.trials(admin.id, b.id)).items.map((t) => [t.verdict, t.costUsd])).toEqual([['pass', 0.6], ['pass', 0.6], ['skipped', null]]);
  }, 120_000);

  it('stops a trial that runs past its timeout, fails it as `timeout`, and carries on with the next', async () => {
    const admin = await login('bench-timeout');
    const b = await start(admin, { trials: 2, trialTimeoutMinutes: 5 });
    await pass(b.id);
    const [first] = await prisma.benchmarkTrial.findMany({ where: { benchmarkId: b.id, status: 'running' } });
    expect(first!.runId).not.toBeNull();
    // The pass that closes it was queued for the deadline when it started.
    const recheck = await prisma.job.findFirstOrThrow({ where: { type: BENCHMARK_ADVANCE_JOB, subjectId: b.id, reason: 'benchmark_recheck' } });
    expect(recheck.scheduledFor!.getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
    // Within the time: a pass leaves it alone.
    await pass(b.id);
    expect((await prisma.benchmarkTrial.findUniqueOrThrow({ where: { id: first!.id } })).status).toBe('running');
    // Six minutes later.
    await prisma.benchmarkTrial.update({ where: { id: first!.id }, data: { startedAt: new Date(Date.now() - 6 * 60_000) } });
    await pass(b.id);
    expect(await prisma.benchmarkTrial.findUniqueOrThrow({ where: { id: first!.id } })).toMatchObject({ status: 'graded', verdict: 'fail', failureReason: 'timeout', claimedSuccess: false, tokenHash: null });
    expect(await prisma.run.findUnique({ where: { id: first!.runId! }, select: { status: true, stopReason: true } })).toEqual({ status: 'cancelled', stopReason: 'cancelled' });
    await drive(b.id, admin.id);
    expect(await service.get(admin.id, b.id)).toMatchObject({ status: 'completed', progress: { graded: 2, fail: 1, pass: 1 } });
  }, 120_000);

  it('ends a timed-out run itself when the run does not stop in time', async () => {
    const admin = await login('bench-force');
    const b = await start(admin);
    await pass(b.id);
    const trial = await prisma.benchmarkTrial.findFirstOrThrow({ where: { benchmarkId: b.id, status: 'running' } });
    // A run that says it is running while no job holds it: Stop only sets a flag nobody reads.
    await prisma.run.update({ where: { id: trial.runId! }, data: { status: 'running', startedAt: new Date(), activeSince: new Date() } });
    await prisma.benchmarkTrial.update({ where: { id: trial.id }, data: { startedAt: new Date(Date.now() - 15 * 60_000 - 30_000) } });
    await pass(b.id);
    expect(await prisma.run.findUnique({ where: { id: trial.runId! }, select: { status: true, cancelRequested: true } })).toEqual({ status: 'running', cancelRequested: true });
    expect(await prisma.benchmarkTrial.findUniqueOrThrow({ where: { id: trial.id } })).toMatchObject({ status: 'running', failureReason: 'timeout' });
    // A minute past the deadline.
    await prisma.benchmarkTrial.update({ where: { id: trial.id }, data: { startedAt: new Date(Date.now() - 17 * 60_000) } });
    await pass(b.id);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: trial.runId! } })).status).toBe('cancelled');
    expect(await prisma.benchmarkTrial.findUniqueOrThrow({ where: { id: trial.id } })).toMatchObject({ status: 'graded', verdict: 'fail', failureReason: 'timeout' });
    await pass(b.id);
    expect((await benchmarkRow(b.id)).status).toBe('completed');
  }, 120_000);

  it('cancel stops the live run through the ordinary cancel path, skips the rest, and only then can the benchmark be deleted', async () => {
    const admin = await login('bench-cancel');
    play = async (call) => void (await call('request_human', { kind: 'other', prompt: 'Anyone there?', input: 'text', choices: null }));
    const b = await start(admin, { trials: 3 });
    await pass(b.id);
    const live = await prisma.benchmarkTrial.findFirstOrThrow({ where: { benchmarkId: b.id, status: 'running' } });
    // The run is working (it waits for a person) when Cancel comes in.
    await goal.advance(live.runId!, admin.id, null);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: live.runId! } })).status).toBe('waiting_human');

    expect((await app.inject({ method: 'DELETE', url: `/api/benchmarks/${b.id}`, headers: admin.headers })).statusCode).toBe(409);
    const cancel = jest.spyOn(app.get(TasksService), 'cancel');
    const res = await app.inject({ method: 'POST', url: `/api/benchmarks/${b.id}/cancel`, headers: admin.headers });
    expect(res.statusCode).toBe(200);
    expect(cancel).toHaveBeenCalledWith(admin.id, live.runId);
    cancel.mockRestore();
    expect(res.json<{ data: BenchmarkView }>().data).toMatchObject({ status: 'cancelled', progress: { total: 3, pending: 0, running: 0, graded: 0, skipped: 3 } });
    expect(await prisma.run.findUnique({ where: { id: live.runId! }, select: { status: true, stopReason: true } })).toEqual({ status: 'cancelled', stopReason: 'cancelled' });
    expect((await trialsOf(b.id)).map((t) => [t.status, t.verdict, t.failureReason])).toEqual(Array.from({ length: 3 }, () => ['skipped', 'skipped', 'cancelled']));
    expect(await prisma.run.count({ where: { userId: admin.id } })).toBe(1);
    expect(await prisma.auditEvent.findFirst({ where: { action: 'benchmarks.cancelled', targetId: b.id } })).toMatchObject({ actorUserId: admin.id, meta: { skipped: 2, stopped: 1 } });

    // Cancelling again, and a late pass, change nothing and start nothing.
    expect((await app.inject({ method: 'POST', url: `/api/benchmarks/${b.id}/cancel`, headers: admin.headers })).json<{ data: BenchmarkView }>().data.status).toBe('cancelled');
    await pass(b.id);
    expect(await prisma.run.count({ where: { userId: admin.id } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { action: 'benchmarks.cancelled', targetId: b.id } })).toBe(1);

    expect((await app.inject({ method: 'DELETE', url: `/api/benchmarks/${b.id}`, headers: admin.headers })).statusCode).toBe(204);
    expect(await prisma.benchmark.count({ where: { id: b.id } })).toBe(0);
    expect(await prisma.benchmarkTrial.count({ where: { benchmarkId: b.id } })).toBe(0);
    // Its run stays in the owner's history.
    expect(await prisma.run.count({ where: { id: live.runId! } })).toBe(1);
    expect(await prisma.auditEvent.findFirst({ where: { action: 'benchmarks.deleted', targetId: b.id } })).toMatchObject({ actorUserId: admin.id });
    expect((await app.inject({ method: 'DELETE', url: `/api/benchmarks/${b.id}`, headers: admin.headers })).statusCode).toBe(404);
  }, 120_000);

  it('a node that is down ends each trial as `error`, and three in a row fail the benchmark', async () => {
    const admin = await login('bench-host');
    hosts = [{ id: HOST_ID, name: 'home-node', version: '1', online: false, browser_connected: false, on_demand: false, profiles: [], running_profiles: [], last_seen: new Date().toISOString() }];
    const b = await start(admin, { trials: 5, hostId: HOST_ID });
    await pass(b.id);
    const done = await service.get(admin.id, b.id);
    expect(done).toMatchObject({ status: 'failed', config: { hostId: HOST_ID }, progress: { total: 5, graded: 3, error: 3, skipped: 2, pass: 0, fail: 0 } });
    const items = (await service.trials(admin.id, b.id)).items;
    expect(items.slice(0, 3).map((t) => [t.verdict, t.failureReason, t.checks, t.runId])).toEqual(Array.from({ length: 3 }, () => ['error', 'error', [{ name: 'host', pass: false, detail: 'The node home-node is offline' }], null]));
    expect(items.slice(3).map((t) => [t.status, t.verdict, t.failureReason])).toEqual([['skipped', 'skipped', 'error'], ['skipped', 'skipped', 'error']]);
    expect(await prisma.run.count({ where: { userId: admin.id } })).toBe(0);
  }, 120_000);

  it('a node that comes back is used: one error does not fail the benchmark, and the run is pinned to that node', async () => {
    const admin = await login('bench-host-back');
    hosts = [{ id: HOST_ID, name: 'home-node', version: '1', online: false, browser_connected: false, on_demand: false, profiles: [], running_profiles: [], last_seen: new Date().toISOString() }];
    const b = await start(admin, { trials: 2, hostId: HOST_ID });
    // The first trial finds the node down; before the pass looks again it is back.
    const real = app.get(FabricClient).hosts.bind(app.get(FabricClient));
    const seen = jest.spyOn(app.get(FabricClient), 'hosts').mockImplementation(async () => {
      const now = await real();
      hosts = [{ ...hosts[0], online: true, browser_connected: true }];
      return now;
    });
    await drive(b.id, admin.id);
    seen.mockRestore();
    expect(await service.get(admin.id, b.id)).toMatchObject({ status: 'completed', progress: { graded: 2, error: 1, pass: 1 } });
    const run = await prisma.run.findFirstOrThrow({ where: { userId: admin.id } });
    expect(run).toMatchObject({ hostId: HOST_ID, hostFallback: false });
  }, 120_000);

  it('a grader that throws gives the verdict `error` with its message, and the benchmark continues', async () => {
    const admin = await login('bench-grader');
    const challenge = challengeById('nav-lookup')!;
    const grade = challenge.grade;
    let thrown = false;
    challenge.grade = (input) => {
      if (!thrown) {
        thrown = true;
        throw new Error('the grader broke');
      }
      return grade(input);
    };
    try {
      const b = await start(admin, { trials: 2 });
      await drive(b.id, admin.id);
      expect((await service.trials(admin.id, b.id)).items.map((t) => [t.verdict, t.failureReason, t.checks!.map((c) => c.detail ?? c.pass)])).toEqual([['error', 'error', ['the grader broke']], ['pass', null, expect.anything()]]);
      expect((await benchmarkRow(b.id)).status).toBe('completed');
    } finally {
      challenge.grade = grade;
    }
  }, 120_000);

  it('resumes from the rows after a crash between claiming a trial and creating its run', async () => {
    const admin = await login('bench-crash');
    const b = await start(admin);
    // What a process that died in the middle of a start leaves behind.
    await prisma.benchmark.update({ where: { id: b.id }, data: { status: 'running', startedAt: new Date() } });
    await prisma.benchmarkTrial.updateMany({ where: { benchmarkId: b.id }, data: { status: 'running', startedAt: new Date() } });
    await drive(b.id, admin.id);
    expect(await service.get(admin.id, b.id)).toMatchObject({ status: 'completed', progress: { graded: 1, pass: 1 } });
    expect(await prisma.run.count({ where: { userId: admin.id } })).toBe(1);
  }, 120_000);
});

describe('starting a benchmark', () => {
  it('refuses an unknown challenge, an unassignable or repeated policy, an unknown node and an unreachable site by name, and writes nothing', async () => {
    const admin = await login('bench-refuse');
    const post = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/benchmarks', headers: admin.headers, payload });
    const error = (res: { body: string }) => JSON.parse(res.body) as { code?: string; message?: string; error?: { code?: string; message?: string } };
    const codeOf = (res: { body: string }) => error(res).code ?? error(res).error?.code;
    const messageOf = (res: { body: string }) => error(res).message ?? error(res).error?.message;

    const unknown = await post({ policies: [{ ref: 'builtin:balanced' }], challengeIds: ['nav-lookup', 'nav-nowhere'] });
    expect([unknown.statusCode, codeOf(unknown)]).toEqual([400, 'CHALLENGE_UNKNOWN']);
    expect(messageOf(unknown)).toContain('nav-nowhere');
    const foreign = await post({ policies: [{ ref: 'builtin:balanced' }, { ref: '00000000-0000-4000-8000-00000000abcd' }] });
    expect([foreign.statusCode, codeOf(foreign)]).toEqual([400, 'POLICY_REF_INVALID']);
    expect(messageOf(foreign)).toContain('00000000-0000-4000-8000-00000000abcd');
    const twice = await post({ policies: [{ ref: 'builtin:balanced' }, { ref: 'builtin:balanced', label: 'Again' }] });
    expect([twice.statusCode, codeOf(twice)]).toEqual([400, 'POLICY_DUPLICATE']);
    const node = await post({ policies: [{ ref: 'builtin:balanced' }], hostId: HOST_ID });
    expect([node.statusCode, codeOf(node)]).toEqual([400, 'BENCHMARK_HOST_NOT_FOUND']);
    for (const body of [{ policies: [] }, { policies: [{ ref: 'builtin:balanced' }], trials: 0 }, { policies: [{ ref: 'builtin:balanced' }], context: { benchmark: {} } }, { policies: [{ ref: 'builtin:balanced' }], allowedDomains: ['example.test'] }]) {
      expect((await post(body)).statusCode).toBe(400);
    }
    const address = app.get(BenchmarkSiteAddress);
    const settings = jest.spyOn(address, 'settingsNow').mockResolvedValue({ ...DEFAULT_BENCHMARK_SETTINGS });
    const unreachable = await post({ policies: [{ ref: 'builtin:balanced' }] });
    const suite = (await app.inject({ method: 'GET', url: '/api/benchmarks/suite', headers: admin.headers })).json<{ data: { site: { reachable: boolean; problem: string | null } } }>().data;
    settings.mockResolvedValue({ ...DEFAULT_BENCHMARK_SETTINGS, siteBaseUrl: SITE_BASE });
    expect([unreachable.statusCode, codeOf(unreachable)]).toEqual([400, 'BENCHMARK_SITE_UNREACHABLE']);
    expect(suite.site).toMatchObject({ reachable: false });
    expect(suite.site.problem).toMatch(/cannot reach/);

    expect(await prisma.benchmark.count({ where: { userId: admin.id } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { actorUserId: admin.id, action: 'benchmarks.started' } })).toBe(0);
  });

  it('refuses a second benchmark on the same node and profile with a 409 that names the first, and allows another profile', async () => {
    const admin = await login('bench-seat');
    const profile = `seat-${stamp.slice(-6)}`;
    const first = await start(admin, { profile, name: 'First' });
    const res = await app.inject({ method: 'POST', url: '/api/benchmarks', headers: admin.headers, payload: { policies: [{ ref: 'builtin:economy' }], profile } });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('BENCHMARK_RUNNING');
    expect(res.body).toContain('First');
    // Another administrator is refused too, without the name of a benchmark that is not theirs.
    const other = await login('bench-seat-other');
    const theirs = await app.inject({ method: 'POST', url: '/api/benchmarks', headers: other.headers, payload: { policies: [{ ref: 'builtin:economy' }], profile } });
    expect(theirs.statusCode).toBe(409);
    expect(theirs.body).not.toContain('First');
    expect(theirs.body).not.toContain(first.id);
    const second = await start(admin, { profile: `${profile}-b` });
    expect(second.status).toBe('queued');
    await service.cancel({ id: admin.id }, first.id);
    const third = await start(admin, { profile });
    expect(third.status).toBe('queued');
  });

  it('describes the suite: every challenge with its category, what the agent can attempt, the defaults and the site', async () => {
    const admin = await login('bench-suite');
    const suite = (await app.inject({ method: 'GET', url: '/api/benchmarks/suite', headers: admin.headers })).json<{ data: Awaited<ReturnType<BenchmarksService['suite']>> }>().data;
    expect(suite).toMatchObject({ key: SUITE.key, version: SUITE.version, defaults: { trials: 3, capUsd: 5, trialTimeoutMinutes: 15 }, limits: { maxPolicies: 8, maxTrials: 10 }, site: { baseUrl: SITE_BASE, reachable: true, problem: null } });
    expect(suite.challenges.map((c) => c.id)).toEqual(SUITE.challenges.map((c) => c.id));
    expect(suite.challenges.every((c) => c.supported && c.missing.length === 0)).toBe(true);
    expect(suite.categories.map((c) => c.id)).toContain('navigation');
  });

  it('marks a challenge the agent cannot attempt `unsupported` at the start: it is never run and never failed', async () => {
    const admin = await login('bench-unsupported');
    const challenge = challengeById('nav-spa')!;
    challenge.requires = ['file_upload'];
    try {
      const b = await start(admin, { challengeIds: ['nav-spa', 'nav-lookup'] });
      expect(b.progress).toMatchObject({ total: 2, pending: 1, skipped: 1, unsupported: 1 });
      await drive(b.id, admin.id);
      expect((await service.trials(admin.id, b.id)).items.map((t) => [t.challengeId, t.status, t.verdict, t.failureReason, t.runId === null])).toEqual([['nav-lookup', 'graded', 'pass', null, false], ['nav-spa', 'skipped', 'unsupported', 'unsupported', true]]);
      expect((await benchmarkRow(b.id)).status).toBe('completed');
    } finally {
      delete challenge.requires;
    }
  }, 120_000);
});

describe('no other run can carry a benchmark run\'s limits', () => {
  it('a request that starts a run cannot set its trigger or its context', async () => {
    const user = await login('bench-body', 'contributor');
    const res = await app.inject({ method: 'POST', url: '/api/runs', headers: user.headers, payload: { goal: 'Read the page', trigger: 'benchmark', context: { benchmark: { allowedDomains: ['anything.example.test'], confirmRiskyActions: false } } } });
    const runs = await prisma.run.findMany({ where: { userId: user.id }, select: { trigger: true, context: true } });
    // Either the body is refused, or the fields are dropped: no run of this user is a benchmark run.
    expect([201, 400]).toContain(res.statusCode);
    expect(runs.every((r) => r.trigger !== 'benchmark' && r.context === null)).toBe(true);
    expect(runs).toHaveLength(res.statusCode === 201 ? 1 : 0);
  });

  it('a finished benchmark can be written straight into the database for the specs that read one', async () => {
    const admin = await login('bench-fixture');
    const made = await createGradedBenchmark(prisma, admin.id, { result: (c) => (c.policyRef === 'builtin:economy' && c.trialIndex === 0 ? { verdict: 'fail', claimedSuccess: true } : undefined) });
    created.push(made.id);
    const b = await service.get(admin.id, made.id);
    expect(b).toMatchObject({ status: 'completed', progress: { total: 12, graded: 12, pass: 10, fail: 2 } });
    expect(b.spentUsd).toBeCloseTo(0.12, 6);
    expect(b.totals).toMatchObject({ inputTokens: 144_000, outputTokens: 7_200, cachedInputTokens: 48_000, modelCalls: 48, costKnown: true });
    expect(b.totals.costUsd).toBeCloseTo(0.12, 6);
    expect((await service.trials(admin.id, made.id)).items[0]).toMatchObject({ model: 'fixture:builtin:economy', models: { startTier: 'standard' } });
    expect((await service.trials(admin.id, made.id, { verdict: 'fail' })).items.map((t) => [t.policyRef, t.trialIndex, t.failureReason, t.claimedSuccess])).toEqual([['builtin:economy', 0, 'wrong_result', true], ['builtin:economy', 0, 'wrong_result', true]]);
  });
});
