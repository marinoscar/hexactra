/**
 * Error codes for Hexactra SDK errors
 */
export declare enum ErrorCode {
    InvalidInput = "INVALID_INPUT",
    Unauthorized = "UNAUTHORIZED",
    Forbidden = "FORBIDDEN",
    NotFound = "NOT_FOUND",
    Conflict = "CONFLICT",
    RateLimit = "RATE_LIMIT",
    InternalError = "INTERNAL_ERROR",
    NetworkError = "NETWORK_ERROR",
    TimeoutError = "TIMEOUT_ERROR"
}
/**
 * Error details returned by the API
 */
export interface ErrorDetails {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
}
/**
 * Custom error class for Hexactra SDK errors
 */
export declare class HexactraError extends Error {
    readonly status: number;
    readonly details: ErrorDetails;
    constructor(status: number, details: ErrorDetails);
}
/**
 * HTTP client configuration
 */
export interface HttpClientConfig {
    /** Base URL of the Hexactra control plane */
    baseUrl: string;
    /** Optional authentication token */
    token?: string;
    /** Request timeout in milliseconds (default: 30000) */
    timeout?: number;
    /** Custom fetch implementation (for testing or Node.js compatibility) */
    fetch?: typeof fetch;
}
/**
 * HTTP response with typed body
 */
export interface HttpResponse<T> {
    ok: boolean;
    status: number;
    statusText: string;
    headers: Headers;
    body: T;
}
/**
 * HTTP client for Hexactra control plane API
 */
export declare class HttpClient {
    private readonly baseUrl;
    private readonly token?;
    private readonly timeout;
    private readonly fetchImpl;
    constructor(config: HttpClientConfig);
    /**
     * Perform a GET request
     */
    get<T>(path: string): Promise<HttpResponse<T>>;
    /**
     * Perform a POST request
     */
    post<T, R>(path: string, body?: T): Promise<HttpResponse<R>>;
    /**
     * Perform a PUT request
     */
    put<T, R>(path: string, body?: T): Promise<HttpResponse<R>>;
    /**
     * Perform a DELETE request
     */
    delete<T>(path: string): Promise<HttpResponse<T>>;
    private request;
    private mapStatusToErrorCode;
}
/**
 * Streaming response handler for event subscriptions
 */
export interface StreamEvent<T> {
    type: string;
    data: T;
}
/**
 * Event stream parser for Server-Sent Events
 */
export declare class SSEParser {
    private buffer;
    parse(data: string): StreamEvent<unknown>[];
}
/**
 * Event stream client for real-time updates
 */
export declare class EventStreamClient {
    private httpClient;
    private eventSource;
    private onMessage;
    private onError;
    constructor(httpClient: HttpClient);
    /**
     * Subscribe to events for a session
     */
    subscribe(sessionId: string, onMessage: (event: StreamEvent<unknown>) => void, onError?: (error: Error) => void): void;
    /**
     * Stop listening for events
     */
    unsubscribe(): void;
    private pollingInterval;
    private startPolling;
    private stopPolling;
}
//# sourceMappingURL=http.d.ts.map