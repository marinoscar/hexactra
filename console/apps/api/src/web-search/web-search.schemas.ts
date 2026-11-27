// Request and response shapes of `/api/web-search` (E50.5, #975). No response has a field that can hold a key or any part of one,
// and the administrator's usage has no user id and no query.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { webSearchSystemSettingsSchema } from './web-search.settings';

const tier = z.enum(['user', 'organization', 'system']);

export const searchBodySchema = z
  .object({
    query: z.string().trim().min(1).max(400).describe('What to search for. Not logged.'),
    count: z.number().int().min(1).max(20).default(5).describe('How many results (1 to 20, default 5).'),
    freshness: z.enum(['day', 'week', 'month', 'year']).nullable().default(null).describe('Only results from the last day, week, month or year.'),
    site: z
      .string()
      .trim()
      .toLowerCase()
      .max(253)
      .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'A host name such as docs.example.test')
      .nullable()
      .default(null)
      .describe('Only results from this site (a host name).'),
  })
  .strict();
export class WebSearchBodyDto extends createZodDto(searchBodySchema) {}

export const searchResultSchema = z.object({
  provider: z.string().describe('The provider that answered (after a fallback, the second one).'),
  hits: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string(), publishedAt: z.string().nullable() })),
  answer: z.object({ text: z.string(), citations: z.array(z.string()) }).nullable().describe('Answer-type providers only.'),
});
export class WebSearchResultDto extends createZodDto(searchResultSchema) {}

export const statusSchema = z.object({
  enabled: z.boolean().describe('A search of yours would be made now.'),
  reason: z.enum(['disabled_by_admin', 'disabled_by_you', 'no_provider', 'no_key']).nullable().describe('Why not, when `enabled` is false.'),
  provider: z.object({ id: z.string(), label: z.string(), tier: tier.nullable().describe('The tier of the key it would use (none for a provider without a key).') }).nullable(),
  today: z.object({ calls: z.number().int(), limit: z.number().int().nullable().describe('Searches a day (UTC); `null`: unlimited.'), remaining: z.number().int().nullable() }),
  perRunLimit: z.number().int().nullable().describe('Searches a run; `null`: unlimited.'),
});
export class WebSearchStatusDto extends createZodDto(statusSchema) {}

export const providerViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['results', 'answer']),
  credential: z.enum(['api_key', 'none', 'ai_service']),
  needsKey: z.boolean(),
  enabled: z.boolean().describe("The administrator's switch for this provider."),
  listed: z.boolean().describe("In the deployment's order of providers."),
  keyTier: tier.nullable().describe('The tier of the key your requests would use, among the allowed ones.'),
  keys: z.object({ user: z.boolean(), organization: z.boolean(), system: z.boolean() }).describe('Which tiers hold a key, allowed or not. Never a key.'),
  estimatedCostPerCallUsd: z.number().nullable().describe('An ESTIMATE per call (the administrator can override it), not a price.'),
});
export class WebSearchProviderDto extends createZodDto(providerViewSchema) {}

const resolvedProviderSchema = z.object({
  enabled: z.boolean(),
  costPerCallUsd: z.number().nullable(),
  baseUrl: z.string().nullable().describe("A self-hosted provider's address (SearXNG)."),
  allowPrivate: z.boolean().describe('"This instance is on my private network": http and a private address are accepted for the configured host only.'),
  model: z.string().nullable().describe("An answer-type provider's model, a model id of the AI catalogue (OpenAI web search). Null: not chosen, the provider is not usable."),
});

export const adminSettingsSchema = z.object({
  enabled: z.boolean(),
  providers: z.record(z.string(), resolvedProviderSchema).describe('Saved per-provider settings; a provider not listed has the defaults (on, the default estimate).'),
  order: z.array(z.string()),
  shareDeploymentKey: z.boolean(),
  allowUserKeys: z.boolean(),
  limits: z.object({ perRun: z.number().int().nullable(), perUserPerDay: z.number().int().nullable(), fetchPerRun: z.number().int().nullable().describe('Pages `web_fetch` may read in one run; null: unlimited.') }),
  fetch: z.object({ enabled: z.boolean().describe('`web_fetch` reads public pages on the console server.'), blockedHosts: z.array(z.string()).describe('Hosts (or `*.suffix`) web_fetch never reads, at any redirect.') }),
  installed: z
    .array(z.object({ id: z.string(), label: z.string(), credential: z.enum(['api_key', 'none', 'ai_service']), hosts: z.array(z.string()), defaultEstimatedCostPerCallUsd: z.number().nullable() }))
    .describe('The providers this console has, with their default cost estimate.'),
});
export class WebSearchAdminSettingsDto extends createZodDto(adminSettingsSchema) {}
export type WebSearchAdminSettings = z.infer<typeof adminSettingsSchema>;

export class UpdateWebSearchAdminDto extends createZodDto(webSearchSystemSettingsSchema.strict()) {}

export const usageQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(90).default(30).describe('How many UTC days back (default 30).') });
export class WebSearchUsageQueryDto extends createZodDto(usageQuerySchema) {}

export const usageRowSchema = z.object({
  day: z.string().describe('UTC day, YYYY-MM-DD.'),
  provider: z.string(),
  calls: z.number().int(),
  failures: z.number().int(),
  estimatedCostUsd: z.number().describe('An ESTIMATE, from the cost per call in force when each call was made.'),
});
export class WebSearchUsageRowDto extends createZodDto(usageRowSchema) {}

/** `?provider=` of `POST /api/web-search/diagnose` (E50.13). */
export const searchDiagnoseQuerySchema = z
  .object({ provider: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).optional().describe('A provider id; default: the one that answers for you.') })
  .strict();
export class SearchDiagnoseQueryDto extends createZodDto(searchDiagnoseQuerySchema) {}
