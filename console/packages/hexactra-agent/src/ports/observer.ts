/** What one step the tool recorded told the stall detector: the page's URL and a digest of what the tool read. Never typed text or page text. */
export interface ObservedStep {
  ok: boolean;
  url?: string | null;
  contentHash?: string;
}

/** One tool call as the wrapper saw it, after it returned (E46.5). */
export interface ToolCallObservation {
  /** The run's step sequence after the call (the last step it recorded, or the sequence it ran at). */
  seq: number;
  tool: string;
  family: string;
  commits: boolean;
  /** The arguments exactly as the model sent them. The observer decides what of them it may keep; a correct one keeps no typed value. */
  args: unknown;
  /** The text the model read back. */
  resultText: string;
  /** The last recorded step's `ok`; for a call that recorded no step, whether it ran. */
  ok: boolean;
  /** `ran`: the tool ran. `refused`: a gate refused it. `asked`: a gate asked a person instead. */
  outcome: 'ran' | 'refused' | 'asked';
  /** The steps the call recorded, in order. */
  steps: ObservedStep[];
  startedAt: number;
  durationMs: number;
}

/**
 * Watches tool calls (E46.5): the Knowledge Graph's capture binds one; a host without it binds nothing.
 *
 * A correct binding guarantees: it never changes what the call returns or what the run does (the wrapper catches a throw and counts it); it
 * stores no typed text, secret, handoff value, token, page text, screenshot or model reasoning.
 */
export interface ObserverPort {
  /** Just before a call runs (after Stop and Pause, before the gates): the page is still as the model saw it. Optional; a throw is ignored. */
  beforeToolCall?(call: { tool: string; family: string; args: unknown }): void | Promise<void>;
  toolCall(observation: ToolCallObservation): void | Promise<void>;
}
