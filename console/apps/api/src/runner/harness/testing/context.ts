// A RunContext over the fakes, and a scripted goal that runs to completion with nothing but the harness (E38.5): the proof that the generic
// layer needs no browser, no database and no model.
import { BudgetTracker } from '../budget';
import { RunUsage } from '../cost';
import { createRunContext } from '../create-context';
import { GatePipeline, type Gate } from '../gate-pipeline';
import type { LoopProfile } from '../loop-profile';
import { NO_OBSERVATION } from '../loop-profile';
import type { Ports, PolicyPort } from '../ports';
import { ToolRegistry } from '../registry';
import type { AnyContext, RunContext } from '../run-context';
import { newStallState } from '../stall';
import type { RunnerTool } from '../tool-def';
import type { HarnessMemory } from '../types';
import { FakeApprovals, FakeControl, FakeQuestions, FakeRunStore, FakeTelemetry, ScriptedModel, UNLIMITED } from './fakes';

export interface FakeRunOptions<X> {
  ext?: X;
  memory?: Partial<HarnessMemory>;
  policy?: Partial<PolicyPort['policy']>;
  model?: ScriptedModel;
  approvals?: FakeApprovals | null;
  /** Time, in ms, that the clock advances at each call. */
  clockStep?: number;
}

export interface FakeRun<X> {
  ctx: RunContext<HarnessMemory, X>;
  store: FakeRunStore;
  control: FakeControl;
  questions: FakeQuestions;
  telemetry: FakeTelemetry;
  model: ScriptedModel;
  approvals: FakeApprovals | null;
  events: { notified: string[]; steps: string[] };
}

export function fakeRun<X = Record<string, never>>(options: FakeRunOptions<X> = {}): FakeRun<X> {
  const store = new FakeRunStore();
  const control = new FakeControl();
  const questions = new FakeQuestions();
  const telemetry = new FakeTelemetry();
  const model = options.model ?? new ScriptedModel([]);
  const approvals = options.approvals === undefined ? new FakeApprovals() : options.approvals;
  const events = { notified: [] as string[], steps: [] as string[] };
  let now = 1_000_000;
  const policy: PolicyPort = {
    policy: { ref: 'fake', startTier: 'standard', maxTier: 'frontier', allowProviderFallback: true, callsPerChunk: 10, stall: { maxConsecutiveFailures: 5, maxRepeatedAction: 4, noProgressActions: 12, onStall: 'nudge_then_escalate', maxEscalations: 2 }, effectiveBudget: UNLIMITED, ...options.policy },
    routing: {
      problem: () => null,
      route: (tier) => ({ label: tier, params: { model: `fake-${tier}` } }),
      fallback: () => null,
      same: () => false,
      hasVision: () => null,
    },
    mask: (text) => text,
  };
  const ports: Ports = {
    model,
    store,
    questions,
    control,
    policy,
    events: {
      step: (kind, ok) => void events.steps.push(`${kind}:${ok}`),
      tokens: () => undefined,
      modelCalls: () => undefined,
      inputTokensPerCall: () => undefined,
      recovered: () => undefined,
      stepRecorded: async () => undefined,
      overBudget: async () => undefined,
      needsYou: async (ask) => void events.notified.push(ask.prompt),
    },
    telemetry,
    clock: { now: () => (now += options.clockStep ?? 0) },
    ids: { uuid: () => `id-${now++}` },
    ...(approvals ? { approvals } : {}),
  };
  const memory: HarnessMemory = { log: [], chunks: 0, ...options.memory };
  const ctx = createRunContext<HarnessMemory, X>({
    run: { id: 'run-1', userId: 'user-1', orgId: null, goal: 'Do the thing', trigger: null, taskId: null, conversationId: null },
    ports,
    memory,
    state: { stepCount: 0, seq: 0, stall: null, stop: null, budgetKey: null, finished: null, handoffId: null, handoffExpiresAt: null, handoffAsk: null },
    tracker: new BudgetTracker(options.policy?.effectiveBudget ?? UNLIMITED, {}),
    stall: newStallState(),
    tier: 'standard',
    startTier: 'standard',
    active: { activeMs: 0, activeSince: null },
    usage: new RunUsage(),
    prices: {},
    hopAfterMs: 10 * 60_000,
    startedAt: now,
    ext: (options.ext ?? {}) as X,
  });
  return { ctx, store, control, questions, telemetry, model, approvals, events };
}

/** A loop profile with no screens: the tools given, the gates given, and instructions of its own. */
export function textProfile<C extends AnyContext>(tools: RunnerTool<C>[], gates: Gate<C>[] = [], instructions = 'You are a test agent.'): LoopProfile<C> {
  return {
    instructions,
    registry: new ToolRegistry<C>().registerAll(tools),
    pipeline: new GatePipeline<C>(gates),
    visionNotes: { byTier: '(No images.)', refused: '(No images.)' },
    observe: async () => NO_OBSERVATION,
    assembleInput: (text, _observation, status) => `${text}\n\n${status}`,
    contextLines: () => [],
    summarizeGuidance: (note) => `The owner added: ${note}`,
    aboutOwner: '',
  };
}
