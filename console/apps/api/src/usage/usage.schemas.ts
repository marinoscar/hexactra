import { timeZoneIdSchema } from '@marinoscar/platform-contract/settings';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { TOKEN_TYPES, USAGE_BREAKDOWNS, USAGE_RANGES } from './usage-report';

/** The query of `GET /api/usage/report` and `GET /api/usage/export.csv`. */
export const usageQuerySchema = z
  .object({
    range: z.enum(USAGE_RANGES).default('30d').describe('`7d`, `30d` and `90d` are whole days ending today; `1y` is the 12 calendar months ending this month, one bucket per month.'),
    scope: z.enum(['me', 'all']).default('me').describe("`me`: the caller's own usage (`usage:read`). `all`: every user's (also needs `ai_config:read`)."),
    breakdown: z.enum(USAGE_BREAKDOWNS).default('model').describe('How the series are split: by model, by token type (uncached input, cached input, output, reasoning), by feature, by provider, by user (`scope=all` only) or not at all.'),
    tz: timeZoneIdSchema.optional().describe("IANA time zone the days and months are in; default the caller's time zone setting."),
    userId: z.uuid().optional().describe('Only this user (`scope=all` only).'),
    provider: z.string().min(1).max(64).optional(),
    model: z.string().min(1).max(128).optional().describe('Only this model id, as the provider reports it.'),
    feature: z.string().min(1).max(64).optional().describe('Only this AI feature (`browser_agent`, `chat_orchestrator`, `task_builder`, ...).'),
  })
  .strict();
export type UsageQuery = z.infer<typeof usageQuerySchema>;
export class UsageQueryDto extends createZodDto(usageQuerySchema) {}

const tokenTypeCosts = z.object(Object.fromEntries(TOKEN_TYPES.map((t) => [t, z.number()])) as Record<(typeof TOKEN_TYPES)[number], z.ZodNumber>);

export const usageReportSchema = z.object({
  range: z.enum(USAGE_RANGES),
  scope: z.enum(['me', 'all']),
  breakdown: z.enum(USAGE_BREAKDOWNS),
  timeZone: z.string(),
  granularity: z.enum(['day', 'month']),
  from: z.string().describe('First day covered (YYYY-MM-DD, in `timeZone`).'),
  to: z.string().describe('Last day covered (YYYY-MM-DD, in `timeZone`).'),
  buckets: z.array(z.string()).describe('The periods, oldest first: `YYYY-MM-DD` days, or `YYYY-MM` months for `1y`.'),
  series: z.array(z.object({ key: z.string(), label: z.string(), costUsd: z.array(z.number()), tokens: z.array(z.number()), requests: z.array(z.number()) })).describe('One per breakdown key; each array is aligned with `buckets`.'),
  totals: z.object({
    requests: z.number(),
    failed: z.number(),
    inputTokens: z.number(),
    cachedInputTokens: z.number().describe('Part of `inputTokens`.'),
    outputTokens: z.number(),
    reasoningTokens: z.number().describe('Part of `outputTokens`.'),
    tokens: z.number().describe('`inputTokens + outputTokens`.'),
    costUsd: z.number(),
    costKnown: z.boolean().describe('False when a call was on a model with no price: `costUsd` is then a lower bound ("at least").'),
    costByTokenType: tokenTypeCosts,
  }),
  byModel: z.array(
    z.object({
      key: z.string(),
      provider: z.string(),
      model: z.string(),
      requests: z.number(),
      failed: z.number(),
      inputTokens: z.number(),
      cachedInputTokens: z.number(),
      outputTokens: z.number(),
      reasoningTokens: z.number(),
      tokens: z.number(),
      costUsd: z.number().nullable(),
      costShare: z.number().nullable(),
    }),
  ),
  unpricedModels: z.array(z.string()).describe('`<provider>:<model>` keys with usage but no price.'),
  runs: z.object({ count: z.number(), succeeded: z.number(), costUsd: z.number(), avgSuccessCostUsd: z.number().nullable() }).describe('Browser-agent runs started in the range (their own cost counters).'),
  pricing: z.object({ overridesApplied: z.boolean().describe("True when the caller's own model prices replaced the deployment's for this report.") }),
});
export type UsageReport = z.infer<typeof usageReportSchema>;
export class UsageReportResponseDto extends createZodDto(usageReportSchema) {}
