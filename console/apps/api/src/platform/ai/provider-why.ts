// What a provider refused, in words that are safe to show the owner: its own short error code and the request field it named
// (`invalid_function_parameters`, `tools[3].parameters`). Identifiers only; the provider's message never comes through here (#675).
import type { AiError } from '@marinoscar/platform-api/ai';

const SAFE_ID = /^[A-Za-z0-9_.[\]-]{1,80}$/;

/** `code, field` when the error carries them as identifiers, else an empty string. A value that is not an identifier is left out. */
export function providerWhy(e: AiError): string {
  const d = (e.getResponse() as { details?: Record<string, unknown> }).details ?? {};
  return [d.providerCode, d.param].filter((v): v is string => typeof v === 'string' && SAFE_ID.test(v)).join(', ');
}
