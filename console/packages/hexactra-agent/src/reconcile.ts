import type { RunStorePort } from './ports';
import type { HarnessMemory } from './types';

// Reconcile on start (E38.3): a job that finds a run `running` and not cleanly handed on (a retried job) carries on from the last
// step that really happened. The step rows are the truth, the memory (what the model is told) may lag them, and a step still in
// `intent` is one whose result was never recorded: it may or may not have happened, and it is never repeated blindly.

/** An action that may or may not have happened. Kept in the memory so a saved approval cannot cover the same target again. */
export interface UnknownStep {
  seq: number;
  what: string;
  category: string | null;
  label: string | null;
  host: string | null;
}

/** The line the model reads when the run was interrupted. */
export const INTERRUPTED_LINE = 'The run was interrupted and continued. Look at the page before acting.';

/** The model's instruction for a step that may or may not have happened. */
export function unknownLine(seq: number, what: string): string {
  return `Step ${seq} (${what}) may or may not have happened. Do not repeat it. Check the page and the account's recent activity; if you cannot tell, ask the owner.`;
}

/** Rows `record()` writes for the model's log; routing, trace and guidance rows are not part of it. */
function logged(row: { kind: string; action: string | null }): boolean {
  return row.kind === 'action' || row.kind === 'observe' || row.kind === 'finish' || (row.kind === 'handoff' && row.action === null);
}

function trim(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export interface Reconciled {
  /** Step rows the memory lacked, now in its log (they count as actions: the run's `step_count` grows by this). */
  appended: number;
  /** Steps that were still `intent`: now `unknown`. */
  unknown: UnknownStep[];
  /** The run was interrupted (the last job never ended cleanly), or steps were missing from the memory. */
  recovered: boolean;
}

function argsOf(row: { args: unknown }): Record<string, unknown> {
  const raw = row.args && typeof row.args === 'object' && !Array.isArray(row.args) ? (row.args as Record<string, unknown>) : {};
  // The intent's own notes are for this module, not for the model's log.
  const { gate: _gate, what: _what, ...rest } = raw;
  return rest;
}

/**
 * Brings `memory` up to the step rows. Mutates the memory (log, `lastSeq`, the confirmation markers, `unknownSteps`) and marks
 * `intent` rows `unknown`; the caller saves the memory and adds `appended` to the run's `step_count`.
 */
export async function reconcileSteps(store: RunStorePort, input: { memory: HarnessMemory; stepCount: number; interrupted: boolean }): Promise<Reconciled> {
  const { memory } = input;
  const baseline = memory.lastSeq;
  const rows = await store.stepsToReconcile(baseline);
  const newest = await store.newestSeq();
  const unknown: UnknownStep[] = [];
  const lines: string[] = [];
  let appended = 0;
  for (const row of rows) {
    if (!logged(row)) continue;
    const n = input.stepCount + appended + 1;
    appended += 1;
    const raw = row.args && typeof row.args === 'object' && !Array.isArray(row.args) ? (row.args as Record<string, unknown>) : {};
    const args = argsOf(row);
    const shown = Object.keys(args).length ? ` ${JSON.stringify(args)}` : '';
    if (row.phase === 'intent') {
      const gate = (raw.gate ?? null) as { category?: string | null; label?: string | null; host?: string | null } | null;
      const what = typeof raw.what === 'string' ? raw.what : (row.action ?? row.kind);
      await store.markUnknown(row.seq, trim(`unknown: the job stopped before the result was recorded (${what})`, 1_900));
      unknown.push({ seq: n, what, category: gate?.category ?? null, label: gate?.label ?? null, host: gate?.host ?? null });
      lines.push(`${n}. ${row.action ?? row.kind}${shown} → UNKNOWN: the job stopped before the result was recorded`);
    } else {
      lines.push(`${n}. ${row.action ?? row.kind}${shown} → ${row.ok ? 'ok' : 'FAILED'}: ${trim(row.summary, 300)}`);
    }
  }
  const recovered = input.interrupted || appended > 0;
  if (appended > 0) memory.log.push(...lines);
  if (recovered) {
    memory.log.push(INTERRUPTED_LINE);
    // A fresh screenshot starts the next round whenever screenshots are on.
    memory.look ??= 'page';
  }
  if (unknown.length > 0) {
    // The approval was for the step that may have happened: it is spent. The gate asks again for that target.
    memory.confirmedTarget = null;
    memory.pendingConfirmation = null;
    memory.gatePending = null;
    memory.unknownSteps = [...(memory.unknownSteps ?? []), ...unknown].slice(-20);
    for (const u of unknown) memory.log.push(unknownLine(u.seq, u.what));
  }
  memory.lastSeq = Math.max(baseline ?? 0, newest);
  return { appended, unknown, recovered };
}

/** Whether a gated target had an attempt that may or may not have happened in this run: no saved approval covers it (#555). */
export function targetUnknown(memory: HarnessMemory, target: { category: string | null; label: string | null; host: string | null }): boolean {
  return (memory.unknownSteps ?? []).some((u) => u.category === target.category && u.label === target.label && u.host === target.host);
}

/** The target's click went ahead and its result is recorded: its last attempt is no longer unknown. */
export function clearUnknown(memory: HarnessMemory, target: { category: string | null; label: string | null; host: string | null }): void {
  if (!memory.unknownSteps?.length) return;
  memory.unknownSteps = memory.unknownSteps.filter((u) => !(u.category === target.category && u.label === target.label && u.host === target.host));
}
