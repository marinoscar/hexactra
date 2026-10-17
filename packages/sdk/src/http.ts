//! HTTP client implementation for Hexactra control plane API

/**
 * Error codes for Hexactra SDK errors
 */
export enum ErrorCode {
  InvalidInput = 'INVALID_INPUT',
  Unauthorized = 'UNAUTHORIZED',
  Forbidden = 'FORBIDDEN',
  NotFound = 'NOT_FOUND',
  Conflict = 'CONFLICT',
  RateLimit = 'RATE_LIMIT',
  InternalError = 'INTERNAL_ERROR',
  NetworkError = 'NETWORK_ERROR',
  TimeoutError = 'TIMEOUT_ERROR',
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
export class HexactraError extends Error {
  constructor(
    public readonly status: number,
    public readonly details: ErrorDetails
  ) {
    super(details.message);
    this.name = 'HexactraError';
  }
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
export class HttpClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeout: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HttpClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.token = config.token;
    this.timeout = config.timeout ?? 30000;
    this.fetchImpl = config.fetch ?? fetch;
  }

  /**
   * Perform a GET request
   */
  async get<T>(path: string): Promise<HttpResponse<T>> {
    return this.request<T>('GET', path);
  }

  /**
   * Perform a POST request
   */
  async post<T, R>(path: string, body?: T): Promise<HttpResponse<R>> {
    return this.request<R>('POST', path, body);
  }

  /**
   * Perform a PUT request
   */
  async put<T, R>(path: string, body?: T): Promise<HttpResponse<R>> {
    return this.request<R>('PUT', path, body);
  }

  /**
   * Perform a DELETE request
   */
  async delete<T>(path: string): Promise<HttpResponse<T>> {
    return this.request<T>('DELETE', path);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<HttpResponse<T>> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.token) {
        headers['Authorization'] = `Bearer ${this.token}`;
      }

      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }

      const response = await this.fetchImpl(url, init);
      clearTimeout(timeoutId);

      let responseBody: T;
      const contentType = response.headers.get('content-type');

      if (contentType?.includes('application/json')) {
        responseBody = await response.json();
      } else {
        responseBody = (await response.text()) as T;
      }

      if (!response.ok) {
        const errorDetails: ErrorDetails = {
          code: this.mapStatusToErrorCode(response.status),
          message: responseBody as string,
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
    } catch (error) {
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

  private mapStatusToErrorCode(status: number): ErrorCode {
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
export class SSEParser {
  private buffer = '';

  parse(data: string): StreamEvent<unknown>[] {
    const events: StreamEvent<unknown>[] = [];
    this.buffer += data;

    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        // Start new event
      } else if (line.startsWith('data:')) {
        try {
          const data = JSON.parse(line.slice(5));
          events.push({ type: 'message', data });
        } catch {
          // Skip invalid JSON
        }
      } else if (line.trim() === '') {
        // Empty line marks end of event
      }
    }

    return events;
  }
}

/**
 * Event stream client for real-time updates
 */
export class EventStreamClient {
  private eventSource: EventSource | null = null;
  private onMessage: ((event: StreamEvent<unknown>) => void) | null = null;
  private onError: ((error: Error) => void) | null = null;

  constructor(private httpClient: HttpClient) {}

  /**
   * Subscribe to events for a session
   */
  subscribe(sessionId: string, onMessage: (event: StreamEvent<unknown>) => void, onError?: (error: Error) => void): void {
    this.onMessage = onMessage;
    this.onError = onError ?? ((e) => console.error('Stream error:', e));

    const url = `${this.httpClient['baseUrl']}/sessions/${sessionId}/events`;
    
    // For now, use a simple polling approach since SSE may not be implemented yet
    this.startPolling(url);
  }

  /**
   * Stop listening for events
   */
  unsubscribe(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.stopPolling();
  }

  private pollingInterval: number | null = null;

  private startPolling(_url: string): void {
    const poll = async () => {
      try {
        const response = await this.httpClient.get<unknown>('/poll');
        if (this.onMessage && response.ok) {
          this.onMessage({ type: 'poll', data: response.body });
        }
      } catch (error) {
        if (this.onError) {
          this.onError(error as Error);
        }
      }
    };

    this.pollingInterval = window?.setInterval ? window.setInterval(poll, 1000) : null;
  }

  private stopPolling(): void {
    if (this.pollingInterval) {
      if (window?.clearInterval) {
        window.clearInterval(this.pollingInterval);
      }
      this.pollingInterval = null;
    }
  }
}
