import { registerErrorCode } from '@marinoscar/platform-api/core';

// The skill error codes (#1008). The platform's filter passes a `code` through only when it is registered for the response status.
registerErrorCode({ code: 'SKILL_NOT_FOUND', status: 404, description: "The skill does not exist or is not the caller's." });
registerErrorCode({ code: 'SKILL_NAME_TAKEN', status: 409, description: 'The caller already has a skill with this name (ignoring case).' });
registerErrorCode({ code: 'SKILL_LIMIT', status: 409, description: 'The caller already has 100 skills: delete some first.' });
registerErrorCode({ code: 'SKILL_SECRET', status: 400, description: 'A field looks like Secret Material (a password, a code, a token, a full card, account, IBAN or Social Security number). `details.issues` names each field.' });
registerErrorCode({ code: 'INVALID_SITE', status: 400, description: 'A site is not a registrable domain such as google.com. `details.site` is the value refused.' });
