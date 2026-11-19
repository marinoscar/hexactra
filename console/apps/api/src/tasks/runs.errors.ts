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
