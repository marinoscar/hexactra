import type { ModelStep } from './ports';
import type { AnyContext } from './run-context';

/** Counts one model call in the usage totals (saved per chunk), in the budget and in the trace. */
export function countCall(ctx: AnyContext, step: ModelStep): void {
  const label = ctx.ports.policy.routing.route(ctx.tier).label;
  const usd = ctx.usage.add(step.response.provider, step.response.model || label || undefined, step.response.usage, ctx.prices);
  ctx.tracker.add({ modelCalls: 1, inputTokens: step.response.usage?.inputTokens, outputTokens: step.response.usage?.outputTokens, costUsd: usd ?? 0, costKnown: usd !== null });
  ctx.ports.telemetry.modelCall(step, { model: step.response.model || label || 'unknown', usd });
}
