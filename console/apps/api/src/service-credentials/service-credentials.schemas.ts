// Request and response shapes of `/api/service-credentials` (E50.2, #972). No response has a field that can hold a value, a hint, a
// length or any part of a key.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { SERVICE_CREDENTIAL_ID_PATTERN } from './service-credential.port';

const id = z.string().regex(SERVICE_CREDENTIAL_ID_PATTERN, 'A lower-case identifier: a letter, then letters, digits or underscores (at most 40)');
const tier = z.enum(['user', 'organization', 'system']);
const iso = z.string().describe('ISO 8601 timestamp');

export const refParamSchema = z.object({ service: id.describe('The service (`web_search`).'), name: id.describe('The key within it (`brave`).') });
export class ServiceCredentialRefParamDto extends createZodDto(refParamSchema) {}

export const setValueSchema = z
  .object({ value: z.string().min(1).max(4096).describe('The key. Write-only: it is never returned, not even in part.') })
  .strict();
export class SetServiceCredentialDto extends createZodDto(setValueSchema) {}

const tierStateSchema = z.object({
  available: z.boolean().describe('A key may be stored at this tier for this reference (the organization tier needs an active organization).'),
  set: z.boolean().describe('A key is stored at this tier.'),
  setAt: iso.nullable().describe('When it was stored. Never a part of the key.'),
});

export const serviceCredentialViewSchema = z.object({
  service: z.string(),
  name: z.string(),
  label: z.string(),
  binding: z.enum(['credential_store', 'vault', 'builtin']).describe('Where the answering key is kept.'),
  tier: tier.nullable().describe('The tier a request of yours would use now (user, then organization, then deployment), or `null`.'),
  tiers: z.object({ user: tierStateSchema, organization: tierStateSchema, system: tierStateSchema }),
});
export class ServiceCredentialResponseDto extends createZodDto(serviceCredentialViewSchema) {}
export type ServiceCredentialView = z.infer<typeof serviceCredentialViewSchema>;
