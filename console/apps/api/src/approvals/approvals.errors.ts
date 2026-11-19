import { registerErrorCode } from '@marinoscar/platform-api/core';

// Saved approval error codes (#554), registered once at module load.
registerErrorCode({ code: 'APPROVAL_RULE_NOT_FOUND', status: 404, description: "The saved approval does not exist or is not the caller's." });
registerErrorCode({ code: 'RULE_CANNOT_WIDEN', status: 400, description: 'A saved approval can only be narrowed: a limit may be set or lowered, an expiry shortened, a scope added, or the rule disabled. Answer a new question to make a looser rule.' });
registerErrorCode({ code: 'APPROVAL_RULE_INVALID', status: 422, description: "A saved approval could not be made from this answer: the question is not rememberable, or a scope it names is not the question's." });
registerErrorCode({ code: 'CARD_RULE_NEEDS_AMOUNT_LIMIT', status: 422, description: "A saved approval for a card needs an amount limit (unlike other approvals): the answer was refused so nothing was approved or remembered." });
registerErrorCode({ code: 'APPROVAL_RULE_DUPLICATE', status: 409, description: 'The caller already has the same saved approval with that scope.' });
