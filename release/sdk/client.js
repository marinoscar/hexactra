"use strict";
//! Client for Hexactra control plane API
Object.defineProperty(exports, "__esModule", { value: true });
exports.ControlPlaneClient = void 0;
const types_1 = require("./types");
const http_1 = require("./http");
/**
 * Client for the Hexactra control plane API
 */
class ControlPlaneClient {
    httpClient;
    constructor(config) {
        this.httpClient = new http_1.HttpClient(config);
    }
    /**
     * Create a new goal (task) for a session
     */
    async createGoal(sessionId, actions) {
        const request = { sessionId, actions };
        return this.httpClient
            .post(`/goals`, request)
            .then((response) => response.body);
    }
    /**
     * Get session details
     */
    async getSession(sessionId) {
        return this.httpClient.get(`/sessions/${sessionId}`).then((response) => response.body);
    }
    /**
     * List all sessions
     */
    async listSessions() {
        return this.httpClient.get('/sessions').then((response) => response.body.sessions);
    }
    /**
     * Get operation details
     */
    async getOperation(operationId) {
        return this.httpClient.get(`/operations/${operationId}`).then((response) => response.body);
    }
    /**
     * Execute a single browser action
     */
    async executeAction(sessionId, action) {
        return this.httpClient
            .post(`/sessions/${sessionId}/actions`, action)
            .then((response) => response.body);
    }
    // ==================== HITL Methods ====================
    /**
     * Create an interaction request (HITL)
     */
    async createInteractionRequest(sessionId, reason, details, kind, ttlMinutes) {
        const request = {
            sessionId,
            reason,
            details,
            kind,
            ttlMinutes,
        };
        return this.httpClient
            .post(`/hitl/requests`, request)
            .then((response) => this.convertToInteractionRequest(response.body.request));
    }
    /**
     * Claim an interaction request
     */
    async claimInteractionRequest(requestId, ownerId) {
        const request = { ownerId };
        return this.httpClient
            .post(`/hitl/requests/${requestId}/claim`, request)
            .then((response) => response.body.claimed);
    }
    /**
     * Respond to an interaction request
     */
    async respondInteractionRequest(requestId, status, ownerId, secret) {
        const request = { ownerId, status, secret };
        return this.httpClient
            .post(`/hitl/requests/${requestId}/respond`, request)
            .then((response) => response.body.responded);
    }
    /**
     * Get pending interaction requests for a session
     */
    async getPendingInteractionRequests(sessionId) {
        return this.httpClient
            .get(`/hitl/requests/pending?sessionId=${encodeURIComponent(sessionId)}`)
            .then((response) => response.body.requests.map((r) => this.convertToInteractionRequest(r)));
    }
    // ==================== OOB Confirmation Methods ====================
    /**
     * Request out-of-band confirmation
     */
    async requestOobConfirmation(sessionId, reason, details, ttlMinutes) {
        const request = {
            sessionId,
            reason,
            details,
            ttlMinutes,
        };
        return this.httpClient
            .post(`/hitl/oob/confirm`, request)
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
    async verifyOob(channelId, verificationCode) {
        const request = { channelId, verificationCode };
        return this.httpClient
            .post(`/hitl/oob/verify`, request)
            .then((response) => response.body.verified);
    }
    // ==================== Passkey Methods ====================
    /**
     * Request passkey authentication
     */
    async requestPasskey(sessionId, reason, details, ttlMinutes) {
        const request = {
            sessionId,
            reason,
            details,
            ttlMinutes,
        };
        return this.httpClient
            .post(`/hitl/passkey/request`, request)
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
    async verifyPasskey(challengeId, credentialId, authenticatorData, clientDataJson, signature) {
        const request = {
            challengeId,
            credentialId,
            authenticatorData,
            clientDataJson,
            signature,
        };
        return this.httpClient
            .post(`/hitl/passkey/verify`, request)
            .then((response) => response.body.verified);
    }
    // ==================== Helper Methods ====================
    convertToInteractionRequest(response) {
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
    isNetworkError(error) {
        return (error instanceof http_1.HexactraError && error.details.code === types_1.ErrorCode.NetworkError);
    }
    /**
     * Check if an error is due to invalid authentication
     */
    isUnauthorizedError(error) {
        return (error instanceof http_1.HexactraError &&
            (error.details.code === types_1.ErrorCode.Unauthorized || error.status === 401));
    }
    /**
     * Check if an error is due to insufficient permissions
     */
    isForbiddenError(error) {
        return (error instanceof http_1.HexactraError && error.details.code === types_1.ErrorCode.Forbidden);
    }
    /**
     * Check if an error is due to a missing resource
     */
    isNotFoundError(error) {
        return (error instanceof http_1.HexactraError && error.details.code === types_1.ErrorCode.NotFound);
    }
}
exports.ControlPlaneClient = ControlPlaneClient;
//# sourceMappingURL=client.js.map