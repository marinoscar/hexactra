"use strict";
//! HTTP client implementation for Hexactra control plane API
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventStreamClient = exports.SSEParser = exports.HttpClient = exports.HexactraError = exports.ErrorCode = void 0;
/**
 * Error codes for Hexactra SDK errors
 */
var ErrorCode;
(function (ErrorCode) {
    ErrorCode["InvalidInput"] = "INVALID_INPUT";
    ErrorCode["Unauthorized"] = "UNAUTHORIZED";
    ErrorCode["Forbidden"] = "FORBIDDEN";
    ErrorCode["NotFound"] = "NOT_FOUND";
    ErrorCode["Conflict"] = "CONFLICT";
    ErrorCode["RateLimit"] = "RATE_LIMIT";
    ErrorCode["InternalError"] = "INTERNAL_ERROR";
    ErrorCode["NetworkError"] = "NETWORK_ERROR";
    ErrorCode["TimeoutError"] = "TIMEOUT_ERROR";
})(ErrorCode || (exports.ErrorCode = ErrorCode = {}));
/**
 * Custom error class for Hexactra SDK errors
 */
class HexactraError extends Error {
    status;
    details;
    constructor(status, details) {
        super(details.message);
        this.status = status;
        this.details = details;
        this.name = 'HexactraError';
    }
}
exports.HexactraError = HexactraError;
/**
 * HTTP client for Hexactra control plane API
 */
class HttpClient {
    baseUrl;
    token;
    timeout;
    fetchImpl;
    constructor(config) {
        this.baseUrl = config.baseUrl.replace(/\/+$/, '');
        this.token = config.token;
        this.timeout = config.timeout ?? 30000;
        this.fetchImpl = config.fetch ?? fetch;
    }
    /**
     * Perform a GET request
     */
    async get(path) {
        return this.request('GET', path);
    }
    /**
     * Perform a POST request
     */
    async post(path, body) {
        return this.request('POST', path, body);
    }
    /**
     * Perform a PUT request
     */
    async put(path, body) {
        return this.request('PUT', path, body);
    }
    /**
     * Perform a DELETE request
     */
    async delete(path) {
        return this.request('DELETE', path);
    }
    async request(method, path, body) {
        const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);
        try {
            const headers = {
                'Content-Type': 'application/json',
            };
            if (this.token) {
                headers['Authorization'] = `Bearer ${this.token}`;
            }
            const init = {
                method,
                headers,
                signal: controller.signal,
            };
            if (body !== undefined) {
                init.body = JSON.stringify(body);
            }
            const response = await this.fetchImpl(url, init);
            clearTimeout(timeoutId);
            let responseBody;
            const contentType = response.headers.get('content-type');
            if (contentType?.includes('application/json')) {
                responseBody = await response.json();
            }
            else {
                responseBody = (await response.text());
            }
            if (!response.ok) {
                const errorDetails = {
                    code: this.mapStatusToErrorCode(response.status),
                    message: responseBody,
                };
                throw new HexactraError(response.status, errorDetails);
            }
            return {
                ok: true,
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                body: responseBody,
            };
        }
        catch (error) {
            clearTimeout(timeoutId);
            if (error instanceof Error && error.name === 'AbortError') {
                throw new HexactraError(408, {
                    code: ErrorCode.TimeoutError,
                    message: 'Request timeout',
                });
            }
            // Check for network errors - fetch throws TypeError for network issues
            if (error instanceof TypeError || (error instanceof Error && !('status' in error))) {
                throw new HexactraError(503, {
                    code: ErrorCode.NetworkError,
                    message: 'Network error - unable to connect to server',
                });
            }
            throw error;
        }
    }
    mapStatusToErrorCode(status) {
        switch (status) {
            case 400:
                return ErrorCode.InvalidInput;
            case 401:
                return ErrorCode.Unauthorized;
            case 403:
                return ErrorCode.Forbidden;
            case 404:
                return ErrorCode.NotFound;
            case 409:
                return ErrorCode.Conflict;
            case 429:
                return ErrorCode.RateLimit;
            case 500:
            case 502:
            case 503:
            case 504:
                return ErrorCode.InternalError;
            default:
                return ErrorCode.InternalError;
        }
    }
}
exports.HttpClient = HttpClient;
/**
 * Event stream parser for Server-Sent Events
 */
class SSEParser {
    buffer = '';
    parse(data) {
        const events = [];
        this.buffer += data;
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';
        for (const line of lines) {
            if (line.startsWith('event:')) {
                // Start new event
            }
            else if (line.startsWith('data:')) {
                try {
                    const data = JSON.parse(line.slice(5));
                    events.push({ type: 'message', data });
                }
                catch {
                    // Skip invalid JSON
                }
            }
            else if (line.trim() === '') {
                // Empty line marks end of event
            }
        }
        return events;
    }
}
exports.SSEParser = SSEParser;
/**
 * Event stream client for real-time updates
 */
class EventStreamClient {
    httpClient;
    eventSource = null;
    onMessage = null;
    onError = null;
    constructor(httpClient) {
        this.httpClient = httpClient;
    }
    /**
     * Subscribe to events for a session
     */
    subscribe(sessionId, onMessage, onError) {
        this.onMessage = onMessage;
        this.onError = onError ?? ((e) => console.error('Stream error:', e));
        const url = `${this.httpClient['baseUrl']}/sessions/${sessionId}/events`;
        // For now, use a simple polling approach since SSE may not be implemented yet
        this.startPolling(url);
    }
    /**
     * Stop listening for events
     */
    unsubscribe() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
        this.stopPolling();
    }
    pollingInterval = null;
    startPolling(_url) {
        const poll = async () => {
            try {
                const response = await this.httpClient.get('/poll');
                if (this.onMessage && response.ok) {
                    this.onMessage({ type: 'poll', data: response.body });
                }
            }
            catch (error) {
                if (this.onError) {
                    this.onError(error);
                }
            }
        };
        this.pollingInterval = window?.setInterval ? window.setInterval(poll, 1000) : null;
    }
    stopPolling() {
        if (this.pollingInterval) {
            if (window?.clearInterval) {
                window.clearInterval(this.pollingInterval);
            }
            this.pollingInterval = null;
        }
    }
}
exports.EventStreamClient = EventStreamClient;
//# sourceMappingURL=http.js.map