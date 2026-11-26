// What a run keeps about its connections (E39.7): in the run memory (`runs.transcript`) and in the context. Never a mailbox's content: ids,
// counts and the hash of the arguments the owner approved.
import type { SnapshotConnection } from '../../../policies/policy-snapshot';
import type { NeedsBrowser } from './run-connections';

/** The call the owner was asked to approve, and is now being waited on. */
export interface ConnectionAsk {
  questionId: string;
  connectionId: string;
  tool: string;
  /** The hash of the validated arguments the card showed: only the same call goes through. */
  argsHash: string;
  /** What the card said, for the record of the confirmed step. */
  prompt: string;
}

export interface ConnectionsMemory {
  /** The owner approved this call: the gate lets exactly it through once. */
  approved?: ConnectionAsk | null;
  /** Calls the owner declined (the hashes): the gate refuses them without asking again. */
  declined?: { connectionId: string; tool: string; argsHash: string }[];
  /** Drafts this run saved (the newest three): what `mail_send(draft_id)` shows the owner. The run's own text, never the mailbox's. */
  drafts?: Record<string, { connectionId: string; to: string[]; cc: string[]; bcc: string[]; subject: string; body: string }>;
  /** What the run has read through connections: the caps of the agent policy's context section are checked against it. */
  reads?: { messages: string[]; chars: number };
  /** The MCP toolboxes this run opened with `open_toolbox` (E50.17): family ids (`mcp:<connectionId>`). Set only by the tool. */
  toolboxes?: string[];
}

/** The limits of what a run may read through connections: the agent policy's context section (E39.7). */
export interface ConnectionReadLimits {
  messages: number;
  chars: number;
}

export const DEFAULT_CONNECTION_READ_LIMITS: Readonly<ConnectionReadLimits> = Object.freeze({ messages: 25, chars: 200_000 });

/** What the context holds of the run's connections. */
export interface RunConnectionsInfo {
  list: readonly SnapshotConnection[];
  limits: ConnectionReadLimits;
  needsBrowser: NeedsBrowser;
  /** The browser opens at its first use. */
  lazyBrowser: boolean;
  /** How the model is told to ask the owner which account (a chat has `ask_user`, a run `request_human`). */
  askWith?: 'request_human' | 'ask_user';
}
