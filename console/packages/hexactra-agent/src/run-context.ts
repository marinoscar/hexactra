// The object every part of a run receives (E38.5): ports and plain state, never a service. Tools, gates and the loop take what they
// need from it; nothing in the harness closes over a framework object or a module-level singleton.
import type { ActiveClock } from './active-time';
import type { BudgetTracker, BudgetKey } from './budget';
import type { PriceTable, RunUsage } from './cost';
import type { Picture, Ports, QuestionSpec } from './ports';
import type { StallState } from './stall';
import type { ActivityOptions, GateTarget, HarnessMemory, RunActivityPhase, RunState, StepExtra, Tier } from './types';

/** The facts about the run that never change while a job works. Plain values: no Prisma row. */
export interface RunInfo {
  id: string;
  userId: string;
  orgId: string | null;
  goal: string;
  trigger: string | null;
  taskId: string | null;
  conversationId: string | null;
}

/**
 * One job's run. `M` is the memory (the harness's fields plus a toolset's), `X` is what the toolset and the host add (a browser
 * port, the site list, saved logins). The bound methods are the harness services; they take no argument the context already holds.
 */
export interface RunContext<M extends HarnessMemory = HarnessMemory, X = unknown> {
  readonly run: RunInfo;
  readonly ports: Ports;
  memory: M;
  state: RunState;
  tracker: BudgetTracker;
  stall: StallState;
  /** The tier the run is on; moved at chunk boundaries only. */
  tier: Tier;
  startTier: Tier;
  /** The run's active-time fields as last written: they drive the time budget (#399). */
  active: ActiveClock;
  /** Usage of the chunk in progress, saved at its end. */
  usage: RunUsage;
  prices: PriceTable;
  /** The job hands the run on once it has worked this long (a little before its lease runs out). */
  hopAfterMs: number;
  startedAt: number;
  ext: X;

  /** What the run page shows as happening now. Best effort: never fails the run. */
  setActivity(phase: RunActivityPhase, options?: ActivityOptions): Promise<void>;
  /** The first exhausted budget now (active time read off the clock), or null (#404). */
  budgetCheck(): BudgetKey | null;
  stopForBudget(key: BudgetKey): void;
  /** Checks the budget; when spent, ends the chunk and returns the text the model reads, else null. */
  budgetStop(): string | null;
  /** A budget newly over `warnAtPercent`: logs it once and queues the line the next round's input carries. True: the chunk should end. */
  noteWarnings(): boolean;
  sendOverNotice(): Promise<void>;
  /** The refusal the model reads when this job no longer holds the run, Stop or Pause was pressed, or a budget is spent; null to go ahead. */
  preflight(): Promise<string | null>;
  /**
   * Records one step: the model's log line, the stall feed, the budget and the step row, atomically and only while this job holds
   * the run. `intentSeq` finishes an intent row opened earlier.
   */
  record(kind: string, action: string | null, args: Record<string, unknown> | null, ok: boolean, summary: string, started: number, reasoning?: string, extra?: StepExtra, intentSeq?: number | null): Promise<void>;
  /** An action that can commit something is about to be sent (E38.3): its step row is written first, in phase `intent`. Null: the job lost the run. */
  openIntent(action: string, args: Record<string, unknown>, gate: GateTarget | null, what?: string): Promise<number | null>;
  /** A record of the trace that is not an action: takes a `seq`, never the step count. */
  note(kind: string, action: string | null, summary: string, extra?: { questionId?: string | null; ok?: boolean }): Promise<number>;
  /** A routing step (#405): a tier change or a provider fallback. */
  routing(from: string, to: string, reason: string, extra?: Record<string, unknown>): Promise<void>;
  /** Opens a question for a person and ends the chunk on it. False when no person could be asked. */
  askPerson(spec: QuestionSpec, started: number): Promise<boolean>;
  /** Saves the memory and the chunk's usage (a checkpoint). */
  checkpoint(): Promise<void>;
  shoot(moment: string): Promise<Picture>;
  attachShot(seq: number, moment: string, picture: Picture): Promise<void>;
}

/** Any run context: what the registry and the wrapper accept. A tool is written against its own, narrower context type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyContext = RunContext<any, any>;
