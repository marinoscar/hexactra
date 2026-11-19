// Moving a run between model tiers (#405), at chunk boundaries only.
import type { RunContext } from './run-context';
import { clearStallEvidence, DE_ESCALATE_AFTER } from './stall';
import { TIER_LABEL, type HarnessMemory, type Tier } from './types';

type Ctx = RunContext<HarnessMemory>;

/** The text a run carries when its model takes no images. The toolset provides it: it names the tools to use instead. */
export interface VisionNotes {
  /** The tier's model takes no images. */
  byTier: string;
  /** The model refused an image. */
  refused: string;
}

/** Move the run to another tier, at a chunk boundary. */
export async function switchTier(ctx: Ctx, to: Tier, kind: 'escalate' | 'deescalate', reason: string, notes: VisionNotes): Promise<void> {
  const { memory } = ctx;
  const from = ctx.tier;
  ctx.tier = to;
  memory.tier = to;
  if (kind === 'escalate') {
    memory.escalations = (memory.escalations ?? 0) + 1;
    memory.tierNote = `Escalated to ${TIER_LABEL[to]} (stuck: ${reason})`;
    memory.log.push(`Escalated to the ${TIER_LABEL[to]} tier (stuck: ${reason}).`);
  } else {
    memory.tierNote = null;
    memory.log.push(`Back on the ${TIER_LABEL[to]} tier: the run is making progress again.`);
  }
  memory.stallsHere = 0;
  memory.progressStreak = 0;
  clearStallEvidence(ctx.stall);
  // The new tier's model may not take images (and the old one may not have): follow it.
  const vision = ctx.ports.policy.routing.hasVision(to);
  if (vision === false && !memory.visionOff) {
    memory.visionOff = true;
    memory.visionOffByTier = true;
    memory.log.push(notes.byTier);
  } else if (vision !== false && memory.visionOff && memory.visionOffByTier) {
    memory.visionOff = false;
    memory.visionOffByTier = false;
  }
  await ctx.routing(from, to, reason, { kind });
  await ctx.ports.store.setTier(to, memory.escalations ?? 0);
}

/** After enough progressing actions on an escalated tier, the run returns to its start tier (#405). */
export async function maybeDeEscalate(ctx: Ctx, notes: VisionNotes): Promise<void> {
  if (ctx.tier === ctx.startTier || (ctx.memory.progressStreak ?? 0) < DE_ESCALATE_AFTER) return;
  await switchTier(ctx, ctx.startTier, 'deescalate', `${ctx.memory.progressStreak} progressing actions in a row`, notes);
}
