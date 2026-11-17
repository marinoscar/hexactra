import { z } from 'zod';

import { TIERS, type Tier } from './agent-policy.schema';

/**
 * The model tier definitions (#403): what "Fast", "Standard" and "Frontier"
 * mean, defined once as a deployment default (the `browserAgentTiers` system
 * namespace, edited by an admin) and overridden per user (the `tiers` field of
 * the `browserAgent` user namespace). Pure: no I/O. Whether a model is enabled
 * is checked at run start (`model-tiers.service.ts`), never here.
 */

/** Reasoning effort a tier asks for. `none` asks for the least reasoning the provider offers. */
export const TIER_EFFORTS = ['none', 'low', 'medium', 'high'] as const;
export type TierEffort = (typeof TIER_EFFORTS)[number];

const model = (text: string) => z.string().trim().min(1).max(200).nullable().describe(text);

export const tierDefSchema = z.object({
  model: model("`provider:modelId` as the platform's model catalogue names it. `null` means not set: the tier borrows the nearest set tier."),
  reasoningEffort: z.enum(TIER_EFFORTS).nullable().describe("How hard the model thinks on this tier. `null` uses the provider's default."),
  maxOutputTokens: z.number().int().min(256).max(64_000).nullable().describe('Most tokens one model reply may have on this tier. `null` uses the provider default. The per-model caps an admin set in the AI settings still apply.'),
  fallbackModel: model('Model used instead when the provider errors or rate-limits and the policy allows provider fallback. `null` means none.'),
});
export type TierDef = z.infer<typeof tierDefSchema>;

/** A tier left entirely unset. */
export const EMPTY_TIER: TierDef = { model: null, reasoningEffort: null, maxOutputTokens: null, fallbackModel: null };

/** The deployment default (and the shape of the stored namespace): every tier present. */
export const modelTiersSchema = z
  .object({ fast: tierDefSchema, standard: tierDefSchema, frontier: tierDefSchema })
  .describe('The three model tiers: Fast (cheap, quick), Standard (everyday) and Frontier (the strongest, used when a run is stuck).');
export type ModelTiers = z.infer<typeof modelTiersSchema>;

export const DEFAULT_MODEL_TIERS: ModelTiers = { fast: { ...EMPTY_TIER }, standard: { ...EMPTY_TIER }, frontier: { ...EMPTY_TIER } };

/** One tier's override: any subset of the fields; `null` clears a field back to "not set". */
export const tierOverrideSchema = tierDefSchema.partial();
export type TierOverride = z.infer<typeof tierOverrideSchema>;

/** A per-tier, per-field partial: the user's `tiers` and a PATCH of the deployment default. */
export const modelTiersOverrideSchema = z.object({
  fast: tierOverrideSchema.optional(),
  standard: tierOverrideSchema.optional(),
  frontier: tierOverrideSchema.optional(),
});
export type ModelTiersOverride = z.infer<typeof modelTiersOverrideSchema>;

/** Merge a patch into a stored override: per tier, per field; `null` removes a field. Empty tiers are dropped. */
export function mergeTierOverrides(current: ModelTiersOverride | undefined, patch: ModelTiersOverride | null | undefined): ModelTiersOverride | undefined {
  if (patch === null) return undefined;
  const out: ModelTiersOverride = {};
  for (const t of TIERS) {
    const merged: Record<string, unknown> = { ...(current?.[t] ?? {}) };
    for (const [k, v] of Object.entries(patch?.[t] ?? {})) {
      if (v === null) delete merged[k];
      else if (v !== undefined) merged[k] = v;
    }
    if (Object.keys(merged).length > 0) out[t] = merged as TierOverride;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Where the value of a tier's model came from. */
export const FIELD_SOURCES = ['pin', 'user', 'deployment', 'fill_down', 'ai_default'] as const;
export type FieldSource = (typeof FIELD_SOURCES)[number];

/** The `ResolvedTier` of the snapshot and of the effective-tiers response. */
export const resolvedTierSchema = z.object({
  model: z.string().nullable().describe('The model the tier uses, as `provider:modelId` when the catalogue knows it. `null` when none is selected.'),
  provider: z.string().nullable().describe('The provider id the call goes to; `null` when the catalogue could not place the model.'),
  modelId: z.string().nullable().describe("The provider's own id of the model; `null` when the catalogue could not place it."),
  modelSource: z.enum(FIELD_SOURCES).nullable().describe('Where the model came from: the policy pin, the user, the deployment, another tier (fill-down) or the platform default model.'),
  borrowedFrom: z.enum(TIERS).nullable().describe('For `fill_down`: the tier the model was borrowed from.'),
  reasoningEffort: z.enum(TIER_EFFORTS).nullable(),
  effortSource: z.enum(['user', 'deployment']).nullable(),
  maxOutputTokens: z.number().int().nullable(),
  maxOutputTokensSource: z.enum(['user', 'deployment']).nullable(),
  fallbackModel: z.string().nullable(),
  fallbackProvider: z.string().nullable(),
  fallbackSource: z.enum(['user', 'deployment']).nullable(),
  vision: z.boolean().nullable().describe('Whether the model accepts images. `false` starts the run without screenshots. `null` when unknown.'),
  tools: z.boolean().nullable().describe('Whether the model supports tool calls, which the browser agent needs. `null` when unknown.'),
  reasoning: z.boolean().nullable().describe('Whether the model supports a reasoning effort. When `false` the configured effort is not sent. `null` when unknown.'),
  usable: z.boolean().describe('False when the model is not an enabled model the user can call, or lacks tool calls.'),
  problem: z.string().nullable().describe('Why the tier is not usable.'),
});
export type ResolvedTier = z.infer<typeof resolvedTierSchema>;
export type ResolvedTiers = Record<Tier, ResolvedTier>;
export const resolvedTiersSchema = z.object({ fast: resolvedTierSchema, standard: resolvedTierSchema, frontier: resolvedTierSchema });

/** The provider-neutral names the platform's `reasoning.effort` accepts. `none` is the lowest the platform offers. */
export function platformEffort(effort: TierEffort | null): 'minimal' | 'low' | 'medium' | 'high' | null {
  if (effort === null) return null;
  return effort === 'none' ? 'minimal' : effort;
}
