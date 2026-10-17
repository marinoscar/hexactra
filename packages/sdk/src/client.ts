//! Client for Hexactra control plane API

import {
  Goal,
  Session,
  Operation,
  BrowserAction,
  ActionResult,
  CreateGoalRequest,
  InteractionRequest,
  InteractionKind,
  InteractionStatus,
  CreateInteractionRequestRequest,
  CreateInteractionRequestResponse,
  InteractionRequestResponse,
  ClaimInteractionRequestRequest,
  ClaimInteractionRequestResponse,
  RespondInteractionRequestRequest,
  RespondInteractionRequestResponse,
  RequestOobConfirmationRequest,
  RequestOobConfirmationResponse,
  OobChannelInfo,
  VerifyOobRequest,
  VerifyOobResponse,
  RequestPasskeyRequest,
  RequestPasskeyResponse,
  PasskeyChallenge,
  VerifyPasskeyRequest,
  VerifyPasskeyResponse,
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

  // ==================== HITL Methods ====================

  /**
   * Create an interaction request (HITL)
   */
  async createInteractionRequest(
    sessionId: string,
    reason: string,
    details: Record<string, unknown>,
    kind?: InteractionKind,
    ttlMinutes?: number
  ): Promise<InteractionRequest> {
    const request: CreateInteractionRequestRequest = {
      sessionId,
      reason,
      details,
      kind,
      ttlMinutes,
    };
    return this.httpClient
      .post<CreateInteractionRequestRequest, CreateInteractionRequestResponse>(
        `/hitl/requests`,
        request
      )
      .then((response) => this.convertToInteractionRequest(response.body.request));
  }

  /**
   * Claim an interaction request
   */
  async claimInteractionRequest(requestId: string, ownerId: string): Promise<boolean> {
    const request: ClaimInteractionRequestRequest = { ownerId };
    return this.httpClient
      .post<ClaimInteractionRequestRequest, ClaimInteractionRequestResponse>(
        `/hitl/requests/${requestId}/claim`,
        request
      )
      .then((response) => response.body.claimed);
  }

  /**
   * Respond to an interaction request
   */
  async respondInteractionRequest(
    requestId: string,
    status: InteractionStatus,
    ownerId: string,
    secret?: string
  ): Promise<boolean> {
    const request: RespondInteractionRequestRequest = { ownerId, status, secret };
    return this.httpClient
      .post<RespondInteractionRequestRequest, RespondInteractionRequestResponse>(
        `/hitl/requests/${requestId}/respond`,
        request
      )
      .then((response) => response.body.responded);
  }

  /**
   * Get pending interaction requests for a session
   */
  async getPendingInteractionRequests(sessionId: string): Promise<InteractionRequest[]> {
    return this.httpClient
      .get<{ requests: InteractionRequestResponse[] }>(
        `/hitl/requests/pending?sessionId=${encodeURIComponent(sessionId)}`
      )
      .then((response) => response.body.requests.map((r) => this.convertToInteractionRequest(r)));
  }

  // ==================== OOB Confirmation Methods ====================

  /**
   * Request out-of-band confirmation
   */
  async requestOobConfirmation(
    sessionId: string,
    reason: string,
    details: Record<string, unknown>,
    ttlMinutes?: number
  ): Promise<{ request: InteractionRequest; oobChannel: OobChannelInfo }> {
    const request: RequestOobConfirmationRequest = {
      sessionId,
      reason,
      details,
      ttlMinutes,
    };
    return this.httpClient
      .post<RequestOobConfirmationRequest, RequestOobConfirmationResponse>(
        `/hitl/oob/confirm`,
        request
      )
      .then((response) => ({
        request: {
          ...response.body.request,
          originSessionId: response.body.request.originSessionId || sessionId,
        },
        oobChannel: response.body.oobChannel,
      }));
  }

  /**
   * Verify OOB confirmation code
   */
  async verifyOob(channelId: string, verificationCode: string): Promise<boolean> {
    const request: VerifyOobRequest = { channelId, verificationCode };
    return this.httpClient
      .post<VerifyOobRequest, VerifyOobResponse>(`/hitl/oob/verify`, request)
      .then((response) => response.body.verified);
  }

  // ==================== Passkey Methods ====================

  /**
   * Request passkey authentication
   */
  async requestPasskey(
    sessionId: string,
    reason: string,
    details: Record<string, unknown>,
    ttlMinutes?: number
  ): Promise<{ request: InteractionRequest; passkeyChallenge: PasskeyChallenge }> {
    const request: RequestPasskeyRequest = {
      sessionId,
      reason,
      details,
      ttlMinutes,
    };
    return this.httpClient
      .post<RequestPasskeyRequest, RequestPasskeyResponse>(`/hitl/passkey/request`, request)
      .then((response) => ({
        request: {
          ...response.body.request,
          originSessionId: response.body.request.originSessionId || sessionId,
        },
        passkeyChallenge: response.body.passkeyChallenge,
      }));
  }

  /**
   * Verify passkey authentication
   */
  async verifyPasskey(
    challengeId: string,
    credentialId: string,
    authenticatorData: string,
    clientDataJson: string,
    signature: string
  ): Promise<boolean> {
    const request: VerifyPasskeyRequest = {
      challengeId,
      credentialId,
      authenticatorData,
      clientDataJson,
      signature,
    };
    return this.httpClient
      .post<VerifyPasskeyRequest, VerifyPasskeyResponse>(`/hitl/passkey/verify`, request)
      .then((response) => response.body.verified);
  }

  // ==================== Helper Methods ====================

  private convertToInteractionRequest(response: InteractionRequestResponse): InteractionRequest {
    return {
      id: response.id,
      sessionId: response.sessionId,
      reason: response.reason,
      details: response.details,
      createdAt: response.createdAt,
      kind: response.kind,
      status: response.status,
      expiresAt: response.expiresAt,
      originSessionId: response.originSessionId || response.sessionId,
    };
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
