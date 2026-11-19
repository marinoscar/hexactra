// What the policy answers to a stall (#405), and which tier an escalation would move to. No side effects.
import type { RunContext } from './run-context';
import { decideStall, MAX_STALL_HANDOFFS, type StallResponse } from './stall';
import { tierRank, TIERS, type HarnessMemory, type Tier } from './types';

type Ctx = RunContext<HarnessMemory>;

/** The tier a stall would escalate to, or null: none left, the limit is reached, or the next tier is no different. */
export function nextTier(ctx: Ctx): Tier | null {
  const { policy, routing } = ctx.ports.policy;
  if ((ctx.memory.escalations ?? 0) >= policy.stall.maxEscalations) return null;
  for (let r = tierRank(ctx.tier) + 1; r <= tierRank(policy.maxTier); r += 1) {
    const t = TIERS[r]!;
    if (routing.problem(t)) continue;
    if (routing.same(ctx.tier, t)) continue;
    return t;
  }
  return null;
}

/** What the policy answers to a stall now. */
export function stallResponse(ctx: Ctx): StallResponse {
  const mode = ctx.ports.policy.policy.stall.onStall;
  // An unattended (scheduled) run does not wait for a person unless its policy says to.
  const canAsk = (ctx.memory.stallHandoffs ?? 0) < MAX_STALL_HANDOFFS && (mode === 'ask_human' || ctx.run.trigger !== 'schedule');
  return decideStall({ mode, stallsHere: ctx.memory.stallsHere ?? 0, canEscalate: nextTier(ctx) !== null, canAsk });
}
