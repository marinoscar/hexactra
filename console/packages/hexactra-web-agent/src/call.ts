// Calling a web port under the run's rules (E50.4): Stop, Pause, the budgets and the lease first (`preflight`), the run page's activity
// while it waits, and the owner's Stop as the abort signal. Shared support of the two tools, not a tool.
import { STOPPED_TEXT } from '@marinoscar/hexactra-agent';
import type { WebContext } from './context';
import { isWebToolError, type WebToolErrorCode } from './ports';

export type PortOutcome<T> = { ok: true; value: T } | { ok: false; code: WebToolErrorCode } | { ok: false; stopped: string };

/** The span attributes the web tools add (closed, content-free names and values; the host keeps only the names it allows). */
export const WEB_SPAN_ATTRS = { provider: 'hexactra.web.provider', results: 'hexactra.web.results', kind: 'hexactra.web.kind', outcome: 'hexactra.web.outcome' } as const;

/** What a call to a port came to, for the span: `ok`, `stopped`, or the error code in lower case (`limit_reached`, `blocked`, ...). */
function spanOutcome(ctx: WebContext, tool: string, outcome: string): void {
  ctx.ports.telemetry.toolAttributes({ [WEB_SPAN_ATTRS.kind]: tool === 'web_fetch' ? 'fetch' : 'search', [WEB_SPAN_ATTRS.outcome]: outcome });
}

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
    const value = await fn(ctx.ports.control.abortSignal);
    spanOutcome(ctx, tool, 'ok');
    return { ok: true, value };
  } catch (e) {
    if (ctx.ports.control.requested) {
      ctx.state.stop = 'cancel';
      spanOutcome(ctx, tool, 'stopped');
      return { ok: false, stopped: STOPPED_TEXT };
    }
    const code = isWebToolError(e) ? e.code : 'UNAVAILABLE';
    spanOutcome(ctx, tool, code.toLowerCase());
    return { ok: false, code };
  } finally {
    await ctx.setActivity('thinking');
  }
}

/** The run's sensitive patterns (the host's `PolicyPort.mask`, the table the trace masking uses): true when `text` holds one. */
export const holdsSecret = (ctx: WebContext, text: string): boolean => ctx.ports.policy.mask(text) !== text;
