// Moving a run between model tiers (#405), at chunk boundaries only.
import type { RunContext } from './run-context';
import { nextTier } from './stall-policy';
import { clip } from './text';
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

/** The nudge after a run was stopped from giving up (E49.4, #961). Its own words are quoted back as data, clipped. */
export function giveUpNudge(result: string): string {
  return (
    `You were about to finish without reaching the goal ("${clip(result, 300)}"). A stronger model continues now. ` +
    'Look at the page again before deciding: it may have moved on, or there may be another way. Do not ask the person for something they already gave unless the page says it was wrong. ' +
    'Finish as failed only if the goal truly cannot be reached.'
  );
}

/**
 * Before a run finishes as failed (E49.4, #961): when a stronger tier is still allowed (the policy's maxTier and maxEscalations), the
 * run escalates once and goes on, with the finish undone. A run on its max tier, one that already did this, a wrap-up after a budget
 * stop, and a run whose owner said no (`ownerDeclined`, set by the host when it folds an answer) finish as before. Returns whether it
 * escalated.
 */
export async function escalateBeforeGivingUp(ctx: Ctx, notes: VisionNotes): Promise<boolean> {
  const { memory, state } = ctx;
  const done = state.finished;
  // After the owner said no, giving up is the right answer: a stronger model must not try again (or ask again).
  if (!done || done.success || state.wrappingUp || memory.escalatedBeforeGivingUp || memory.ownerDeclined) return false;
  const to = nextTier(ctx);
  if (!to) return false;
  memory.escalatedBeforeGivingUp = true;
  state.finished = null;
  state.stop = null;
  await switchTier(ctx, to, 'escalate', 'about to finish without reaching the goal', notes);
  memory.pendingNudge = giveUpNudge(done.result);
  return true;
}

/**
 * Whether an owner's answer said no (E49.4, #961): a yes/no card denied, or a question declined or left unanswered. The host sets
 * `memory.ownerDeclined` from it when it folds an answer, and a failed finish after a no is then never escalated.
 */
export function ownerSaidNo(a: { completed: boolean; input: string; value?: string }): boolean {
  return !a.completed || (a.input === 'confirm' && a.value === 'deny');
}
