import { Injectable, Logger, Optional } from '@nestjs/common';
import { AiError, AiService, defineTool, type AiDefinedTool, type AiToolLoopResult } from '@marinoscar/platform-api/ai';
import { Prisma } from '@prisma/client';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

import { FabricClient, FabricError } from '../fabric/fabric.client';
import { chooseHost } from './host-choice';
import { balancedSpec, builtinPolicy, SYSTEM_DEFAULT_POLICY_REF } from '../policies/builtin-policies';
import { PolicyModelCheck } from '../policies/policy-model-check';
import { ModelTiersService } from '../policies/model-tiers.service';
import { fallbackRequest, sameTierRequest, tierHasVision, tierProblem, tierRequest, type TierRequest } from './tier-request';
import { tierRank, TIERS, type Tier } from '../policies/agent-policy.schema';
import {
  clearStallEvidence,
  DE_ESCALATE_AFTER,
  decideStall,
  digest,
  lastActions,
  MAX_IDLE_CHUNKS,
  MAX_STALL_HANDOFFS,
  newStallState,
  nudgeText,
  observeAction,
  observePage,
  readStallState,
  resetStall,
  stallHandoffPrompt,
  stallWrapUpInstruction,
  type ActionObservation,
  type PageState,
  type StallResponse,
  type StallSignal,
  type StallState,
} from './stall';
import { PolicyResolver } from '../policies/policy.resolver';
import { readAppLimits, readSnapshot, type RunPolicySnapshot } from '../policies/policy-snapshot';
import { PrismaService } from '../prisma/prisma.service';
import { questionSpecSchema, type QuestionConstraints, type QuestionInputType, type QuestionOption, type QuestionResponse, type QuestionSpec } from '../questions/questions.contract';
import { QuestionsService } from '../questions/questions.service';
import { redactActionArgs, redactUrl } from '../tasks/redact';
import { RunNotifier } from '../tasks/run-notifier';
import { TasksService } from '../tasks/tasks.service';
import { BROWSER_AGENT_FEATURE_ID } from './browser-agent.feature';
import { priceTableOf } from './agent-pricing.settings';
import { RunUsage, type PriceTable, type UsageDelta } from './cost';
import { activeElapsedMs } from './active-time';
import { GOAL_RUN_HOP_MARGIN_MS, GOAL_RUN_MAX_RUNTIME_MS } from './goal-run.enqueue';
import { BUDGET_ERROR } from './run-budget-errors';
import {
  BUDGET_LABEL,
  BUDGET_STOP_REASON,
  BudgetTracker,
  computeEffectiveBudget,
  isUnlimited,
  UNLIMITED_LOG_LINE,
  usedOfLimit,
  warningLine,
  wrapUpInstruction,
  type BudgetCeilings,
  type BudgetKey,
  type RunStopReason,
} from './budget';
import { actionTarget, runActivity, type ActivityTarget, type RunActivityPhase } from './activity';
import { ACTION_TIMEOUT_MS, FabricSession, handoffOutcome, type CreatedHandoff } from './fabric-session';
import { domainAllowed, looksRisky } from './policy';
import { maxElementsFor, PLATFORM_MAX_CALLS_PER_CHUNK, ScreenshotWindow, shotHash } from './context-settings';
import { captureScreen, markCenter, roundInput, type Screen, type ScreenMark, type ScreenView } from './vision';

/** Lines of the step log handed back to the model each chunk. */
const LOG_LINES = 60;
/** Output cap of the wrap-up call (#404): a summary, not a continuation. */
const WRAP_UP_MAX_OUTPUT_TOKENS = 1_500;
/** AI error codes that send a chunk to the tier's fallback model (#405). */
const FALLBACK_CODES: ReadonlySet<string> = new Set(['AI_PROVIDER_UNAVAILABLE', 'AI_RATE_LIMITED', 'AI_MODEL_NOT_REACHABLE']);
/** What a tier is called in the text a person reads. */
const TIER_LABEL: Record<Tier, string> = { fast: 'Fast', standard: 'Standard', frontier: 'Frontier' };

/** What the run keeps between chunks and across a handoff (`runs.transcript`). Never secrets. */
export interface RunMemory {
  log: string[];
  /** A secret handoff whose value `type_handoff_secret` may type (once). */
  secretHandoffId?: string | null;
  /** A person approved one risky action. */
  confirmationGranted?: boolean;
  chunks: number;
  /** The provider refused images: the run continues without screenshots (#366). */
  visionOff?: boolean;
  /** The screen the next round shows the model (default: the page). */
  look?: Screen | null;
  /** Digests of the screenshots last shown to the model (never the images, #406). */
  shots?: string[];
  /** Budgets already warned about (#404): each is warned once per run, across jobs. */
  warned?: BudgetKey[];
  /** Warning lines the next round's input carries (#404). */
  pendingWarnings?: string[];
  /** The tier the run is on (#405); absent until the first advance. */
  tier?: Tier;
  /** Tier escalations so far (#405). */
  escalations?: number;
  /** The stall detector's state (#405): digests and normalised selectors only, never typed text or secrets. */
  stall?: StallState;
  /** Stalls since the run last escalated (or started): the first is nudged. */
  stallsHere?: number;
  /** Times a stall asked a person. */
  stallHandoffs?: number;
  /** Successful, progressing actions in a row (for de-escalation). */
  progressStreak?: number;
  /** The nudge the next round's input carries. */
  pendingNudge?: string;
  /** Why the run is on a stronger tier, while it is (the activity shows it). */
  tierNote?: string | null;
  /** `visionOff` was set because the tier's model has no vision (not because a call refused images). */
  visionOffByTier?: boolean;
}

/** `continue`: the job is near its runtime limit; the handler queues a new job and the run stays `running`. */
export type RunOutcome = 'succeeded' | 'failed' | 'cancelled' | 'waiting_human' | 'requeue' | 'continue';

/** Ends a chunk early: the loop is stopped from `onStep`. */
class StopLoop extends Error {
  constructor(readonly reason: 'finish' | 'pause' | 'cancel' | 'budget' | 'look' | 'hop' | 'warn' | 'escalate' | 'stall') {
    super(reason);
  }
}

const INSTRUCTIONS = `You are the user's hands and eyes on their own computer. You operate a real Chrome browser, and the desktop it runs on, to reach their goal the way a skilled person sitting at the machine would. You act with the user's full authority.

How to see:
- A round may start with a screenshot of the page, with interactive elements boxed and numbered, and their positions listed. Use it to understand the layout, what is visible, and what changed.
- observe_elements lists interactive elements with CSS selectors; read_text reads the page text. Use them for exact targets and content.
- look takes a fresh screenshot (screen "desktop" shows the whole computer screen). It ends your turn; the next turn starts with the image.

How to act (choose what works, as a person would):
- By element: click and type_text with selectors, or click_mark with a number from the screenshot.
- By position, with real mouse and keyboard events: click_at, hover_at, drag, scroll_at, type_keys, key. Use them for canvas, custom widgets, hover menus, sliders, drag and drop, and whenever a selector click does nothing.
- run_javascript runs any JavaScript in the page and returns its value: read state, fill complex forms, call the page's own functions, or get past a stubborn widget.
- Tabs: tabs, switch_tab, new_tab. navigate opens any URL.
- Outside the page (native file pickers, OS dialogs, permission prompts, other windows): look at the desktop, then desktop_click, desktop_type, desktop_key, desktop_scroll, desktop_drag.
- Check the result of each action before the next one. If something does not work, try another way before giving up.

When you need the person:
- Only for what only they have: a code sent to their phone or email, a passkey or security-key touch, a password you were not given, or a CAPTCHA puzzle you cannot pass (tick an "I am not a robot" box yourself, as a person would). Call request_human. For a code or password they give you, call type_handoff_secret: you never see secret values.
- If a click is refused because the task asks for confirmation before purchases, call request_human with kind "confirmation", then try again.

When done, or when the goal is impossible, call finish with a short, factual result.`;

function trim(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** The model's `request_human` arguments (snake_case, nulls for what does not apply). */
export interface RequestHumanArgs {
  kind: string;
  prompt: string;
  input: string;
  choices?: string[] | null;
  options?: { id: string; label: string; description?: string | null }[] | null;
  constraints?: Partial<Record<'max_length' | 'pattern' | 'multiline' | 'min' | 'max' | 'step' | 'unit' | 'min_selections' | 'max_selections', unknown>> | null;
  confirm_label?: string | null;
  deny_label?: string | null;
  risk?: 'low' | 'high' | null;
}

const CONSTRAINT_FROM_MODEL = {
  max_length: 'maxLength',
  pattern: 'pattern',
  multiline: 'multiline',
  min: 'min',
  max: 'max',
  step: 'step',
  unit: 'unit',
  min_selections: 'minSelections',
  max_selections: 'maxSelections',
} as const;

/** The model's `request_human` arguments as the console's question contract (camelCase, nulls dropped), ready to validate. */
export function requestHumanSpec(a: RequestHumanArgs): Record<string, unknown> {
  const options = a.options?.length
    ? a.options.map((o) => ({ id: o.id, label: o.label, ...(o.description ? { description: o.description } : {}) }))
    : a.choices?.length
      ? a.choices.map((c) => c.slice(0, 100))
      : undefined;
  const constraints: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a.constraints ?? {})) {
    const key = CONSTRAINT_FROM_MODEL[k as keyof typeof CONSTRAINT_FROM_MODEL];
    if (key && v !== null && v !== undefined) constraints[key] = v;
  }
  return {
    kind: a.kind,
    prompt: a.prompt,
    input: a.input,
    ...(options && (a.input === 'choice' || a.input === 'multi_choice') ? { options } : {}),
    ...(Object.keys(constraints).length ? { constraints } : {}),
    ...(a.input === 'confirm' && a.confirm_label ? { confirmLabel: a.confirm_label } : {}),
    ...(a.input === 'confirm' && a.deny_label ? { denyLabel: a.deny_label } : {}),
    ...(a.input === 'confirm' && a.risk ? { risk: a.risk } : {}),
  };
}

/** What the model reads after a person answered (never a secret). */
export function answerLine(a: { input: string; kind: string; value?: string; values?: string[]; options: QuestionOption[] | null; unit: string | null }): string {
  const label = (id: string) => (a.options ?? []).find((o) => o.id === id)?.label ?? id;
  switch (a.input) {
    case 'secret':
      return 'The person provided the secret. Type it with type_handoff_secret(selector).';
    case 'confirm':
      return a.value === 'approve' ? 'The person approved.' : 'The person denied it. Do not do it; finish if you cannot continue another way.';
    case 'choice':
      return `The person chose: ${trim(label(a.value ?? ''), 500)}`;
    case 'multi_choice':
      return `The person selected: ${trim((a.values ?? []).map(label).join(', '), 500)}`;
    case 'number':
      return `The person entered: ${trim(`${a.value ?? ''}${a.unit ? ` ${a.unit}` : ''}`, 500)}`;
    case 'text':
      return `The person answered: ${trim(a.value ?? '', 500)}`;
    case 'takeover':
      return 'The person took over the browser and is done. Check the page and continue.';
    default:
      return `The person completed the ${a.kind} step. Check the page and continue.`;
  }
}

@Injectable()
export class GoalRunnerService {
  private readonly log = new Logger(GoalRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly fabric: FabricClient,
    private readonly ai: AiService,
    @Optional() private readonly notifier?: RunNotifier,
    @Optional() private readonly questions?: QuestionsService,
    @Optional() private readonly systemSettings?: SystemSettingsService,
    @Optional() private readonly policies?: PolicyResolver,
    @Optional() private readonly modelCheck?: PolicyModelCheck,
    @Optional() private readonly modelTiers?: ModelTiersService,
  ) {}

  /** The admin's price table; empty when unreadable (calls are then unpriced, never free). */
  private async priceTable(): Promise<PriceTable> {
    try {
      return priceTableOf(await this.systemSettings?.getNamespace('agentPricing'));
    } catch (e) {
      this.log.warn(`could not read the agent price table: ${e instanceof Error ? e.message : String(e)}`);
      return {};
    }
  }
  /** The deployment's budget ceilings; none when unreadable or when no settings service is wired. */
  private async ceilings(): Promise<BudgetCeilings> {
    try {
      return (await this.systemSettings?.getNamespace('browserAgentCeilings')) ?? {};
    } catch (e) {
      this.log.warn(`could not read the budget ceilings: ${e instanceof Error ? e.message : String(e)}`);
      return {};
    }
  }

  /** The wall clock; tests replace it to pass time without waiting. */
  clock: () => number = Date.now;

  /**
   * The agent policy the run runs under (#401), snapshotted onto the run at its
   * FIRST advance and never again: a later edit of the policy or of the user's
   * settings does not change a live run. Fall-through notes (a level that named
   * a deleted or foreign policy) go to the run's first log line.
   */
  private async policySnapshot(db: ReturnType<PrismaService['forUser']>, run: { id: string; userId: string; taskId: string | null; policyRef: string | null; policySource: RunPolicySnapshot['source'] | null; policySnapshot: Prisma.JsonValue | null; appLimits?: Prisma.JsonValue | null; task: { policyRef: string | null } | null }, memory: RunMemory): Promise<RunPolicySnapshot> {
    const stored = readSnapshot(run.policySnapshot);
    if (stored) {
      // Upgrade an older snapshot once, then never change it: the effective budget (#404) and the model tiers (#403).
      let upgraded = stored;
      if (!upgraded.effectiveBudget) upgraded = { ...upgraded, effectiveBudget: computeEffectiveBudget(upgraded.spec.budget, await this.ceilings()) };
      if (upgraded.resolvedTiers === undefined && this.modelTiers) upgraded = await this.withTiers(run.userId, upgraded);
      if (upgraded !== stored) await db.run.updateMany({ where: { id: run.id }, data: { policySnapshot: upgraded as never } });
      return upgraded;
    }
    let snapshot: RunPolicySnapshot;
    let notes: string[] = [];
    if (this.policies) {
      const resolved = await this.policies.forRun({
        userId: run.userId,
        taskId: run.taskId,
        policyRef: run.policyRef,
        policySource: run.policySource,
        taskPolicyRef: run.task ? run.task.policyRef : null,
      });
      snapshot = this.policies.snapshot(resolved);
      notes = resolved.notes;
      snapshot = await this.withTiers(run.userId, snapshot);
    } else {
      // Without a resolver (a runner built by hand): the system default.
      const b = builtinPolicy(SYSTEM_DEFAULT_POLICY_REF)!;
      snapshot = { schemaVersion: 1, ref: b.id, name: b.name, version: b.version, builtin: true, source: 'system_default', spec: balancedSpec(), tiers: null, takenAt: new Date().toISOString() };
      snapshot = await this.withTiers(run.userId, snapshot);
    }
    // What the run is held to: the policy's budget under the deployment's ceilings, fixed for the run (#404).
    snapshot = { ...snapshot, effectiveBudget: computeEffectiveBudget(snapshot.spec.budget, await this.ceilings()) };
    // The limits of the AI app that started it (#464), recorded on the run at its start: the snapshot keeps them.
    const appLimits = readAppLimits(run.appLimits);
    if (appLimits) snapshot = { ...snapshot, appLimits };
    // Compare-and-set: only the first writer's snapshot stands (a retried job re-reads it).
    const { count } = await db.run.updateMany({
      where: { id: run.id, policySnapshot: { equals: Prisma.DbNull } },
      data: { policyRef: snapshot.ref, policyVersion: snapshot.version, policySource: snapshot.source, policySnapshot: snapshot as never },
    });
    if (count === 0) {
      const fresh = await db.run.findFirst({ where: { id: run.id }, select: { policySnapshot: true } });
      const winner = readSnapshot(fresh?.policySnapshot);
      if (winner) return winner;
    }
    if (isUnlimited(snapshot.effectiveBudget!)) memory.log.unshift(UNLIMITED_LOG_LINE);
    for (const n of notes) memory.log.push(n);
    return snapshot;
  }

  /** The snapshot with its three model tiers resolved (#403): the models of the run are fixed here, once. */
  private async withTiers(userId: string, snapshot: RunPolicySnapshot): Promise<RunPolicySnapshot> {
    if (!this.modelTiers) return snapshot;
    try {
      const resolvedTiers = await this.modelTiers.resolve(userId, snapshot.spec);
      const tiers = Object.fromEntries(Object.entries(resolvedTiers).map(([t, r]) => [t, { provider: r.provider, model: r.modelId ?? r.model }]));
      return { ...snapshot, resolvedTiers, tiers };
    } catch (e) {
      // Without resolved tiers the platform's target resolver picks the model, as before.
      this.log.warn(`run: the model tiers could not be resolved: ${e instanceof Error ? e.message : String(e)}`);
      return snapshot;
    }
  }


  /**
   * Advance a run: start it, resume it after a handoff, or finish it.
   * Returns what the caller (the job) should do next.
   */
  async advance(runId: string, userId: string, orgId: string | null): Promise<RunOutcome> {
    const jobStartedAt = this.clock();
    const db = this.prisma.forUser({ userId });
    const run = await db.run.findFirst({ where: { id: runId }, include: { task: true, conversation: { select: { allowedDomains: true, confirmRiskyActions: true } } } });
    if (!run) return 'failed';
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') return run.status;
    const session = new FabricSession(this.fabric);
    // The run row as last written: its active-time fields drive the time budget (#399).
    let current: { activeMs: number; activeSince: Date | null } = run;
    const memory: RunMemory = (run.transcript as unknown as RunMemory | null) ?? { log: [], chunks: 0 };

    if (run.cancelRequested) {
      await this.finish(userId, run.id, run.sessionId, session, 'cancelled', { error: 'Cancelled by the user', stopReason: 'cancelled' });
      return 'cancelled';
    }

    // The policy snapshot, written once at the first advance (resolved apart from the run's own state).
    const snapshot = await this.policySnapshot(db, run, memory);
    // The tier the run is on: the start tier, moved up on a stall and back down after progress (#405). Kept in the memory, so it survives chunks, jobs and handoffs.
    const startTier = snapshot.spec.models.startTier;
    let tier: Tier = memory.tier ?? startTier;
    memory.tier = tier;
    const stall = (memory.stall = readStallState(memory.stall));
    if (run.currentTier !== tier) await db.run.updateMany({ where: { id: run.id }, data: { currentTier: tier } });
    // A tier with no usable model fails the run now, before a browser is allocated (#403).
    const tierError = this.modelTiers ? tierProblem(snapshot, tier) : null;
    if (tierError) {
      await this.finish(userId, run.id, run.sessionId, session, 'failed', { error: tierError });
      return 'failed';
    }
    // A model without image input starts the run without screenshots, instead of finding out from a refused call.
    if (!memory.visionOff && tierHasVision(snapshot, tier) === false) {
      memory.visionOff = true;
      memory.visionOffByTier = true;
      memory.log.push('(Screenshots are off: the model of this tier does not accept images. Use observe_elements and read_text.)');
    }

    // Resume after a handoff: fold the person's answer into the memory.
    if (run.status === 'waiting_human') {
      if (!run.handoffId) {
        await this.tasks.transition(userId, run.id, 'failed', { error: 'Waiting for a person without a handoff', stopReason: 'error' });
        return 'failed';
      }
      const h = await session.getHandoff(run.handoffId);
      if (h.status === 'pending') return 'waiting_human';
      await this.questions?.reconcileHandoff(h);
      // The answer as the broker recorded it (labels of choices), else as the fabric reports it.
      const q = await db.question.findFirst({ where: { handoffId: h.id }, select: { response: true, options: true, constraints: true, input: true } });
      const resp = (q?.response as unknown as QuestionResponse | null) ?? null;
      const outcome = resp?.outcome ?? handoffOutcome(h);
      if (h.status === 'completed' && outcome === 'completed') {
        const line = answerLine({
          input: (q?.input as QuestionInputType | undefined) ?? h.input,
          kind: h.kind,
          value: resp?.value ?? h.response?.value,
          values: resp?.values ?? h.response?.values,
          options: (q?.options as unknown as QuestionOption[] | null) ?? null,
          unit: (q?.constraints as unknown as QuestionConstraints | null)?.unit ?? null,
        });
        if (h.input === 'secret') memory.secretHandoffId = h.id;
        if (h.input === 'confirm' && (resp?.value ?? h.response?.value) === 'approve' && h.kind === 'confirmation') memory.confirmationGranted = true;
        if (h.kind === 'confirmation' && h.input !== 'confirm') memory.confirmationGranted = true;
        memory.log.push(line);
      } else {
        memory.log.push(`The person did not help (handoff ${h.status}${outcome === 'cancelled' ? ', declined' : ''}). Do not retry the same request; finish if you cannot continue.`);
      }
      // A person helped (or did not): every stall counter starts over (#405).
      resetStall(stall);
      memory.stallsHere = 0;
      memory.progressStreak = 0;
      current = await this.tasks.transition(userId, run.id, 'running', { handoffId: null, transcript: memory as never, activity: runActivity('starting') as never });
    } else if (run.status === 'running') {
      // A continuation of this run in a new job (the last one neared its runtime limit): no status change, so its active time stays continuous.
      this.log.log(`run ${run.id}: continuing in a new job`);
    } else {
      current = await this.tasks.transition(userId, run.id, 'running', { activity: runActivity('starting') as never });
      await this.notifier?.started?.(userId, run);
    }

    let sessionId = run.sessionId;
    if (!sessionId) {
      try {
        const hosts = run.hostId ? await this.fabric.hosts() : [];
        const choice = chooseHost(hosts, run.hostId, run.hostFallback);
        if (choice.kind === 'fail') {
          await this.finish(userId, run.id, null, session, 'failed', { error: choice.error, stopReason: 'error' });
          return 'failed';
        }
        if (choice.note) {
          memory.log.push(choice.note);
          this.log.log(`run ${run.id}: ${choice.note}`);
        }
        sessionId = await session.create({ profile: run.profile, hostId: choice.hostId, label: `run ${run.id}` });
      } catch (e) {
        await this.finish(userId, run.id, null, session, 'failed', { error: `No browser available: ${e instanceof Error ? e.message : String(e)}`, stopReason: 'error' });
        return 'failed';
      }
      await db.run.updateMany({ where: { id: run.id }, data: { sessionId } });
    }

    // The limits come from the run's policy snapshot (its effective budget: policy under the ceilings); `null` means no limit.
    const effective = snapshot.effectiveBudget ?? computeEffectiveBudget(snapshot.spec.budget, null);
    // Starts from what the run already used in earlier jobs and chunks, so a continued run never gets a fresh budget.
    const tracker = new BudgetTracker(effective, {
      actions: run.stepCount,
      modelCalls: run.modelCalls,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      costUsd: Number(run.costUsd),
      costKnown: run.costKnown,
      activeMs: run.activeMs,
      warned: memory.warned,
    });
    // Context efficiency (#406): every knob is the run's own snapshot, never a constant.
    const ctx = snapshot.spec.context;
    const shotWindow = new ScreenshotWindow(ctx.screenshotsKept, ctx.pruneBatch);
    // The AI app's limits (#464), from the snapshot: they only ever narrow the task's opt-ins.
    const app = snapshot.appLimits ?? readAppLimits(run.appLimits);
    const policy = {
      // The opt-ins of the run's task, or of the chat that started it (#484); an ad-hoc run has none.
      allowedDomains: run.task?.allowedDomains ?? run.conversation?.allowedDomains ?? [],
      // The app's own allowed sites: a URL must pass both lists.
      appDomains: app?.allowedDomains ?? [],
      confirmRisky: (run.task?.confirmRiskyActions ?? run.conversation?.confirmRiskyActions ?? false) || app?.confirmPurchases === true,
    };
    /** Whether a URL is allowed by the task and by the app. */
    const siteAllowed = (url: string) => domainAllowed(url, policy.allowedDomains) && domainAllowed(url, policy.appDomains);
    const sitesText = [policy.allowedDomains.join(', ') || null, policy.appDomains.length ? `the app's: ${policy.appDomains.join(', ')}` : null].filter(Boolean).join('; ');
    // Routing steps (#405) take a `seq` but are not actions: the sequence runs ahead of `stepCount` by their number.
    const lastSeq = await this.prisma.runStep.aggregate({ where: { runId: run.id }, _max: { seq: true } });
    const state = {
      stepCount: run.stepCount,
      seq: Math.max(run.stepCount, lastSeq._max.seq ?? 0),
      /** The stall that ended the chunk (#405). */
      stall: null as StallSignal | null,
      stop: null as StopLoop['reason'] | null,
      /** Which budget ended the run (set with `stop = 'budget'`). */
      budgetKey: null as BudgetKey | null,
      finished: null as { success: boolean; result: string } | null,
      handoffId: null as string | null,
      handoffExpiresAt: null as Date | null,
      handoffAsk: null as { prompt: string; kind: string; input: string } | null,
      labels: new Map<string, string>(),
      /** The numbered marks of the last page screenshot. */
      marks: new Map<number, ScreenMark>(),
      /** The last screen the model was shown. */
      view: null as ScreenView | null,
    };

    /** What the run page shows as happening now (#379). Best effort: never fails the run. */
    const setActivity = async (phase: RunActivityPhase, opts: Parameters<typeof runActivity>[1] = {}) => {
      try {
        await db.run.updateMany({ where: { id: run.id, status: 'running' }, data: { activity: runActivity(phase, { ...opts, ...(memory.tierNote ? { note: memory.tierNote } : {}) }) as never } });
      } catch (e) {
        this.log.debug(`run ${run.id}: could not record its activity: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    /** The first exhausted budget now (active time read off the clock), or null (#404). */
    const budgetCheck = (): BudgetKey | null => {
      tracker.setActiveMs(activeElapsedMs(current, this.clock()));
      return tracker.state().exhausted;
    };
    const stopForBudget = (key: BudgetKey) => {
      state.stop = 'budget';
      state.budgetKey = key;
    };
    /** A budget newly over `warnAtPercent`: log it once and queue the line the next round's input carries. */
    const noteWarnings = (): boolean => {
      const keys = tracker.takeWarnings();
      if (keys.length === 0) return false;
      const { percent } = tracker.state();
      const usedNow = tracker.used();
      memory.warned = tracker.warnedKeys();
      for (const k of keys) {
        const limit = effective.limits[k]!;
        memory.pendingWarnings = [...(memory.pendingWarnings ?? []), warningLine(k, percent[k]!, usedNow[k], limit)];
        memory.log.push(`Budget warning: ${BUDGET_LABEL[k]} is at ${Math.floor(percent[k]!)}% (${usedOfLimit(k, usedNow[k], limit)}).`);
      }
      return true;
    };

    /** What a recorded action tells the stall detector beyond its arguments (#405). */
    type StallExtra = Omit<ActionObservation, 'type' | 'args' | 'ok'>;
    const stallNow = () => snapshot.spec.stall;
    /** Feed the detector one action; a stall ends the chunk (an escalation is its own stop reason). */
    const feedStall = (type: string, args: Record<string, unknown>, ok: boolean, extra: StallExtra) => {
      const verdict = observeAction(stall, stallNow(), { type, args, ok, ...extra });
      if (extra.secret) return;
      memory.progressStreak = verdict.progressing ? (memory.progressStreak ?? 0) + 1 : 0;
      if (verdict.signal && !state.stop && !state.stall) {
        state.stall = verdict.signal;
        state.stop = stallResponse() === 'escalate' ? 'escalate' : 'stall';
      }
    };

    const record = async (kind: string, action: string | null, args: Record<string, unknown> | null, ok: boolean, summary: string, started: number, reasoning?: string, extra?: StallExtra) => {
      state.stepCount += 1;
      state.seq += 1;
      tracker.add({ actions: 1 });
      this.tasks.metrics.step(kind, ok);
      if (action && args && (kind === 'action' || action === 'look')) feedStall(action, args, ok, extra ?? {});
      await this.prisma.runStep.create({
        data: {
          runId: run.id,
          seq: state.seq,
          kind,
          action,
          args: args ? (redactActionArgs(action ?? '', args) as never) : undefined,
          ok,
          summary: trim(summary, 1_900),
          reasoning: reasoning ? trim(reasoning, 1_900) : null,
          durationMs: Date.now() - started,
        },
      });
      await db.run.updateMany({ where: { id: run.id }, data: { stepCount: state.stepCount } });
      await this.tasks.stepRecorded?.(run.userId, run.id, state.stepCount);
      memory.log.push(`${state.stepCount}. ${action ?? kind}${args ? ` ${JSON.stringify(redactActionArgs(action ?? '', args))}` : ''} → ${ok ? 'ok' : 'FAILED'}: ${trim(summary, 300)}`);
    };

    /** Run one fabric action under the policy, record it, and return what the model sees. */
    const act = async (action: Record<string, unknown>, reason?: string, target?: ActivityTarget): Promise<string> => {
      const started = Date.now();
      const type = String(action.type);
      const spent = budgetCheck();
      if (spent) {
        stopForBudget(spent);
        return `${BUDGET_ERROR[spent]}.`;
      }
      await setActivity('acting', { action, reason, timeoutMs: ACTION_TIMEOUT_MS, target: target ?? actionTarget(action, state.marks.values()) });
      try {
        return await runAction(action, type, started, reason);
      } finally {
        // Back to the model, which reads the result and picks the next step.
        await setActivity('thinking');
      }
    };

    const runAction = async (action: Record<string, unknown>, type: string, started: number, reason?: string): Promise<string> => {
      let op;
      try {
        op = await session.act(sessionId!, action, ACTION_TIMEOUT_MS);
      } catch (e) {
        const msg = e instanceof FabricError ? e.message : String(e);
        await record('action', type, action, false, msg, started, reason);
        return `Error: ${msg}`;
      }
      if (op.state !== 'succeeded') {
        const msg = op.error ?? op.state;
        await record('action', type, action, false, msg, started, reason);
        return `Failed (${op.state}): ${msg}`;
      }
      const result = op.result ?? {};
      let summary = 'done';
      let forModel = 'ok';
      // What the stall detector learns from the result (#405): where the page is, and whether new content came back.
      let extra: StallExtra = {};
      if (type === 'navigate') {
        extra = { url: String(result.url ?? ''), title: typeof result.title === 'string' ? result.title : null };
        // The model needs the real URL; the stored step gets it without its query.
        forModel = `at ${String(result.url ?? '')} — ${String(result.title ?? '')}`;
        summary = `at ${redactUrl(String(result.url ?? ''))} — ${trim(String(result.title ?? ''), 200)}`;
      }
      if (type === 'text') {
        const text = String(result.text ?? '');
        extra = { contentHash: digest(text) };
        summary = `read ${text.length} characters`;
        forModel = trim(text, ctx.observationChars);
      }
      if (type === 'elements') {
        const els = (result.elements as Array<Record<string, unknown>> | undefined) ?? [];
        state.labels.clear();
        extra = { contentHash: digest(JSON.stringify(els.map((el) => [el.selector, el.text, el.name]))) };
        for (const el of els) state.labels.set(String(el.selector), `${String(el.text ?? '')} ${String(el.aria_label ?? el.name ?? '')}`);
        summary = `${els.length} interactive elements`;
        forModel = trim(JSON.stringify(els.map((el) => ({ selector: el.selector, tag: el.tag, role: el.role, text: el.text, type: el.type, name: el.name }))), ctx.observationChars);
      }
      if (type === 'scroll') extra = { resultKey: `y${String(result.y ?? '')}` };
      if (type === 'scroll') summary = forModel = `scrolled to ${String(result.y ?? '?')}`;
      if (type === 'evaluate') {
        const value = JSON.stringify(result.value ?? null) ?? 'undefined';
        extra = { contentHash: digest(value) };
        summary = `returned ${String(result.type ?? typeof result.value)} (${value.length} characters)`;
        forModel = trim(`${String(result.type ?? '')}: ${value}${result.description ? ` (${String(result.description)})` : ''}`, ctx.observationChars);
      }
      if (type === 'tabs') {
        const tabs = (result.tabs as Record<string, unknown>[] | undefined) ?? [];
        const active = tabs.find((t) => t.active === true);
        if (active && typeof active.url === 'string') extra = { url: active.url, title: typeof active.title === 'string' ? active.title : null };
        summary = `${tabs.length} tabs`;
        forModel = trim(JSON.stringify(tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active }))), ctx.observationChars);
      }
      if (type === 'new_tab') summary = forModel = `opened tab ${String(result.tab_id ?? '?')}`;
      await record('action', type, action, true, summary, started, reason, extra);
      return forModel;
    };

    /**
     * Open a handoff for a person and pause the run on it: the one path `request_human` and a stall that asks
     * for help share. Every stall counter starts over (#405). False when no person could be asked.
     */
    const askPerson = async (spec: QuestionSpec, started: number): Promise<boolean> => {
      try {
        const created = await session.openHandoff(sessionId!, {
          kind: spec.kind,
          prompt: spec.prompt,
          input: spec.input,
          choices: spec.options ?? [],
          constraints: spec.constraints,
          confirmLabel: spec.confirmLabel,
          denyLabel: spec.denyLabel,
          risk: spec.risk,
        });
        state.handoffId = created.id;
        state.handoffExpiresAt = created.expiresAt;
        await this.mirror(userId, run.id, sessionId!, created, spec);
      } catch (e) {
        await record('handoff', null, null, false, `could not ask a person: ${e instanceof Error ? e.message : String(e)}`, started);
        return false;
      }
      await record('handoff', null, { kind: spec.kind, input: spec.input }, true, `asked a person (${spec.kind}): ${trim(spec.prompt, 300)}`, started);
      state.handoffAsk = { prompt: spec.prompt, kind: spec.kind, input: spec.input };
      state.stop = 'pause';
      resetStall(stall);
      memory.stallsHere = 0;
      memory.progressStreak = 0;
      return true;
    };

    const tools: AiDefinedTool[] = [
      defineTool({
        name: 'observe_elements',
        description: 'List the interactive elements of the current page with CSS selectors.',
        parameters: z.object({}),
        execute: () => act({ type: 'elements', max_elements: maxElementsFor(ctx.observationChars) }),
      }),
      defineTool({
        name: 'read_text',
        description: 'Read the visible text of the page, or of one element.',
        parameters: z.object({ selector: z.string().max(2000).nullable() }),
        execute: ({ selector }) => act({ type: 'text', ...(selector ? { selector } : {}), max_chars: ctx.observationChars }),
      }),
      defineTool({
        name: 'navigate',
        description: 'Open any URL in the current tab.',
        parameters: z.object({ url: z.string().max(8000), reason: z.string().max(500) }),
        execute: async ({ url, reason }) => {
          if (!siteAllowed(url)) {
            await record('action', 'navigate', { url }, false, 'refused by policy: site not allowed', Date.now(), reason);
            return `Refused: ${url.startsWith('javascript:') ? 'use run_javascript instead of a javascript: URL' : `that site is not allowed for this task (${sitesText})`}.`;
          }
          return act({ type: 'navigate', url }, reason);
        },
      }),
      defineTool({
        name: 'click',
        description: 'Click the element matching a CSS selector.',
        parameters: z.object({ selector: z.string().max(2000), reason: z.string().max(500) }),
        execute: async ({ selector, reason }) => {
          if (policy.confirmRisky && !memory.confirmationGranted && looksRisky(selector, state.labels.get(selector), reason)) {
            await record('action', 'click', { selector }, false, 'paused by policy: needs a person\'s confirmation', Date.now(), reason);
            return 'Refused: this looks like a purchase, payment or irreversible submission. Call request_human with kind "confirmation" describing exactly what will happen, then try again.';
          }
          const out = await act({ type: 'click', selector }, reason);
          if (looksRisky(selector, state.labels.get(selector), reason)) memory.confirmationGranted = false;
          return out;
        },
      }),
      defineTool({
        name: 'type_text',
        description: 'Type text into an input (not secrets: use type_handoff_secret for those).',
        parameters: z.object({ selector: z.string().max(2000), text: z.string().max(10_000), submit: z.boolean() }),
        execute: ({ selector, text, submit }) => act({ type: 'type', selector, text, clear: true, submit }),
      }),
      defineTool({
        name: 'press_key',
        description: 'Press a key such as Enter, Tab or Escape.',
        parameters: z.object({ key: z.string().max(40) }),
        execute: ({ key }) => act({ type: 'press', key }),
      }),
      defineTool({
        name: 'scroll',
        description: 'Scroll the page vertically by a number of pixels (negative scrolls up).',
        parameters: z.object({ dy: z.number().int().min(-20000).max(20000) }),
        execute: ({ dy }) => act({ type: 'scroll', dy }),
      }),
      defineTool({
        name: 'wait_for',
        description: 'Wait until an element matching a selector appears (up to 15 s).',
        parameters: z.object({ selector: z.string().max(2000) }),
        execute: ({ selector }) => act({ type: 'wait_for', selector, timeout_ms: 15_000 }),
      }),
      defineTool({
        name: 'go_back',
        description: 'Go back one page.',
        parameters: z.object({}),
        execute: () => act({ type: 'back' }),
      }),
      defineTool({
        name: 'look',
        description:
          'Take a fresh screenshot and end this turn; the next turn starts with the image. screen "page" shows the tab with numbered interactive elements; "desktop" shows the whole computer screen (native dialogs, file pickers, other windows).',
        parameters: z.object({ screen: z.enum(['page', 'desktop']), reason: z.string().max(500) }),
        execute: async ({ screen, reason }) => {
          if (memory.visionOff || !shotWindow.enabled) return 'Screenshots are not available with this model: use observe_elements and read_text.';
          const spent = budgetCheck();
          if (spent) {
            stopForBudget(spent);
            return `${BUDGET_ERROR[spent]}.`;
          }
          await record('observe', 'look', { screen }, true, `looked at the ${screen}`, Date.now(), reason);
          memory.look = screen;
          state.stop = 'look';
          return 'Looking; the screenshot comes with the next turn.';
        },
      }),
      defineTool({
        name: 'click_mark',
        description: 'Click the element numbered n on the latest page screenshot, with a real mouse click at its center.',
        parameters: z.object({ n: z.number().int().min(1), double: z.boolean(), reason: z.string().max(500) }),
        execute: async ({ n, double, reason }) => {
          const mark = state.marks.get(n);
          if (!mark) return `There is no mark ${n} on the latest screenshot. Call look to refresh it.`;
          if (policy.confirmRisky && !memory.confirmationGranted && looksRisky(mark.selector, mark.text, reason)) {
            await record('action', 'click_at', { mark: n }, false, "paused by policy: needs a person's confirmation", Date.now(), reason);
            return 'Refused: this looks like a purchase, payment or irreversible submission. Call request_human with kind "confirmation" describing exactly what will happen, then try again.';
          }
          const { x, y } = markCenter(mark);
          const out = await act({ type: 'click_at', x, y, ...(double ? { click_count: 2 } : {}) }, reason, { x: mark.x, y: mark.y, w: mark.w, h: mark.h });
          if (looksRisky(mark.selector, mark.text, reason)) memory.confirmationGranted = false;
          return out;
        },
      }),
      defineTool({
        name: 'click_at',
        description: 'Real mouse click at viewport coordinates (CSS pixels, as on the page screenshot). button left/middle/right; double for a double click; modifiers alt, ctrl, meta, shift.',
        parameters: z.object({
          x: z.number().int().min(0),
          y: z.number().int().min(0),
          button: z.enum(['left', 'middle', 'right']),
          double: z.boolean(),
          modifiers: z.array(z.enum(['alt', 'ctrl', 'meta', 'shift'])),
          reason: z.string().max(500),
        }),
        execute: async ({ x, y, button, double, modifiers, reason }) => {
          if (policy.confirmRisky && !memory.confirmationGranted && looksRisky(reason)) {
            await record('action', 'click_at', { x, y }, false, "paused by policy: needs a person's confirmation", Date.now(), reason);
            return 'Refused: this looks like a purchase, payment or irreversible submission. Call request_human with kind "confirmation" describing exactly what will happen, then try again.';
          }
          const out = await act({ type: 'click_at', x, y, ...(button !== 'left' ? { button } : {}), ...(double ? { click_count: 2 } : {}), ...(modifiers.length ? { modifiers } : {}) }, reason);
          if (looksRisky(reason)) memory.confirmationGranted = false;
          return out;
        },
      }),
      defineTool({
        name: 'hover_at',
        description: 'Move the mouse to viewport coordinates (opens hover menus and tooltips).',
        parameters: z.object({ x: z.number().int().min(0), y: z.number().int().min(0) }),
        execute: ({ x, y }) => act({ type: 'mouse', op: 'move', x, y }),
      }),
      defineTool({
        name: 'drag',
        description: 'Real mouse drag from one viewport point to another (sliders, drag and drop, drawing).',
        parameters: z.object({ from_x: z.number().int().min(0), from_y: z.number().int().min(0), to_x: z.number().int().min(0), to_y: z.number().int().min(0) }),
        execute: (a) => act({ type: 'drag', ...a }),
      }),
      defineTool({
        name: 'scroll_at',
        description: 'Mouse-wheel scroll at a viewport point: scrolls whatever is under it (a list, a map, a panel). Positive dy scrolls down.',
        parameters: z.object({ x: z.number().int().min(0), y: z.number().int().min(0), dy: z.number().int().min(-20000).max(20000) }),
        execute: ({ x, y, dy }) => act({ type: 'scroll_at', x, y, dx: 0, dy }),
      }),
      defineTool({
        name: 'type_keys',
        description: 'Type text into whatever has focus with real keyboard events (click the field first). Use for fields that ignore type_text.',
        parameters: z.object({ text: z.string().min(1).max(10_000) }),
        execute: ({ text }) => act({ type: 'type_keys', text }),
      }),
      defineTool({
        name: 'key',
        description: 'Press one key with real keyboard events, with modifiers: key "a" with ["ctrl"] selects all, "Enter", "Escape", "Tab", "ArrowDown", "PageDown", "F5".',
        parameters: z.object({ key: z.string().min(1).max(40), modifiers: z.array(z.enum(['alt', 'ctrl', 'meta', 'shift'])) }),
        execute: ({ key, modifiers }) => act({ type: 'key', key, ...(modifiers.length ? { modifiers } : {}) }),
      }),
      defineTool({
        name: 'run_javascript',
        description:
          'Run JavaScript in the current page and get its value back (like the DevTools console: the last expression is the value; top-level await works). Use it to read page state, fill or submit complex forms, call the page\'s functions, or work around stubborn widgets.',
        parameters: z.object({ script: z.string().min(1).max(100_000), reason: z.string().max(500) }),
        execute: ({ script, reason }) => act({ type: 'evaluate', script, await_promise: true }, reason),
      }),
      defineTool({
        name: 'tabs',
        description: 'List the open tabs (id, title, URL, which is active).',
        parameters: z.object({}),
        execute: () => act({ type: 'tabs' }),
      }),
      defineTool({
        name: 'switch_tab',
        description: 'Make a tab (by id from tabs) the active one; later actions use it.',
        parameters: z.object({ tab_id: z.number().int() }),
        execute: ({ tab_id }) => act({ type: 'activate_tab', tab_id }),
      }),
      defineTool({
        name: 'new_tab',
        description: 'Open a new tab, optionally at a URL, and make it active.',
        parameters: z.object({ url: z.string().max(8000).nullable() }),
        execute: async ({ url }) => {
          if (url && !siteAllowed(url)) {
            await record('action', 'new_tab', { url }, false, 'refused by policy: site not allowed', Date.now());
            return `Refused: that site is not allowed for this task (${sitesText}).`;
          }
          return act({ type: 'new_tab', ...(url ? { url } : {}) });
        },
      }),
      defineTool({
        name: 'desktop_click',
        description: 'Click anywhere on the computer screen, at screen coordinates from a desktop screenshot (look with screen "desktop").',
        parameters: z.object({ x: z.number().int().min(0), y: z.number().int().min(0), button: z.enum(['left', 'middle', 'right']), double: z.boolean() }),
        execute: ({ x, y, button, double }) => act({ type: 'desktop_click', x, y, ...(button !== 'left' ? { button } : {}), ...(double ? { click_count: 2 } : {}) }),
      }),
      defineTool({
        name: 'desktop_type',
        description: 'Type text into whatever has focus on the computer (a native file dialog\'s path box, another window).',
        parameters: z.object({ text: z.string().min(1).max(10_000) }),
        execute: ({ text }) => act({ type: 'desktop_type', text }),
      }),
      defineTool({
        name: 'desktop_key',
        description: 'Press a key chord on the computer, xdotool style: "Return", "Escape", "ctrl+l", "alt+F4", "ctrl+a BackSpace".',
        parameters: z.object({ key: z.string().min(1).max(64) }),
        execute: ({ key }) => act({ type: 'desktop_key', key }),
      }),
      defineTool({
        name: 'desktop_scroll',
        description: 'Scroll on the computer screen by mouse-wheel clicks at a point (positive dy scrolls down).',
        parameters: z.object({ x: z.number().int().min(0), y: z.number().int().min(0), dy: z.number().int().min(-100).max(100) }),
        execute: ({ x, y, dy }) => act({ type: 'desktop_scroll', x, y, dy }),
      }),
      defineTool({
        name: 'desktop_drag',
        description: 'Drag on the computer screen from one point to another.',
        parameters: z.object({ from_x: z.number().int().min(0), from_y: z.number().int().min(0), to_x: z.number().int().min(0), to_y: z.number().int().min(0) }),
        execute: (a) => act({ type: 'desktop_drag', ...a }),
      }),
      defineTool({
        name: 'request_human',
        description:
          'Ask the person for help: a CAPTCHA, a one-time code, a passkey, a login, a choice, a number, or a confirmation before an irreversible step. ' +
          'input: none (they do something, then press Done), text, secret (a code or password; type it with type_handoff_secret), choice (one of options), ' +
          'multi_choice (several of options), number (with constraints min/max/step/unit), confirm (approve or deny; risk "high" by default), takeover (they take over the browser, then press Done). ' +
          'Set the fields that do not apply to null. The run pauses until they answer.',
        parameters: z.object({
          kind: z.enum(['captcha', 'code', 'passkey', 'login', 'confirmation', 'other']),
          prompt: z.string().min(1).max(1500),
          input: z.enum(['none', 'text', 'secret', 'choice', 'multi_choice', 'number', 'confirm', 'takeover']),
          /** Bare option labels (each its own id); or use `options`. */
          choices: z.array(z.string().max(100)).max(10).nullable(),
          options: z.array(z.object({ id: z.string().max(64), label: z.string().max(100), description: z.string().max(200).nullable() })).max(10).nullable(),
          constraints: z
            .object({
              max_length: z.number().int().nullable(),
              pattern: z.string().max(200).nullable(),
              multiline: z.boolean().nullable(),
              min: z.number().nullable(),
              max: z.number().nullable(),
              step: z.number().nullable(),
              unit: z.string().max(20).nullable(),
              min_selections: z.number().int().nullable(),
              max_selections: z.number().int().nullable(),
            })
            .nullable(),
          confirm_label: z.string().max(40).nullable(),
          deny_label: z.string().max(40).nullable(),
          risk: z.enum(['low', 'high']).nullable(),
        }),
        execute: async (args) => {
          const started = Date.now();
          const parsed = questionSpecSchema.safeParse(requestHumanSpec(args));
          if (!parsed.success) return `Invalid request_human: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'question'}: ${i.message}`).join('; ')}. Fix it and call request_human again.`;
          const spec = parsed.data;
          if (!(await askPerson(spec, started))) return 'Could not reach a person right now.';
          return 'Waiting for the person.';
        },
      }),
      defineTool({
        name: 'type_handoff_secret',
        description: 'Type the secret (code or password) the person gave through request_human into an input. You never see the value.',
        parameters: z.object({ selector: z.string().max(2000), submit: z.boolean() }),
        execute: async ({ selector, submit }) => {
          const started = Date.now();
          if (!memory.secretHandoffId) return 'No secret is available: call request_human with input "secret" first.';
          const handoffId = memory.secretHandoffId;
          memory.secretHandoffId = null;
          let op;
          await setActivity('acting', { action: { type: 'type', selector, secret: '', submit }, target: actionTarget({ selector }, state.marks.values()) });
          try {
            // The fabric types the value itself: the console never sees it.
            op = await session.typeSecret(sessionId!, { handoffId, selector, clear: true, submit });
          } catch {
            await record('action', 'type', { selector, secret: '' }, false, 'the secret was already used or expired', started, undefined, { secret: true });
            return 'The secret is no longer available; ask the person again if needed.';
          } finally {
            await setActivity('thinking');
          }
          const ok = op.state === 'succeeded';
          await record('action', 'type', { selector, submit }, ok, ok ? 'typed the secret' : (op.error ?? op.state), started, undefined, { secret: true });
          return ok ? 'Typed the secret.' : `Failed: ${op.error ?? op.state}`;
        },
      }),
      defineTool({
        name: 'finish',
        description: 'End the run with a short factual result.',
        parameters: z.object({ success: z.boolean(), result: z.string().min(1).max(4000) }),
        execute: async ({ success, result }) => {
          state.finished = { success, result };
          state.stop = 'finish';
          await record('finish', null, null, success, trim(result, 1_900), Date.now());
          return 'Finished.';
        },
      }),
    ];

    const goal = run.goal;
    // This job hands the run on a little before its lease runs out.
    const hopDue = () => this.clock() - jobStartedAt > GOAL_RUN_MAX_RUNTIME_MS - GOAL_RUN_HOP_MARGIN_MS;
    const prices = await this.priceTable();
    const used = new RunUsage();
    const provider = () => this.ai.forUser(userId, { feature: BROWSER_AGENT_FEATURE_ID, ...(orgId ? { orgId } : {}) });
    /** Count one model call in the usage totals (saved per chunk) and in the budget. */
    const countCall = (step: { response: { provider?: string; model?: string; usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } } }) => {
      const usd = used.add(step.response.provider, step.response.model || tierRequest(snapshot, tier).modelLabel || undefined, step.response.usage, prices);
      tracker.add({ modelCalls: 1, inputTokens: step.response.usage?.inputTokens, outputTokens: step.response.usage?.outputTokens, costUsd: usd ?? 0, costKnown: usd !== null });
    };

    /** The tier a stall would escalate to, or null: none left, the limit is reached, or the next tier is no different. */
    const nextTier = (): Tier | null => {
      if ((memory.escalations ?? 0) >= snapshot.spec.stall.maxEscalations) return null;
      for (let r = tierRank(tier) + 1; r <= tierRank(snapshot.spec.models.maxTier); r += 1) {
        const t = TIERS[r]!;
        if (this.modelTiers && tierProblem(snapshot, t)) continue;
        if (sameTierRequest(snapshot, tier, t)) continue;
        return t;
      }
      return null;
    };
    /** What the policy answers to a stall now (no side effects). */
    const stallResponse = (): StallResponse => {
      const mode = snapshot.spec.stall.onStall;
      // An unattended (scheduled) run does not wait for a person unless its policy says to.
      const canAsk = (memory.stallHandoffs ?? 0) < MAX_STALL_HANDOFFS && (mode === 'ask_human' || run.trigger !== 'schedule');
      return decideStall({ mode, stallsHere: memory.stallsHere ?? 0, canEscalate: nextTier() !== null, canAsk });
    };

    /** A routing step (#405): a tier change or a provider fallback. It is not an action: it takes a `seq`, never `stepCount` or the actions budget. */
    const recordRouting = async (from: string, to: string, reason: string, extra: Record<string, unknown> = {}) => {
      state.seq += 1;
      await this.prisma.runStep.create({
        data: { runId: run.id, seq: state.seq, kind: 'routing', action: null, args: { from, to, reason, ...extra } as never, ok: true, summary: trim(`${from} → ${to}: ${reason}`, 1_900), durationMs: 0 },
      });
    };

    /** Move the run to another tier, at a chunk boundary. */
    const switchTier = async (to: Tier, kind: 'escalate' | 'deescalate', reason: string) => {
      const from = tier;
      tier = to;
      memory.tier = to;
      if (kind === 'escalate') {
        memory.escalations = (memory.escalations ?? 0) + 1;
        memory.tierNote = `Escalated to ${TIER_LABEL[to]} (stuck: ${reason})`;
        memory.log.push(`Escalated to the ${TIER_LABEL[to]} tier (stuck: ${reason}).`);
      } else {
        memory.tierNote = null;
        memory.log.push(`Back on the ${TIER_LABEL[to]} tier: the run is making progress again.`);
      }
      memory.stallsHere = 0;
      memory.progressStreak = 0;
      clearStallEvidence(stall);
      // The new tier's model may not take images (and the old one may not have): follow it.
      const vision = tierHasVision(snapshot, to);
      if (vision === false && !memory.visionOff) {
        memory.visionOff = true;
        memory.visionOffByTier = true;
        memory.log.push('(Screenshots are off: the model of this tier does not accept images. Use observe_elements and read_text.)');
      } else if (vision !== false && memory.visionOff && memory.visionOffByTier) {
        memory.visionOff = false;
        memory.visionOffByTier = false;
      }
      await recordRouting(from, to, reason, { kind });
      await db.run.updateMany({ where: { id: run.id }, data: { currentTier: to, escalations: memory.escalations ?? 0 } });
      this.log.log(`run ${run.id}: ${kind === 'escalate' ? 'escalated' : 'de-escalated'} ${from} -> ${to} (${reason})`);
    };

    /** The run just asked a person, or is about to wait for one: move it to `waiting_human`. */
    const pauseForPerson = async (): Promise<RunOutcome> => {
      await this.tasks.transition(userId, run.id, 'waiting_human', { handoffId: state.handoffId, handoffExpiresAt: state.handoffExpiresAt });
      await this.notifier?.needsYou(userId, { ...run, handoffId: state.handoffId ?? null }, state.handoffAsk?.prompt ?? 'The agent needs you.', state.handoffAsk?.kind ?? 'other', state.handoffAsk?.input ?? 'none', state.handoffExpiresAt);
      return 'waiting_human';
    };

    /**
     * Answer a stall as the policy says (#405), at a chunk boundary. Null: the run goes on (nudged, or
     * escalated); otherwise the run's outcome (waiting for a person, or ended as `stalled`).
     */
    const respondToStall = async (signal: StallSignal): Promise<RunOutcome | null> => {
      const response = stallResponse();
      memory.log.push(`Stalled: ${signal.reason}.`);
      memory.progressStreak = 0;
      if (response === 'nudge') {
        memory.pendingNudge = nudgeText(signal.reason, lastActions(stall));
        memory.stallsHere = (memory.stallsHere ?? 0) + 1;
        clearStallEvidence(stall);
        return null;
      }
      if (response === 'escalate') {
        await switchTier(nextTier()!, 'escalate', signal.reason);
        return null;
      }
      if (response === 'ask') {
        memory.stallHandoffs = (memory.stallHandoffs ?? 0) + 1;
        const spec = questionSpecSchema.parse({ kind: 'other', input: 'takeover', prompt: stallHandoffPrompt(signal.reason, lastActions(stall)) });
        if (await askPerson(spec, Date.now())) {
          await this.saveMemory(userId, run.id, memory, used.drain());
          return pauseForPerson();
        }
      }
      return wrapUp(signal);
    };

    /** After enough progressing actions on an escalated tier, the run returns to its start tier (#405). */
    const maybeDeEscalate = async () => {
      if (tier === startTier || (memory.progressStreak ?? 0) < DE_ESCALATE_AFTER) return;
      await switchTier(startTier, 'deescalate', `${memory.progressStreak} progressing actions in a row`);
    };

    /**
     * A budget is used up: one last call with only `finish` (exempt from the budget, counted in the
     * totals) so the run still returns a partial result. Without a `finish` the run ends on the budget's message.
     * `finish(success: true)` is a success; anything else is a failure with the typed stop reason.
     */
    const wrapUp = async (cause: BudgetKey | StallSignal): Promise<RunOutcome> => {
      // A used-up budget, or a stall nothing could answer (#405): both end the run with a typed reason and a summary.
      const stopReason: RunStopReason = typeof cause === 'string' ? BUDGET_STOP_REASON[cause] : 'stalled';
      const error = typeof cause === 'string' ? BUDGET_ERROR[cause] : `The agent stalled: ${cause.reason}`;
      const instruction = typeof cause === 'string' ? wrapUpInstruction(cause) : stallWrapUpInstruction(cause.reason);
      memory.log.push(`${error}: asking the model to wrap up.`);
      state.stop = null;
      state.finished = null;
      const finishTool = tools.filter((t) => t.tool.name === 'finish');
      const input = [`Goal: ${goal}`, memory.log.length ? `Progress so far (latest last):\n${memory.log.slice(-LOG_LINES).join('\n')}` : '', instruction].filter(Boolean).join('\n\n');
      await setActivity('thinking');
      try {
        await provider().runTools({
          // The current tier's model and effort (#403); the wrap-up keeps its own small output cap.
          ...(({ modelLabel: _label, ...req }) => req)(tierRequest(snapshot, tier)),
          instructions: INSTRUCTIONS,
          input,
          tools: finishTool,
          maxSteps: 1,
          maxOutputTokens: WRAP_UP_MAX_OUTPUT_TOKENS,
          onStep: (step) => countCall(step),
        });
      } catch (e) {
        this.log.warn(`run ${run.id}: the wrap-up call failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      await this.saveMemory(userId, run.id, memory, used.drain());
      const done = state.finished as { success: boolean; result: string } | null;
      if (done?.success) {
        await this.finish(userId, run.id, sessionId, session, 'succeeded', { result: done.result, stopReason });
        return 'succeeded';
      }
      await this.finish(userId, run.id, sessionId, session, 'failed', { ...(done ? { result: done.result } : {}), error, stopReason });
      return 'failed';
    };

    let idleChunks = 0;
    for (;;) {
      // Everything is checked before each chunk, active time included (#399, #404).
      const spent = budgetCheck();
      if (spent) return wrapUp(spent);
      noteWarnings();
      if (hopDue()) return 'continue';
      // A chunk boundary: the only place the model changes, so provider caching holds within a chunk (#405).
      await maybeDeEscalate();
      memory.chunks += 1;
      state.stop = null;
      state.stall = null;
      const stepsBefore = state.stepCount;
      const warnings = memory.pendingWarnings ?? [];
      memory.pendingWarnings = [];
      // What the model sees this round: the screen, as a person would (#366).
      let view: ScreenView | null = null;
      let shown: ScreenView[] = [];
      let page: PageState | null = null;
      if (!memory.visionOff && shotWindow.enabled) {
        await setActivity('looking');
        const screen: Screen = memory.look ?? 'page';
        memory.look = null;
        try {
          view = await captureScreen(session, this.fabric, sessionId!, screen);
          if (screen === 'page') state.marks = new Map(view.marks.map((m) => [m.n, m]));
          state.view = view;
          shown = shotWindow.push(view);
          memory.shots = shotWindow.hashes;
          // The page as the stall detector sees it: a digest of what is on it, never the image (#405).
          if (screen === 'page') page = { url: view.url, title: view.title, view: view.marks.length ? digest(JSON.stringify(view.marks.map((m) => [m.selector, m.text, m.x, m.y, m.w, m.h]))) : shotHash(view.dataUrl) };
        } catch (e) {
          this.log.debug(`run ${run.id}: no ${screen} screenshot this round: ${e instanceof Error ? e.message : String(e)}`);
          memory.log.push(`(No ${screen} screenshot this round: ${trim(e instanceof Error ? e.message : String(e), 200)})`);
        }
      }
      // No visible progress over enough actions is judged here, where the new screenshot shows what changed.
      const boundaryStall = observePage(stall, stallNow(), page);
      if (boundaryStall) {
        const out = await respondToStall(boundaryStall);
        if (out) return out;
        // The new tier's model may not take images.
        if (memory.visionOff) {
          view = null;
          shown = [];
        }
      }
      const nudge = memory.pendingNudge;
      memory.pendingNudge = undefined;
      const buildInput = () =>
        [
          `Goal: ${goal}`,
          `Allowed sites: ${sitesText || 'any'}.`,
          memory.log.length ? `Progress so far (latest last):\n${memory.log.slice(-LOG_LINES).join('\n')}` : 'Nothing has been done yet. Start by navigating or observing the page.',
          memory.confirmationGranted ? 'The person approved the next irreversible step.' : '',
          ...warnings,
          nudge ?? '',
          'Continue toward the goal.',
        ]
          .filter(Boolean)
          .join('\n\n');
      // Volatile status goes last, after the screenshots, so the prefix stays cacheable (#406).
      const status = `Steps used: ${state.stepCount}${effective.limits.actions !== null ? ` of ${effective.limits.actions}` : ' (no limit)'}.`;
      let result: AiToolLoopResult | null = null;
      await setActivity('thinking');
      const tierReq = tierRequest(snapshot, tier);
      const call = (withImage: boolean, req: TierRequest) =>
        provider().runTools({
          // The model, effort and output cap of the run's current tier, from the snapshot (#403).
          ...(({ modelLabel: _label, ...r }) => r)(req),
          instructions: INSTRUCTIONS,
          input: roundInput(buildInput(), withImage && shown.length ? shown : null, status),
          tools,
          maxSteps: Math.min(ctx.callsPerChunk, PLATFORM_MAX_CALLS_PER_CHUNK),
          onStep: (step) => {
            countCall(step);
            this.tasks.metrics.inputTokensPerCall(step.response.usage?.inputTokens ?? 0);
            // A finish, a pause for a person, a look or a stall already ends the chunk; otherwise the budget decides.
            if (!state.stop) {
              const key = budgetCheck();
              if (key) stopForBudget(key);
              else if (hopDue()) state.stop = 'hop';
              // The warning goes into the next round's input, so the chunk ends here (once per budget).
              else if (noteWarnings()) state.stop = 'warn';
            }
            if (state.stop) throw new StopLoop(state.stop);
          },
        });
      const isFallbackError = (e: unknown): e is AiError => e instanceof AiError && FALLBACK_CODES.has(e.code);
      const attempt = async (req: TierRequest): Promise<AiToolLoopResult> => {
        try {
          return await call(view !== null, req);
        } catch (e) {
          // A provider or model without vision refuses the image: carry on without. (An unavailable provider is another matter.)
          if (e instanceof StopLoop || isFallbackError(e) || view === null || state.stepCount > stepsBefore) throw e;
          this.log.warn(`run ${run.id}: the model refused the screenshot, continuing without vision: ${e instanceof Error ? e.message : String(e)}`);
          memory.visionOff = true;
          memory.log.push('(Screenshots are off: this model does not accept images. Use observe_elements and read_text.)');
          return call(false, req);
        }
      };
      try {
        try {
          result = await attempt(tierReq);
        } catch (e) {
          // The provider is down, overloaded or rate-limiting: this chunk once more on the tier's fallback model, then back to the primary (#405).
          const fallback = isFallbackError(e) && snapshot.spec.models.allowProviderFallback ? fallbackRequest(snapshot, tier) : null;
          if (!fallback || !isFallbackError(e)) throw e;
          memory.log.push(`(The ${TIER_LABEL[tier]} model could not be reached (${e.code}): this round runs on its fallback model.)`);
          await recordRouting(tierReq.modelLabel ?? tier, fallback.modelLabel ?? 'fallback', e.code, { kind: 'fallback', tier });
          result = await attempt(fallback);
        }
      } catch (e) {
        if (!(e instanceof StopLoop)) {
          await this.saveMemory(userId, run.id, memory, used.drain());
          throw e;
        }
      }
      await this.saveMemory(userId, run.id, memory, used.drain());

      const fresh = await db.run.findFirst({ where: { id: run.id }, select: { cancelRequested: true } });
      if (fresh?.cancelRequested) {
        await this.finish(userId, run.id, sessionId, session, 'cancelled', { error: 'Cancelled by the user', stopReason: 'cancelled' });
        return 'cancelled';
      }
      if (state.stop === 'pause' && state.handoffId) return pauseForPerson();
      if (state.stop === 'finish' && state.finished) {
        const to = state.finished.success ? 'succeeded' : 'failed';
        await this.finish(userId, run.id, sessionId, session, to, state.finished.success ? { result: state.finished.result, stopReason: 'finished' } : { result: state.finished.result, error: 'The agent could not reach the goal', stopReason: 'finished' });
        return to;
      }
      if (state.stop === 'budget' && state.budgetKey) return wrapUp(state.budgetKey);
      if (state.stop === 'hop') return 'continue';
      if (result && result.stopReason === 'completed') {
        // The model answered without calling finish: take its answer as the result.
        await this.finish(userId, run.id, sessionId, session, 'succeeded', { result: trim(result.final.outputText || 'Done.', 7_900), stopReason: 'finished' });
        return 'succeeded';
      }
      // A stall the detector found during the chunk, or rounds that record nothing at all (a model that only talks):
      // the policy answers (nudge, escalate, ask a person or end the run), whatever the budget (#405).
      let stalled: StallSignal | null = state.stall;
      if (stalled) idleChunks = 0;
      else {
        idleChunks = state.stepCount === stepsBefore && !state.stop ? idleChunks + 1 : 0;
        if (idleChunks >= MAX_IDLE_CHUNKS) {
          stalled = { kind: 'idle', reason: `no action in ${MAX_IDLE_CHUNKS} rounds in a row` };
          idleChunks = 0;
        }
      }
      if (stalled) {
        const out = await respondToStall(stalled);
        if (out) return out;
        await this.saveMemory(userId, run.id, memory, used.drain());
      }
      // steps_exhausted, or a budget warning: another chunk.
    }
  }

  /** Record the handoff in the question broker (the inbox and the channels read it there). Never fails the run. */
  private async mirror(userId: string, runId: string, sessionId: string, created: CreatedHandoff, spec: QuestionSpec) {
    if (!this.questions) return;
    try {
      await this.questions.mirrorHandoff({ id: userId }, spec, created, { askedBy: `run:${runId}`, runId, fabricSessionId: sessionId });
    } catch (e) {
      this.log.warn(`run ${runId}: could not mirror handoff ${created.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async saveMemory(userId: string, runId: string, memory: RunMemory, usage: UsageDelta) {
    memory.log = memory.log.slice(-200);
    this.tasks.metrics.tokens(usage.inputTokens, usage.outputTokens);
    this.tasks.metrics.modelCalls(usage.modelCalls);
    await this.prisma.forUser({ userId }).run.updateMany({
      where: { id: runId },
      data: {
        transcript: memory as never,
        inputTokens: { increment: usage.inputTokens },
        outputTokens: { increment: usage.outputTokens },
        cachedInputTokens: { increment: usage.cachedInputTokens },
        modelCalls: { increment: usage.modelCalls },
        costUsd: { increment: usage.costUsd },
        // Only ever flips to false: one unpriced call makes the whole figure a lower bound.
        ...(usage.costKnown ? {} : { costKnown: false }),
      },
    });
  }

  private async finish(
    userId: string,
    runId: string,
    sessionId: string | null,
    session: FabricSession,
    to: 'succeeded' | 'failed' | 'cancelled',
    patch: { result?: string; error?: string; stopReason?: RunStopReason },
  ) {
    if (sessionId) await session.end(sessionId);
    const done = await this.tasks.transition(userId, runId, to, patch);
    this.log.log(`run ${runId}: ${to}`);
    await this.notifier?.finished(userId, done, to, patch.result ?? patch.error);
  }
}
