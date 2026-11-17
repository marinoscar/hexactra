import { registerErrorCode } from '@marinoscar/platform-api/core';

// The agent policy error codes (#401). The platform's filter passes a `code`
// through only when it is registered for the response status, so they are
// declared here, once, at module load (before the application is created).
registerErrorCode({ code: 'POLICY_PIN_INVALID', status: 400, description: 'A model pin names an unknown or disabled model, or one without tools and vision.' });
registerErrorCode({ code: 'POLICY_REF_INVALID', status: 400, description: 'A policy id in a request is not a built-in policy or one of the caller\'s own.' });
registerErrorCode({ code: 'POLICY_BUILTIN_READONLY', status: 403, description: 'A built-in policy cannot be edited or deleted: duplicate it.' });
registerErrorCode({ code: 'POLICY_NOT_FOUND', status: 404, description: 'The policy does not exist or is not the caller\'s.' });
registerErrorCode({ code: 'POLICY_NAME_TAKEN', status: 409, description: 'The caller already has a policy with this name.' });
registerErrorCode({ code: 'POLICY_IN_USE', status: 409, description: 'Tasks or schedules still use the policy; `details` lists them. Pass `reassignTo` to move them.' });
registerErrorCode({ code: 'POLICY_IS_DEFAULT', status: 409, description: 'The policy is the caller\'s default: choose another default first.' });
registerErrorCode({ code: 'POLICY_VERSION_CONFLICT', status: 412, description: 'The `If-Match` version is stale: the policy changed since it was loaded.' });
registerErrorCode({ code: 'POLICY_SPEC_INVALID', status: 500, description: 'A stored policy no longer passes validation.' });

// Export and import (#402).
registerErrorCode({ code: 'POLICY_IMPORT_INVALID', status: 400, description: 'A policy file is not valid: `details.errors` lists every invalid policy with its issues and `details.fileIssues` any problem with the file itself. Nothing is imported.' });
registerErrorCode({ code: 'POLICY_IMPORT_UNSUPPORTED_VERSION', status: 400, description: 'The policy file or one of its specs was written by a newer version of the format than this deployment reads.' });
registerErrorCode({ code: 'POLICY_IMPORT_TOO_LARGE', status: 413, description: 'The policy file is over 256 KB.' });
