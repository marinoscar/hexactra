// The typed error codes of deliveries (E39.6, #603). Registered at import, so the platform's exception filter keeps them and the OpenAPI
// document lists them.
import { registerErrorCode } from '@marinoscar/platform-api/core';

registerErrorCode({ code: 'INVALID_DELIVERY', status: 400, description: "A delivery's configuration is invalid (`details.issues`: a path and a message each): an unknown field, a template with a line break or an unknown placeholder, a column naming an output the task does not have, a connection that is not yours or lacks the capability, a webhook address that is not allowed." });
registerErrorCode({ code: 'DELIVERY_NOT_FOUND', status: 404, description: 'The delivery does not exist, is not on this task, or is not the caller\'s.' });
registerErrorCode({ code: 'TOO_MANY_DELIVERIES', status: 422, description: 'A task has at most 10 deliveries.' });
registerErrorCode({ code: 'RUN_DELIVERY_NOT_FOUND', status: 404, description: 'The delivery log entry does not exist, is not on this run, or is not the caller\'s.' });
registerErrorCode({ code: 'DELIVERY_NOT_RETRYABLE', status: 409, description: 'Only a delivery that failed, or one stuck sending or pending, can be retried.' });
registerErrorCode({ code: 'DELIVERY_TEST_RATE_LIMITED', status: 429, description: 'At most 10 test sends a minute.' });
registerErrorCode({ code: 'RECIPIENT_NOT_CONFIRMED', status: 409, description: 'A delivery uses an email address that is not yours and that you have not confirmed (`details.addresses`). Confirm each with `POST /delivery-recipients`, then save the delivery again. A delivery with such an address can be saved switched off.' });
registerErrorCode({ code: 'RECIPIENT_LIMIT', status: 422, description: 'The task would use more different email addresses than the deployment allows (`details.limit`).' });
