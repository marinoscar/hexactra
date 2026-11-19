import type { ActivityOptions, HarnessMemory, RunActivityPhase } from '../types';
import type { UsageDelta } from '../cost';

/** A step row as the harness writes it. Arguments are already redacted. */
export interface NewStep {
  seq: number;
  kind: string;
  action: string | null;
  args?: Record<string, unknown> | null;
  ok: boolean;
  /** `intent` before an action that can commit is sent, `done` after, `unknown` for an intent whose result was never recorded. */
  phase?: 'intent' | 'done' | 'unknown';
  summary: string;
  reasoning?: string | null;
  durationMs?: number;
  questionId?: string | null;
}

/** What may change on a step already written. */
export interface StepPatch {
  args?: Record<string, unknown>;
  summary?: string;
  questionId?: string;
}

export interface StoredStep {
  seq: number;
  kind: string;
  action: string | null;
  args: unknown;
  ok: boolean;
  phase: string;
  summary: string;
}

export interface CheckpointInput {
  memory: HarnessMemory;
  usage: UsageDelta;
}

export interface CommitStepInput {
  memory: HarnessMemory;
  stepCount: number;
  /** The row to write (a new one, or the `intent` row of this `seq` finished). */
  step: NewStep;
  /** The step row already exists as an `intent`: update it instead of creating one. */
  finishesIntent: boolean;
}

export type Transition = 'running' | 'waiting_human' | 'paused';

/**
 * Where the run is kept. Every write of a step and of the memory is conditional on the job still holding the run (E38.3), and a
 * method that returns `false` says it did not: the caller then stops and writes nothing more. Guarantees: `commitStep` writes the
 * step row, the step count and the memory in one transaction (the model's view of the run and the run itself agree after it);
 * `checkpoint` survives a crash (a retried job finds the memory as it was last saved); a job that lost the run writes nothing.
 */
export interface RunStorePort {
  /** Whether this job still holds the run. One small read, asked before each action is sent. */
  holdsRun(): Promise<boolean>;
  /** Saves the memory and adds the chunk's usage to the run's totals. False: this job lost the run. */
  checkpoint(input: CheckpointInput): Promise<boolean>;
  /** The step row, the step count and the memory, atomically. False: this job lost the run. */
  commitStep(input: CommitStepInput): Promise<boolean>;
  /** Saves the memory alone, at once (a crash between two fields finds what was done). False: this job lost the run. */
  saveMemory(memory: HarnessMemory): Promise<boolean>;
  /** Saves the memory, then writes the step as an `intent`. False (nothing written): this job lost the run. */
  openIntent(memory: HarnessMemory, step: NewStep): Promise<boolean>;
  /** A step that is not an action (routing, a trace note, a blocked page): takes a `seq`, never the step count. */
  appendStep(step: NewStep): Promise<void>;
  getStep(seq: number): Promise<(StoredStep & { screenshotKey: string | null }) | null>;
  patchStep(seq: number, patch: StepPatch): Promise<void>;
  /** The highest `seq` written so far, 0 for none. */
  newestSeq(): Promise<number>;
  /** Rows after `afterSeq` (all when undefined) and every row still in phase `intent`, oldest first. */
  stepsToReconcile(afterSeq: number | undefined): Promise<StoredStep[]>;
  markUnknown(seq: number, summary: string): Promise<void>;
  /** What the run page shows as happening now. Best effort and only while the run is running; never throws. */
  setActivity(phase: RunActivityPhase, options: ActivityOptions): Promise<void>;
  /** The tier the run is on and how often it escalated. */
  setTier(tier: string, escalations: number): Promise<void>;
  /** Records a step a person allowed (`runs.confirmed_actions`). */
  appendConfirmedAction(entry: { seq: number; prompt: string; action: string; at: Date }): Promise<void>;
  /** The chat guidance the owner added since the last chunk, each line claimed once across jobs. */
  takeGuidance(): Promise<string[]>;
  /** Moves the run to `waiting_human` (with its handoff) or back to `running`. Active time follows the status. */
  transition(to: Transition, patch?: { handoffId?: string | null; handoffExpiresAt?: Date | null }): Promise<void>;
  /** Pauses the run this job holds. False: it was stopped or finished in the meantime (the job has nothing more to do). */
  pause(patch?: { handoffId?: string | null }): Promise<boolean>;
  /** Ends the run: releases what it holds (the browser), moves the status, notifies the owner. */
  finish(to: 'succeeded' | 'failed' | 'cancelled', patch: { result?: string; error?: string; stopReason?: string; outputs?: Record<string, { value: unknown; ok: boolean; note?: string }>; outputsComplete?: boolean }): Promise<void>;
}
