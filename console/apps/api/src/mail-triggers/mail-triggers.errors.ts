import { registerErrorCode } from '@marinoscar/platform-api/core';

// The mail trigger error codes (E39.8, #605), registered once at module load. None carries an address, a subject or a message from a provider.
registerErrorCode({ code: 'MAIL_TRIGGER_NOT_FOUND', status: 404, description: "The mail trigger does not exist or is not the caller's." });
registerErrorCode({ code: 'MAIL_TRIGGER_LIMIT', status: 409, description: 'The caller already has the most mail triggers the deployment allows: delete one first. `details.limit`.' });
registerErrorCode({ code: 'MAIL_TRIGGER_CONNECTION_INVALID', status: 400, description: "The connection is not the caller's, is not a Google or Microsoft account, or does not have `mail_read` switched on. `details.reason`: `not_found`, `no_mail_read`, `no_mail_modify`." });
registerErrorCode({ code: 'MAIL_TRIGGER_POLL_TOO_FAST', status: 400, description: 'The poll interval is under the deployment minimum. `details.minPollSeconds`.' });
registerErrorCode({ code: 'MAIL_TRIGGER_INPUTS_INVALID', status: 400, description: 'The input mapping does not fit the task\'s parameters (`details.issues` per parameter key): an unknown or sensitive parameter, a fixed value its rules refuse, or an unsafe capture pattern.' });
registerErrorCode({ code: 'MAIL_TRIGGER_CONNECTION_UNAVAILABLE', status: 409, description: 'The preview could not read the mailbox. `details.reason` is a stable code (`CONNECTION_NEEDS_RECONNECT`, `CONNECTION_PAUSED`, `CAPABILITY_OFF`, `PERMISSION_MISSING`, `RATE_LIMITED`, `PROVIDER_ERROR`).' });
