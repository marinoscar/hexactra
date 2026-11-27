// How one run reads in the runs list (#423) and what can be done with it. Pure.
import type { PlatformApiClient } from '@marinoscar/platform-web/core';

import { runTaskWith } from '../policies/api';
import type { Run, RunListItem } from '../types/runs';
import { formatCost, isLive, isTerminal, type ConfirmOptions } from '../ui';

/** "45 s", "12 min", "2 h 5 min". */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** How long the run took (`finishedAt − startedAt`), "running 2 min" while it is live, null before it starts. */
export function runDuration(run: Pick<Run, 'status' | 'startedAt' | 'createdAt' | 'finishedAt'>, now: number): string | null {
  if (run.status === 'paused') return 'paused';
  if (isLive(run.status)) {
    if (!run.startedAt) return null;
    const since = shortDuration(now - Date.parse(run.startedAt));
    return `running ${since}`;
  }
  const start = Date.parse(run.startedAt ?? run.createdAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Number.NaN;
  return Number.isNaN(start) || Number.isNaN(end) ? null : shortDuration(end - start);
}

/** What started the run, in words: "manual", "schedule", "API", "MCP", "by packer" for an external agent. */
export function triggerWords(run: Pick<Run, 'trigger' | 'actor'>): string {
  if (run.trigger === 'external') return `by ${run.actor ?? 'an external agent'}`;
  if (run.trigger === 'api' || run.trigger === 'mcp') return run.trigger.toUpperCase();
  return run.trigger;
}

/**
 * A run's cost in the list: "$0.42", "≥ $2.01" when part could not be priced,
 * null when there is none to show (no model call yet, or a deployment without
 * model prices, where the figure would be "≥ $0.00").
 */
/** A run's tokens (input + output) as `1,234` or `45.6k`; null for a run that made no model call. */
export function rowTokens(run: Pick<Run, 'inputTokens' | 'outputTokens'>): string | null {
  const total = (run.inputTokens ?? 0) + (run.outputTokens ?? 0);
  if (total <= 0) return null;
  return total >= 10_000 ? `${(total / 1_000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k` : total.toLocaleString('en-US');
}

export function rowCost(run: Pick<Run, 'costUsd' | 'costKnown' | 'modelCalls'>): string | null {
  if (typeof run.costUsd !== 'number') return null;
  const known = run.costKnown ?? true;
  if (run.costUsd <= 0 && !(known && (run.modelCalls ?? 0) > 0)) return null;
  return formatCost(run.costUsd, known);
}

export type RunMenuAction = 'open' | 'again' | 'againWith' | 'exportPdf' | 'exportJson' | 'cancel' | 'delete';

export const RUN_MENU_LABEL: Record<RunMenuAction, string> = { open: 'Open', again: 'Run again', againWith: 'Run again with…', exportPdf: 'Export PDF', exportJson: 'Export JSON', cancel: 'Cancel', delete: 'Delete' };

export interface RunMenuPermissions {
  /** `runs:write`. */
  canWrite: boolean;
  /** `runs:delete`. */
  canDelete: boolean;
  /** `agent_policies:read`, with at least one policy to offer. */
  canPickPolicy: boolean;
  /** `runs:read` and a client that can download: Export PDF and Export JSON (#544). Default false. */
  canExport?: boolean;
}

/**
 * The actions of a run, in menu order. Run again is not offered for a run an
 * external agent drove (there is nothing to start); Export is for any run (a
 * live one's file is partial); Cancel is for a live run,
 * Delete for a finished one. An action the viewer may not take is absent.
 */
export function runMenuActions(run: Pick<Run, 'status' | 'trigger'>, p: RunMenuPermissions): RunMenuAction[] {
  const again = p.canWrite && run.trigger !== 'external';
  return [
    'open' as const,
    ...(again ? (['again'] as const) : []),
    ...(again && p.canPickPolicy ? (['againWith'] as const) : []),
    ...(p.canExport ? (['exportPdf', 'exportJson'] as const) : []),
    ...(p.canWrite && isLive(run.status) ? (['cancel'] as const) : []),
    ...(p.canDelete && isTerminal(run.status) ? (['delete'] as const) : []),
  ];
}

/**
 * The policy "Run again" repeats: the original run's, only when it was chosen
 * for that run ("Run with…", `source: 'run'`). Otherwise none, so the task's
 * or the user's current policy applies.
 */
export function runAgainPolicy(run: Pick<Run, 'policy'>): string | undefined {
  return run.policy?.source === 'run' ? run.policy.id : undefined;
}

/**
 * Starts the run again: a task's run through the task, an ad-hoc run with the
 * same goal, profile and machine. `policyId` is a "Run again with…" choice;
 * without it `runAgainPolicy` decides.
 */
export function runAgain(api: PlatformApiClient, run: RunListItem, policyId?: string): Promise<{ id: string }> {
  const policy = policyId ?? runAgainPolicy(run);
  if (run.taskId) return runTaskWith(api, run.taskId, policy);
  return api.post<{ id: string }>('/runs', {
    goal: run.goal,
    profile: run.profile,
    ...(run.hostId ? { hostId: run.hostId, hostFallback: run.hostFallback ?? true } : {}),
    ...(policy ? { policyId: policy } : {}),
  });
}

/** How many steps the owner confirmed that a run carried out (#540): a list row has the count, a full run the list. */
export function confirmedCount(run: Pick<Run, 'confirmedActions'>): number {
  const c = run.confirmedActions;
  return typeof c === 'number' ? c : Array.isArray(c) ? c.length : 0;
}

/**
 * The question "Run again" asks first for a run that carried out a step its owner confirmed (#540),
 * succeeded or not; null when it has none. `prompt` names the step when it is known.
 */
export function runAgainQuestion(count: number, prompt?: string | null): ConfirmOptions | null {
  if (count <= 0) return null;
  const step = prompt ? `a step you confirmed: '${prompt.length > 160 ? `${prompt.slice(0, 159)}…` : prompt}'` : 'a step you confirmed';
  return { title: 'Run this again?', body: `This run already carried out ${step}. Running it again may do it twice.`, confirmLabel: 'Run again', cancelLabel: 'Cancel' };
}

/** The same question for a run as the API gives it (the last confirmed step's prompt, when the run carries the list). */
export function runAgainQuestionFor(run: Pick<Run, 'confirmedActions'>): ConfirmOptions | null {
  const c = run.confirmedActions;
  return runAgainQuestion(confirmedCount(run), Array.isArray(c) ? c.at(-1)?.prompt : null);
}
