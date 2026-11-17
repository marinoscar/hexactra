// Deleting runs (#421): the body of `POST /runs/delete` and what it answers.
// "Which runs" is #420's `runFilterSchema`, so what the list shows with a
// filter and what a delete by that filter removes cannot differ.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { TERMINAL_RUN_STATUSES } from './run-status';
import { runFilterSchema, type RunFilter } from './runs.schemas';

/** The most ids one `POST /runs/delete` takes. */
export const RUNS_DELETE_IDS_MAX = 500;
/** A filter that matches more finished runs than this is deleted by a queue job (202), not in the request. */
export const RUNS_DELETE_SYNC_MAX = 500;
/** Rows deleted per transaction. */
export const RUNS_DELETE_BATCH = 200;
/** How far the matching count may be from `expectedCount` (a fraction of it) before the delete is refused. */
export const RUNS_DELETE_COUNT_TOLERANCE = 0.05;

/**
 * The filter of a delete. Strict, unlike the list's query: an unknown key is a
 * 400, never ignored, so a misspelt `taskId` cannot widen a delete to every run.
 */
export const runDeleteFilterSchema = runFilterSchema.strict();

/**
 * True when the filter narrows nothing among finished runs: no key at all, or
 * only `state=finished` / every finished status. Such a filter means "all my
 * finished runs" and needs `expectedCount`.
 */
export function selectsEveryFinishedRun(filter: RunFilter): boolean {
  const { status, state, ...rest } = filter;
  if (Object.values(rest).some((v) => v !== undefined)) return false;
  // Both: `runWhere` rejects the filter (INVALID_FILTER).
  if (state && status) return false;
  if (state) return state === 'finished';
  return !status || TERMINAL_RUN_STATUSES.every((s) => status.includes(s));
}

/** True when `matched` is more than 5 % away from the count the caller agreed to. */
export function countChanged(expected: number, matched: number): boolean {
  return Math.abs(matched - expected) > expected * RUNS_DELETE_COUNT_TOLERANCE;
}

export const deleteRunsSchema = z
  .strictObject({
    ids: z
      .array(z.uuid())
      .min(1)
      .max(RUNS_DELETE_IDS_MAX)
      .refine((v) => new Set(v.map((id) => id.toLowerCase())).size === v.length, { message: 'ids must be unique' })
      .optional()
      .describe(`The runs to delete: 1 to ${RUNS_DELETE_IDS_MAX} unique ids. Not together with \`filter\`.`),
    filter: runDeleteFilterSchema
      .optional()
      .describe(
        'Delete every FINISHED run (succeeded, failed, cancelled) that matches: the same filter as `GET /runs`. A live status in it is ignored, never deleted. Not together with `ids`. `{}` means all finished runs and needs `expectedCount`.',
      ),
    expectedCount: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('With `filter`: the number of runs the caller expects to delete (the count it showed). When the real count differs by more than 5 %, nothing is deleted and the answer is 409 `COUNT_CHANGED`.'),
  })
  .superRefine((body, ctx) => {
    if ((body.ids === undefined) === (body.filter === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'Send exactly one of ids or filter' });
      return;
    }
    if (body.ids && body.expectedCount !== undefined) ctx.addIssue({ code: 'custom', path: ['expectedCount'], message: 'expectedCount goes with filter, not with ids' });
    if (body.filter && body.expectedCount === undefined && selectsEveryFinishedRun(body.filter)) {
      ctx.addIssue({ code: 'custom', path: ['expectedCount'], message: 'A filter that selects every finished run needs expectedCount' });
    }
  });
export class DeleteRunsDto extends createZodDto(deleteRunsSchema) {}

/** 200 of `POST /runs/delete`: what was deleted in the request. */
export const runsDeletedResponseSchema = z.object({
  deleted: z.number().int().describe('Runs deleted, with their steps and questions'),
  costUsd: z.number().nullable().describe('The recorded model spend (USD) of the deleted runs; null when none of them made a model call'),
  skippedLive: z.array(z.uuid()).describe('Runs left alone because they are queued, running or waiting for a person: cancel them first'),
  notFound: z.array(z.uuid()).describe("With `ids`: ids that are not the caller's runs (missing, already deleted, or another user's). Always empty with `filter`"),
});
export class RunsDeletedResponseDto extends createZodDto(runsDeletedResponseSchema) {}

/** 202 of `POST /runs/delete`: the filter matched more than 500 runs, a queue job deletes them. */
export const runsDeleteQueuedResponseSchema = z.object({
  jobId: z.uuid().describe('The `browser.runs.delete` job that deletes the runs'),
  matched: z.number().int().describe('Finished runs that matched when the request was made; runs created later are never deleted by the job'),
  costUsd: z.number().nullable().describe('The recorded model spend (USD) of the matched runs; null when none of them made a model call'),
});
export class RunsDeleteQueuedResponseDto extends createZodDto(runsDeleteQueuedResponseSchema) {}
