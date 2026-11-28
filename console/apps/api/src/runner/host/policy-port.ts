// PolicyPort over the run's policy snapshot (#401): the loop reads limits, tiers and models only from here.
import type { RunPolicySnapshot } from '../../policies/policy-snapshot';
import { maskSensitive } from '../../tasks/mask';
import { PLATFORM_MAX_CALLS_PER_CHUNK } from '@marinoscar/hexactra-browser-agent/context-settings';
import { computeEffectiveBudget, type ModelRoute, type PolicyPort } from '@marinoscar/hexactra-agent';
import { fallbackRequest, sameTierRequest, tierHasVision, tierProblem, tierRequest, type TierRequest } from '../tier-request';

const routeOf = ({ modelLabel, ...params }: TierRequest): ModelRoute => ({ label: modelLabel, params });

/** `tiersResolved`: the model-tiers service is wired. Without it a tier is never judged unusable and the platform's resolver picks the model. */
export function policyPort(snapshot: RunPolicySnapshot, tiersResolved: boolean): PolicyPort {
  const { spec } = snapshot;
  return {
    policy: {
      ref: snapshot.ref,
      startTier: spec.models.startTier,
      maxTier: spec.models.maxTier,
      allowProviderFallback: spec.models.allowProviderFallback,
      callsPerChunk: Math.min(spec.context.callsPerChunk, PLATFORM_MAX_CALLS_PER_CHUNK),
      // E54.1: absent (every built-in, every policy written before) keeps one action per reply, and the run is unchanged.
      ...(spec.context.actionsPerReply && spec.context.actionsPerReply > 1 ? { actionsPerReply: spec.context.actionsPerReply } : {}),
      // E54.2: absent or `plain` keeps every result text as before.
      ...(spec.context.actionResults === 'delta' ? { actionResults: 'delta' as const } : {}),
      // E54.3: absent or `every_round` keeps a picture every round.
      ...(spec.context.screenshotWhen === 'on_change' ? { screenshotWhen: 'on_change' as const } : {}),
      stall: spec.stall,
      effectiveBudget: snapshot.effectiveBudget ?? computeEffectiveBudget(spec.budget, null),
    },
    routing: {
      problem: (tier) => (tiersResolved ? tierProblem(snapshot, tier) : null),
      route: (tier) => routeOf(tierRequest(snapshot, tier)),
      fallback: (tier) => {
        const f = fallbackRequest(snapshot, tier);
        return f ? routeOf(f) : null;
      },
      same: (a, b) => sameTierRequest(snapshot, a, b),
      hasVision: (tier) => tierHasVision(snapshot, tier),
    },
    mask: (text) => maskSensitive(text).text,
  };
}
