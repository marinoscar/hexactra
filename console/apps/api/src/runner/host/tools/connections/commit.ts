// A connection call that changes something (E39.7): send, create, append, upload. Shared by the gated tools; the gate has already decided.
// In this order: Stop and the budgets (`preflight`), the intent step (a job that dies between the send and its result leaves evidence, and
// the next job never repeats the call blindly, E38.3), the call, then the step with the outcome, and the owner's approval is spent.
import { allowedByRule } from '@marinoscar/hexactra-browser-agent/gates';
import type { SavedApproval } from '@marinoscar/hexactra-agent';
import type { HostContext } from '../../context';
import { callConnection, errorText, type Cap, LEASE_LOST_TEXT, noteCall, openCallIntent, outcomeUnknown, recordStep, type ConnectionDecision, type Service } from './support';
import type { Capability } from '../../../../connections/connections.constants';

export interface WriteSpec<S extends Service, T> {
  tool: string;
  service: S;
  decision: ConnectionDecision;
  capability: Capability;
  /** The step's arguments: recipients and subject, names and sizes; never a body or a file's content. */
  stepArgs: Record<string, unknown>;
  /** What the intent names, in the words the model reads if the outcome is lost: "send an email from Work to 1 recipient (subject: X)". */
  what: string;
  /** What to check before doing it again when the outcome is unknown (`mail_search` of the Sent folder, a calendar list). */
  check: string;
  call: (cap: Cap[S]) => Promise<T>;
  /** The step's summary and the model's text for a carried-out call. */
  done: (value: T) => { summary: string; text: string; ambiguous?: boolean };
}

/** Spends the owner's approval of a call that was carried out: the confirmed step, or the saved approval's use. */
export async function settle(ctx: HostContext, decision: ConnectionDecision, tool: string, seqBefore: number): Promise<void> {
  if (decision.via === 'rule' && decision.rule) {
    await allowedByRule(ctx as never, decision.rule as SavedApproval, seqBefore, tool);
    return;
  }
  const mem = (ctx.memory.connections ??= {});
  mem.approved = null;
  if (ctx.state.seq !== seqBefore) await ctx.ports.store.appendConfirmedAction({ seq: ctx.state.seq, prompt: decision.prompt ?? `${tool} with ${decision.request.connection?.label ?? 'a connection'}`, action: tool, at: new Date() });
}

export async function commitCall<S extends Service, T>(ctx: HostContext, spec: WriteSpec<S, T>): Promise<string> {
  const { request } = spec.decision;
  const conn = request.connection!;
  const refused = await ctx.preflight();
  if (refused) return refused;
  const started = Date.now();
  await ctx.setActivity('acting', { action: { type: spec.tool }, timeoutMs: 60_000 });
  const seqBefore = ctx.state.seq;
  const intent = await openCallIntent(ctx, spec.tool, conn.id, spec.stepArgs, `${spec.what}; before anything else, ${spec.check}`);
  if (intent === null) return LEASE_LOST_TEXT;
  noteCall(ctx, conn.provider, spec.capability, 'write');
  try {
    let called;
    try {
      called = await callConnection(ctx, conn, spec.service, spec.call);
    } catch (e) {
      // Not a typed failure: the call may or may not have gone out. Recorded, never retried blindly.
      await recordStep(ctx, spec.tool, started, spec.stepArgs, false, `failed unexpectedly: ${e instanceof Error ? e.name : 'error'}; the outcome is not known`, { intent });
      (ctx.memory.connections ??= {}).approved = null;
      return `The call failed unexpectedly and it may or may not have happened. Do not repeat it blindly: ${spec.check} first.`;
    }
    if (called.ok) {
      const done = spec.done(called.value);
      await recordStep(ctx, spec.tool, started, spec.stepArgs, true, done.summary, { intent });
      await settle(ctx, spec.decision, spec.tool, seqBefore);
      return done.text;
    }
    if (outcomeUnknown(called.error)) {
      // The provider could not be reached or failed in the middle: the owner's approval is spent, the call is not repeated.
      await recordStep(ctx, spec.tool, started, spec.stepArgs, false, `${errorText(called.error, conn.label)} The outcome is not known.`, { intent });
      (ctx.memory.connections ??= {}).approved = null;
      return `${called.text} It may or may not have happened. Do not repeat it blindly: ${spec.check} first, and if you cannot tell, ask the owner.`;
    }
    // A failure that certainly did nothing (the account, the permission, the arguments): the approval stands for the retry.
    await recordStep(ctx, spec.tool, started, spec.stepArgs, false, called.text, { intent });
    return called.text;
  } finally {
    await ctx.setActivity('thinking');
  }
}
