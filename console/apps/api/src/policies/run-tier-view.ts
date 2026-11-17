// Which tier and model a run is on, for the run page's header chips (#408).
//
// The run's tiers are fixed in its policy snapshot (#403). The tier it is on
// right now is `runs.current_tier` once stall escalation (#405) keeps it;
// until then, and on a run that never escalated, it is the policy's start
// tier. This is the one place that maps those columns to the view, so the
// shape stays the same whichever of them a run row carries.
import { TIERS, type Tier } from './agent-policy.schema';
import type { RunPolicySnapshot } from './policy-snapshot';

/** What a run response says about the run's model tier. */
export interface RunTierView {
  /** The tier the policy starts runs on. */
  start: Tier;
  /** The highest tier the run may escalate to. */
  max: Tier;
  /** The tier the run is on now (the start tier until an escalation moves it). */
  current: Tier;
  /** How many times the run escalated (0 before #405, or when it never did). */
  escalations: number;
  /** The current tier's model as the catalogue names it (`provider:modelId`); null when the snapshot has none. */
  model: string | null;
}

/** The routing columns a run row may carry (#405); both are optional here. */
export interface RunTierColumns {
  currentTier?: unknown;
  escalations?: unknown;
}

const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v);

/** The tier view of a run under its snapshot; null before the run has a snapshot. */
export function runTierView(snapshot: RunPolicySnapshot | null, row: object = {}): RunTierView | null {
  if (!snapshot) return null;
  // Any run row: the routing columns are read when it has them.
  const run = row as RunTierColumns;
  const { startTier, maxTier } = snapshot.spec.models;
  const current = isTier(run.currentTier) ? run.currentTier : startTier;
  const escalations = typeof run.escalations === 'number' && Number.isFinite(run.escalations) && run.escalations > 0 ? Math.floor(run.escalations) : 0;
  const resolved = snapshot.resolvedTiers?.[current];
  const legacy = snapshot.tiers?.[current];
  const model = resolved?.model ?? (legacy?.model ? (legacy.provider ? `${legacy.provider}:${legacy.model}` : legacy.model) : null);
  return { start: startTier, max: maxTier, current, escalations, model };
}
