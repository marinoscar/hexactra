// The generic types of the agent harness. Nothing here knows about a browser, a database or a framework.
import type { ActivityTarget } from './activity';
import type { BudgetKey } from './budget';
import type { UnknownStep } from './reconcile';
import type { StallSignal, StallState } from './stall';

/** The three model tiers of a run (#403); a run starts on one and may move up when it stalls. */
export type Tier = 'fast' | 'standard' | 'frontier';
export const TIERS: readonly Tier[] = ['fast', 'standard', 'frontier'];
export const TIER_LABEL: Record<Tier, string> = { fast: 'Fast', standard: 'Standard', frontier: 'Frontier' };
export function tierRank(t: Tier): number {
  return TIERS.indexOf(t);
}

/** What the caller of one job does next. `continue`: the job is near its runtime limit and hands the run on. */
export type RunOutcome = 'succeeded' | 'failed' | 'cancelled' | 'waiting_human' | 'paused' | 'requeue' | 'continue' | 'superseded';

/** Why a chunk (one model tool loop) ended early. */
export type StopReason = 'finish' | 'pause' | 'owner_pause' | 'cancel' | 'budget' | 'look' | 'hop' | 'warn' | 'escalate' | 'stall' | 'lease';

/** Ends a chunk early: thrown from the model port's `onStep`. */
export class StopLoop extends Error {
  constructor(readonly reason: StopReason) {
    super(reason);
  }
}

/** The job found another token on the run: it lost the run and must stop at once without touching it (E38.3). */
export class LeaseLost extends Error {
  constructor(readonly runId: string) {
    super(`run ${runId}: another job took over this run`);
  }
}

/** What the model reads when a tool is not carried out because the owner pressed Stop. */
export const STOPPED_TEXT = 'Stopped by the owner.';
/** What the model reads when a tool is not carried out because the owner paused the run (E38.2). The chunk ends; nothing was done. */
export const PAUSED_TEXT = 'The owner paused the run. This was not done.';
/** What a tool answers once another job holds the run (E38.3): the chunk ends at once. */
export const LEASE_LOST_TEXT = 'Stop: another job took over this run. Do nothing more.';

export type { ActivityTarget, RunActivityPhase } from './activity';

/** What `ctx.setActivity` takes beyond the phase. */
export interface ActivityOptions {
  action?: Record<string, unknown>;
  reason?: string;
  timeoutMs?: number;
  target?: ActivityTarget;
  note?: string;
}

/** The commitment a gate stopped or a person approved (#550): decided by what is acted on, never by the model's words. */
export interface GateTarget {
  /** The kind of commitment (a payment, a purchase, a message sent): a toolset's own vocabulary. */
  category: string | null;
  label: string | null;
  host: string | null;
}

/**
 * What a run keeps between chunks, jobs and handoffs (`runs.transcript`). Never secrets. The harness owns these fields; a toolset
 * adds its own by extending the interface (the browser toolset adds screenshots, saved logins, and so on).
 */
export interface HarnessMemory {
  log: string[];
  chunks: number;
  /** Budgets already warned about (#404): each is warned once per run, across jobs. */
  warned?: BudgetKey[];
  /** Warning lines the next round's input carries (#404). */
  pendingWarnings?: string[];
  /** Soft budgets (#537) already noticed as over their limit: each is noted and notified once per run, across jobs. */
  overNoticed?: BudgetKey[];
  /** The tier the run is on (#405); absent until the first advance. */
  tier?: Tier;
  escalations?: number;
  /** The stall detector's state (#405): digests and normalised selectors only, never typed text or secrets. */
  stall?: StallState;
  stallsHere?: number;
  stallHandoffs?: number;
  progressStreak?: number;
  /** The nudge the next round's input carries. */
  pendingNudge?: string;
  /** What an earlier job of the same chat did (#490): the follow-up's context, shown after the goal. Never a secret. */
  context?: string;
  /** Why the run is on a stronger tier, while it is (the activity shows it). */
  tierNote?: string | null;
  /** The commitment a person approved (#550): the gate lets through this target, not any later one. */
  confirmedTarget?: GateTarget | null;
  /** The commitment the gate last stopped (#550): the next confirmation the model asks for carries it as the question's `gate`. */
  gatePending?: GateTarget | null;
  /** The approved confirmation (#540), until the action it allowed is carried out. `tries` counts failed actions; five clear it. */
  pendingConfirmation?: { prompt: string; tries: number } | null;
  /** The prompt of the last request the run made (the question a confirmation approves). */
  askedPrompt?: string;
  /** Before #550: a person approved one risky action. Read once from an older transcript. */
  confirmationGranted?: boolean;
  /** The highest step `seq` this memory already tells the model about (E38.3). */
  lastSeq?: number;
  /** Actions that may or may not have happened (E38.3): asked again, and no saved approval covers them. */
  unknownSteps?: UnknownStep[];
  /** How many times `finish` was refused for a missing or invalid field of the structured result (E39.5): two at most, then the run ends with what it has. */
  outputAttempts?: number;
  /** Trace screenshots stored so far (#541), for the cap. */
  traceShots?: number;
  /** Screens the next round shows the model; a toolset without screens leaves it. */
  look?: string | null;
  /** The model takes no images: the run continues without screenshots (#366). */
  visionOff?: boolean;
  /** `visionOff` was set because the tier's model has no vision (not because a call refused images). */
  visionOffByTier?: boolean;
}

/** One named value a run returns beside its words (task outputs, E39.5): the toolset checks it, the harness only carries it to the store. */
export interface ResultField {
  value: unknown;
  ok: boolean;
  note?: string;
}

/** What a run returns beside its result text: its fields by key, and whether every one was returned and valid. */
export interface StructuredResult {
  fields: Record<string, ResultField>;
  complete: boolean;
}

/** The patch fields of a finished run that carry a {@link StructuredResult}. */
export function structuredPatch(result: { outputs?: StructuredResult } | null | undefined): { outputs?: Record<string, ResultField>; outputsComplete?: boolean } {
  return result?.outputs ? { outputs: result.outputs.fields, outputsComplete: result.outputs.complete } : {};
}

/** The mutable facts of one job's run: counters, the reason the chunk ends, and what a pause waits for. */
export interface RunState {
  stepCount: number;
  /** Routing and trace rows take a `seq` but are not actions: the sequence runs ahead of `stepCount` by their number. */
  seq: number;
  stall: StallSignal | null;
  stop: StopReason | null;
  /** Which budget ended the run (set with `stop = 'budget'`). */
  budgetKey: BudgetKey | null;
  finished: { success: boolean; result: string; outputs?: StructuredResult } | null;
  /** The wrap-up call is under way (a budget or a stall ended the loop): a toolset that checks what `finish` is given accepts whatever it is. */
  wrappingUp: boolean;
  handoffId: string | null;
  handoffExpiresAt: Date | null;
  handoffAsk: { prompt: string; kind: string; input: string } | null;
}

/** What the stall detector learns from a result beyond its arguments. `secret` steps are not fed to it at all. */
export interface StepExtra {
  url?: string | null;
  title?: string | null;
  contentHash?: string;
  resultKey?: string;
  secret?: boolean;
}
