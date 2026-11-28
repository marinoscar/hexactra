import type { z } from 'zod';

/** A tool as the model is offered it: the name, the description for the model, the arguments schema and the call. */
export interface ModelTool {
  name: string;
  description: string;
  parameters: z.ZodType;
  /** `false`: the provider is not asked for strict function calling (see `RunnerTool.strict`). Absent: strict. */
  strict?: boolean;
  execute(args: never): Promise<string>;
}

/** The model, effort and output cap a tier resolves to: opaque to the harness, handed back to the port as is. */
export interface ModelRoute {
  /** What a person reads for the model (`standard`, a model name). */
  label: string | null;
  params: Record<string, unknown>;
}

export interface ModelStep {
  response: { provider?: string; model?: string; finishReason?: string; usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } };
  calls?: { callId: string; name: string; status: string; durationMs: number }[];
  /**
   * How long the model took to answer this round trip, in milliseconds (E54.0): the binding measures it (the time since the previous step,
   * less the tools this step ran). Absent when the binding cannot tell; then it counts as 0.
   */
  latencyMs?: number;
}

export interface ModelRequest {
  route: ModelRoute;
  instructions: string;
  /** What the model reads this round: text, or what the toolset's `assembleInput` made of the text and the images. */
  input: unknown;
  tools: ModelTool[];
  maxSteps: number;
  maxOutputTokens?: number;
  signal: AbortSignal;
  /** Called after each model response and its tool calls. Throwing ends the chunk: the port lets the error escape. */
  onStep(step: ModelStep): void;
}

export interface ModelResult {
  /** `completed`: the model answered without calling a tool. Anything else: it ran out of steps. */
  stopReason: string;
  outputText: string;
}

/** The provider is down, overloaded, rate-limiting or the model cannot be reached: the loop may retry on the tier's fallback. */
export class ModelUnavailable extends Error {
  constructor(
    readonly code: string,
    readonly original?: unknown,
  ) {
    super(code);
  }
}

/**
 * Runs one tool-calling chunk. Guarantee: the port validates arguments against `parameters`, calls `execute`, feeds the result back
 * and stops when the model answers, when `maxSteps` is reached, when `signal` aborts, or when `onStep` throws (the throw escapes).
 * It throws `ModelUnavailable` for a provider that cannot be reached, and any other error as it is.
 */
export interface ModelPort {
  runTools(request: ModelRequest): Promise<ModelResult>;
}
