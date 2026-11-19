/** A question for a person, as the harness knows it. The host's contract is richer; this is what the loop and the gates read and write. */
export interface QuestionSpec {
  kind: string;
  prompt: string;
  input: string;
  options?: unknown;
  constraints?: unknown;
  confirmLabel?: unknown;
  denyLabel?: unknown;
  risk?: unknown;
  rememberLabel?: unknown;
  /** The commitment the gate stopped, from the server's own record: `{ host, category, label }`. */
  gate?: unknown;
  /** What "Don't ask again" would remember. */
  rememberable?: unknown;
}

export interface OpenedQuestion {
  /** The id the answer comes back under (a handoff id). */
  handoffId: string;
  expiresAt: Date | null;
  /** The broker's own id, so the step that asked links to it; null without a broker. */
  questionId: string | null;
}

/**
 * Asking a person. Guarantees: `open` returns only once the question exists where the person will see it; an answer is delivered to
 * the run once; a person who cannot be reached makes `open` throw (the loop then records "could not ask a person").
 */
export interface QuestionPort {
  /** Validates the raw arguments of a request; a message the model can act on when invalid. */
  parse(raw: Record<string, unknown>): { ok: true; spec: QuestionSpec } | { ok: false; message: string };
  /** The question as the person will see it: the host may add where the run came from ("Started by <app>"). Pure. */
  prepare(spec: QuestionSpec): QuestionSpec;
  open(spec: QuestionSpec): Promise<OpenedQuestion>;
}
