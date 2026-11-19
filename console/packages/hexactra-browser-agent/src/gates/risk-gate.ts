// The confirmation gate (#550) and the owner's saved approvals (#555). Whether a click must wait for a person is decided by what is
// clicked (the target's facts, read from the page), never by the model's reason. A saved approval is matched by the server and the model
// cannot claim one.
import { clip, targetUnknown, type Gate, type GateTarget, type SavedApproval } from '../../harness';
import type { BrowserContext } from '../context';
import { currentHost } from '../page';
import { approvalCovers, classifyTarget, type TargetFacts } from '../policy';

export const RISK_GATE = 'risk';

/** What a click tool asks the risk gate: what it looked at, and how a refusal reads in the step. */
export interface RiskRequest {
  action: string;
  /** The arguments the refused step keeps (never the model's reason). */
  args: Record<string, unknown>;
  reason: string;
  /** What the page said about the target; the tool's fallback facts when it could not be asked. */
  facts: TargetFacts | null;
  /** Whether the page itself described the target (a saved approval needs it). */
  described: boolean;
}

/** What a click tool receives when the gate lets it through. */
export interface RiskDecision {
  /** The commitment the click is: null for an ordinary click. */
  target: GateTarget | null;
  /** The saved approval that allowed it, when no confirmation did. */
  rule: SavedApproval | null;
}

/** Whether the person's approval covers this target. */
function approved(ctx: BrowserContext, target: GateTarget): boolean {
  return Boolean(ctx.memory.confirmedTarget && approvalCovers(ctx.memory.confirmedTarget as never, target as never)) || Boolean(ctx.ext.hooks.covers?.(target));
}

/**
 * The confirmation gate: the gated target and its reason, or null when the click may go ahead. With the task's confirmation off,
 * nothing is read.
 */
async function gateFor(ctx: BrowserContext, facts: TargetFacts | null): Promise<(GateTarget & { why: string }) | null> {
  if (!ctx.ext.confirmRisky()) return null;
  const verdict = classifyTarget(facts ?? {});
  if (!verdict.risky || !verdict.category) return null;
  ctx.ports.telemetry.gated(verdict.category);
  return { category: verdict.category, label: verdict.label, host: await currentHost(ctx), why: verdict.why ?? 'a commitment' };
}

/**
 * A saved approval that lets a gated click through (#555), matched by the server: the registrable domain of the page the browser reports,
 * the verdict's category and the element's label read from the page. Never when the page could not describe the target (a cross-origin
 * frame, a failed read), never when the run's AI app asks before purchases (#464), never after an attempt on this target that may or may
 * not have happened (E38.3), never while "Pause all" is on. The model is not asked and cannot claim one.
 */
async function savedGate(ctx: BrowserContext, target: GateTarget, described: boolean): Promise<SavedApproval | null> {
  const approvals = ctx.ports.approvals;
  if (!approvals || !described || !target.host || ctx.ext.hooks.savedApprovalBlocked?.(target) || targetUnknown(ctx.memory, target)) return null;
  return approvals.matchGate({ host: target.host, category: target.category ?? '', label: target.label ?? '' });
}

export const riskGate: Gate<BrowserContext> = {
  name: RISK_GATE,
  async check(ctx, request) {
    const r = request as RiskRequest | null;
    if (!r) return { kind: 'allow', data: { target: null, rule: null } satisfies RiskDecision };
    const target = await gateFor(ctx, r.facts);
    const rule = target && !approved(ctx, target) ? await savedGate(ctx, target, r.described) : null;
    if (target && !approved(ctx, target) && !rule) {
      // The next confirmation the model asks for carries this gate (#550).
      ctx.memory.gatePending = { category: target.category, label: target.label, host: target.host };
      return {
        kind: 'refuse',
        text: `Refused: ${target.why} is a ${target.category} step. Call request_human with kind "confirmation" describing exactly what will happen, then try again.`,
        step: { action: r.action, args: { ...r.args, category: target.category, label: target.label }, summary: `paused by policy: needs a person's confirmation (${target.category}: ${target.why})`, reasoning: r.reason },
      };
    }
    return { kind: 'allow', data: { target, rule } satisfies RiskDecision };
  },
};

/**
 * After a click a saved approval allowed (#555): the step carries `approval.ruleId` and says so, the rule's use is recorded, and the step
 * is a confirmed action "by saved approval" (#540). Only when the click was carried out.
 */
export async function allowedByRule(ctx: BrowserContext, rule: SavedApproval, seqBefore: number, action: string): Promise<void> {
  const { state, ports, memory } = ctx;
  if (state.seq === seqBefore) return;
  const step = await ports.store.getStep(state.seq);
  if (!step || !step.ok || step.kind !== 'action') return;
  const args = step.args && typeof step.args === 'object' && !Array.isArray(step.args) ? (step.args as Record<string, unknown>) : {};
  await ports.store.patchStep(state.seq, { args: { ...args, approval: { ruleId: rule.id } }, summary: clip(`allowed by a saved approval: ${rule.summary}`, 1_900) });
  try {
    await ports.approvals?.recordUse(rule, { stepSeq: state.seq });
  } catch {
    // The use is a count for the owner: it never fails the run.
  }
  await ports.store.appendConfirmedAction({ seq: state.seq, prompt: `by saved approval: ${rule.summary}`, action, at: new Date() });
  memory.log.push(`(Step ${state.stepCount} went ahead on a saved approval of the owner.)`);
}

/** After a gated click went ahead the approval is spent; a failed attempt keeps it for the retry (#540). */
export function spend(ctx: BrowserContext, target: GateTarget | null): void {
  if (target && !ctx.memory.pendingConfirmation) ctx.memory.confirmedTarget = null;
}
