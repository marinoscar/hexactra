import { registerErrorCode } from '@marinoscar/platform-api/core';

// The typed error codes of the runs list (#420). Registered at import, so the
// platform's exception filter keeps them and the OpenAPI document lists them.
registerErrorCode({ code: 'INVALID_FILTER', status: 400, description: 'A run filter contradicts itself: `status` together with `state`, or `from` after `to`.' });
registerErrorCode({ code: 'INVALID_CURSOR', status: 400, description: 'The `cursor` is not one a runs page returned as `nextCursor`. Start again from the first page.' });
