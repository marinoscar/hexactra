import { registerErrorCode } from '@marinoscar/platform-api/core';

// The memory error codes (#551). The platform's filter passes a `code` through
// only when it is registered for the response status.
registerErrorCode({ code: 'MEMORY_NOT_FOUND', status: 404, description: "The memory does not exist or is not the caller's." });
registerErrorCode({ code: 'MEMORY_LABEL_TAKEN', status: 409, description: 'The caller already has an active memory with this label (ignoring case).' });
registerErrorCode({ code: 'MEMORY_LIMIT', status: 409, description: 'The caller already has 500 active memories: archive or delete some first.' });
registerErrorCode({ code: 'MEMORY_NOT_ACTIVE', status: 409, description: 'Only an active memory can be edited, superseded or archived; only an archived one can be unarchived.' });
registerErrorCode({ code: 'MEMORY_HOLDS_SECRET', status: 422, description: 'A field looks like Secret Material (a password, a code, a full card, account or Social Security number). `details.issues` names each field. Keep the last four digits.' });
