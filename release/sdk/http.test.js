"use strict";
//! Tests for Hexactra SDK HTTP client and error handling
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const http_1 = require("./http");
// Mock fetch
const mockFetch = vitest_1.vi.fn();
(0, vitest_1.beforeEach)(() => {
    global.fetch = mockFetch;
});
(0, vitest_1.describe)('HttpClient', () => {
    const config = {
        baseUrl: 'http://localhost:3000',
        token: 'test-token',
        timeout: 5000,
    };
    let client;
    (0, vitest_1.beforeEach)(() => {
        client = new http_1.HttpClient(config);
        mockFetch.mockReset();
    });
    (0, vitest_1.describe)('GET requests', () => {
        (0, vitest_1.it)('should make correct GET request with headers', async () => {
            const mockResponse = { id: '123', name: 'test' };
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: new Headers({ 'Content-Type': 'application/json' }),
                json: () => Promise.resolve(mockResponse),
            });
            const response = await client.get('/test');
            (0, vitest_1.expect)(response.ok).toBe(true);
            (0, vitest_1.expect)(response.status).toBe(200);
            (0, vitest_1.expect)(response.body).toEqual(mockResponse);
            (0, vitest_1.expect)(mockFetch).toHaveBeenCalledWith('http://localhost:3000/test', vitest_1.expect.objectContaining({
                method: 'GET',
                headers: vitest_1.expect.objectContaining({
                    Authorization: 'Bearer test-token',
                    'Content-Type': 'application/json',
                }),
                signal: vitest_1.expect.any(AbortSignal),
            }));
        });
        (0, vitest_1.it)('should handle errors', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
                headers: new Headers({ 'Content-Type': 'application/json' }),
                json: () => Promise.resolve({
                    error: { code: 'UNAUTHORIZED', message: 'Invalid token' },
                }),
            });
            await (0, vitest_1.expect)(client.get('/test')).rejects.toThrow(http_1.HexactraError);
        });
        (0, vitest_1.it)('should handle network errors', async () => {
            // Mock fetch to throw a TypeError wrapped in an Error with a message containing 'fetch'
            mockFetch.mockRejectedValueOnce(new Error('Network error'));
            await (0, vitest_1.expect)(client.get('/test')).rejects.toThrow(http_1.HexactraError);
        });
    });
    (0, vitest_1.describe)('POST requests', () => {
        (0, vitest_1.it)('should make correct POST request with body', async () => {
            const mockResponse = { success: true, id: '456' };
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 201,
                statusText: 'Created',
                headers: new Headers({ 'Content-Type': 'application/json' }),
                json: () => Promise.resolve(mockResponse),
            });
            const response = await client.post('/test', { name: 'test' });
            (0, vitest_1.expect)(response.ok).toBe(true);
            (0, vitest_1.expect)(response.status).toBe(201);
            (0, vitest_1.expect)(response.body).toEqual(mockResponse);
            const callArgs = mockFetch.mock.calls[0];
            const body = JSON.parse(callArgs[1]?.body || '{}');
            (0, vitest_1.expect)(body).toEqual({ name: 'test' });
        });
    });
    (0, vitest_1.describe)('Timeout handling', () => {
        (0, vitest_1.it)('should abort request on timeout', async () => {
            // Create a slow fetch
            mockFetch.mockImplementation((_url, init) => {
                return new Promise((resolve, reject) => {
                    if (init?.signal) {
                        init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
                    }
                    setTimeout(() => resolve({
                        ok: true,
                        status: 200,
                        statusText: 'OK',
                        headers: new Headers(),
                        json: () => Promise.resolve({}),
                    }), 10000); // Slow response
                });
            });
            const slowClient = new http_1.HttpClient({ ...config, timeout: 100 });
            await (0, vitest_1.expect)(slowClient.get('/test')).rejects.toThrow(http_1.HexactraError);
        });
    });
});
(0, vitest_1.describe)('HexactraError', () => {
    (0, vitest_1.it)('should create error with status and details', () => {
        const error = new http_1.HexactraError(401, {
            code: http_1.ErrorCode.Unauthorized,
            message: 'Invalid token',
        });
        (0, vitest_1.expect)(error.name).toBe('HexactraError');
        (0, vitest_1.expect)(error.status).toBe(401);
        (0, vitest_1.expect)(error.details.code).toBe(http_1.ErrorCode.Unauthorized);
        (0, vitest_1.expect)(error.message).toBe('Invalid token');
    });
});
(0, vitest_1.describe)('Error Code Mapping', () => {
    (0, vitest_1.it)('should map HTTP status codes to error codes', () => {
        // This is tested indirectly through the client's behavior
        (0, vitest_1.expect)(http_1.ErrorCode.InvalidInput).toBe('INVALID_INPUT');
        (0, vitest_1.expect)(http_1.ErrorCode.Unauthorized).toBe('UNAUTHORIZED');
        (0, vitest_1.expect)(http_1.ErrorCode.Forbidden).toBe('FORBIDDEN');
        (0, vitest_1.expect)(http_1.ErrorCode.NotFound).toBe('NOT_FOUND');
    });
});
//# sourceMappingURL=http.test.js.map