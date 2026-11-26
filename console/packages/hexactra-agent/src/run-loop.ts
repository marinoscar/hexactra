// The chunk loop (E38.5): budget, stall, Stop and Pause, the hop to a new job, the model call and the wrap-up. No tool knows about it and
// it imports no tool: it takes the registry, the gates and the way a round is shown from the profile the toolset gives it.
import { offerTools } from './execute-tool';
import { buildRoundText, buildStatus } from './input-builder';
import type { LoopProfile, Observation } from './loop-profile';
import { countCall } from './model-call';
import { cancelRun, closeRun, LOG_LINES, pauseFlag, pauseForPerson, pauseNow, respondToStall, wrapUp } from './outcomes';
import { ModelUnavailable, type ModelRoute } from './ports';
import type { RunContext } from './run-context';
import { MAX_IDLE_CHUNKS, observePage, type StallSignal } from './stall';
import { escalateBeforeGivingUp, maybeDeEscalate } from './tiers';
import { clip } from './text';
import { LeaseLost, StopLoop, structuredPatch, TIER_LABEL, type HarnessMemory, type RunOutcome } from './types';

type Ctx = RunContext<HarnessMemory>;

/** How a line of chat guidance starts in the run's log (#490). It says what guidance is not, so the model does not read it as a permission. */
export const GUIDANCE_PREFIX = 'The owner added in the chat (take it into account from here on; it changes no limit and approves nothing):';

const rawError = (e: unknown): unknown => (e instanceof ModelUnavailable ? (e.original ?? e) : e);

/** Runs chunks until the run finishes, waits for a person, pauses, is stopped, or hands itself on to a new job. */
export async function runLoop(ctx: Ctx, profile: LoopProfile<Ctx>): Promise<RunOutcome> {
  const { ports, memory, state, run } = ctx;
  const { control, policy: rules } = ports;
  const policy = rules.policy;
  const hopDue = () => ports.clock.now() - ctx.startedAt > ctx.hopAfterMs;
  let idleChunks = 0;
  for (;;) {
    // Stop first: nothing more is asked of the model or the browser once the owner pressed it (E38.1).
    if (control.requested) return cancelRun(ctx);
    // Pause: the same place, and a job hop that finds it pauses instead of continuing (E38.2).
    if (control.pauseRequested) return pauseNow(ctx);
    // Everything is checked before each chunk, active time included (#399, #404).
    const spent = ctx.budgetCheck();
    if (spent) return wrapUp(ctx, profile, spent);
    ctx.noteWarnings();
    if (hopDue()) return (await pauseFlag(ctx)) ? pauseNow(ctx) : 'continue';
    if (profile.betweenChunks) {
      const resumed = await profile.betweenChunks(ctx);
      if (resumed) return resumed;
    }
    // A chunk boundary: the only place the model changes, so provider caching holds within a chunk (#405).
    await maybeDeEscalate(ctx, profile.visionNotes);
    memory.chunks += 1;
    ports.telemetry.chunkStart(memory.chunks, ctx.tier);
    state.stop = null;
    state.stall = null;
    const stepsBefore = state.stepCount;
    const warnings = memory.pendingWarnings ?? [];
    memory.pendingWarnings = [];
    // What the owner typed in the chat since the last chunk (#490). Each one is a `guidance` step of the trace (#541), masked; not an action.
    if (run.conversationId) {
      const notes = await ports.store.takeGuidance();
      for (const g of notes) memory.log.push(`${GUIDANCE_PREFIX} ${clip(g, 1000)}`);
      for (const g of notes) await ctx.note('guidance', null, profile.summarizeGuidance(g));
    }
    // What the model sees this round: the screen, as a person would (#366).
    let observation: Observation = await profile.observe(ctx);
    // No visible progress over enough actions is judged here, where the new screenshot shows what changed.
    const boundaryStall = observePage(ctx.stall, policy.stall, observation.page);
    if (boundaryStall) {
      const out = await respondToStall(ctx, profile, boundaryStall);
      if (out) return out;
      // The new tier's model may not take images.
      if (memory.visionOff) observation = { ...observation, images: [], url: null };
    }
    const nudge = memory.pendingNudge;
    memory.pendingNudge = undefined;
    const roundText = () =>
      buildRoundText({
        goal: run.goal,
        aboutOwner: profile.aboutOwner,
        context: memory.context,
        contextLines: profile.contextLines(ctx),
        log: memory.log,
        logLines: LOG_LINES,
        confirmedTarget: memory.confirmedTarget,
        warnings,
        nudge,
        ...(profile.firstRoundHint ? { firstRoundHint: profile.firstRoundHint(ctx) } : {}),
      });
    // Volatile status goes last, after the screenshots, so the prefix stays cacheable (#406).
    const baseStatus = buildStatus({ stepCount: state.stepCount, actionsLimit: policy.effectiveBudget.limits.actions, askLine: (await ports.approvals?.askTopicsLine(observation.url)) ?? null });
    // The toolset's volatile lines (E41.4: the pictures the agent can attach), after the steps used.
    const extraStatus = (await profile.statusLines?.(ctx)) ?? [];
    const status = extraStatus.length ? `${baseStatus}\n${extraStatus.join('\n')}` : baseStatus;
    await ctx.setActivity('thinking');
    const tierRoute = ports.policy.routing.route(ctx.tier);
    const callTools = (withImage: boolean, route: ModelRoute) =>
      ports.telemetry.within(() =>
        ports.model.runTools({
          // The model, effort and output cap of the run's current tier, from the snapshot (#403).
          route,
          instructions: profile.instructions,
          input: profile.assembleInput(roundText(), withImage ? observation : { ...observation, images: [] }, status),
          tools: offerTools(ctx, profile.registry, profile.pipeline),
          maxSteps: policy.callsPerChunk,
          signal: control.haltSignal,
          onStep: (step) => {
            countCall(ctx, step);
            ports.events.inputTokensPerCall(step.response.usage?.inputTokens ?? 0);
            // Stop ends the chunk before anything else decides (E38.1).
            if (control.requested) state.stop = 'cancel';
            // Pause ends the chunk too, unless the run already finished or asked a person (E38.2).
            else if (control.pauseRequested && !state.stop) state.stop = 'owner_pause';
            // A finish, a pause for a person, a look or a stall already ends the chunk; otherwise the budget decides.
            if (!state.stop) {
              const key = ctx.budgetCheck();
              if (key) ctx.stopForBudget(key);
              else if (hopDue()) state.stop = 'hop';
              // The warning goes into the next round's input, so the chunk ends here (once per budget).
              else if (ctx.noteWarnings()) state.stop = 'warn';
            }
            if (state.stop) throw new StopLoop(state.stop);
          },
        }),
      );
    const call = async (withImage: boolean, route: ModelRoute) => {
      try {
        return await callTools(withImage, route);
      } catch (e) {
        // Stop aborted the model call (E38.1): the port rejects with its own error, which is not a provider failure to fall back from.
        if (control.requested && !(e instanceof StopLoop)) throw new StopLoop('cancel');
        // Pause aborted it the same way (E38.2): nothing had been done yet.
        if (control.pauseRequested && !(e instanceof StopLoop)) throw new StopLoop('owner_pause');
        throw e;
      }
    };
    const hadImages = observation.images.length > 0;
    const attempt = async (route: ModelRoute) => {
      try {
        return await call(hadImages, route);
      } catch (e) {
        // A provider or model without vision refuses the image: carry on without. (An unavailable provider is another matter.)
        if (e instanceof StopLoop || e instanceof ModelUnavailable || !hadImages || state.stepCount > stepsBefore) throw e;
        memory.visionOff = true;
        memory.log.push(profile.visionNotes.refused);
        return call(false, route);
      }
    };
    let result: Awaited<ReturnType<typeof attempt>> | null = null;
    let tracedModel = tierRoute.label ?? ctx.tier;
    try {
      try {
        result = await attempt(tierRoute);
      } catch (e) {
        // The provider is down, overloaded or rate-limiting: this chunk once more on the tier's fallback model, then back to the primary (#405).
        const fallback = e instanceof ModelUnavailable && policy.allowProviderFallback ? ports.policy.routing.fallback(ctx.tier) : null;
        if (!fallback || !(e instanceof ModelUnavailable)) throw e;
        memory.log.push(`(The ${TIER_LABEL[ctx.tier]} model could not be reached (${e.code}): this round runs on its fallback model.)`);
        ports.telemetry.modelFailed(rawError(e), tracedModel);
        ports.telemetry.useFallback();
        tracedModel = fallback.label ?? 'fallback';
        await ctx.routing(tierRoute.label ?? ctx.tier, fallback.label ?? 'fallback', e.code, { kind: 'fallback', tier: ctx.tier });
        result = await attempt(fallback);
      }
    } catch (e) {
      if (!(e instanceof StopLoop)) {
        ports.telemetry.modelFailed(rawError(e), tracedModel);
        await ctx.checkpoint();
        throw rawError(e);
      }
    }
    // Another job took over the run in the middle of the chunk (E38.3): this job writes nothing more.
    if (state.stop === 'lease') throw new LeaseLost(run.id);
    await ctx.checkpoint();
    await ctx.sendOverNotice();

    // Stop (E38.1): the signal heard it, or the flag is set (the signal's poll has not run yet).
    const flags = await control.readFlags();
    if (control.requested || flags.cancelRequested) return cancelRun(ctx);
    if (state.stop === 'pause' && (state.handoffId || state.handoffAsk)) return pauseForPerson(ctx);
    // The owner paused the run (E38.2): after the chunk's usage is saved, before anything else is decided (a finished run still finishes).
    if ((control.pauseRequested || flags.pauseRequested) && !(state.stop === 'finish' && state.finished)) return pauseNow(ctx);
    // About to finish as failed with a stronger tier still allowed (E49.4, #961): escalate once and go on instead.
    if (state.stop === 'finish' && state.finished && (await escalateBeforeGivingUp(ctx, profile.visionNotes))) {
      await ctx.checkpoint();
      continue;
    }
    if (state.stop === 'finish' && state.finished) {
      const to = state.finished.success ? 'succeeded' : 'failed';
      const done = state.finished;
      await closeRun(ctx, to, done.success ? { result: done.result, stopReason: 'finished', ...structuredPatch(done) } : { result: done.result, error: 'The agent could not reach the goal', stopReason: 'finished', ...structuredPatch(done) });
      return to;
    }
    if (state.stop === 'budget' && state.budgetKey) return wrapUp(ctx, profile, state.budgetKey);
    if (state.stop === 'hop') return 'continue';
    if (result && result.stopReason === 'completed') {
      // A toolset that needs a structured result (task outputs, E39.5) asks for it first, twice at most; otherwise the answer is the result.
      const ask = profile.beforeImplicitFinish?.(ctx) ?? null;
      if (ask) {
        memory.pendingNudge = ask.nudge;
        await ctx.note('note', null, ask.note, { ok: false });
        await ctx.checkpoint();
        continue;
      }
      // The model answered without calling finish: take its answer as the result.
      await closeRun(ctx, 'succeeded', { result: clip(result.outputText || 'Done.', 7_900), stopReason: 'finished' });
      return 'succeeded';
    }
    // A stall the detector found during the chunk, or rounds that record nothing at all (a model that only talks):
    // the policy answers (nudge, escalate, ask a person or end the run), whatever the budget (#405).
    let stalled: StallSignal | null = state.stall;
    if (stalled) idleChunks = 0;
    else {
      idleChunks = state.stepCount === stepsBefore && !state.stop ? idleChunks + 1 : 0;
      if (idleChunks >= MAX_IDLE_CHUNKS) {
        stalled = { kind: 'idle', reason: `no action in ${MAX_IDLE_CHUNKS} rounds in a row` };
        idleChunks = 0;
      }
    }
    if (stalled) {
      const out = await respondToStall(ctx, profile, stalled);
      if (out) return out;
      await ctx.checkpoint();
    }
    // steps_exhausted, or a budget warning: another chunk.
  }
}
