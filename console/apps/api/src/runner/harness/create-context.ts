// Builds a RunContext: the plain state of one job's run plus the harness services bound to it.
import { activeElapsedMs } from './active-time';
import { BUDGET_LABEL, overNoteLine, usedOfLimit, warningLine, type BudgetKey } from './budget';
import { BUDGET_ERROR } from './budget-errors';
import { isSecretInput, questionMoment, type TraceMoment } from './moments';
import type { Picture, QuestionSpec } from './ports';
import type { RunContext } from './run-context';
import { note, openIntent, record, routing } from './steps';
import { resetStall } from './stall';
import { clip } from './text';
import { LEASE_LOST_TEXT, LeaseLost, PAUSED_TEXT, STOPPED_TEXT, type HarnessMemory } from './types';

export type RunContextInit<M extends HarnessMemory, X> = Omit<
  RunContext<M, X>,
  'setActivity' | 'budgetCheck' | 'stopForBudget' | 'budgetStop' | 'noteWarnings' | 'sendOverNotice' | 'preflight' | 'record' | 'openIntent' | 'note' | 'routing' | 'askPerson' | 'checkpoint' | 'shoot' | 'attachShot'
>;

export function createRunContext<M extends HarnessMemory, X>(init: RunContextInit<M, X>): RunContext<M, X> {
  // The owner's one "over its usual limit" notification (#537), waiting for the chunk's memory to be saved.
  let overNotice: { usedOfLimit: string; label: string } | null = null;
  // The harness services are written against the base memory; a toolset's memory only adds fields.
  const ctx: RunContext<M, X> = {
    ...init,
    async setActivity(phase, options = {}) {
      try {
        await ctx.ports.store.setActivity(phase, { ...options, ...(ctx.memory.tierNote ? { note: ctx.memory.tierNote } : {}) });
      } catch {
        // Best effort: it never fails the run.
      }
    },
    budgetCheck() {
      ctx.tracker.setActiveMs(activeElapsedMs(ctx.active, ctx.ports.clock.now()));
      return ctx.tracker.state().exhausted;
    },
    stopForBudget(key) {
      ctx.state.stop = 'budget';
      ctx.state.budgetKey = key;
    },
    budgetStop() {
      const spent = ctx.budgetCheck();
      if (!spent) return null;
      ctx.stopForBudget(spent);
      return `${BUDGET_ERROR[spent]}.`;
    },
    noteWarnings() {
      const { tracker, memory } = ctx;
      const effective = ctx.ports.policy.policy.effectiveBudget;
      if (tracker.enforcement === 'soft') {
        tracker.takeWarnings();
        memory.warned = tracker.warnedKeys();
        const over = tracker.takeOverNotices();
        if (over.length === 0) return false;
        memory.overNoticed = tracker.overNoticedKeys();
        const usedNow = tracker.used();
        for (const k of over) memory.log.push(overNoteLine(k, usedNow[k], effective.limits[k]!));
        // Once per run, for the first budget to go over (never a second notification); sent once the
        // memory that records it is saved, so a retried job never sends it again.
        if (over.length === tracker.overNoticedKeys().length) {
          const k = over[0]!;
          overNotice = { usedOfLimit: usedOfLimit(k, usedNow[k], effective.limits[k]!), label: BUDGET_LABEL[k] };
        }
        return false;
      }
      const keys = tracker.takeWarnings();
      if (keys.length === 0) return false;
      const { percent } = tracker.state();
      const usedNow = tracker.used();
      memory.warned = tracker.warnedKeys();
      for (const k of keys) {
        const limit = effective.limits[k]!;
        memory.pendingWarnings = [...(memory.pendingWarnings ?? []), warningLine(k, percent[k]!, usedNow[k], limit)];
        memory.log.push(`Budget warning: ${BUDGET_LABEL[k]} is at ${Math.floor(percent[k]!)}% (${usedOfLimit(k, usedNow[k], limit)}).`);
      }
      return true;
    },
    async sendOverNotice() {
      if (!overNotice) return;
      const n = overNotice;
      overNotice = null;
      await ctx.ports.events.overBudget(n.usedOfLimit, n.label);
    },
    async preflight() {
      const { state, ports } = ctx;
      // Another job took over the run (E38.3): nothing more is sent from here.
      if (state.stop === 'lease' || !(await ports.store.holdsRun())) {
        state.stop = 'lease';
        return LEASE_LOST_TEXT;
      }
      // Stop was pressed (E38.1): nothing is sent to the browser and nothing is recorded.
      if (ports.control.requested) {
        state.stop = 'cancel';
        return STOPPED_TEXT;
      }
      // Pause was pressed (E38.2): the same, and the run pauses after this chunk. An action already sent is never aborted by it.
      if (ports.control.pauseRequested) {
        state.stop ??= 'owner_pause';
        return PAUSED_TEXT;
      }
      return ctx.budgetStop();
    },
    record: (...args) => record(ctx as never, ...args),
    openIntent: (action, args, gate) => openIntent(ctx as never, action, args, gate),
    note: (kind, action, summary, extra) => note(ctx as never, kind, action, summary, extra),
    routing: (from, to, reason, extra) => routing(ctx as never, from, to, reason, extra),
    async shoot(moment: string): Promise<Picture> {
      return ctx.ports.pictures ? ctx.ports.pictures.capture(moment) : {};
    },
    async attachShot(seq, moment, picture) {
      await ctx.ports.pictures?.attach(seq, moment, picture);
    },
    async askPerson(asked: QuestionSpec, started: number) {
      const { memory, state, ports } = ctx;
      // The question as the person will see it (a confirmation of an AI app's run names the app, #465).
      const spec = ports.questions.prepare(asked);
      // A new request supersedes a confirmation not yet acted on (#540); its prompt is what an approval allows.
      memory.pendingConfirmation = null;
      memory.askedPrompt = spec.prompt;
      // The screen the person is asked about (#541), before the handoff opens; never for a secret or a sign-in (#525).
      const moment: TraceMoment = questionMoment(spec.kind);
      const pre = isSecretInput(spec.input) ? null : await ctx.shoot(moment);
      let questionId: string | null = null;
      try {
        const created = await ports.questions.open(spec);
        state.handoffId = created.handoffId;
        state.handoffExpiresAt = created.expiresAt;
        questionId = created.questionId;
      } catch (e) {
        await ctx.record('handoff', null, null, false, `could not ask a person: ${e instanceof Error ? e.message : String(e)}`, started);
        return false;
      }
      await ctx.record('handoff', null, { kind: spec.kind, input: spec.input }, true, `asked a person (${spec.kind}): ${clip(spec.prompt, 300)}`, started);
      ports.telemetry.asked({ kind: spec.kind, input: spec.input });
      if (questionId) await ports.store.patchStep(state.seq, { questionId });
      if (pre) await ctx.attachShot(state.seq, moment, pre);
      state.handoffAsk = { prompt: spec.prompt, kind: spec.kind, input: spec.input };
      state.stop = 'pause';
      resetStall(ctx.stall);
      memory.stallsHere = 0;
      memory.progressStreak = 0;
      return true;
    },
    async checkpoint() {
      const { memory, ports, run } = ctx;
      memory.log = memory.log.slice(-200);
      const usage = ctx.usage.drain();
      ports.events.tokens(usage.inputTokens, usage.outputTokens);
      ports.events.modelCalls(usage.modelCalls);
      if (!(await ports.store.checkpoint({ memory, usage }))) throw new LeaseLost(run.id);
    },
  };
  return ctx;
}

export type { BudgetKey };
