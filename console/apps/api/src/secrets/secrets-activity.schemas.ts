// Response shapes of the Activity, reach and administrator summary routes (E37.4, #593). None has a field that can
// hold a login, a password, a code, a username or text from a page or a provider.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const activityItemSchema = z.object({
  id: z.string().uuid(),
  at: z.string().describe('ISO 8601: when the fabric recorded it.'),
  event: z.enum(['lookup', 'release']).describe('`lookup`: the agent asked your provider for the logins of the page. `release`: a field was handed over to be typed.'),
  runId: z.string().uuid().nullable().describe('The run or chat browser it happened in, when it is yours and still exists.'),
  site: z.string().nullable().describe('The host of the page, never a path or query.'),
  field: z.enum(['username', 'password', 'one_time_code']).nullable().describe('Which field was typed. Never its value.'),
  outcome: z.string().describe('A closed code: `typed`, `ok`, or why nothing was typed (`origin_mismatch`, `not_found`, `disabled`, `rate_limited`, ...).'),
  refused: z.boolean().describe('Nothing was typed: the fabric or the provider refused or failed.'),
  matches: z.number().int().nullable().describe('For a lookup: how many logins matched the page.'),
});
export const activityListSchema = z.object({
  items: z.array(activityItemSchema),
  /** The provider's own activity page (Vault's "Agent activity"), when the provider is connected. */
  providerActivityUrl: z.string().nullable(),
});
export class ActivityListResponseDto extends createZodDto(activityListSchema) {}

export const reachItemSchema = z.object({
  site: z.string().nullable(),
  fields: z.array(z.enum(['username', 'password', 'one_time_code'])).describe('The fields typed so far for this login.'),
  uses: z.number().int(),
  lastUsedAt: z.string(),
  lastRunId: z.string().uuid().nullable(),
});
export const reachSchema = z.object({
  /** `per_origin`: the provider can only look logins up for a page (Vault), so this lists the logins used so far. */
  listing: z.enum(['per_origin']),
  items: z.array(reachItemSchema),
});
export class ReachResponseDto extends createZodDto(reachSchema) {}

export const adminSummarySchema = z.object({
  deploymentEnabled: z.boolean(),
  usersConnected: z.number().int(),
  usersNeedingReconnect: z.number().int(),
  usesThisWeek: z.number().int().describe('Fields typed in the last 7 days, across every owner.'),
  refusalsThisWeek: z.number().int().describe('Lookups and releases that were refused or failed in the last 7 days.'),
});
export class AdminSummaryResponseDto extends createZodDto(adminSummarySchema) {}
