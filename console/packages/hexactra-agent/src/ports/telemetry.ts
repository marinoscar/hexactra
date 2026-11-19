export interface StepFacts {
  response: { provider?: string; model?: string; finishReason?: string; usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } };
  calls?: { callId: string; name: string; status: string; durationMs: number }[];
}

/**
 * Traces and metrics of one job (E38.4). Never carries a typed value, a secret or an image. A host without telemetry binds a no-op;
 * the harness behaves the same either way.
 */
export interface TelemetryPort {
  /** Runs `fn` inside the job's trace context (so model and tool spans nest under it). */
  within<T>(fn: () => Promise<T>): Promise<T>;
  /** One tool call: opens its span and times it. */
  toolCall<T>(name: string, fn: () => Promise<T>): Promise<T>;
  setTier(tier: string): void;
  chunkStart(number: number, tier: string): void;
  modelCall(step: StepFacts, extra: { model: string; usd: number | null }): void;
  modelFailed(error: unknown, model: string): void;
  useFallback(): void;
  stepRecorded(info: { seq: number; ok: boolean; action: string | null; url?: unknown }): void;
  gated(category: string): void;
  asked(facts: { kind: string; input: string }): void;
  answered(facts: { kind: string; input: string | null; channel: string | null; outcome: string; waitedMs: number | null }): void;
}
