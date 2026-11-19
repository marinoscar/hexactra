// Small pure helpers of the agent trace (E38.4): the shape of a model step, and what a span may say about a page or an error.
import { trace, type Span, type SpanContext } from '@opentelemetry/api';

import { ERROR_TYPE } from './trace-attributes';

export interface PendingTool {
  name: string;
  start: number;
  span?: Span;
  endedAt?: number;
  thrown?: boolean;
  seq?: number;
  ok?: boolean;
  action?: string;
  host?: string;
  gate?: string;
}

/** What `onStep` hands over about a model round trip (a structural subset of `AiToolStep`). */
export interface StepFacts {
  response: { provider?: string; model?: string; finishReason?: string; usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } };
  calls?: { callId: string; name: string; status: string; durationMs: number }[];
}

/** The host of a URL, or undefined: the one part of a page address a span may carry. */
export function pageHost(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** The span context of a stored trace and span id (a remote, sampled parent), or null when they are not valid. */
export function storedSpanContext(traceId: string | null | undefined, spanId: string | null | undefined): SpanContext | null {
  if (!traceId || !spanId) return null;
  const sc: SpanContext = { traceId, spanId, traceFlags: 1, isRemote: true };
  return trace.isSpanContextValid(sc) ? sc : null;
}

/** An `error.type` for a thrown value: an AI or fabric error's code, else the error's class name. Never its message. */
export function errorTypeOf(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(code)) return code;
  return e instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(e.name) ? e.name : ERROR_TYPE.other;
}
