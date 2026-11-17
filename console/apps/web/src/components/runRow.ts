// How one run reads in the runs list (#423) and what can be done with it. Pure.
import type { PlatformApiClient } from '@marinoscar/platform-web/core';

import { runTaskWith } from '../policies/api';
import type { Run, RunListItem } from '../types/runs';
import { formatCost, isLive, isTerminal } from '../ui';

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
  if (isLive(run.status)) {
    if (!run.startedAt) return null;
    const since = shortDuration(now - Date.parse(run.startedAt));
    return run.status === 'waiting_human' ? `waiting, ${since} in` : `running ${since}`;
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
export function rowCost(run: Pick<Run, 'costUsd' | 'costKnown' | 'modelCalls'>): string | null {
  if (typeof run.costUsd !== 'number') return null;
  const known = run.costKnown ?? true;
  if (run.costUsd <= 0 && !(known && (run.modelCalls ?? 0) > 0)) return null;
  return formatCost(run.costUsd, known);
}

export type RunMenuAction = 'open' | 'again' | 'againWith' | 'cancel' | 'delete';

export const RUN_MENU_LABEL: Record<RunMenuAction, string> = { open: 'Open', again: 'Run again', againWith: 'Run again with…', cancel: 'Cancel', delete: 'Delete' };

export interface RunMenuPermissions {
  /** `runs:write`. */
  canWrite: boolean;
  /** `runs:delete`. */
  canDelete: boolean;
  /** `agent_policies:read`, with at least one policy to offer. */
  canPickPolicy: boolean;
}

/**
 * The actions of a run, in menu order. Run again is not offered for a run an
 * external agent drove (there is nothing to start); Cancel is for a live run,
 * Delete for a finished one. An action the viewer may not take is absent.
 */
export function runMenuActions(run: Pick<Run, 'status' | 'trigger'>, p: RunMenuPermissions): RunMenuAction[] {
  const again = p.canWrite && run.trigger !== 'external';
  return [
    'open' as const,
    ...(again ? (['again'] as const) : []),
    ...(again && p.canPickPolicy ? (['againWith'] as const) : []),
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
