import { registerErrorCode } from '@marinoscar/platform-api/core';

// The typed error codes of the chat routes (#483). Registered at import, so the
// platform's exception filter keeps them and the OpenAPI document lists them.
registerErrorCode({ code: 'CHAT_NOT_FOUND', status: 404, description: "The chat does not exist or is not the caller's." });
registerErrorCode({ code: 'CHAT_ARCHIVED', status: 409, description: 'The chat is archived: it is read-only until it is unarchived.' });
registerErrorCode({ code: 'CHAT_RUN_LIVE', status: 409, description: 'A run of this chat is queued, running or waiting for a person. Stop it before deleting the chat.' });
