import { HttpException, HttpStatus } from '@nestjs/common';
import { registerErrorCode } from '@marinoscar/platform-api/core';

// The service credential error codes (E50.2, #972). None carries a value or any part of one.
registerErrorCode({ code: 'SERVICE_CREDENTIAL_UNKNOWN', status: 404, description: 'No service credential is registered under this service and name.' });
registerErrorCode({ code: 'SERVICE_CREDENTIAL_TIER_NOT_ALLOWED', status: 409, description: 'This key cannot be stored at this tier (user, organization or deployment). `details.tier` names it.' });
registerErrorCode({ code: 'SERVICE_CREDENTIAL_NO_ORGANIZATION', status: 409, description: 'The caller has no active organization, so there is no organization key to set or remove.' });
registerErrorCode({ code: 'SERVICE_CREDENTIAL_INVALID', status: 422, description: 'The value does not have the shape this key has. `details.reason` (closed): for example `too_short`, `too_long`, `bad_characters`. The value is never echoed.' });
// The second binding (E50.3, #973): the owner's secrets provider.
registerErrorCode({ code: 'SERVICE_CREDENTIAL_NOT_SET', status: 409, description: 'There is no key of yours to move from where it is kept.' });
registerErrorCode({ code: 'SERVICE_CREDENTIAL_NOT_IN_PROVIDER', status: 409, description: 'Your Vault does not answer with this key yet: add it there as a "Service key" opened to the agent, then move it again. `details.reason` (closed): `not_found`, `needs_scope`, `needs_reconnect`, `disabled`, ...' });
registerErrorCode({ code: 'SERVICE_CREDENTIAL_PROVIDER_READ_ONLY', status: 409, description: 'This key is kept in your remote Vault, which the console cannot write: change it in Vault.' });
registerErrorCode({ code: 'SERVICE_CREDENTIAL_PROVIDER_UNAVAILABLE', status: 503, description: 'Your secrets provider could not answer or is switched off; nothing was changed. `details.reason` (closed).' });

export type ServiceCredentialErrorCode =
  | 'SERVICE_CREDENTIAL_UNKNOWN'
  | 'SERVICE_CREDENTIAL_TIER_NOT_ALLOWED'
  | 'SERVICE_CREDENTIAL_NO_ORGANIZATION'
  | 'SERVICE_CREDENTIAL_INVALID'
  | 'SERVICE_CREDENTIAL_NOT_SET'
  | 'SERVICE_CREDENTIAL_NOT_IN_PROVIDER'
  | 'SERVICE_CREDENTIAL_PROVIDER_READ_ONLY'
  | 'SERVICE_CREDENTIAL_PROVIDER_UNAVAILABLE';

const STATUS: Record<ServiceCredentialErrorCode, HttpStatus> = {
  SERVICE_CREDENTIAL_UNKNOWN: HttpStatus.NOT_FOUND,
  SERVICE_CREDENTIAL_TIER_NOT_ALLOWED: HttpStatus.CONFLICT,
  SERVICE_CREDENTIAL_NO_ORGANIZATION: HttpStatus.CONFLICT,
  SERVICE_CREDENTIAL_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
  SERVICE_CREDENTIAL_NOT_SET: HttpStatus.CONFLICT,
  SERVICE_CREDENTIAL_NOT_IN_PROVIDER: HttpStatus.CONFLICT,
  SERVICE_CREDENTIAL_PROVIDER_READ_ONLY: HttpStatus.CONFLICT,
  SERVICE_CREDENTIAL_PROVIDER_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
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
