import { registerErrorCode } from '@marinoscar/platform-api/core';

// The guided profile sign-in routes' error codes (E48.4), registered once at import: the exception filter passes a payload
// `code` through only when it is registered for the exception's status.
registerErrorCode({ code: 'PROFILE_IN_USE', status: 409, description: "A run is using the profile's browser (`details.runId`, `details.runUrl`); sign in once it has finished. A sign-in never interrupts a run." });
registerErrorCode({ code: 'TAKEOVER_HELD', status: 409, description: "Someone else controls the host's desktop; a sign-in cannot start until they release it." });
registerErrorCode({ code: 'SIGNIN_UNAVAILABLE', status: 409, description: 'The host is not an unattended node with a desktop: sign the profile in on that machine.' });
registerErrorCode({ code: 'SIGNIN_HOST_OFFLINE', status: 409, description: 'The host is offline.' });
registerErrorCode({ code: 'PROFILE_NOT_FOUND', status: 404, description: 'The host has no profile of that name.' });
registerErrorCode({ code: 'SIGNIN_NOT_FOUND', status: 404, description: 'No sign-in session of yours has that id.' });
registerErrorCode({ code: 'INVALID_PROFILE', status: 400, description: 'Not a profile name: 1-32 lowercase letters, digits, - and _.' });
