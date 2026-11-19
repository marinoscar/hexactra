/** The owner's standing approval that matched a gate or an ask. */
export interface SavedApproval {
  id: string;
  summary: string;
}

/**
 * The owner's saved approvals (#555). Optional: a host without one makes every gated step ask. Guarantees: matching is done by the
 * server from facts it read itself (never the model's words); `recordUse` is called once per step it allowed.
 */
export interface ApprovalPort {
  /** A saved-approvals store is present. False: nothing is ever matched and every ask goes to the owner. */
  readonly enabled: boolean;
  /** A rule that lets this gated target through, or null. */
  matchGate(target: { host: string; category: string; label: string }): Promise<SavedApproval | null>;
  /** A rule that lets an ask the agent made on its own through, or null. */
  matchAsk(topic: string, pageUrl: string): Promise<SavedApproval | null>;
  /**
   * A rule that lets a call through one of the owner's connections go ahead (E39.7), or null: for this connection and tool, in this run's
   * task or chat, covering every recipient the call reaches. `recipients` are the addresses the server read from the validated call.
   */
  matchConnection(target: { connectionId: string; tool: string; recipients: readonly string[] }): Promise<SavedApproval | null>;
  recordUse(rule: SavedApproval, use: { stepSeq: number }): Promise<void>;
  /** What "Don't ask again" offers for a gate. */
  rememberableGate(gate: { host: string | null; category: string; label: string | null }): unknown;
  /** What it offers for an ask on a topic, on a page. */
  rememberableAsk(topic: string, pageUrl: string): unknown;
  /** The fixed topic of an ask (`other` when none fits). */
  topicOf(raw: unknown): string;
  /** The line naming the owner's ask rules for the current site, or null. */
  askTopicsLine(pageUrl: string | null): Promise<string | null>;
}
