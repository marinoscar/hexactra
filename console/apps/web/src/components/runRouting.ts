/**
 * Routing steps (#405) as the run timeline shows them (#408): a step of kind
 * `routing` records an escalation, a de-escalation or a provider fallback as
 * `{ from, to, reason }`. This is the one place that reads that shape; a run
 * from before #405 simply has no such steps.
 */
import { TIER_LABEL, type Tier } from './runBudget';

/** The step fields a routing row reads. */
export interface RoutingStepLike {
  kind: string;
  args: Record<string, unknown> | null;
  summary: string;
}

export interface RoutingRow {
  direction: 'up' | 'down' | 'fallback';
  /** "↑ Frontier: stuck on repeated click". */
  label: string;
}

const TIER_ORDER: readonly Tier[] = ['fast', 'standard', 'frontier'];
const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIER_ORDER as readonly string[]).includes(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export const isRoutingStep = (s: { kind: string }) => s.kind === 'routing';

/** The row of a routing step; null for any other step. Reads `args` first, then falls back to the summary. */
export function routingRow(step: RoutingStepLike): RoutingRow | null {
  if (!isRoutingStep(step)) return null;
  const a = step.args ?? {};
  const from = a.from;
  const to = a.to;
  const reason = text(a.reason) ?? text(step.summary);
  const tail = reason ? `: ${reason}` : '';
  if (isTier(from) && isTier(to) && from !== to) {
    const up = TIER_ORDER.indexOf(to) > TIER_ORDER.indexOf(from);
    return { direction: up ? 'up' : 'down', label: `${up ? '↑' : '↓'} ${TIER_LABEL[to]}${tail}` };
  }
  // Anything else is a model switch within a tier: the fallback model, or back to the primary.
  const back = typeof to === 'string' && /primary/i.test(to);
  return { direction: 'fallback', label: `⇄ ${back ? 'primary' : 'fallback'} model${tail}` };
}
