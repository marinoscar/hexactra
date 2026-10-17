//! Tests for Hexactra SDK HTTP client and error handling

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  HttpClient,
  HexactraError,
  ErrorCode,
  HttpClientConfig,
} from './http';

// Mock fetch
const mockFetch = vi.fn();

beforeEach(() => {
  global.fetch = mockFetch;
});

describe('HttpClient', () => {
  const config: HttpClientConfig = {
    baseUrl: 'http://localhost:3000',
    token: 'test-token',
    timeout: 5000,
  };

  let client: HttpClient;

  beforeEach(() => {
    client = new HttpClient(config);
    mockFetch.mockReset();
  });

  describe('GET requests', () => {
    it('should make correct GET request with headers', async () => {
      const mockResponse = { id: '123', name: 'test' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: () => Promise.resolve(mockResponse),
      });

      const response = await client.get<{ id: string; name: string }>('/test');

      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockResponse);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/test',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
            'Content-Type': 'application/json',
          }),
          signal: expect.any(AbortSignal),
        })
      );
    });

    it('should handle errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: () =>
          Promise.resolve({
            error: { code: 'UNAUTHORIZED', message: 'Invalid token' },
          }),
      });

      await expect(client.get('/test')).rejects.toThrow(HexactraError);
    });

    it('should handle network errors', async () => {
      // Mock fetch to throw a TypeError wrapped in an Error with a message containing 'fetch'
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(client.get('/test')).rejects.toThrow(HexactraError);
    });
  });

  describe('POST requests', () => {
    it('should make correct POST request with body', async () => {
      const mockResponse = { success: true, id: '456' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        statusText: 'Created',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: () => Promise.resolve(mockResponse),
      });

      const response = await client.post<{ name: string }, { success: boolean; id: string }>(
        '/test',
        { name: 'test' }
      );

      expect(response.ok).toBe(true);
      expect(response.status).toBe(201);
      expect(response.body).toEqual(mockResponse);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1]?.body || '{}');
      expect(body).toEqual({ name: 'test' });
    });
  });

  describe('Timeout handling', () => {
    it('should abort request on timeout', async () => {
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

      const slowClient = new HttpClient({ ...config, timeout: 100 });

      await expect(slowClient.get('/test')).rejects.toThrow(HexactraError);
    });
  });
});

describe('HexactraError', () => {
  it('should create error with status and details', () => {
    const error = new HexactraError(401, {
      code: ErrorCode.Unauthorized,
      message: 'Invalid token',
    });

    expect(error.name).toBe('HexactraError');
    expect(error.status).toBe(401);
    expect(error.details.code).toBe(ErrorCode.Unauthorized);
    expect(error.message).toBe('Invalid token');
  });
});

describe('Error Code Mapping', () => {
  it('should map HTTP status codes to error codes', () => {
    // This is tested indirectly through the client's behavior
    expect(ErrorCode.InvalidInput).toBe('INVALID_INPUT');
    expect(ErrorCode.Unauthorized).toBe('UNAUTHORIZED');
    expect(ErrorCode.Forbidden).toBe('FORBIDDEN');
    expect(ErrorCode.NotFound).toBe('NOT_FOUND');
  });
});
