import { HttpException, HttpStatus } from '@nestjs/common';
import { registerErrorCode } from '@marinoscar/platform-api/core';

// The service credential error codes (E50.2, #972). None carries a value or any part of one.
registerErrorCode({ code: 'SERVICE_CREDENTIAL_UNKNOWN', status: 404, description: 'No service credential is registered under this service and name.' });
registerErrorCode({ code: 'SERVICE_CREDENTIAL_TIER_NOT_ALLOWED', status: 409, description: 'This key cannot be stored at this tier (user, organization or deployment). `details.tier` names it.' });
registerErrorCode({ code: 'SERVICE_CREDENTIAL_NO_ORGANIZATION', status: 409, description: 'The caller has no active organization, so there is no organization key to set or remove.' });
registerErrorCode({ code: 'SERVICE_CREDENTIAL_INVALID', status: 422, description: 'The value does not have the shape this key has. `details.reason` (closed): for example `too_short`, `too_long`, `bad_characters`. The value is never echoed.' });

export type ServiceCredentialErrorCode = 'SERVICE_CREDENTIAL_UNKNOWN' | 'SERVICE_CREDENTIAL_TIER_NOT_ALLOWED' | 'SERVICE_CREDENTIAL_NO_ORGANIZATION' | 'SERVICE_CREDENTIAL_INVALID';

const STATUS: Record<ServiceCredentialErrorCode, HttpStatus> = {
  SERVICE_CREDENTIAL_UNKNOWN: HttpStatus.NOT_FOUND,
  SERVICE_CREDENTIAL_TIER_NOT_ALLOWED: HttpStatus.CONFLICT,
  SERVICE_CREDENTIAL_NO_ORGANIZATION: HttpStatus.CONFLICT,
  SERVICE_CREDENTIAL_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
};

/** The typed failure of the service credentials port. `details` holds a tier or a closed reason: never a value. */
export class ServiceCredentialError extends HttpException {
  constructor(
    readonly code: ServiceCredentialErrorCode,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super({ code, message, ...(details ? { details } : {}) }, STATUS[code]);
    this.name = 'ServiceCredentialError';
  }
}
