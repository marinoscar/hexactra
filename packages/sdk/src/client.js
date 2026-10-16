"use strict";
//! Client for Hexactra control plane API
Object.defineProperty(exports, "__esModule", { value: true });
exports.ControlPlaneClient = void 0;
class ControlPlaneClient {
    baseUrl;
    httpClient;
    constructor(baseUrl, httpClient) {
        this.baseUrl = baseUrl;
        this.httpClient = httpClient;
    }
    async createGoal(sessionId, actions) {
        const request = { sessionId, actions };
        return this.httpClient.post(`${this.baseUrl}/goals`, request);
    }
    async getSession(sessionId) {
        return this.httpClient.get(`${this.baseUrl}/sessions/${sessionId}`);
    }
    async getOperation(operationId) {
        return this.httpClient.get(`${this.baseUrl}/operations/${operationId}`);
    }
    async executeAction(sessionId, action) {
        return this.httpClient.post(`${this.baseUrl}/sessions/${sessionId}/actions`, action);
    }
}
exports.ControlPlaneClient = ControlPlaneClient;
//# sourceMappingURL=client.js.map