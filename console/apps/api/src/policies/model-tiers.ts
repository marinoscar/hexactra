import { TIERS, type Tier } from './agent-policy.schema';
import { type FieldSource, type ModelTiers, type ModelTiersOverride, type TierDef, type TierEffort } from './model-tiers.schema';

/**
 * The order in which a tier with no model of its own borrows one (#403):
 * `fast` and `frontier` borrow `standard` first, `standard` borrows `frontier`
 * and then `fast`. The nearest SET tier, so each ladder ends at the remaining tier.
 */
export const FILL_DOWN_ORDER: Record<Tier, readonly Tier[]> = {
  fast: ['standard', 'frontier'],
  standard: ['frontier', 'fast'],
  frontier: ['standard', 'fast'],
};

/** One tier's chosen values, before the catalogue places the models. */
export interface TierSelection {
  tier: Tier;
  /** `provider:modelId` or a bare id, exactly as set. */
  model: string | null;
  modelSource: FieldSource | null;
  borrowedFrom: Tier | null;
  reasoningEffort: TierEffort | null;
  effortSource: 'user' | 'deployment' | null;
  maxOutputTokens: number | null;
  maxOutputTokensSource: 'user' | 'deployment' | null;
  fallbackModel: string | null;
  fallbackSource: 'user' | 'deployment' | null;
}

export interface SelectTiersInput {
  /** The policy's per-tier model pins. */
  pins?: Partial<Record<Tier, string | null | undefined>>;
  /** The user's override. */
  user?: ModelTiersOverride | null;
  /** The deployment default. */
  deployment?: ModelTiers | null;
  /** The platform default model of the user (`ai.defaultModel`), as `provider:modelId`. */
  aiDefault?: string | null;
}

type Layered<T> = { value: T; source: 'user' | 'deployment' } | null;

function layered<K extends keyof TierDef>(input: SelectTiersInput, tier: Tier, key: K): Layered<NonNullable<TierDef[K]>> {
  const u = input.user?.[tier]?.[key];
  if (u !== undefined && u !== null) return { value: u as NonNullable<TierDef[K]>, source: 'user' };
  const d = input.deployment?.[tier]?.[key];
  if (d !== undefined && d !== null) return { value: d as NonNullable<TierDef[K]>, source: 'deployment' };
  return null;
}

/**
 * Pure: the values each tier resolves to. For the model:
 * `pin > user > deployment > fill-down > ai.defaultModel`. Fill-down borrows
 * the nearest tier whose model the user or deployment SET (a pin applies to its
 * own tier only). The effort, output cap and fallback are the tier's own:
 * `user > deployment > null`; they are never borrowed, so Fast keeps the
 * provider's default effort even when it borrows Standard's model.
 */
export function selectTiers(input: SelectTiersInput): Record<Tier, TierSelection> {
  const own = Object.fromEntries(TIERS.map((t) => [t, layered(input, t, 'model')])) as Record<Tier, Layered<string>>;
  const out = {} as Record<Tier, TierSelection>;
  for (const tier of TIERS) {
    let model: string | null = null;
    let modelSource: FieldSource | null = null;
    let borrowedFrom: Tier | null = null;
    const pin = input.pins?.[tier]?.trim();
    if (pin) {
      model = pin;
      modelSource = 'pin';
    } else if (own[tier]) {
      model = own[tier]!.value;
      modelSource = own[tier]!.source;
    } else {
      const donor = FILL_DOWN_ORDER[tier].find((t) => own[t]);
      if (donor) {
        model = own[donor]!.value;
        modelSource = 'fill_down';
        borrowedFrom = donor;
      } else if (input.aiDefault) {
        model = input.aiDefault;
        modelSource = 'ai_default';
      }
    }
    const effort = layered(input, tier, 'reasoningEffort');
    const cap = layered(input, tier, 'maxOutputTokens');
    const fallback = layered(input, tier, 'fallbackModel');
    out[tier] = {
      tier,
      model,
      modelSource,
      borrowedFrom,
      reasoningEffort: effort?.value ?? null,
      effortSource: effort?.source ?? null,
      maxOutputTokens: cap?.value ?? null,
      maxOutputTokensSource: cap?.source ?? null,
      fallbackModel: fallback?.value ?? null,
      fallbackSource: fallback?.source ?? null,
    };
  }
  return out;
}

/** Where an admin or a user sets the tiers: named in the run error when nothing is selected. */
export const MODEL_TIERS_PAGE = 'Model tiers (Admin settings > Model tiers for the deployment default, or your Browser agent settings for your own)';

/** The run error when the start tier has no model at all. */
export function noModelMessage(tier: Tier): string {
  return `No model selected for the ${tier} tier. Set a model on the ${MODEL_TIERS_PAGE}, or choose a default model in your AI settings.`;
}
