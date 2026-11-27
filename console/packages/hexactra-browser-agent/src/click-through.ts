// What every click does once the risk gate let it through: the card payment around the pay button, the action itself, and the spending of
// the approval. Shared by `click`, `click_mark` and `click_at`; the gate and the target are the tool's.
import type { GateDecision } from '@marinoscar/hexactra-agent';
import { act } from './act';
import type { BrowserContext } from './context';
import { allowedByRule, RISK_GATE, spend, type RiskDecision } from './gates/risk-gate';
import { lastStepOk, pageDigest } from './page';

/** `action` is the name a saved approval records (`click`, `click_at`); `box` is where the click lands, for the run page. */
export async function clickThrough(ctx: BrowserContext, decision: GateDecision, fabricAction: Record<string, unknown>, name: string, reason: string, box?: { x: number; y: number; w?: number; h?: number }): Promise<string> {
  const { target, rule } = (decision[RISK_GATE] ?? { target: null, rule: null }) as RiskDecision;
  const seqBefore = ctx.state.seq;
  const hooks = ctx.ext.hooks;
  const cardPay = rule ? false : ((await hooks.payBegin?.(target)) ?? false);
  // The page as it was before the click (E52.3): `act` says when the click left it exactly so.
  const before = await pageDigest(ctx);
  const out = await act(ctx, fabricAction, reason, box, target, { before });
  if (rule) await allowedByRule(ctx, rule, seqBefore, name);
  else spend(ctx, target);
  if (cardPay) await hooks.payEnd?.(await lastStepOk(ctx, seqBefore));
  return out;
}
