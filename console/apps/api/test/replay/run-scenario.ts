// `runScenario` (E38.6): runs the real chunk loop (`harness/run-loop.ts`) with the browser toolset and its gates over a scenario's fake
// site, to the end, and returns what happened. Each job is built the way the host builds one (a fresh context over the saved memory), so
// a question, a crash, a pause and a hop to a new job are the same steps they are in production. The model is the scenario's script, or
// any `ModelPort` (the live mode gives a real one).
import { ASK_TOPICS } from '../../src/approvals/approval-match';
import { builtinPolicy } from '../../src/policies/builtin-policies';
import { NO_MASKING, type BrowserExt, type BrowserMemory } from '@marinoscar/hexactra-browser-agent/context';
import { ScreenshotWindow } from '@marinoscar/hexactra-browser-agent/context-settings';
import { riskGate, siteGate } from '@marinoscar/hexactra-browser-agent/gates';
import { domainAllowed } from '@marinoscar/hexactra-browser-agent/policy';
import { assembleRoundInput, observeRound, VISION_NOTES } from '@marinoscar/hexactra-browser-agent/round';
import {
  BudgetTracker,
  type BudgetSpec,
  computeEffectiveBudget,
  FIRST_ROUND_HINT,
  GatePipeline,
  readStallState,
  reconcileSteps,
  RunUsage,
  type CheckpointInput,
  type LoopProfile,
  type ModelPort,
  type PolicyPort,
  type Ports,
  type PriceTable,
  type RunOutcome,
  type RunnerTool,
  type StoredStep,
  type Tier,
  type ToolFamily,
} from '@marinoscar/hexactra-agent';
import { createRunContext, runLoop } from '@marinoscar/hexactra-agent/engine';
import { FakeApprovals, FakeRunStore, FakeTelemetry } from '@marinoscar/hexactra-agent/testing';
import { connectionGate } from '../../src/runner/host/gates/connection-gate';
import { DEFAULT_CONNECTION_READ_LIMITS } from '../../src/runner/host/connections/memory';
import { registerRunTools } from '../../src/runner/host/run-tools';
import { mcpToolset } from '../../src/runner/host/tools/connections/mcp';
import { runContextLines, runInstructions } from '../../src/runner/host/toolbox-line';
import { scenarioAccounts, type ScenarioAccounts } from './connections';
import { checkInvariants } from './invariants';
import { OwnerQuestions, OwnerScript, type AskedQuestion } from './owner';
import type { Scenario } from './scenario.schema';
import { evaluate, evaluatePending } from './expectations';
import { newModelRecord, recording, ScriptedScenarioModel, ScriptExhausted, type ModelRecord } from './scripted-model';
import { OwnerSecrets, SiteBrowser } from './site';
import { scenarioWeb, webSiteGate } from './web';

/** The store of a scenario: the fakes' store, plus the run's usage totals and step count that a new job starts from. */
export class ScenarioStore extends FakeRunStore {
  stepCount = 0;
  totals = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, costKnown: true };
  override async checkpoint(input: CheckpointInput): Promise<boolean> {
    const ok = await super.checkpoint(input);
    if (ok) {
      this.totals.modelCalls += input.usage.modelCalls;
      this.totals.inputTokens += input.usage.inputTokens;
      this.totals.outputTokens += input.usage.outputTokens;
      this.totals.costUsd += input.usage.costUsd;
      this.totals.costKnown &&= input.usage.costKnown;
    }
    return ok;
  }
  override async commitStep(input: Parameters<FakeRunStore['commitStep']>[0]): Promise<boolean> {
    const ok = await super.commitStep(input);
    if (ok) this.stepCount = input.stepCount;
    return ok;
  }
}

export interface ScenarioOptions {
  /** The model. Absent: the scenario's script (scripted mode). A real one is the live mode. */
  model?: ModelPort;
  /** What a model call costs, by model served (live mode); without it the cost is unknown. */
  prices?: PriceTable;
  /** The tier the run starts on, over the policy's (live mode picks one). */
  tier?: Tier;
  /** How each tier resolves to a model (live mode: the real resolver). Absent: a label per tier, which a scripted model ignores. */
  routing?: PolicyPort['routing'];
  /** The owner's skills (#1008): the block and `skill_read`, bound as the host binds them (host/skills.ts). Absent: none, as before. */
  skills?: { block: string; tools: readonly RunnerTool<never>[]; family: ToolFamily<never> } | null;
}

export interface ScenarioResult {
  scenario: Scenario;
  mode: 'scripted' | 'live';
  /** How the last job ended; `error` when the harness threw (a script that ran out, a bug). */
  status: RunOutcome | 'error';
  error: string | null;
  finished: { to: string; patch: unknown } | null;
  steps: StoredStep[];
  asked: AskedQuestion[];
  site: SiteBrowser;
  violations: string[];
  /** What differs from `expect`, in words; empty when the scenario passed. */
  failures: string[];
  pass: boolean;
  jobs: number;
  tier: string | null;
  usage: { modelCalls: number; inputTokens: number; outputTokens: number; costUsd: number; costKnown: boolean };
  model: ModelRecord;
  memory: unknown;
  /** Every tool call that went through the wrapper, in order, with its family (E41.1): `refused` when a gate refused it. */
  calls: { tool: string; family: string; outcome: 'ran' | 'refused' }[];
  /** The families offered in any round, and those used, sorted. */
  familiesOffered: string[];
  familiesUsed: string[];
  /** The tools the run could be offered (registered), for naming an unknown tool in `expect`. */
  knownTools: string[];
  /** What the doubles of the owner's accounts received; null without connections. */
  accounts: ScenarioAccounts | null;
  /** The pending expectations that do not hold yet (reported, not failing). */
  pendingFailures: string[];
  /** The calls that reached the fake search provider and page reader (E50.7). */
  webCalls: number;
}

const MAX_JOBS_DEFAULT = 20;

/** Runs one scenario to the end. Never throws for a failed scenario: the result says what failed. */
export async function runScenario(scenario: Scenario, options: ScenarioOptions = {}): Promise<ScenarioResult> {
  const mode: ScenarioResult['mode'] = options.model ? 'live' : 'scripted';
  const spec = builtinPolicy(scenario.policy)!.spec;
  const sabotage = new Set(scenario.harness.sabotage ?? []);
  const owner = { stopPressed: false, pausePressed: false };
  const secrets = new OwnerSecrets();
  const store = new ScenarioStore();
  const telemetry = new FakeTelemetry();
  const approvals = new FakeApprovals();
  approvals.rules = scenario.approvals.map((a, i) => ({ id: `rule-${i + 1}`, host: a.host, category: a.category, label: a.label, summary: `${a.label} on ${a.host}` }));
  const control = { requested: false, pauseRequested: false, abort: new AbortController() };
  // Each job races its loop against its own "the job died" signal; the crash happens once.
  let die: () => void = () => undefined;
  const arm = (): Promise<'crash'> => new Promise<'crash'>((resolve) => (die = () => resolve('crash')));
  let crashed = arm();
  let crashArmed = Boolean(scenario.harness.crash);

  const sites = { allowed: (url: string) => domainAllowed(url, scenario.task.allowedDomains), text: scenario.task.allowedDomains.join(', ') };
  const budget = { ...spec.budget, ...Object.fromEntries(Object.entries(scenario.harness.budget ?? {}).filter(([, v]) => v !== undefined)) } as BudgetSpec & { maxWebCalls?: number | null };
  const site = new SiteBrowser(scenario, {
    allowed: sites.allowed,
    owner,
    secrets,
    afterAction: (n) => {
      if (scenario.harness.stopAfterActions === n) {
        owner.stopPressed = true;
        // `stop_ignored` is a harness that never hears the owner: the kit knows Stop was pressed, the harness is not told.
        if (!sabotage.has('stop_ignored')) control.requested = true;
      }
      if (scenario.harness.pauseAfterActions === n) {
        owner.pausePressed = true;
        if (!sabotage.has('pause_ignored')) control.pauseRequested = true;
      }
    },
    crash: scenario.harness.crash
      ? {
          ...scenario.harness.crash,
          die: () => {
            if (!crashArmed) return Promise.resolve(undefined as never);
            crashArmed = false;
            die();
            // The job is gone: this action never answers.
            return new Promise<never>(() => undefined);
          },
        }
      : null,
  });
  const questions = new OwnerQuestions(() => ({ activations: site.activations.length, actions: site.actions.length }));
  const script = new OwnerScript(scenario.owner, secrets);

  const modelRecord = newModelRecord();
  // One record across the jobs of the run.
  let model: ModelPort = options.model ? recording(options.model, modelRecord) : new ScriptedScenarioModel(scenario.script, modelRecord);
  const newScriptedModel = (chunks: typeof scenario.script): void => void (model = new ScriptedScenarioModel(chunks, modelRecord));

  const effectiveBudget = computeEffectiveBudget(budget, null, scenario.trigger === 'chat' ? 'soft' : 'hard');
  const stall = { ...spec.stall, ...scenario.harness.stall };
  const startTier = options.tier ?? spec.models.startTier;
  const policy: PolicyPort = {
    policy: { ref: scenario.policy, startTier, maxTier: spec.models.maxTier, allowProviderFallback: false, callsPerChunk: Math.min(spec.context.callsPerChunk, 10), stall, effectiveBudget },
    routing: options.routing ?? {
      problem: () => null,
      route: (tier) => ({ label: tier, params: { tier } }),
      fallback: () => null,
      same: () => false,
      hasVision: () => null,
    },
    mask: (text) => text,
  };
  let now = 1_000_000;
  let id = 0;
  const events = { notified: [] as string[] };
  const policyFacts = () => ({ sites: sites.text, confirm: scenario.task.confirmRiskyActions, approvals: approvals.rules.length });
  const policyAtStart = policyFacts();

  // The owner's accounts and MCP servers (E41.1): the real connection tools over doubles, registered as the host registers them.
  const accounts = scenarioAccounts(scenario.connections, scenario.previousJob);
  const web = // Web search (E50.7), bound as the host binds it.
    scenarioWeb(scenario, sites.allowed, budget.maxWebCalls ?? null);
  const registry = registerRunTools<never>({
    web: web ? { tools: web.tools as never, family: web.family as never } : null,
    needsBrowser: scenario.needsBrowser,
    connections: accounts !== null,
    ...(accounts ? await mcpToolset(accounts.deps, 'user-1', accounts.list).then((m) => ({ mcp: m.tools as unknown as RunnerTool<never>[], mcpFamilies: m.families as never })) : { mcp: [] }),
    skills: options.skills ?? null,
  });
  // `gates_off` replaces both gates with ones that allow everything, as a broken change to them would.
  const openGates = [
    { name: 'site', check: async () => ({ kind: 'allow' as const }) },
    { name: 'risk', check: async () => ({ kind: 'allow' as const, data: { target: null, rule: null } }) },
  ];
  const pipeline = new GatePipeline<never>((sabotage.has('gates_off') ? [...openGates, { name: 'connection', check: async () => ({ kind: 'allow' as const }) }] : [siteGate, riskGate, connectionGate, ...(web ? [webSiteGate] : [])]) as never[]);

  const buildJob = async (memory: BrowserMemory) => {
    const stallState = (memory.stall = readStallState(memory.stall));
    const ports: Ports = {
      model,
      store,
      questions,
      control: {
        get requested() {
          return control.requested;
        },
        get pauseRequested() {
          return control.pauseRequested && !control.requested;
        },
        abortSignal: control.abort.signal,
        haltSignal: control.abort.signal,
        readFlags: async () => ({ cancelRequested: control.requested, pauseRequested: control.pauseRequested }),
      },
      policy,
      events: {
        step: () => undefined,
        tokens: () => undefined,
        modelCalls: () => undefined,
        inputTokensPerCall: () => undefined,
        recovered: () => undefined,
        stepRecorded: async () => undefined,
        overBudget: async () => undefined,
        needsYou: async (ask) => void events.notified.push(ask.prompt),
      },
      telemetry,
      clock: { now: () => (now += 10) },
      ids: { uuid: () => `id-${(id += 1)}` },
      approvals,
    };
    const ext: BrowserExt = {
      browser: site,
      sites,
      state: { labels: new Map(), marks: new Map(), view: null },
      shotWindow: new ScreenshotWindow(scenario.vision ? 2 : 0, 5),
      observationChars: 4_000,
      settleDelaysMs: [0, 0, 0, 0],
      confirmRisky: () => scenario.task.confirmRiskyActions,
      sensitiveParams: () => [],
      masking: NO_MASKING,
      hooks: {},
      outputs: null,
      // What the connection tools read from the host's context (E41.1): the doubles, the run's list and its read caps.
      ...(accounts
        ? {
            d: accounts.deps,
            connections: { list: accounts.list, needsBrowser: scenario.needsBrowser, lazyBrowser: false, limits: DEFAULT_CONNECTION_READ_LIMITS },
          }
        : {}),
      ...(web ? { web: web.ext } : {}),
    } as BrowserExt;
    const newest = await store.newestSeq();
    const ctx = createRunContext<BrowserMemory, BrowserExt>({
      run: { id: 'run-1', userId: 'user-1', orgId: null, goal: scenario.goal, trigger: scenario.trigger, taskId: null, conversationId: scenario.trigger === 'chat' ? 'chat-1' : null },
      ports,
      memory,
      state: { stepCount: store.stepCount, seq: Math.max(store.stepCount, newest), stall: null, stop: null, budgetKey: null, finished: null, wrappingUp: false, handoffId: null, handoffExpiresAt: null, handoffAsk: null },
      tracker: new BudgetTracker(effectiveBudget, {
        actions: store.stepCount,
        modelCalls: store.totals.modelCalls,
        inputTokens: store.totals.inputTokens,
        outputTokens: store.totals.outputTokens,
        costUsd: store.totals.costUsd,
        costKnown: store.totals.costKnown,
        warned: memory.warned,
        overNoticed: memory.overNoticed,
      }),
      stall: stallState,
      tier: memory.tier ?? startTier,
      startTier,
      active: { activeMs: 0, activeSince: null },
      usage: new RunUsage(),
      prices: options.prices ?? {},
      hopAfterMs: 10 * 60_000,
      startedAt: now,
      ext,
    });
    memory.tier = ctx.tier;
    const profile: LoopProfile<typeof ctx> = {
      // What a run reads, built as the host builds it (E41.2): the families offered, the toolbox line, the family-neutral first hint.
      instructions: runInstructions(registry, ctx as never, ASK_TOPICS),
      registry: registry as never,
      pipeline: pipeline as never,
      visionNotes: VISION_NOTES,
      observe: (c) => observeRound(c as never),
      assembleInput: assembleRoundInput,
      contextLines: (c) => runContextLines(registry, c as never),
      firstRoundHint: () => FIRST_ROUND_HINT,
      summarizeGuidance: (note) => note,
      aboutOwner: options.skills?.block ?? '',
    };
    return { ctx, profile };
  };

  let memory: BrowserMemory = { log: [], chunks: 0, ...(scenario.vision ? {} : { visionOff: true }), ...(scenario.context ? { context: scenario.context } : {}) };
  let status: ScenarioResult['status'] = 'error';
  let error: string | null = null;
  let jobs = 0;
  let lastCtxMemory: BrowserMemory = memory;
  let recovering = false;
  const maxJobs = scenario.harness.maxJobs ?? MAX_JOBS_DEFAULT;

  try {
    while (jobs < maxJobs) {
      jobs += 1;
      if (recovering) {
        // A retried job (E38.3): the step rows are the truth. Saved at once, as the host does.
        const rec = await reconcileSteps(store, { memory, stepCount: store.stepCount, interrupted: true });
        store.stepCount += rec.appended;
        await store.saveMemory(memory);
        recovering = false;
      }
      const { ctx, profile } = await buildJob(memory);
      lastCtxMemory = ctx.memory;
      const outcome = await Promise.race([runLoop(ctx as never, profile as never), crashed]);
      memory = ctx.memory;
      lastCtxMemory = memory;
      if (outcome === 'crash') {
        // The job died around a click: a new job starts from what was saved, on the script written for it.
        memory = structuredClone(store.memory ?? { log: [], chunks: 0 }) as BrowserMemory;
        crashed = arm();
        recovering = true;
        if (!options.model) newScriptedModel(scenario.harness.scriptAfterCrash ?? []);
        continue;
      }
      status = outcome;
      if (outcome === 'waiting_human') {
        const q = questions.pending;
        if (!q || !script.answer(q, memory)) break;
        continue;
      }
      if (outcome === 'paused' && scenario.harness.resumeAfterPause) {
        owner.pausePressed = false;
        control.pauseRequested = false;
        memory.log.push('The owner paused the run and resumed it. Look at the page again before acting.');
        memory.look = 'page';
        if (!options.model) newScriptedModel(scenario.harness.scriptAfterPause ?? []);
        continue;
      }
      if (outcome === 'continue') continue;
      break;
    }
  } catch (e) {
    status = 'error';
    error = e instanceof ScriptExhausted ? `${e.message}: the scenario needs a finish, or fewer steps than the agent took` : e instanceof Error ? e.message : String(e);
  }
  if (status === 'error' && !error) error = `the run did not end within ${maxJobs} jobs`;

  const steps = store.rows();
  const facts = {
    scenario,
    site,
    asked: questions.asked,
    steps,
    memory: store.memory ?? lastCtxMemory,
    model: modelRecord,
    spans: telemetry.calls,
    policyAtStart,
    policyAtEnd: policyFacts(),
    ownerSecrets: scenario.owner.flatMap((r) => [r.answer === 'secret' ? r.value : undefined, r.password]).filter((s): s is string => typeof s === 'string'),
  };
  const violations = checkInvariants(facts);
  const result: ScenarioResult = {
    scenario,
    mode,
    status,
    error,
    finished: store.finished,
    steps,
    asked: questions.asked,
    site,
    violations,
    failures: [],
    pass: false,
    jobs,
    tier: store.tier?.tier ?? startTier,
    usage: { ...store.totals },
    model: modelRecord,
    memory: facts.memory,
    calls: telemetry.families.map((c) => ({ ...c, family: c.family.replace(/^mcp:conn-/, 'mcp:') })),
    familiesOffered: [...new Set(telemetry.offered.flat().map((f) => f.replace(/^mcp:conn-/, 'mcp:')))].sort(),
    familiesUsed: [],
    knownTools: registry.all().map((t) => t.name),
    accounts,
    pendingFailures: [],
    webCalls: web ? web.search.calls.length + web.fetch.calls.length : 0,
  };
  result.familiesUsed = [...new Set(result.calls.map((c) => c.family))].sort();
  result.failures = evaluate(result);
  result.pendingFailures = evaluatePending(result);
  result.pass = result.failures.length === 0;
  return result;
}
