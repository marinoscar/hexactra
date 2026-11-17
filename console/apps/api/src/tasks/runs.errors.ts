import { registerErrorCode } from '@marinoscar/platform-api/core';

// The typed error codes of the runs list (#420). Registered at import, so the
// platform's exception filter keeps them and the OpenAPI document lists them.
registerErrorCode({ code: 'INVALID_FILTER', status: 400, description: 'A run filter contradicts itself: `status` together with `state`, or `from` after `to`.' });
registerErrorCode({ code: 'INVALID_CURSOR', status: 400, description: 'The `cursor` is not one a runs page returned as `nextCursor`. Start again from the first page.' });
// Deleting runs (#421).
registerErrorCode({ code: 'RUN_NOT_FOUND', status: 404, description: "The run does not exist or is not the caller's." });
registerErrorCode({ code: 'RUN_LIVE', status: 409, description: 'The run is queued, running or waiting for a person: a live run is never deleted. Cancel it first.' });
registerErrorCode({ code: 'COUNT_CHANGED', status: 409, description: 'The finished runs that match the filter differ by more than 5 % from `expectedCount`; `details.matched` is the real count. Nothing was deleted.' });
