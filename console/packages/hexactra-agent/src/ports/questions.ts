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
  /**
   * A call through one of the owner's connections the owner is asked to approve (E39.7): built by the server from the tool's validated
   * arguments, never from model text. Such a question needs no browser.
   */
  action?: unknown;
  /** One line with no content that stands for the question in the run's step, its memory and the owner's notifications (the card itself shows the details). */
  stepSummary?: string;
}

export interface OpenedQuestion {
  /**
   * The id the answer comes back under (a browser handoff id). Null for a question that needs no browser (E39.7): it is asked in the
   * owner's inbox, the run waits for it with no handoff, and its answer resumes the run through the question's own id.
   */
  handoffId: string | null;
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
