//! Tests for Hexactra SDK ControlPlaneClient

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ControlPlaneClient } from './client';
import { InteractionKind, InteractionStatus } from './types';

// Mock fetch
const mockFetch = vi.fn();

beforeEach(() => {
  global.fetch = mockFetch;
});

describe('ControlPlaneClient', () => {
  const config = {
    baseUrl: 'http://localhost:3000',
    token: 'test-token',
  };

  let client: ControlPlaneClient;

  beforeEach(() => {
    client = new ControlPlaneClient(config);
    mockFetch.mockReset();
  });

  describe('listSessions', () => {
    it('should return list of sessions', async () => {
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

      expect(sessions).toHaveLength(2);
      expect(sessions[0].id).toBe('1');
    });

    it('should handle unauthorized error', async () => {
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

      await expect(client.listSessions()).rejects.toThrow();
    });
  });

  describe('executeAction', () => {
    it('should execute browser action', async () => {
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

      expect(result.success).toBe(true);
    });
  });

  describe('createInteractionRequest', () => {
    it('should create HITL request', async () => {
      const mockResponse = {
        request: {
          id: 'req-123',
          session_id: 'session-1',
          reason: 'Approval required',
          details: {},
          created_at: '2024-01-01T00:00:00Z',
          kind: InteractionKind.ActionApproval,
          status: InteractionStatus.Pending,
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

      const request = await client.createInteractionRequest(
        'session-1',
        'Approval required',
        {}
      );

      expect(request.id).toBe('req-123');
    });
  });

  describe('error handling', () => {
    it('should detect network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      try {
        await client.listSessions();
      } catch (error) {
        expect(client.isNetworkError(error)).toBe(true);
      }
    });

    it('should detect unauthorized errors', async () => {
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

      try {
        await client.listSessions();
      } catch (error) {
        expect(client.isUnauthorizedError(error)).toBe(true);
      }
    });
  });
});
