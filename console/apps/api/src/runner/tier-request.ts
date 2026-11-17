import type { Tier } from '../policies/agent-policy.schema';
import { platformEffort } from '../policies/model-tiers.schema';
import type { RunPolicySnapshot } from '../policies/policy-snapshot';

/** The per-call model settings of one tier: what `runTools` is given beside the prompt. */
export interface TierRequest {
  provider?: string;
  model?: string;
  reasoning?: { effort: 'minimal' | 'low' | 'medium' | 'high' };
  maxOutputTokens?: number;
  /** The provider-neutral model id for cost accounting; the catalogue's own id when known. */
  modelLabel: string | null;
}

/**
 * The model, reasoning effort and output cap for one call at `tier` (#403),
 * read from the run's snapshot only. The ONE place the runner decides them;
 * tier escalation (#405) calls it with the tier the run is on. A snapshot
 * without resolved tiers (a run started before #403) yields an empty request,
 * and the platform's target resolver picks the model.
 */
export function tierRequest(snapshot: RunPolicySnapshot, tier: Tier): TierRequest {
  const t = snapshot.resolvedTiers?.[tier];
  if (!t?.model) return { modelLabel: null };
  // A model that cannot reason would refuse the request: the effort is only sent where it can apply.
  const effort = t.reasoning === false ? null : platformEffort(t.reasoningEffort);
  return {
    // Placed in the catalogue: the provider and its own model id; otherwise the string as set.
    ...(t.provider && t.modelId ? { provider: t.provider, model: t.modelId } : { model: t.model }),
    ...(effort ? { reasoning: { effort } } : {}),
    ...(t.maxOutputTokens ? { maxOutputTokens: t.maxOutputTokens } : {}),
    modelLabel: t.model,
  };
}

/** Whether a model on `tier` accepts images; `null` when unknown (the first refused call settles it). */
export function tierHasVision(snapshot: RunPolicySnapshot, tier: Tier): boolean | null {
  return snapshot.resolvedTiers?.[tier]?.vision ?? null;
}

/** Why a run cannot start on `tier`, or null. Only judged when the tiers were resolved. */
export function tierProblem(snapshot: RunPolicySnapshot, tier: Tier): string | null {
  const t = snapshot.resolvedTiers?.[tier];
  return t && !t.usable ? t.problem : null;
}
