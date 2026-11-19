// What the schedule editor edits, and how it maps to the API's schedule item
// (`POST /tasks` `schedules[]`, `PUT /tasks/:id/schedules`, `POST /schedules`,
// `PATCH /schedules/:id`).

import { DEFAULT_CRON } from './model';

/** One schedule being edited. Every field is the API's; `policyId: null` follows the task's policy. */
export interface ScheduleDraft {
  /** The saved schedule's id; absent on a new one. */
  id?: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  concurrency: 'skip' | 'queue';
  policyId: string | null;
  /** Preset values for the task's parameters (#556), by key; absent when the schedule has none. */
  inputs?: Record<string, string>;
}

/** A schedule item as the API takes it in a task's schedule set. */
export interface ScheduleItemInput {
  id?: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  concurrency: 'skip' | 'queue';
  policyId: string | null;
  /** Preset values for the task's parameters (#552); `null` clears them, absent keeps them. */
  inputs?: Record<string, string> | null;
}

/** A new schedule: every day at 09:00 in the profile time zone, active, skipping overlaps, on the task's policy. */
export function newScheduleDraft(profileTimezone: string): ScheduleDraft {
  return { cron: DEFAULT_CRON, timezone: profileTimezone, enabled: true, concurrency: 'skip', policyId: null };
}

/** The draft of a saved schedule (a `GET /schedules` row or a task summary's schedule). */
export function draftFromSchedule(s: { id: string; cron: string; timezone: string; enabled: boolean; concurrency?: 'skip' | 'queue'; policyId?: string | null; inputs?: Record<string, string> | null }): ScheduleDraft {
  return { id: s.id, cron: s.cron, timezone: s.timezone, enabled: s.enabled, concurrency: s.concurrency ?? 'skip', policyId: s.policyId ?? null, ...(s.inputs && Object.keys(s.inputs).length ? { inputs: { ...s.inputs } } : {}) };
}

/** The request item of a draft: with `id` the API updates that schedule, without it creates one. */
export function draftToItem(draft: ScheduleDraft): ScheduleItemInput {
  return {
    ...(draft.id ? { id: draft.id } : {}),
    cron: draft.cron.trim(),
    timezone: draft.timezone,
    enabled: draft.enabled,
    concurrency: draft.concurrency,
    policyId: draft.policyId,
    // Only a schedule that has, or had, preset values sends them (an empty set clears them).
    ...(draft.inputs !== undefined ? { inputs: Object.keys(draft.inputs).length ? draft.inputs : null } : {}),
  };
}
