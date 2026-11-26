import { HttpException, HttpStatus } from '@nestjs/common';
import { registerErrorCode } from '@marinoscar/platform-api/core';

/** At most this many reports a minute per user and target (E50.10). */
export const DIAGNOSE_RATE_LIMIT = 6;

registerErrorCode({ code: 'DIAGNOSTICS_RATE_LIMITED', status: 429, description: `At most ${DIAGNOSE_RATE_LIMIT} diagnostic reports a minute for one target. \`details.retryAfterS\` says how long to wait.` });

export function rateLimited(retryAfterS: number): HttpException {
  return new HttpException(
    { code: 'DIAGNOSTICS_RATE_LIMITED', message: `At most ${DIAGNOSE_RATE_LIMIT} diagnostic reports a minute for one target. Wait ${retryAfterS} seconds.`, details: { retryAfterS } },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
