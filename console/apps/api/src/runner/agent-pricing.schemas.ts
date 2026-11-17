import { z } from 'zod';

/** `'<provider>:<modelId>'`: the provider id, a colon, then the model id as the provider spells it. */
export const MODEL_PRICE_KEY = /^[a-z0-9][a-z0-9_.-]*:\S.*$/;

const perMTok = z.number().finite().min(0).max(100_000);

/** One model's price, in USD per million tokens. */
export const modelPriceSchema = z.object({
  inputPerMTok: perMTok,
  outputPerMTok: perMTok,
  /** Absent bills cached input tokens as ordinary input. */
  cachedInputPerMTok: perMTok.optional(),
});

/**
 * The `agentPricing` system settings namespace: the price list the console
 * prices every browser-agent model call with, and the platform's AI usage
 * report through the `AI_PRICING` port. Maintained by the admin, never an
 * environment variable and never in source.
 */
export const agentPricingSettingsSchema = z.object({
  currency: z.literal('USD'),
  models: z
    .record(z.string().max(240).regex(MODEL_PRICE_KEY, "Use '<provider>:<model id>', e.g. 'openai:model-x'"), modelPriceSchema)
    .refine((m) => Object.keys(m).length <= 500, { message: 'At most 500 models' }),
});
export type AgentPricingSettings = z.infer<typeof agentPricingSettingsSchema>;

/** A PATCH replaces the whole `models` table (the admin edits it as one table). */
export const agentPricingSettingsPatchSchema = agentPricingSettingsSchema.partial();
