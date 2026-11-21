// Which models a trial's run could call (E44.3, #741), from the run's policy snapshot. The run row records the tier it is on and how
// often it escalated, not the model of each call; the snapshot's resolved tiers are what every call of the run was built from
// (`tierRequest(snapshot, tier)`), so they are the reliable source. A provider fallback inside a tier is listed as `fallbackModel`.
import { TIERS, type Tier } from '../policies/agent-policy.schema';
import { readSnapshot } from '../policies/policy-snapshot';

export interface TrialModels {
  startTier: Tier;
  maxTier: Tier;
  /** The tier the run was on when it ended. */
  finalTier: Tier;
  /** The start tier's model (`provider:modelId`): the model of a policy pinned to one tier. Null when the snapshot names none. */
  model: string | null;
  /** The tiers from start to max, in order: the only ones the run may use. */
  tiers: { tier: Tier; model: string | null; fallbackModel: string | null }[];
}

const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v);

/** The models of a run under its snapshot; null for a run that never got one (it ended before its first advance). */
export function trialModels(policySnapshot: unknown, currentTier: unknown): TrialModels | null {
  const snapshot = readSnapshot(policySnapshot as never);
  if (!snapshot) return null;
  const { startTier, maxTier } = snapshot.spec.models;
  const [from, to] = [TIERS.indexOf(startTier), TIERS.indexOf(maxTier)];
  const modelOf = (tier: Tier): { model: string | null; fallbackModel: string | null } => {
    const resolved = snapshot.resolvedTiers?.[tier];
    const legacy = snapshot.tiers?.[tier];
    return { model: resolved?.model ?? (legacy?.model ? (legacy.provider ? `${legacy.provider}:${legacy.model}` : legacy.model) : null), fallbackModel: resolved?.fallbackModel ?? null };
  };
  const tiers = TIERS.slice(Math.min(from, to), Math.max(from, to) + 1).map((tier) => ({ tier, ...modelOf(tier) }));
  return { startTier, maxTier, finalTier: isTier(currentTier) ? currentTier : startTier, model: modelOf(startTier).model, tiers };
}

/** The stored value, read defensively. */
export function readTrialModels(value: unknown): TrialModels | null {
  const v = value as Partial<TrialModels> | null;
  if (!v || typeof v !== 'object' || !isTier(v.startTier) || !isTier(v.maxTier) || !Array.isArray(v.tiers)) return null;
  return {
    startTier: v.startTier,
    maxTier: v.maxTier,
    finalTier: isTier(v.finalTier) ? v.finalTier : v.startTier,
    model: typeof v.model === 'string' ? v.model : null,
    tiers: v.tiers.flatMap((t) => (t && isTier(t.tier) ? [{ tier: t.tier, model: typeof t.model === 'string' ? t.model : null, fallbackModel: typeof t.fallbackModel === 'string' ? t.fallbackModel : null }] : [])),
  };
}
