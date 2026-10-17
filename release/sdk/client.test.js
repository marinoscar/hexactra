"use strict";
//! Tests for Hexactra SDK ControlPlaneClient
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const client_1 = require("./client");
const types_1 = require("./types");
// Mock fetch
const mockFetch = vitest_1.vi.fn();
(0, vitest_1.beforeEach)(() => {
    global.fetch = mockFetch;
});
(0, vitest_1.describe)('ControlPlaneClient', () => {
    const config = {
        baseUrl: 'http://localhost:3000',
        token: 'test-token',
    };
    let client;
    (0, vitest_1.beforeEach)(() => {
        client = new client_1.ControlPlaneClient(config);
        mockFetch.mockReset();
    });
    (0, vitest_1.describe)('listSessions', () => {
        (0, vitest_1.it)('should return list of sessions', async () => {
            const mockResponse = {
                sessions: [
                    { id: '1', status: 'running', created_at: '2024-01-01', updated_at: '2024-01-02' },
                    { id: '2', status: 'paused', created_at: '2024-01-01', updated_at: '2024-01-02' },
                ],
            };
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: new Headers({ 'Content-Type': 'application/json' }),
                json: () => Promise.resolve(mockResponse),
            });
            const sessions = await client.listSessions();
            (0, vitest_1.expect)(sessions).toHaveLength(2);
            (0, vitest_1.expect)(sessions[0].id).toBe('1');
        });
        (0, vitest_1.it)('should handle unauthorized error', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
                headers: new Headers({ 'Content-Type': 'application/json' }),
                json: () => Promise.resolve({
                    error: { code: 'UNAUTHORIZED', message: 'Invalid token' },
                }),
            });
            await (0, vitest_1.expect)(client.listSessions()).rejects.toThrow();
        });
    });
    (0, vitest_1.describe)('executeAction', () => {
        (0, vitest_1.it)('should execute browser action', async () => {
            const mockResponse = {
                success: true,
                data: { screenshot: 'base64-data' },
            };
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: new Headers({ 'Content-Type': 'application/json' }),
                json: () => Promise.resolve(mockResponse),
            });
            const action = { type: 'click', selector: '#button' };
            const result = await client.executeAction('session-id', action);
            (0, vitest_1.expect)(result.success).toBe(true);
        });
    });
    (0, vitest_1.describe)('createInteractionRequest', () => {
        (0, vitest_1.it)('should create HITL request', async () => {
            const mockResponse = {
                request: {
                    id: 'req-123',
                    session_id: 'session-1',
                    reason: 'Approval required',
                    details: {},
                    created_at: '2024-01-01T00:00:00Z',
                    kind: types_1.InteractionKind.ActionApproval,
                    status: types_1.InteractionStatus.Pending,
                    expires_at: '2024-01-01T01:00:00Z',
                },
            };
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 201,
                statusText: 'Created',
                headers: new Headers({ 'Content-Type': 'application/json' }),
                json: () => Promise.resolve(mockResponse),
            });
            const request = await client.createInteractionRequest('session-1', 'Approval required', {});
            (0, vitest_1.expect)(request.id).toBe('req-123');
        });
    });
    (0, vitest_1.describe)('error handling', () => {
        (0, vitest_1.it)('should detect network errors', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Network error'));
            try {
                await client.listSessions();
            }
            catch (error) {
                (0, vitest_1.expect)(client.isNetworkError(error)).toBe(true);
            }
        });
        (0, vitest_1.it)('should detect unauthorized errors', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
                headers: new Headers({ 'Content-Type': 'application/json' }),
                json: () => Promise.resolve({
                    error: { code: 'UNAUTHORIZED', message: 'Invalid token' },
                }),
            });
            try {
                await client.listSessions();
            }
            catch (error) {
                (0, vitest_1.expect)(client.isUnauthorizedError(error)).toBe(true);
            }
        });
    });
});
//# sourceMappingURL=client.test.js.map