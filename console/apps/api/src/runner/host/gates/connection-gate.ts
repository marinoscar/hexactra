// The gate of the tools that change something through one of the owner's connections (E39.7): send, create, update, delete, append, upload.
// A read never reaches it. It decides from facts the SERVER read (the connection the run lists, the arguments after validation, the owner's
// saved approvals), never from the model's words:
//   1. a call the owner already declined is refused, not asked again;
//   2. a call the owner approved on a card goes ahead once, and only the same call (the hash of its validated arguments is compared);
//   3. a saved approval (kind `connection`: this connection, this tool, and for a call that reaches people, a recipient set that covers
//      every one of them) lets it go ahead. A call to anyone new asks again, whatever was remembered. A call whose last attempt may or may
//      not have happened is never covered by one;
//   4. otherwise the owner is asked, on a card the server built from the validated arguments. The run waits for the answer with no browser.
import { normaliseRecipient } from '../../../approvals/approval-match';
import { clip, targetUnknown, type Gate, type GateVerdict } from '@marinoscar/hexactra-agent';
import type { HostContext } from '../context';
import { CONNECTION_GATE, intentTarget, type ConnectionDecision, type ConnectionGateRequest } from '../tools/connections/support';

/** The card's prompt, from the server's facts: "Send an email with Work", then each labelled fact. */
export function cardPrompt(action: NonNullable<ConnectionGateRequest['action']>): string {
  return clip([`The agent asks to ${action.display ?? `${action.tool.replace(/_/g, ' ')} with "${action.connectionLabel}"`}.`, ...action.lines.map((l) => `${l.label}: ${l.value}`)].join('\n'), 2_000);
}

export const connectionGate: Gate<HostContext> = {
  name: CONNECTION_GATE,
  async check(ctx, raw, call): Promise<GateVerdict> {
    const r = raw as ConnectionGateRequest;
    const tool = call.tool;
    if (r.refusal) return { kind: 'refuse', text: r.refusal, step: { action: tool, args: r.connection ? { connection: r.connection.label } : {}, summary: clip(r.refusal, 300) } };
    const conn = r.connection!;
    const action = r.action!;
    const hash = action.hash ?? '';
    const mem = ctx.memory.connections ?? {};
    ctx.ports.telemetry.gated('connection');

    if ((mem.declined ?? []).some((d) => d.connectionId === conn.id && d.tool === tool && d.argsHash === hash)) {
      return { kind: 'refuse', text: 'The owner declined this exact call. It was not done. Do not try it again; tell the owner it was not done.', step: { action: tool, args: { connection: conn.label }, summary: 'declined by the owner earlier; not asked again' } };
    }
    // The run is already about to wait, stop or hand on: nothing more is asked or done.
    if (ctx.state.stop) return { kind: 'refuse', text: 'The run is about to wait or stop. Do not call more tools in this round.' };
    // Only the very call the owner approved, once.
    if (mem.approved && mem.approved.connectionId === conn.id && mem.approved.tool === tool && mem.approved.argsHash === hash) {
      return { kind: 'allow', data: { request: r, via: 'approved', prompt: mem.approved.prompt } satisfies ConnectionDecision };
    }
    // A saved approval: never after an attempt that may or may not have happened (E38.3), and with the recipients it covers.
    const unknown = targetUnknown(ctx.memory, intentTarget(tool, conn.id));
    const approvals = ctx.ports.approvals;
    if (approvals && !unknown) {
      const rule = await approvals.matchConnection({ connectionId: conn.id, tool, recipients: r.recipients ?? [] });
      if (rule) return { kind: 'allow', data: { request: r, via: 'rule', rule } satisfies ConnectionDecision };
    }
    const prompt = cardPrompt(action);
    const parsed = ctx.ports.questions.parse({ kind: 'confirmation', input: 'confirm', prompt, confirmLabel: 'Approve', denyLabel: 'Decline', risk: 'high' });
    if (!parsed.ok) return { kind: 'refuse', text: `Could not ask the owner: ${parsed.message}.` };
    const spec = { ...parsed.spec, action, prompt, stepSummary: `approval of: ${action.summary}` };
    // "Don't ask again" (#555): what the owner may remember is the server's own record of this call, never the model's.
    // A call that reaches people we cannot name (an event's existing attendees) cannot be remembered: no rule would cover them.
    const namable = (r.recipients ?? []).every((x) => normaliseRecipient(x) !== null);
    if (approvals?.enabled && namable) {
      spec.rememberable = {
        kind: 'connection',
        host: conn.id,
        category: null,
        matchKey: tool,
        summary: r.summary ?? `${tool.replace(/_/g, ' ')} with ${conn.label}`,
        ...(r.recipients?.length ? { recipients: r.recipients } : {}),
        scopes: ['everywhere', ...(ctx.run.taskId ? ['this_task'] : []), ...(ctx.run.conversationId ? ['this_chat'] : [])],
      };
    }
    return { kind: 'ask', question: spec, text: 'Asked the owner to approve this. The run waits for their answer: do not call anything else this round.' };
  },
};
