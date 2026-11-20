export interface StepFacts {
  response: { provider?: string; model?: string; finishReason?: string; usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } };
  calls?: { callId: string; name: string; status: string; durationMs: number }[];
}

/**
 * Traces and metrics of one job (E38.4). Never carries a typed value, a secret or an image. A host without telemetry binds a no-op;
 * the harness behaves the same either way.
 */
/** What the wrapper tells the telemetry about one tool call (E41.1). Content-free: a family id and an outcome. */
export interface ToolCallMeta {
  family: string;
  /** Set by the wrapper: `refused` when a gate refused the call. Absent: the call ran (its own success is the step's). */
  outcome?: 'refused';
}

export interface TelemetryPort {
  /** Runs `fn` inside the job's trace context (so model and tool spans nest under it). */
  within<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * One tool call: opens its span and times it. `meta` (E41.1) carries the tool's family (`toolFamilyOf`); the wrapper sets `meta.outcome`
   * to `refused` when a gate refused the call, before `fn` resolves.
   */
  toolCall<T>(name: string, fn: () => Promise<T>, meta?: ToolCallMeta): Promise<T>;
  /** The tool families offered this round (E41.1), sorted; a host records the union for the run. Optional: a host may ignore it. */
  familiesOffered?(families: readonly string[]): void;
  setTier(tier: string): void;
  chunkStart(number: number, tier: string): void;
  modelCall(step: StepFacts, extra: { model: string; usd: number | null }): void;
  modelFailed(error: unknown, model: string): void;
  useFallback(): void;
  stepRecorded(info: { seq: number; ok: boolean; action: string | null; url?: unknown }): void;
  gated(category: string): void;
  /** Closed, content-free attributes of the tool call now running (E39.7: which provider and capability a connection tool used). The host keeps only the names it allows. */
  toolAttributes(attrs: Record<string, string | number | boolean>): void;
  asked(facts: { kind: string; input: string }): void;
  answered(facts: { kind: string; input: string | null; channel: string | null; outcome: string; waitedMs: number | null }): void;
}
