//! Tests for Hexactra SDK ControlPlaneClient

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ControlPlaneClient } from './client';
import type { HandoffView } from './types';

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

  function jsonResponse(body: unknown, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: () => Promise.resolve(body),
    };
  }

  function lastCall(): { url: string; init: RequestInit & { headers: Record<string, string> } } {
    const [url, init] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    return { url, init };
  }

  const handoff: HandoffView = {
    id: 'h-1',
    session_id: 's-1',
    host_id: 'host-1',
    kind: 'code',
    prompt: 'Enter the code',
    input: 'secret',
    status: 'pending',
    created_at: '2026-01-01T00:00:00Z',
    expires_at: '2026-01-01T00:10:00Z',
  };

  describe('createHandoff', () => {
    it('posts a typed question to the session handoffs route', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          { handoff: { ...handoff, input: 'choice' }, response_token: 'hxr_tok', respond_path: '/v1/handoffs/h-1/respond' },
          201
        )
      );

      const created = await client.createHandoff('s-1', {
        kind: 'confirmation',
        prompt: 'Which seat?',
        input: 'choice',
        choices: ['aisle', { id: 'window', label: 'Window', description: 'Left side' }],
        timeout_ms: 60000,
        page: { url: 'https://example.test/seats', title: 'Seats' },
      });

      const { url, init } = lastCall();
      expect(url).toBe('http://localhost:3000/v1/sessions/s-1/handoffs');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({
        kind: 'confirmation',
        prompt: 'Which seat?',
        input: 'choice',
        choices: ['aisle', { id: 'window', label: 'Window', description: 'Left side' }],
        timeout_ms: 60000,
        page: { url: 'https://example.test/seats', title: 'Seats' },
      });
      expect(created.response_token).toBe('hxr_tok');
      expect(created.handoff.id).toBe('h-1');
    });

    it('sends confirm labels, risk and constraints as given', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ handoff, response_token: 't', respond_path: '/p' }, 201)
      );

      await client.createHandoff('s-1', {
        kind: 'confirmation',
        prompt: 'Pay 20.00?',
        input: 'confirm',
        confirm_label: 'Pay',
        deny_label: 'Stop',
        risk: 'high',
      });
      expect(JSON.parse(lastCall().init.body as string)).toMatchObject({
        input: 'confirm',
        confirm_label: 'Pay',
        deny_label: 'Stop',
        risk: 'high',
      });

      mockFetch.mockResolvedValueOnce(
        jsonResponse({ handoff, response_token: 't', respond_path: '/p' }, 201)
      );
      await client.createHandoff('s-1', {
        kind: 'other',
        prompt: 'How many?',
        input: 'number',
        constraints: { min: 1, max: 9, step: 1, unit: 'tickets' },
      });
      expect(JSON.parse(lastCall().init.body as string).constraints).toEqual({
        min: 1,
        max: 9,
        step: 1,
        unit: 'tickets',
      });
    });
  });

  describe('listHandoffs', () => {
    it('lists all handoffs without a query', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ handoffs: [handoff] }));
      const list = await client.listHandoffs();
      expect(lastCall().url).toBe('http://localhost:3000/v1/handoffs');
      expect(list).toEqual([handoff]);
    });

    it('filters by session and pending', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ handoffs: [] }));
      await client.listHandoffs({ sessionId: 's-1', pending: true });
      expect(lastCall().url).toBe('http://localhost:3000/v1/handoffs?session_id=s-1&pending=true');
    });
  });

  describe('getHandoff', () => {
    it('reads one handoff, optionally waiting', async () => {
      const answered: HandoffView = {
        ...handoff,
        status: 'completed',
        response: {
          outcome: 'completed',
          value_withheld: true,
          by: 'token',
          answered_at: '2026-01-01T00:01:00Z',
        },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(answered));
      const view = await client.getHandoff('h-1', { waitMs: 30000 });
      expect(lastCall().url).toBe('http://localhost:3000/v1/handoffs/h-1?wait_ms=30000');
      expect(lastCall().init.method).toBe('GET');
      expect(view.response?.value_withheld).toBe(true);
      expect(view.response?.value).toBeUndefined();

      mockFetch.mockResolvedValueOnce(jsonResponse(handoff));
      await client.getHandoff('h-1');
      expect(lastCall().url).toBe('http://localhost:3000/v1/handoffs/h-1');
    });

    it('rejects on an unknown handoff', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'not_found' }, 404));
      await expect(client.getHandoff('nope')).rejects.toThrow();
    });
  });

  describe('respondHandoff', () => {
    it('sends the response token in the header, never in the URL or body', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ...handoff, input: 'multi_choice', status: 'completed' })
      );

      await client.respondHandoff(
        'h-1',
        { outcome: 'completed', values: ['a', 'b'], channel: 'slack' },
        { responseToken: 'hxr_secret_token' }
      );

      const { url, init } = lastCall();
      expect(url).toBe('http://localhost:3000/v1/handoffs/h-1/respond');
      expect(url).not.toContain('hxr_secret_token');
      expect(init.method).toBe('POST');
      expect(init.headers['x-hexactra-response-token']).toBe('hxr_secret_token');
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ outcome: 'completed', values: ['a', 'b'], channel: 'slack' });
      expect(JSON.stringify(body)).not.toContain('hxr_secret_token');
    });

    it('answers with the client token when no response token is given', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ...handoff, status: 'completed' }));

      await client.respondHandoff('h-1', {
        outcome: 'completed',
        value: 'approve',
        answered_by: 'user:42',
      });

      const { init } = lastCall();
      expect(init.headers['Authorization']).toBe('Bearer test-token');
      expect(init.headers['x-hexactra-response-token']).toBeUndefined();
      expect(JSON.parse(init.body as string)).toEqual({
        outcome: 'completed',
        value: 'approve',
        answered_by: 'user:42',
      });
    });
  });

  describe('cancelHandoff', () => {
    it('posts to the cancel route', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ...handoff, status: 'cancelled' }));
      const view = await client.cancelHandoff('h-1');
      const { url, init } = lastCall();
      expect(url).toBe('http://localhost:3000/v1/handoffs/h-1/cancel');
      expect(init.method).toBe('POST');
      expect(init.body).toBeUndefined();
      expect(view.status).toBe('cancelled');
    });
  });

  describe('typeSecret', () => {
    it('submits a type_secret action to the session actions route', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          id: 'op-1',
          session_id: 's-1',
          host_id: 'host-1',
          action: { type: 'type_secret', handoff_id: 'h-1', selector: '#otp' },
          state: 'succeeded',
          result: {},
          created_at: '2026-01-01T00:02:00Z',
        })
      );

      const op = await client.typeSecret('s-1', {
        handoffId: 'h-1',
        selector: '#otp',
        submit: true,
      });

      const { url, init } = lastCall();
      expect(url).toBe('http://localhost:3000/v1/sessions/s-1/actions');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({
        action: {
          type: 'type_secret',
          handoff_id: 'h-1',
          selector: '#otp',
          clear: false,
          submit: true,
        },
      });
      expect(op.state).toBe('succeeded');
    });

    it('passes clear and tab_id', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'op-2', state: 'queued' }));
      await client.typeSecret('s-1', { handoffId: 'h-1', selector: '#pw', clear: true, tabId: 7 });
      expect(JSON.parse(lastCall().init.body as string).action).toEqual({
        type: 'type_secret',
        handoff_id: 'h-1',
        selector: '#pw',
        clear: true,
        submit: false,
        tab_id: 7,
      });
    });
  });

  it('has no legacy HITL or claim methods', () => {
    const c = client as unknown as Record<string, unknown>;
    for (const name of [
      'createInteractionRequest',
      'claimInteractionRequest',
      'respondInteractionRequest',
      'getPendingInteractionRequests',
      'claimHandoff',
    ]) {
      expect(c[name]).toBeUndefined();
    }
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
