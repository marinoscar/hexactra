// Calling a web port under the run's rules (E50.4): Stop, Pause, the budgets and the lease first (`preflight`), the run page's activity
// while it waits, and the owner's Stop as the abort signal. Shared support of the two tools, not a tool.
import { STOPPED_TEXT } from '@marinoscar/hexactra-agent';
import type { WebContext } from './context';
import { isWebToolError, type WebToolErrorCode } from './ports';

export type PortOutcome<T> = { ok: true; value: T } | { ok: false; code: WebToolErrorCode } | { ok: false; stopped: string };

/** How long the run page says a web call may take. */
export const WEB_CALL_TIMEOUT_MS = 30_000;

/**
 * Runs `fn` with the owner's Stop as its signal. A refusal from `preflight` (Stop, Pause, a spent budget, a lost lease) means nothing is
 * sent. Any error becomes a code: an error that is not a `WebToolError` is `UNAVAILABLE`, and its text is never read.
 */
export async function callPort<T>(ctx: WebContext, tool: string, fn: (signal: AbortSignal) => Promise<T>): Promise<PortOutcome<T> | { ok: false; refused: string }> {
  const refused = await ctx.preflight();
  if (refused) return { ok: false, refused };
  await ctx.setActivity('acting', { action: { type: tool }, timeoutMs: WEB_CALL_TIMEOUT_MS });
  try {
    return { ok: true, value: await fn(ctx.ports.control.abortSignal) };
  } catch (e) {
    if (ctx.ports.control.requested) {
      ctx.state.stop = 'cancel';
      return { ok: false, stopped: STOPPED_TEXT };
    }
    return { ok: false, code: isWebToolError(e) ? e.code : 'UNAVAILABLE' };
  } finally {
    await ctx.setActivity('thinking');
  }
}

/** The run's sensitive patterns (the host's `PolicyPort.mask`, the table the trace masking uses): true when `text` holds one. */
export const holdsSecret = (ctx: WebContext, text: string): boolean => ctx.ports.policy.mask(text) !== text;
