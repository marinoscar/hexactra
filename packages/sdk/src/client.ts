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
} from './types';

export interface HttpClient {
  get<T>(url: string): Promise<T>;
  post<T, R>(url: string, body: T): Promise<R>;
}

export class ControlPlaneClient {
  constructor(private baseUrl: string, private httpClient: HttpClient) {}

  async createGoal(sessionId: string, actions: BrowserAction[]): Promise<Goal> {
    const request: CreateGoalRequest = { sessionId, actions };
    return this.httpClient.post<CreateGoalRequest, Goal>(
      `${this.baseUrl}/goals`,
      request
    );
  }

  async getSession(sessionId: string): Promise<Session> {
    return this.httpClient.get<Session>(`${this.baseUrl}/sessions/${sessionId}`);
  }

  async getOperation(operationId: string): Promise<Operation> {
    return this.httpClient.get<Operation>(`${this.baseUrl}/operations/${operationId}`);
  }

  async executeAction(sessionId: string, action: BrowserAction): Promise<ActionResult> {
    return this.httpClient.post<BrowserAction, ActionResult>(
      `${this.baseUrl}/sessions/${sessionId}/actions`,
      action
    );
  }

  // ==================== HITL Methods ====================

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
    return this.httpClient.post<CreateInteractionRequestRequest, CreateInteractionRequestResponse>(
      `${this.baseUrl}/hitl/requests`,
      request
    ).then((response) => ({
      id: response.request.id,
      sessionId: response.request.sessionId,
      reason: response.request.reason,
      details: response.request.details,
      createdAt: response.request.createdAt,
      kind: response.request.kind,
      status: response.request.status,
      expiresAt: response.request.expiresAt,
      originSessionId: response.request.originSessionId || sessionId,
    }));
  }

  async claimInteractionRequest(requestId: string, ownerId: string): Promise<boolean> {
    const request: ClaimInteractionRequestRequest = { ownerId };
    return this.httpClient.post<ClaimInteractionRequestRequest, ClaimInteractionRequestResponse>(
      `${this.baseUrl}/hitl/requests/${requestId}/claim`,
      request
    ).then((response) => response.claimed);
  }

  async respondInteractionRequest(
    requestId: string,
    status: InteractionStatus,
    ownerId: string,
    secret?: string
  ): Promise<boolean> {
    const request: RespondInteractionRequestRequest = { ownerId, status, secret };
    return this.httpClient.post<RespondInteractionRequestRequest, RespondInteractionRequestResponse>(
      `${this.baseUrl}/hitl/requests/${requestId}/respond`,
      request
    ).then((response) => response.responded);
  }

  async getPendingInteractionRequests(sessionId: string): Promise<InteractionRequest[]> {
    const response = await this.httpClient.get<{
      requests: InteractionRequestResponse[];
    }>(`${this.baseUrl}/hitl/requests/pending?sessionId=${sessionId}`);
    return response.requests.map((r) => this.convertToInteractionRequest(r));
  }

  // ==================== OOB Confirmation Methods ====================

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
    const response = await this.httpClient.post<RequestOobConfirmationRequest, RequestOobConfirmationResponse>(
      `${this.baseUrl}/hitl/oob/confirm`,
      request
    );
    return {
      request: {
        ...response.request,
        originSessionId: response.request.originSessionId || sessionId,
      },
      oobChannel: response.oobChannel,
    };
  }

  async verifyOob(channelId: string, verificationCode: string): Promise<boolean> {
    const request: VerifyOobRequest = { channelId, verificationCode };
    return this.httpClient.post<VerifyOobRequest, VerifyOobResponse>(
      `${this.baseUrl}/hitl/oob/verify`,
      request
    ).then((response) => response.verified);
  }

  // ==================== Passkey Methods ====================

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
    const response = await this.httpClient.post<RequestPasskeyRequest, RequestPasskeyResponse>(
      `${this.baseUrl}/hitl/passkey/request`,
      request
    );
    return {
      request: {
        ...response.request,
        originSessionId: response.request.originSessionId || sessionId,
      },
      passkeyChallenge: response.passkeyChallenge,
    };
  }

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
    return this.httpClient.post<VerifyPasskeyRequest, VerifyPasskeyResponse>(
      `${this.baseUrl}/hitl/passkey/verify`,
      request
    ).then((response) => response.verified);
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
}
