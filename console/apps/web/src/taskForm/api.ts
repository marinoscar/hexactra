// The task form's HTTP calls (#427): one typed function per request, so the
// routes the form uses are in one place (the capability parity test reads them here).
import type { PlatformApiClient } from '@marinoscar/platform-web/core';

import type { ScheduleItemInput } from '../schedule/draft';
import type { CreateTaskBody, TaskWithSchedules } from './values';

/** `GET /tasks/:id?include=summary`: the task with its schedules. */
export function getTask(api: PlatformApiClient, id: string): Promise<TaskWithSchedules> {
  return api.get<TaskWithSchedules>(`/tasks/${encodeURIComponent(id)}?include=summary`);
}

/** `POST /tasks`: the task and its `schedules[]` in one transaction. */
export function createTask(api: PlatformApiClient, body: CreateTaskBody): Promise<TaskWithSchedules> {
  return api.post<TaskWithSchedules>('/tasks', body);
}

/** `PATCH /tasks/:id` with the changed fields only. */
export function updateTask(api: PlatformApiClient, id: string, patch: Partial<CreateTaskBody>): Promise<TaskWithSchedules> {
  return api.patch<TaskWithSchedules>(`/tasks/${id}`, patch);
}

/** `PUT /tasks/:id/schedules`: an item with an id updates, one without creates, an unlisted schedule is deleted. */
export function replaceTaskSchedules(api: PlatformApiClient, id: string, schedules: ScheduleItemInput[]): Promise<TaskWithSchedules> {
  return api.put<TaskWithSchedules>(`/tasks/${id}/schedules`, { schedules });
}

/** `DELETE /tasks/:id`: its schedules go with it; its runs are kept. */
export function deleteTask(api: PlatformApiClient, id: string): Promise<void> {
  return api.delete<void>(`/tasks/${id}`);
}
