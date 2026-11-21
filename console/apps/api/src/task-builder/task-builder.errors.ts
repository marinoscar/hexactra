import { registerErrorCode } from '@marinoscar/platform-api/core';

// The typed error codes of the task builder routes (E42.1, #718). Registered at import.
registerErrorCode({ code: 'TASK_BUILDER_NOT_FOUND', status: 404, description: "The task builder does not exist or is not the caller's." });
registerErrorCode({ code: 'TASK_BUILDER_ARCHIVED', status: 409, description: 'The task builder is archived (its task was saved): start a new one.' });
registerErrorCode({ code: 'INVALID_TASK_SPEC', status: 400, description: 'The task spec does not pass its checks; `details` names each problem.' });
registerErrorCode({ code: 'TASK_SPEC_INCOMPLETE', status: 400, description: 'The builder does not know yet what the task should do: tell it first.' });
