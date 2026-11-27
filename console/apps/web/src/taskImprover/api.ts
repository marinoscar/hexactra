import type { PlatformApiClient } from '@marinoscar/platform-web/core';

// "Improve this task" (E52.9, #1024): the web's calls. A proposal never changes a task: `markApplied` only records what the task form saved.

export type ImprovementStatus = 'queued' | 'running' | 'ready' | 'failed' | 'applied' | 'dismissed';

export interface Evidence {
  runId: string;
  seqFrom: number;
  seqTo: number;
  finding?: string;
}

export interface ImprovementChange {
  kind: 'add' | 'replace' | 'remove';
  text: string;
  why: string;
  evidence: Evidence[];
}

export interface ImprovementSiteFact {
  site: string;
  kind: 'navigation' | 'timing' | 'quirk';
  text: string;
  evidence: Evidence[];
}

export interface Improvement {
  id: string;
  taskId: string;
  status: ImprovementStatus;
  runIds: string[];
  goalBefore: string;
  proposedGoal: string | null;
  summary: string | null;
  changes?: ImprovementChange[];
  siteFacts?: ImprovementSiteFact[];
  confidence: 'low' | 'medium' | 'high' | null;
  model: string | null;
  usedImages: boolean;
  error: string | null;
  appliedGoal: string | null;
  createdAt: string;
  finishedAt: string | null;
  decidedAt: string | null;
}

export const requestImprovement = (api: PlatformApiClient, taskId: string, runIds?: string[]) =>
  api.post<{ id: string; status: 'queued' }>(`/tasks/${taskId}/improvements`, runIds?.length ? { runIds } : {});
export const listImprovements = (api: PlatformApiClient, taskId: string) => api.get<{ items: Improvement[] }>(`/tasks/${taskId}/improvements`);
export const getImprovement = (api: PlatformApiClient, id: string) => api.get<Improvement>(`/task-improvements/${id}`);
export const dismissImprovement = (api: PlatformApiClient, id: string) => api.post<Improvement>(`/task-improvements/${id}/dismiss`, {});
export const markApplied = (api: PlatformApiClient, id: string, goal: string) => api.post<Improvement>(`/task-improvements/${id}/applied`, { goal });

/** Where a proposal is reviewed. */
export const improvementPath = (taskId: string, id: string) => `/tasks/${taskId}/improvements/${id}`;
/** The task form, prefilled with a proposal's goal; `facts` are the indexes of the site facts the owner ticked. */
export const useGoalPath = (taskId: string, id: string, facts: number[]) => `/tasks/${taskId}/edit?improvement=${id}${facts.length ? `&facts=${facts.join(',')}` : ''}`;

/** Ask for a proposal; a 409 (one is being made) answers the one in progress. Returns its id. */
export async function startImprovement(api: PlatformApiClient, taskId: string, runIds?: string[]): Promise<string> {
  try {
    return (await requestImprovement(api, taskId, runIds)).id;
  } catch (e) {
    const details = (e as { details?: { id?: unknown }; body?: { details?: { id?: unknown } } }) ?? {};
    const id = details.details?.id ?? details.body?.details?.id;
    if (typeof id === 'string') return id;
    throw e;
  }
}
