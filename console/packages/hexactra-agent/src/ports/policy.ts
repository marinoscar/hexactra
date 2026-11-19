import type { EffectiveBudget } from '../budget';
import type { StallSettings } from '../stall';
import type { Tier } from '../types';
import type { ModelRoute } from './model';

/** The run's policy, fixed when the run first started (#401): the loop reads nothing else about limits. */
export interface RunPolicy {
  ref: string;
  startTier: Tier;
  maxTier: Tier;
  allowProviderFallback: boolean;
  callsPerChunk: number;
  stall: StallSettings;
  effectiveBudget: EffectiveBudget;
}

/** What each tier resolves to. Every model call is built from here (`AGENTS.md`, run policies): the loop never names a model. */
export interface TierRouting {
  /** Why the tier cannot be used (no model), or null. */
  problem(tier: Tier): string | null;
  route(tier: Tier): ModelRoute;
  /** The tier's fallback model, or null. */
  fallback(tier: Tier): ModelRoute | null;
  /** Whether two tiers resolve to the same model (an escalation would change nothing). */
  same(a: Tier, b: Tier): boolean;
  /** Whether the tier's model takes images; `null` when unknown. */
  hasVision(tier: Tier): boolean | null;
}

/** The rules the run is under, and what may be stored about it. Guarantee: pure; the same input gives the same answer. */
export interface PolicyPort {
  policy: RunPolicy;
  routing: TierRouting;
  /** Masks anything that looks like a secret in text a person or the model will read. */
  mask(text: string): string;
}
