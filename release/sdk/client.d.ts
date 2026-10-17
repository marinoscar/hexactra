import { Goal, Session, Operation, BrowserAction, ActionResult, InteractionRequest, InteractionKind, InteractionStatus, OobChannelInfo, PasskeyChallenge } from './types';
import { HttpClientConfig } from './http';
export interface ControlPlaneClientConfig extends HttpClientConfig {
}
/**
 * Client for the Hexactra control plane API
 */
export declare class ControlPlaneClient {
    private readonly httpClient;
    constructor(config: ControlPlaneClientConfig);
    /**
     * Create a new goal (task) for a session
     */
    createGoal(sessionId: string, actions: BrowserAction[]): Promise<Goal>;
    /**
     * Get session details
     */
    getSession(sessionId: string): Promise<Session>;
    /**
     * List all sessions
     */
    listSessions(): Promise<Session[]>;
    /**
     * Get operation details
     */
    getOperation(operationId: string): Promise<Operation>;
    /**
     * Execute a single browser action
     */
    executeAction(sessionId: string, action: BrowserAction): Promise<ActionResult>;
    /**
     * Create an interaction request (HITL)
     */
    createInteractionRequest(sessionId: string, reason: string, details: Record<string, unknown>, kind?: InteractionKind, ttlMinutes?: number): Promise<InteractionRequest>;
    /**
     * Claim an interaction request
     */
    claimInteractionRequest(requestId: string, ownerId: string): Promise<boolean>;
    /**
     * Respond to an interaction request
     */
    respondInteractionRequest(requestId: string, status: InteractionStatus, ownerId: string, secret?: string): Promise<boolean>;
    /**
     * Get pending interaction requests for a session
     */
    getPendingInteractionRequests(sessionId: string): Promise<InteractionRequest[]>;
    /**
     * Request out-of-band confirmation
     */
    requestOobConfirmation(sessionId: string, reason: string, details: Record<string, unknown>, ttlMinutes?: number): Promise<{
        request: InteractionRequest;
        oobChannel: OobChannelInfo;
    }>;
    /**
     * Verify OOB confirmation code
     */
    verifyOob(channelId: string, verificationCode: string): Promise<boolean>;
    /**
     * Request passkey authentication
     */
    requestPasskey(sessionId: string, reason: string, details: Record<string, unknown>, ttlMinutes?: number): Promise<{
        request: InteractionRequest;
        passkeyChallenge: PasskeyChallenge;
    }>;
    /**
     * Verify passkey authentication
     */
    verifyPasskey(challengeId: string, credentialId: string, authenticatorData: string, clientDataJson: string, signature: string): Promise<boolean>;
    private convertToInteractionRequest;
    /**
     * Check if an error is a network error
     */
    isNetworkError(error: unknown): boolean;
    /**
     * Check if an error is due to invalid authentication
     */
    isUnauthorizedError(error: unknown): boolean;
    /**
     * Check if an error is due to insufficient permissions
     */
    isForbiddenError(error: unknown): boolean;
    /**
     * Check if an error is due to a missing resource
     */
    isNotFoundError(error: unknown): boolean;
}
//# sourceMappingURL=client.d.ts.map