import { registerErrorCode } from '@marinoscar/platform-api/core';

// The typed error codes of the runs list (#420). Registered at import, so the
// platform's exception filter keeps them and the OpenAPI document lists them.
registerErrorCode({ code: 'INVALID_FILTER', status: 400, description: 'A run filter contradicts itself: `status` together with `state`, or `from` after `to`.' });
registerErrorCode({ code: 'INVALID_CURSOR', status: 400, description: 'The `cursor` is not one a runs page returned as `nextCursor`. Start again from the first page.' });
// Deleting runs (#421).
registerErrorCode({ code: 'RUN_NOT_FOUND', status: 404, description: "The run does not exist or is not the caller's." });
registerErrorCode({ code: 'RUN_LIVE', status: 409, description: 'The run is queued, running, waiting for a person or paused: a live run is never deleted. Cancel it first.' });
registerErrorCode({ code: 'COUNT_CHANGED', status: 409, description: 'The finished runs that match the filter differ by more than 5 % from `expectedCount`; `details.matched` is the real count. Nothing was deleted.' });
// Pause and Resume (E38.2, #583).
registerErrorCode({ code: 'RUN_FINISHED', status: 409, description: 'The run has finished (succeeded, failed or cancelled): it cannot be paused.' });
registerErrorCode({ code: 'RUN_NOT_PAUSED', status: 409, description: 'The run is not paused: there is nothing to resume.' });
registerErrorCode({ code: 'RUN_NOT_PAUSABLE', status: 409, description: 'An external agent drives this run through its own browser session: the console cannot pause it.' });
// Exporting a run (#542).
registerErrorCode({ code: 'EXPORT_TOO_LARGE', status: 413, description: 'The run file would be over 50 MB with its screenshots embedded. Export it with `screenshots=none`.' });
registerErrorCode({ code: 'EXPORT_RATE_LIMITED', status: 429, description: 'More than 10 run exports in a minute; `details.retryAfterS` says when to try again.' });
// The signed report link (E39.6, #603).
registerErrorCode({ code: 'REPORT_LINK_INVALID', status: 404, description: 'The report link is not valid: expired, altered, for a run that no longer exists, or for another user\'s run. All look the same on purpose.' });
// Batch runs (E51.1, #1006).
registerErrorCode({ code: 'BATCH_TOO_SMALL', status: 400, description: 'A batch has at least 2 rows. For one row, start a run of the task.' });
registerErrorCode({ code: 'BATCH_TOO_LARGE', status: 400, description: 'A batch has more rows than `runs.batchMaxRows` (default 25); `details.max` is the limit.' });
registerErrorCode({ code: 'BATCH_INPUTS_MISSING', status: 400, description: 'A row has no value for a required parameter (a batch never opens the missing-values form); `details.rows` is `[{ row, missing: [labels] }]`. Nothing was written.' });
registerErrorCode({ code: 'BATCH_SENSITIVE_PARAMETER', status: 400, description: 'The task has a parameter asked for securely: it cannot run as a batch in this version.' });
registerErrorCode({ code: 'BATCH_DUPLICATE_ROW', status: 400, description: 'Two rows have the same resolved values; `details.rows` names both. Nothing was written.' });
registerErrorCode({ code: 'BATCH_NO_ROWS', status: 400, description: 'Start keeps at least one row.' });
registerErrorCode({ code: 'BATCH_UNKNOWN_ROW', status: 400, description: 'A row to keep is not a row of this batch.' });
registerErrorCode({ code: 'BATCH_NOT_FOUND', status: 404, description: "The batch does not exist or is not the caller's." });
registerErrorCode({ code: 'BATCH_LIVE', status: 409, description: 'A batch of this task is still live, or (in a chat) a run or batch of the chat is. Wait for it to end or cancel it.' });
registerErrorCode({ code: 'BATCH_NOT_IN_REVIEW', status: 409, description: 'Only a batch waiting for review can be started.' });
