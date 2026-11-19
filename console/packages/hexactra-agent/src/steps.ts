// Recording what a run does (E38.3): one step row per action, an `intent` row before an action that can commit, the model's log line,
// the stall feed and the budget. These are the harness services behind `ctx.record`, `ctx.openIntent`, `ctx.note` and `ctx.routing`.
import { describeIntent } from './intent';
import { redactActionArgs } from './redact';
import type { RunContext } from './run-context';
import { stallResponse } from './stall-policy';
import { observeAction, type ActionObservation } from './stall';
import { clip } from './text';
import type { GateTarget, HarnessMemory, StepExtra } from './types';

type Ctx = RunContext<HarnessMemory>;

/** The model's log line for a step (the same text a reconciled step gets from its row). */
export function logLine(stepCount: number, action: string | null, kind: string, args: Record<string, unknown> | null, ok: boolean, summary: string): string {
  return `${stepCount}. ${action ?? kind}${args ? ` ${JSON.stringify(redactActionArgs(action ?? '', args))}` : ''} → ${ok ? 'ok' : 'FAILED'}: ${clip(summary, 300)}`;
}

/** Feed the detector one action; a stall ends the chunk (an escalation is its own stop reason). */
function feedStall(ctx: Ctx, type: string, args: Record<string, unknown>, ok: boolean, extra: StepExtra): void {
  const obs: ActionObservation = { type, args, ok, ...extra };
  const verdict = observeAction(ctx.stall, ctx.ports.policy.policy.stall, obs);
  if (extra.secret) return;
  ctx.memory.progressStreak = verdict.progressing ? (ctx.memory.progressStreak ?? 0) + 1 : 0;
  if (verdict.signal && !ctx.state.stop && !ctx.state.stall) {
    ctx.state.stall = verdict.signal;
    ctx.state.stop = stallResponse(ctx) === 'escalate' ? 'escalate' : 'stall';
  }
}

/**
 * After an approved confirmation (#540): the first successful action is the one the person allowed. A policy-paused attempt is not;
 * a failed action keeps the marker (the agent retries); five failures clear it. Only the masked prompt and the action's name are stored.
 */
function noteConfirmed(memory: HarnessMemory, kind: string, ok: boolean, summary: string): { prompt: string } | null {
  const pending = memory.pendingConfirmation;
  if (!pending || kind !== 'action' || summary.startsWith('paused by policy')) return null;
  if (!ok) {
    pending.tries += 1;
    if (pending.tries >= 5) memory.pendingConfirmation = null;
    return null;
  }
  memory.pendingConfirmation = null;
  return { prompt: pending.prompt };
}

/** The record of the step the person allowed (#540), once the memory that no longer holds the marker is saved (E38.3). */
async function recordConfirmed(ctx: Ctx, confirmed: { prompt: string }, action: string | null, kind: string, seq: number): Promise<void> {
  await ctx.ports.store.appendConfirmedAction({ seq, prompt: confirmed.prompt, action: action ?? kind, at: new Date() });
  // The first screen after the confirmed step (#541).
  await ctx.attachShot(seq, 'after_confirmed', await ctx.shoot('after_confirmed'));
}

export async function record(ctx: Ctx, kind: string, action: string | null, args: Record<string, unknown> | null, ok: boolean, summary: string, started: number, reasoning?: string, extra?: StepExtra, intentSeq?: number | null): Promise<void> {
  const { state, memory, ports } = ctx;
  state.stepCount += 1;
  const seq = intentSeq ?? ++state.seq;
  ctx.tracker.add({ actions: 1 });
  ports.events.step(kind, ok);
  ports.telemetry.stepRecorded({ seq, ok, action, url: args?.url });
  if (action && args && (kind === 'action' || action === 'look')) feedStall(ctx, action, args, ok, extra ?? {});
  memory.log.push(logLine(state.stepCount, action, kind, args, ok, summary));
  memory.lastSeq = Math.max(memory.lastSeq ?? 0, seq);
  const confirmed = noteConfirmed(memory, kind, ok, summary);
  memory.log = memory.log.slice(-200);
  // The step row, the step count and the memory in one transaction, conditional on the lease (E38.3): after this the model's
  // view of the run and the run itself agree, and a job that lost the run writes nothing.
  const held = await ports.store.commitStep({
    memory,
    stepCount: state.stepCount,
    finishesIntent: intentSeq != null,
    step: {
      seq,
      kind,
      action,
      args: args ? redactActionArgs(action ?? '', args) : undefined,
      ok,
      phase: 'done',
      summary: clip(summary, 1_900),
      reasoning: reasoning ? clip(reasoning, 1_900) : null,
      durationMs: Date.now() - started,
    },
  });
  if (!held) {
    state.stop = 'lease';
    return;
  }
  if (confirmed) await recordConfirmed(ctx, confirmed, action, kind, seq);
  await ports.events.stepRecorded(state.stepCount);
}

/**
 * An action that can commit something is about to be sent (E38.3): its step row is written first, in phase `intent`, with the memory
 * as it is now. A job that dies before `record` finishes it leaves this row, and the next job marks it `unknown`. Returns the row's
 * `seq`, or null when this job no longer holds the run (nothing is written then).
 */
export async function openIntent(ctx: Ctx, action: string, args: Record<string, unknown>, gate: GateTarget | null, named?: string): Promise<number | null> {
  const { state } = ctx;
  // A tool that knows what it is about to do (a send, a booking) says so itself; the rest are described from their arguments.
  const what = named ?? describeIntent(action, args, gate);
  const held = await ctx.ports.store.openIntent(ctx.memory, {
    seq: state.seq + 1,
    kind: 'action',
    action,
    args: { ...redactActionArgs(action, args), ...(gate ? { gate: { category: gate.category, label: gate.label, host: gate.host } } : {}), what },
    ok: true,
    phase: 'intent',
    summary: clip(`about to ${what}`, 1_900),
  });
  if (!held) {
    state.stop = 'lease';
    return null;
  }
  state.seq += 1;
  return state.seq;
}

/** A record of the trace (#541): takes a `seq`, never the step count, the actions budget or the stall detector. */
export async function note(ctx: Ctx, kind: string, action: string | null, summary: string, extra: { questionId?: string | null; ok?: boolean } = {}): Promise<number> {
  ctx.state.seq += 1;
  await ctx.ports.store.appendStep({ seq: ctx.state.seq, kind, action, ok: extra.ok ?? true, summary: clip(summary, 1_900), durationMs: 0, ...(extra.questionId ? { questionId: extra.questionId } : {}) });
  return ctx.state.seq;
}

/** A routing step (#405): a tier change or a provider fallback. It is not an action: it takes a `seq`, never the step count or the actions budget. */
export async function routing(ctx: Ctx, from: string, to: string, reason: string, extra: Record<string, unknown> = {}): Promise<void> {
  ctx.state.seq += 1;
  await ctx.ports.store.appendStep({ seq: ctx.state.seq, kind: 'routing', action: null, args: { from, to, reason, ...extra }, ok: true, summary: clip(`${from} → ${to}: ${reason}`, 1_900), durationMs: 0 });
}
