/** What the run publishes: metrics, the live step count and the notifications to its owner. Best effort: a failure never fails the run. */
export interface EventsPort {
  step(kind: string, ok: boolean): void;
  tokens(input: number, output: number): void;
  modelCalls(n: number): void;
  inputTokensPerCall(n: number): void;
  recovered(unknownSteps: number): void;
  /** The run's step count changed (the run page updates). */
  stepRecorded(stepCount: number): Promise<void>;
  /** One notification, once per run, for the first soft budget to go over. */
  overBudget(usedOfLimit: string, label: string): Promise<void>;
  /** The run now waits for a person. */
  needsYou(ask: { prompt: string; kind: string; input: string }, expiresAt: Date | null, handoffId: string | null): Promise<void>;
}
