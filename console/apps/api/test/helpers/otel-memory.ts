// An in-memory OpenTelemetry setup for the agent-trace specs (E38.4, #585): a tracer provider that keeps every
// finished span, and a context manager so the active span follows `await`. `uninstall` puts the API back to its
// no-op state, which is what a deployment with the telemetry slice off runs on.
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';

export function installMemoryTracing() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.disable();
  context.disable();
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
  return {
    exporter,
    spans: (): ReadableSpan[] => exporter.getFinishedSpans(),
    reset: () => exporter.reset(),
    uninstall: async () => {
      await provider.shutdown();
      trace.disable();
      context.disable();
    },
  };
}

/** The parent span id of a finished span ('' for a root). */
export const parentOf = (s: ReadableSpan): string => s.parentSpanContext?.spanId ?? '';

const at = (s: ReadableSpan) => s.startTime[0] * 1e9 + s.startTime[1];

/** The finished spans whose parent is `parent`, oldest first. */
export const childrenOf = (spans: ReadableSpan[], parent: ReadableSpan): ReadableSpan[] =>
  spans.filter((s) => parentOf(s) === parent.spanContext().spanId).sort((a, b) => at(a) - at(b));

/** The tree under `root` as indented names, for a readable assertion. */
export function treeOf(spans: ReadableSpan[], root: ReadableSpan, depth = 0): string[] {
  return [`${'  '.repeat(depth)}${root.name}`, ...childrenOf(spans, root).flatMap((c) => treeOf(spans, c, depth + 1))];
}

/** Everything a span could leak through: name, attributes, events, links, status, resource. */
export function spanText(s: ReadableSpan): string {
  return JSON.stringify({ name: s.name, attributes: s.attributes, events: s.events, links: s.links, status: s.status, resource: s.resource.attributes });
}
