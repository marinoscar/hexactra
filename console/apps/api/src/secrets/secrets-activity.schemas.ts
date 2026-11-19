// Response shapes of the Activity, reach and administrator summary routes (E37.4, #593). None has a field that can
// hold a login, a password, a code, a username or text from a page or a provider.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { ACTIVITY_FIELDS } from './secrets-activity';

export const activityItemSchema = z.object({
  id: z.string().uuid(),
  at: z.string().describe('ISO 8601: when the fabric recorded it.'),
  event: z.enum(['lookup', 'release']).describe('`lookup`: the agent asked your provider for the logins of the page. `release`: a field was handed over to be typed.'),
  runId: z.string().uuid().nullable().describe('The run or chat browser it happened in, when it is yours and still exists.'),
  site: z.string().nullable().describe('The host of the page, never a path or query.'),
  loginName: z.string().nullable().describe("The saved login's name, as the run recorded it when it signed in; null when unknown. Never a username."),
  field: z.enum(ACTIVITY_FIELDS).nullable().describe('Which field was typed. Never its value.'),
  outcome: z.string().describe('A closed code: `typed`, `selected`, `ok`, or why nothing was typed (`origin_mismatch`, `not_found`, `disabled`, `rate_limited`, ...).'),
  refused: z.boolean().describe('Nothing was typed: the fabric or the provider refused or failed.'),
  matches: z.number().int().nullable().describe('For a lookup: how many logins matched the page.'),
  amount: z.string().nullable().describe('A card field (E37.7): the amount the agent declared for the purchase, a decimal with two places. Null for anything else.'),
  currency: z.string().nullable().describe('A card field: the currency of the declared amount (ISO 4217).'),
  frameSite: z.string().nullable().describe("A card field typed into an embedded payment frame: the frame's host."),
});
export const activityListSchema = z.object({
  items: z.array(activityItemSchema),
  /** The provider's own activity page (Vault's "Agent activity"), when the provider is connected. */
  providerActivityUrl: z.string().nullable(),
});
export class ActivityListResponseDto extends createZodDto(activityListSchema) {}

export const reachItemSchema = z.object({
  site: z.string().nullable(),
  fields: z.array(z.enum(ACTIVITY_FIELDS)).describe('The fields typed so far for this login.'),
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

export const identityListingSchema = z.object({
  available: z.boolean().describe('Identity details can be read and used: connected, the switches on and the identity permissions granted.'),
  reason: z.enum(['ok', 'not_connected', 'needs_reconnect', 'needs_scope', 'switched_off', 'provider_off', 'unavailable']).describe('Why not, when `available` is false. `needs_scope`: connect again and allow identity details. `provider_off`: the provider has identity details switched off.'),
  items: z
    .array(z.object({ name: z.string().describe("The saved item's name (\"Passport\")"), fields: z.array(z.object({ label: z.string().describe('The field\'s label ("Date of birth")'), sensitive: z.boolean().describe('Typed only on the sites listed for the item in the provider') })) }))
    .describe('The identity items you opened to the agent, with field labels. Never a value.'),
  manageUrl: z.string().nullable().describe("The provider's address, where each item's allowed sites are managed."),
});
export class IdentityListingResponseDto extends createZodDto(identityListingSchema) {}

export const cardListingSchema = z.object({
  available: z.boolean().describe('Cards can be read and used: connected, the switches on and the card permissions granted.'),
  reason: z.enum(['ok', 'not_connected', 'needs_reconnect', 'needs_scope', 'switched_off', 'provider_off', 'unavailable', 'bad_merchant']).describe('Why not, when `available` is false. `needs_scope`: connect again and allow cards. `provider_off`: the provider has card release switched off. `bad_merchant`: not an https address of a site.'),
  merchant: z.string().nullable().describe('The merchant asked about, as `https://<host>`; null when it was not a usable address.'),
  cards: z
    .array(
      z.object({
        name: z.string().describe("The saved card's name"),
        brand: z.string().nullable().describe('The card network (`visa`)'),
        last4: z.string().nullable().describe('The last four digits: never more'),
        expires: z.string().nullable().describe('The card\'s expiry as MM/YYYY'),
        limit: z.object({
          maxAmount: z.string().describe('The most one purchase may be at this merchant, a decimal with two places'),
          currency: z.string(),
          includesSecurityCode: z.boolean().describe('The owner allowed the security code for this card at this merchant'),
          expiresAt: z.string().nullable().describe('When the permission ends, or null'),
        }),
      }),
    )
    .describe('The cards you opened to the agent that hold a live permission for this merchant. Never a number or a code.'),
  manageUrl: z.string().nullable().describe("The provider's address, where each card's merchant permissions are made."),
});
export class CardListingResponseDto extends createZodDto(cardListingSchema) {}

export const cardQuerySchema = z.object({ merchant: z.string().min(1).max(300).describe('A merchant: a host (`shop.example.test`) or an https address.') }).strict();
export class CardQueryDto extends createZodDto(cardQuerySchema) {}
