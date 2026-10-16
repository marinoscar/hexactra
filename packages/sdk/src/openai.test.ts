//! Tests for OpenAI-compatible model adapter

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenAIClient, OpenAIConfig, ChatMessage, ToolDefinition } from './openai';

// Mock fetch globally
const mockFetch = vi.fn();

beforeEach(() => {
  global.fetch = mockFetch;
});

describe('OpenAIClient', () => {
  const config: OpenAIConfig = {
    baseUrl: 'https://api.openai.com/v1',
    modelId: 'gpt-4',
    apiKey: 'test-key',
  };

  let client: OpenAIClient;

  beforeEach(() => {
    client = new OpenAIClient(config);
    mockFetch.mockReset();
  });

  describe('testConnection', () => {
    it('should return success for valid API response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: 'test', choices: [] }),
      });

      const result = await client.testConnection();

      expect(result.success).toBe(true);
      expect(result.message).toBe('Connection successful');
    });

    it('should return error for invalid API key', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () =>
          Promise.resolve({
            error: { message: 'Invalid API key' },
          }),
      });

      const result = await client.testConnection();

      expect(result.success).toBe(false);
      expect(result.message).toBe('Invalid API key');
    });

    it('should return error for network failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await client.testConnection();

      expect(result.success).toBe(false);
      expect(result.message).toBe('Network error');
    });
  });

  describe('getModelCapabilities', () => {
    it('should return capabilities for known model', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                id: 'gpt-4',
                capabilities: { tools: true, vision: false, context_window: 8192 },
              },
            ],
          }),
      });

      const result = await client.getModelCapabilities();

      expect(result.supportsTools).toBe(true);
      expect(result.supportsVision).toBe(false);
      expect(result.contextWindow).toBe(8192);
    });

    it('should return defaults when capabilities unavailable', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await client.getModelCapabilities();

      expect(result.supportsTools).toBe(true);
      expect(result.supportsVision).toBe(false);
    });
  });

  describe('createChatCompletion', () => {
    it('should make correct API request', async () => {
      const mockResponse = {
        id: 'test',
        object: 'chat.completion',
        created: Date.now(),
        model: 'gpt-4',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const messages: ChatMessage[] = [{ role: 'user', content: 'Hi' }];
      const result = await client.createChatCompletion(messages);

      expect(result.choices[0].message.content).toBe('Hello');

      // Verify the request was made correctly
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-key',
          },
          body: JSON.stringify({
            model: 'gpt-4',
            messages,
            stream: false,
            max_tokens: undefined,
            temperature: undefined,
          }),
        })
      );
    });

    it('should include tools in request when provided', async () => {
      const mockResponse = {
        id: 'test',
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const tools: ToolDefinition[] = [
        {
          type: 'function',
          function: {
            name: 'test_tool',
            description: 'A test tool',
            parameters: { type: 'object', properties: {} },
          },
        },
      ];

      await client.createChatCompletion([], tools);

      const fetchCall = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(fetchCall[1]?.body || '{}');

      expect(requestBody.tools).toEqual(tools);
      expect(requestBody.tool_choice).toBe('auto');
    });

    it('should throw error for API failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({
            error: { message: 'Bad request' },
          }),
      });

      await expect(client.createChatCompletion([])).rejects.toThrow('Bad request');
    });
  });

  describe('formatMessages', () => {
    it('should format history with system prompt', () => {
      const history = [
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: 'Hi there' },
      ];

      const messages = OpenAIClient.formatMessages(history, 'You are a helpful assistant');

      expect(messages).toEqual([
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ]);
    });

    it('should format without system prompt', () => {
      const history = [{ role: 'user' as const, content: 'Hello' }];

      const messages = OpenAIClient.formatMessages(history);

      expect(messages).toEqual([{ role: 'user', content: 'Hello' }]);
    });
  });

  describe('extractToolCalls', () => {
    it('should extract tool calls from response', () => {
      const response = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'call_123',
                  type: 'function',
                  function: { name: 'test', arguments: '{}' },
                },
              ],
            },
          },
        ],
      };

      const toolCalls = OpenAIClient.extractToolCalls(response as any);

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].id).toBe('call_123');
    });

    it('should return empty array when no tool calls', () => {
      const response = {
        choices: [{ message: { role: 'assistant', content: 'Hello' } }],
      };

      const toolCalls = OpenAIClient.extractToolCalls(response as any);

      expect(toolCalls).toHaveLength(0);
    });
  });

  describe('createToolCallResult', () => {
    it('should create proper tool call result message', () => {
      const result = OpenAIClient.createToolCallResult('call_123', 'Tool output');

      expect(result).toEqual({
        role: 'tool',
        tool_call_id: 'call_123',
        content: 'Tool output',
      });
    });
  });
});
