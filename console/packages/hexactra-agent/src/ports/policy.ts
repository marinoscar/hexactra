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
  /**
   * How many actions one model reply may carry on an unchanged page (E54.1, #1082). Absent or 1: one, as before (nothing changes). Above 1:
   * fill-type actions may follow each other, and the first action that can change the page, fails or asks a person ends the reply.
   */
  actionsPerReply?: number;
  /**
   * What an action's result tells the model (E54.2, #1083). Absent: as before. `delta`: a click or key press that changed the page also says
   * where the page is now (address, title, an open dialog), from the check that already runs after it, and each round names the open tabs.
   */
  actionResults?: 'delta';
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
