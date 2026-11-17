import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';
import { useMemo } from 'react';

import { deleteTaskBody } from './taskList';
import { runTaskWith } from '../policies/api';
import type { Task, TaskSchedulesChanged, TaskSummary } from '../types/tasks';
import { useConfirm } from '../ui';

/** What an action needs of a task: a list row and the detail page's task both fit. */
export type TaskRef = Pick<Task, 'id' | 'name'> & { summary?: TaskSummary };

/** A task action that failed. The message names the task; `gone` means the task no longer exists. */
export class TaskActionError extends Error {
  constructor(
    message: string,
    readonly gone: boolean,
  ) {
    super(message);
    this.name = 'TaskActionError';
  }
}

/** The message of a task that was deleted elsewhere. */
export const TASK_GONE = 'This task no longer exists';

function failure(e: unknown, what: string, task: TaskRef): TaskActionError {
  if (isPlatformApiError(e) && e.status === 404) return new TaskActionError(`${TASK_GONE}: “${task.name}”.`, true);
  const reason = e instanceof Error && e.message ? `: ${e.message}` : '';
  return new TaskActionError(`Could not ${what} “${task.name}”${reason}`, false);
}

export interface TaskActions {
  /**
   * The Scheduled switch: off pauses every schedule of the task
   * (`POST /tasks/:id/schedules/pause`), on resumes them (`…/resume`).
   * Resolves to the task with its new summary.
   */
  setScheduled: (task: TaskRef, on: boolean) => Promise<TaskSchedulesChanged>;
  /** Start a run now, under `policyId` for this run only (the task's policy when omitted). */
  run: (task: TaskRef, policyId?: string) => Promise<{ id: string }>;
  /** Asks before starting a second run of a task that is already running. Resolves to whether to go on. */
  confirmRunAgain: (task: TaskRef) => Promise<boolean>;
  /** Asks, then deletes the task. Resolves to false when the person cancelled. */
  remove: (task: TaskRef) => Promise<boolean>;
}

/**
 * The actions of a task, shared by the Tasks list and the task page: pause or
 * resume its schedules, run it, delete it. Each rejects with a
 * {@link TaskActionError}; showing the result (a snackbar, a banner, a
 * navigation) is the caller's. Needs `ConfirmProvider`.
 */
export function useTaskActions(): TaskActions {
  const { api } = usePlatformHost();
  const confirm = useConfirm();
  return useMemo<TaskActions>(
    () => ({
      setScheduled: (task, on) =>
        api.post<TaskSchedulesChanged>(`/tasks/${task.id}/schedules/${on ? 'resume' : 'pause'}`, {}).catch((e: unknown) => {
          throw failure(e, on ? 'resume the schedule of' : 'pause the schedule of', task);
        }),
      run: (task, policyId) =>
        runTaskWith(api, task.id, policyId).catch((e: unknown) => {
          throw failure(e, 'start a run of', task);
        }),
      confirmRunAgain: (task) => confirm({ title: `Run “${task.name}” again?`, body: 'This task is already running. Start another run?', confirmLabel: 'Run again' }),
      remove: async (task) => {
        const ok = await confirm({ title: `Delete “${task.name}”?`, body: deleteTaskBody(task.summary), confirmLabel: 'Delete', destructive: true });
        if (!ok) return false;
        try {
          await api.delete(`/tasks/${task.id}`);
        } catch (e) {
          // Already gone is what the person wanted.
          if (isPlatformApiError(e) && e.status === 404) return true;
          throw failure(e, 'delete', task);
        }
        return true;
      },
    }),
    [api, confirm],
  );
}
