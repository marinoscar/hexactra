// How a run ends or waits: closing it, cancelling, pausing, waiting for a person, wrapping up when a budget is spent, and answering a stall.
import { BUDGET_STOP_REASON, wrapUpInstruction, type BudgetKey, type RunStopReason } from './budget';
import { BUDGET_ERROR } from './budget-errors';
import { countCall } from './model-call';
import type { LoopProfile } from './loop-profile';
import { noReportResult, stoppedResult } from './outcome-text';
import type { RunContext } from './run-context';
import { clearStallEvidence, lastActions, nudgeText, stallHandoffPrompt, stallWrapUpInstruction, type StallSignal } from './stall';
import { stallResponse, nextTier } from './stall-policy';
import { switchTier } from './tiers';
import { withinMs } from './time';
import { offerTools } from './execute-tool';
import { structuredPatch, type HarnessMemory, type ResultField, type RunOutcome, type RunState } from './types';

type Ctx = RunContext<HarnessMemory>;
type Profile = LoopProfile<Ctx>;

/** Lines of the step log handed back to the model each chunk. */
export const LOG_LINES = 60;
/** Output cap of the wrap-up call (#404): a summary, not a continuation. */
const WRAP_UP_MAX_OUTPUT_TOKENS = 1_500;
/** How long a Stop waits for the closing trace picture (E38.1): after that the run ends without one. */
const STOP_FINAL_SHOT_MS = 2_000;

/** End the run with a closing `end` step holding the final screen (#541), taken before the browser is released. */
export async function closeRun(ctx: Ctx, to: 'succeeded' | 'failed' | 'cancelled', patch: { result?: string; error?: string; stopReason?: RunStopReason; outputs?: Record<string, ResultField>; outputsComplete?: boolean }): Promise<void> {
  try {
    const seq = await ctx.note('end', null, `The run ended: ${to}`, { ok: to === 'succeeded' });
    // A Stop never waits long for the closing picture (E38.1).
    const final = to === 'cancelled' ? await withinMs(ctx.shoot('final'), STOP_FINAL_SHOT_MS, { note: 'unavailable' }) : await ctx.shoot('final');
    await ctx.attachShot(seq, 'final', final);
  } catch {
    // A missing closing picture never fails the run.
  }
  await ctx.ports.store.finish(to, patch);
}

/** Stop was pressed (E38.1): the memory and usage are already saved; end the run `cancelled`, saying what the last completed step was. */
export async function cancelRun(ctx: Ctx): Promise<RunOutcome> {
  await closeRun(ctx, 'cancelled', { result: stoppedResult(ctx.memory.log, ctx.ports.policy.mask), error: 'Cancelled by the user', stopReason: 'cancelled' });
  return 'cancelled';
}

/** The owner paused the run (E38.2): the chunk's usage is saved, the run is `paused`, the browser stays. */
export async function pauseNow(ctx: Ctx, patch: { handoffId?: string | null } = {}): Promise<RunOutcome> {
  await ctx.checkpoint();
  return (await ctx.ports.store.pause(patch)) ? 'paused' : 'superseded';
}

/** The flag of the owner's Pause, read from the store (the signal's poll may not have run yet). */
export async function pauseFlag(ctx: Ctx): Promise<boolean> {
  const { control } = ctx.ports;
  return control.pauseRequested || (await control.readFlags()).pauseRequested;
}

/** The run just asked a person, or is about to wait for one: move it to `waiting_human`. */
export async function pauseForPerson(ctx: Ctx): Promise<RunOutcome> {
  const { state, ports } = ctx;
  await ports.store.transition('waiting_human', { handoffId: state.handoffId, handoffExpiresAt: state.handoffExpiresAt });
  await ports.events.needsYou(state.handoffAsk ?? { prompt: 'The agent needs you.', kind: 'other', input: 'none' }, state.handoffExpiresAt, state.handoffId ?? null);
  return 'waiting_human';
}

/**
 * A budget is used up: one last call with only `finish` (exempt from the budget, counted in the totals) so the run still returns a
 * partial result. Without a `finish` the run ends on the budget's message. `finish(success: true)` is a success; anything else is a
 * failure with the typed stop reason.
 */
export async function wrapUp(ctx: Ctx, profile: Profile, cause: BudgetKey | StallSignal): Promise<RunOutcome> {
  const { memory, state, ports } = ctx;
  // A used-up budget, or a stall nothing could answer (#405): both end the run with a typed reason and a summary.
  const stopReason: RunStopReason = typeof cause === 'string' ? BUDGET_STOP_REASON[cause] : 'stalled';
  const error = typeof cause === 'string' ? BUDGET_ERROR[cause] : `The agent stalled: ${cause.reason}`;
  const instruction = typeof cause === 'string' ? wrapUpInstruction(cause) : stallWrapUpInstruction(cause.reason);
  memory.log.push(`${error}: asking the model to wrap up.`);
  state.stop = null;
  state.finished = null;
  state.wrappingUp = true;
  const finishTool = offerTools(ctx, profile.registry, profile.pipeline).filter((t) => t.name === 'finish');
  const input = [`Goal: ${ctx.run.goal}`, memory.log.length ? `Progress so far (latest last):\n${memory.log.slice(-LOG_LINES).join('\n')}` : '', instruction, profile.wrapUpNote?.(ctx) ?? ''].filter(Boolean).join('\n\n');
  await ctx.setActivity('thinking');
  try {
    await ports.telemetry.within(() =>
      ports.model.runTools({
        // The current tier's model and effort (#403); the wrap-up keeps its own small output cap.
        route: ports.policy.routing.route(ctx.tier),
        instructions: profile.instructions,
        input,
        tools: finishTool,
        maxSteps: 1,
        maxOutputTokens: WRAP_UP_MAX_OUTPUT_TOKENS,
        signal: ports.control.abortSignal,
        onStep: (step) => countCall(ctx, step),
      }),
    );
  } catch {
    // The wrap-up is best effort: without words the run ends on its own last steps.
  }
  await ctx.checkpoint();
  // Stop during the wrap-up call (E38.1): the run ends cancelled, whatever the model said.
  if (ports.control.requested) return cancelRun(ctx);
  state.wrappingUp = false;
  // `state.finished` was reset above; the wrap-up's `finish` call set it again.
  const done = state.finished as RunState['finished'];
  if (done?.success) {
    await closeRun(ctx, 'succeeded', { result: done.result, stopReason, ...structuredPatch(done) });
    return 'succeeded';
  }
  // No words from the model: the result is the run's own last steps, masked (#540), never only the budget message.
  await closeRun(ctx, 'failed', { result: done ? done.result : noReportResult(memory.log, ports.policy.mask), error, stopReason, ...structuredPatch(done) });
  return 'failed';
}

/**
 * Answer a stall as the policy says (#405), at a chunk boundary. Null: the run goes on (nudged, or escalated); otherwise the run's
 * outcome (waiting for a person, or ended as `stalled`).
 */
export async function respondToStall(ctx: Ctx, profile: Profile, signal: StallSignal): Promise<RunOutcome | null> {
  const { memory, state } = ctx;
  const response = stallResponse(ctx);
  // The screen when the stall was signalled (#541), on the latest step unless it already has a picture.
  const latest = await ctx.ports.store.getStep(state.seq);
  if (latest && !latest.screenshotKey) await ctx.attachShot(state.seq, 'failure', await ctx.shoot('failure'));
  memory.log.push(`Stalled: ${signal.reason}.`);
  memory.progressStreak = 0;
  if (response === 'nudge') {
    memory.pendingNudge = nudgeText(signal.reason, lastActions(ctx.stall));
    memory.stallsHere = (memory.stallsHere ?? 0) + 1;
    clearStallEvidence(ctx.stall);
    return null;
  }
  if (response === 'escalate') {
    await switchTier(ctx, nextTier(ctx)!, 'escalate', signal.reason, profile.visionNotes);
    return null;
  }
  if (response === 'ask') {
    memory.stallHandoffs = (memory.stallHandoffs ?? 0) + 1;
    const parsed = ctx.ports.questions.parse({ kind: 'other', input: 'takeover', prompt: stallHandoffPrompt(signal.reason, lastActions(ctx.stall)) });
    if (!parsed.ok) throw new Error(parsed.message);
    if (await ctx.askPerson(parsed.spec, Date.now())) {
      await ctx.checkpoint();
      return pauseForPerson(ctx);
    }
  }
  return wrapUp(ctx, profile, signal);
}
