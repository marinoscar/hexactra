//! Client for Hexactra control plane API

import {
  Goal,
  Session,
  Operation,
  BrowserAction,
  ActionResult,
  CreateGoalRequest,
  CreateHandoffRequest,
  CreateHandoffResponse,
  HandoffView,
  ListHandoffsOptions,
  RespondHandoffRequest,
  RespondHandoffOptions,
  TypeSecretRequest,
  OperationView,
  ErrorCode,
} from './types';
import { HttpClient, HttpClientConfig, HexactraError } from './http';

export interface ControlPlaneClientConfig extends HttpClientConfig {}

/**
 * Client for the Hexactra control plane API
 */
export class ControlPlaneClient {
  private readonly httpClient: HttpClient;

  constructor(config: ControlPlaneClientConfig) {
    this.httpClient = new HttpClient(config);
  }

  /**
   * Create a new goal (task) for a session
   */
  async createGoal(sessionId: string, actions: BrowserAction[]): Promise<Goal> {
    const request: CreateGoalRequest = { sessionId, actions };
    return this.httpClient
      .post<CreateGoalRequest, Goal>(`/goals`, request)
      .then((response) => response.body);
  }

  /**
   * Get session details
   */
  async getSession(sessionId: string): Promise<Session> {
    return this.httpClient.get<Session>(`/sessions/${sessionId}`).then((response) => response.body);
  }

  /**
   * List all sessions
   */
  async listSessions(): Promise<Session[]> {
    return this.httpClient.get<{ sessions: Session[] }>('/sessions').then(
      (response) => response.body.sessions
    );
  }

  /**
   * Get operation details
   */
  async getOperation(operationId: string): Promise<Operation> {
    return this.httpClient.get<Operation>(`/operations/${operationId}`).then((response) => response.body);
  }

  /**
   * Execute a single browser action
   */
  async executeAction(sessionId: string, action: BrowserAction): Promise<ActionResult> {
    return this.httpClient
      .post<BrowserAction, ActionResult>(`/sessions/${sessionId}/actions`, action)
      .then((response) => response.body);
  }

  // ==================== Handoff Methods ====================
  //
  // Human handoffs of the remote control API (`/v1`). The `/v1` paths are
  // relative to `baseUrl`, so `baseUrl` is the control plane's origin.

  /**
   * Ask a person for help: open a handoff on a session
   * (`POST /v1/sessions/{id}/handoffs`). The session pauses until it is
   * answered, cancelled or expires. The returned `response_token` answers
   * this handoff only, once.
   */
  async createHandoff(
    sessionId: string,
    request: CreateHandoffRequest
  ): Promise<CreateHandoffResponse> {
    return this.httpClient
      .post<CreateHandoffRequest, CreateHandoffResponse>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/handoffs`,
        request
      )
      .then((response) => response.body);
  }

  /**
   * List handoffs (`GET /v1/handoffs`), optionally of one session or only
   * the pending ones.
   */
  async listHandoffs(options: ListHandoffsOptions = {}): Promise<HandoffView[]> {
    const query = new URLSearchParams();
    if (options.sessionId !== undefined) {
      query.set('session_id', options.sessionId);
    }
    if (options.pending !== undefined) {
      query.set('pending', String(options.pending));
    }
    const qs = query.toString();
    return this.httpClient
      .get<{ handoffs: HandoffView[] }>(`/v1/handoffs${qs ? `?${qs}` : ''}`)
      .then((response) => response.body.handoffs);
  }

  /**
   * Read a handoff (`GET /v1/handoffs/{id}`). With `waitMs` the server waits
   * (up to 120 s) for it to resolve. A `secret` answer reads back with
   * `value_withheld: true` and no value; type it with {@link typeSecret}.
   */
  async getHandoff(handoffId: string, options: { waitMs?: number } = {}): Promise<HandoffView> {
    const qs =
      options.waitMs !== undefined ? `?wait_ms=${encodeURIComponent(String(options.waitMs))}` : '';
    return this.httpClient
      .get<HandoffView>(`/v1/handoffs/${encodeURIComponent(handoffId)}${qs}`)
      .then((response) => response.body);
  }

  /**
   * Answer a handoff (`POST /v1/handoffs/{id}/respond`). With
   * `responseToken`, the token goes in the `X-Hexactra-Response-Token`
   * header (never in the URL); without it the client's own operator or
   * service token answers.
   */
  async respondHandoff(
    handoffId: string,
    request: RespondHandoffRequest,
    options: RespondHandoffOptions = {}
  ): Promise<HandoffView> {
    const headers = options.responseToken
      ? { 'x-hexactra-response-token': options.responseToken }
      : undefined;
    return this.httpClient
      .post<RespondHandoffRequest, HandoffView>(
        `/v1/handoffs/${encodeURIComponent(handoffId)}/respond`,
        request,
        headers
      )
      .then((response) => response.body);
  }

  /** Cancel a pending handoff (`POST /v1/handoffs/{id}/cancel`). */
  async cancelHandoff(handoffId: string): Promise<HandoffView> {
    return this.httpClient
      .post<undefined, HandoffView>(`/v1/handoffs/${encodeURIComponent(handoffId)}/cancel`)
      .then((response) => response.body);
  }

  /**
   * Type the answer of a `secret` handoff of this session into the page: a
   * `type_secret` action (`POST /v1/sessions/{id}/actions`). The control
   * plane consumes the value once; the caller never sees it, and the
   * returned operation reports the action without it.
   */
  async typeSecret(sessionId: string, request: TypeSecretRequest): Promise<OperationView> {
    const action: Record<string, unknown> = {
      type: 'type_secret',
      handoff_id: request.handoffId,
      selector: request.selector,
      clear: request.clear ?? false,
      submit: request.submit ?? false,
    };
    if (request.tabId !== undefined) {
      action.tab_id = request.tabId;
    }
    return this.httpClient
      .post<{ action: Record<string, unknown> }, OperationView>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/actions`,
        { action }
      )
      .then((response) => response.body);
  }

  // ==================== Error Handling Helpers ====================

  /**
   * Check if an error is a network error
   */
  isNetworkError(error: unknown): boolean {
    return (
      error instanceof HexactraError && error.details.code === ErrorCode.NetworkError
    );
  }

  /**
   * Check if an error is due to invalid authentication
   */
  isUnauthorizedError(error: unknown): boolean {
    return (
      error instanceof HexactraError &&
      (error.details.code === ErrorCode.Unauthorized || error.status === 401)
    );
  }

  /**
   * Check if an error is due to insufficient permissions
   */
  isForbiddenError(error: unknown): boolean {
    return (
      error instanceof HexactraError && error.details.code === ErrorCode.Forbidden
    );
  }

  /**
   * Check if an error is due to a missing resource
   */
  isNotFoundError(error: unknown): boolean {
    return (
      error instanceof HexactraError && error.details.code === ErrorCode.NotFound
    );
  }
}
