// The span around one fabric operation, inside a run's trace.
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

import { AGENT_KEY, TOOL_KEY, tracer, type AgentTrace } from './agent-trace';
import { errorTypeOf } from './agent-trace-support';
import { ATTR, ERROR_TYPE, SPAN } from './trace-attributes';

/**
 * Wraps one fabric operation in a `hexactra.fabric <action>` span, a CLIENT span the fabric client's
 * `traceparent` header then continues (`hexactra-control` takes it as the parent of its request span).
 * Only inside a run's trace; anywhere else (a probe, an external agent's session) it just calls `fn`.
 */
export async function traceFabric<T extends { id?: string; state?: string }>(action: string, fn: () => Promise<T>): Promise<T> {
  const owner = context.active().getValue(AGENT_KEY) as AgentTrace | undefined;
  if (!owner?.recording) return fn();
  // Inside a tool call the operation hangs under that call; anywhere else (the chunk's screenshot), under the chunk.
  const active = context.active();
  const parent = active.getValue(TOOL_KEY) ? active : owner.currentContext;
  const span = tracer().startSpan(SPAN.fabric(action), { kind: SpanKind.CLIENT, attributes: { [ATTR.fabricAction]: action } }, parent);
  try {
    const op = await context.with(trace.setSpan(parent, span), fn);
    span.setAttributes({ ...(op?.id ? { [ATTR.fabricOperationId]: op.id } : {}), ...(op?.state ? { [ATTR.fabricState]: op.state } : {}) });
    if (op?.state && op.state !== 'succeeded') {
      span.setAttribute(ATTR.errorType, ERROR_TYPE.fabricError);
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    return op;
  } catch (e) {
    span.setAttribute(ATTR.errorType, errorTypeOf(e));
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw e;
  } finally {
    span.end();
  }
}
