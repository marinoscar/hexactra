//! Type definitions for Hexactra

/**
 * Error codes for Hexactra SDK errors
 */
export enum ErrorCode {
  InvalidInput = 'INVALID_INPUT',
  Unauthorized = 'UNAUTHORIZED',
  Forbidden = 'FORBIDDEN',
  NotFound = 'NOT_FOUND',
  Conflict = 'CONFLICT',
  RateLimit = 'RATE_LIMIT',
  InternalError = 'INTERNAL_ERROR',
  NetworkError = 'NETWORK_ERROR',
  TimeoutError = 'TIMEOUT_ERROR',
}

export interface Session {
  id: string;
  profileId: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Profile {
  id: string;
  name: string;
  chromeProfilePath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Operation {
  id: string;
  goalId: string;
  status: OperationStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export enum RunStatus {
  Queued = 'queued',
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
  Cancelled = 'cancelled',
  TimedOut = 'timed_out',
}

export enum SessionStatus {
  Initializing = 'initializing',
  Running = 'running',
  Paused = 'paused',
  Ended = 'ended',
}

export enum OperationStatus {
  Queued = 'queued',
  InProgress = 'in_progress',
  Completed = 'completed',
  Failed = 'failed',
}

export interface BrowserAction {
  type: string;
  payload?: Record<string, unknown>;
}

export interface ActionResult {
  success: boolean;
  error?: string;
  data?: unknown;
}

// ==================== Handoff Types ====================
//
// Human handoffs of the remote control API (`/v1`): see
// docs/remote-control-api.md#human-handoff and api/openapi.yaml.

/** Why the agent needs a human. */
export type HandoffKind = 'captcha' | 'code' | 'passkey' | 'login' | 'confirmation' | 'verification' | 'other';

/** What the human is asked to provide. */
export type HandoffInput =
  | 'none'
  | 'text'
  | 'secret'
  | 'choice'
  | 'multi_choice'
  | 'number'
  | 'confirm'
  | 'takeover';

/** Lifecycle of a handoff. */
export type HandoffStatus = 'pending' | 'completed' | 'cancelled' | 'expired';

/** How the human resolved a handoff. `cancelled` means they declined. */
export type HandoffOutcome = 'completed' | 'cancelled';

/** How risky approving a `confirm` question is (a UI hint). */
export type HandoffRisk = 'low' | 'high';

/** One option of a `choice` or `multi_choice` question, as returned. */
export interface HandoffChoice {
  /** What the answer carries (`[A-Za-z0-9_-]{1,64}`). */
  id: string;
  /** What the human sees (at most 100 characters). */
  label: string;
  /** At most 200 characters. */
  description?: string | null;
}

/** An option as a caller sends it: a bare string (id and label) or an object. */
export type HandoffChoiceSpec = string | HandoffChoice;

/** Bounds on an answer; a constraint that does not apply to the input is a `400`. */
export interface HandoffConstraints {
  /** `text` (1-4096, default 4096) and `secret`. */
  max_length?: number;
  /** `text`: regex the whole answer must match (at most 200 characters). */
  pattern?: string;
  /** `text`: `false` rejects newlines. */
  multiline?: boolean;
  /** `multi_choice`: fewest options to select (default 1). */
  min_selections?: number;
  /** `multi_choice`: most options to select (default: all). */
  max_selections?: number;
  /** `number`: smallest accepted value. */
  min?: number;
  /** `number`: largest accepted value. */
  max?: number;
  /** `number`: the answer is `min` (or 0) plus a multiple of `step`. */
  step?: number;
  /** `number`: unit label (at most 20 characters). */
  unit?: string;
}

/** Page the agent was on when it asked for help (informational only). */
export interface HandoffPage {
  url?: string | null;
  title?: string | null;
}

/** Body of `POST /v1/sessions/{id}/handoffs`. */
export interface CreateHandoffRequest {
  kind: HandoffKind;
  /** What the human should do, in plain words. */
  prompt: string;
  /** Defaults to `none` on the server. */
  input?: HandoffInput;
  /** `choice` and `multi_choice` only (1 to 10). */
  choices?: HandoffChoiceSpec[];
  constraints?: HandoffConstraints;
  /** `confirm` only (at most 40 characters). */
  confirm_label?: string;
  /** `confirm` only (at most 40 characters). */
  deny_label?: string;
  /** `confirm` only (default `high`). */
  risk?: HandoffRisk;
  /** 10 seconds to 24 hours; defaults to 10 minutes. */
  timeout_ms?: number;
  page?: HandoffPage;
}

/** The human's answer as visible to readers. */
export interface HandoffResponse {
  outcome: HandoffOutcome;
  /** `text`, `choice` (option id), `number` (canonical decimal) and `confirm` (`approve` | `deny`). */
  value?: string | null;
  /** `multi_choice`: the selected option ids. */
  values?: string[] | null;
  /**
   * True for `secret` inputs: the value is never returned. Type it into the
   * page with {@link ControlPlaneClient.typeSecret}.
   */
  value_withheld?: boolean;
  /** Which channel answered (free-form label). */
  channel?: string | null;
  /** `operator`, `service:<name>`, `token`, or the `answered_by` an authenticated caller recorded. */
  by?: string | null;
  answered_at?: string | null;
}

/** A handoff as reported by the API and in webhook payloads. */
export interface HandoffView {
  id: string;
  session_id: string;
  host_id: string;
  profile?: string;
  kind: HandoffKind;
  prompt: string;
  input: HandoffInput;
  /** Always objects. */
  choices?: HandoffChoice[];
  constraints?: HandoffConstraints;
  confirm_label?: string | null;
  deny_label?: string | null;
  risk?: HandoffRisk | null;
  page?: HandoffPage | null;
  status: HandoffStatus;
  created_at: string;
  expires_at: string;
  resolved_at?: string | null;
  response?: HandoffResponse | null;
  /** Web viewer of the host's browser, when the host has one. */
  viewer_url?: string | null;
}

/** Response of `POST /v1/sessions/{id}/handoffs`. */
export interface CreateHandoffResponse {
  handoff: HandoffView;
  /** Single-use token any channel can use to answer this handoff. */
  response_token: string;
  /** Path of the respond endpoint. */
  respond_path: string;
}

/** Filters of `GET /v1/handoffs`. */
export interface ListHandoffsOptions {
  sessionId?: string;
  pending?: boolean;
}

/** Body of `POST /v1/handoffs/{id}/respond`. */
export interface RespondHandoffRequest {
  outcome: HandoffOutcome;
  value?: string;
  values?: string[];
  /** Label of the answering channel, for the record. */
  channel?: string;
  /** Who answered (at most 128 characters); honoured only with an operator or service token. */
  answered_by?: string;
}

/** Options of {@link ControlPlaneClient.respondHandoff}. */
export interface RespondHandoffOptions {
  /**
   * The handoff's single-use response token. Sent in the
   * `X-Hexactra-Response-Token` header, never in the URL. Not needed when
   * the client's own token is an operator or service token.
   */
  responseToken?: string;
}

/** A `type_secret` action: type the answer of a `secret` handoff of this session. */
export interface TypeSecretRequest {
  handoffId: string;
  selector: string;
  /** Clear the existing value first. */
  clear?: boolean;
  /** Press Enter / submit the enclosing form after typing. */
  submit?: boolean;
  tabId?: number;
}

/** State of a remote operation. */
export type RemoteOperationState =
  | 'queued'
  | 'dispatched'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

/** An operation of the remote control API (`GET /v1/operations/{id}`). */
export interface OperationView {
  id: string;
  session_id: string;
  host_id: string;
  action: Record<string, unknown> & { type: string };
  state: RemoteOperationState;
  result?: unknown;
  error?: string | null;
  created_at: string;
  completed_at?: string | null;
  /** Top-level navigations blocked under the session's allowed sites since the previous action (#508). */
  navigation_blocked?: BlockedNavigation[];
}

/** A top-level navigation the browser refused under a session's allowed sites (#508). */
export interface BlockedNavigation {
  host: string;
  at: string;
}
