"use strict";
//! Tests for OpenAI-compatible model adapter
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const openai_1 = require("./openai");
// Mock fetch globally
const mockFetch = vitest_1.vi.fn();
(0, vitest_1.beforeEach)(() => {
    global.fetch = mockFetch;
});
(0, vitest_1.describe)('OpenAIClient', () => {
    const config = {
        baseUrl: 'https://api.openai.com/v1',
        modelId: 'gpt-4',
        apiKey: 'test-key',
    };
    let client;
    (0, vitest_1.beforeEach)(() => {
        client = new openai_1.OpenAIClient(config);
        mockFetch.mockReset();
    });
    (0, vitest_1.describe)('testConnection', () => {
        (0, vitest_1.it)('should return success for valid API response', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ id: 'test', choices: [] }),
            });
            const result = await client.testConnection();
            (0, vitest_1.expect)(result.success).toBe(true);
            (0, vitest_1.expect)(result.message).toBe('Connection successful');
        });
        (0, vitest_1.it)('should return error for invalid API key', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 401,
                json: () => Promise.resolve({
                    error: { message: 'Invalid API key' },
                }),
            });
            const result = await client.testConnection();
            (0, vitest_1.expect)(result.success).toBe(false);
            (0, vitest_1.expect)(result.message).toBe('Invalid API key');
        });
        (0, vitest_1.it)('should return error for network failure', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Network error'));
            const result = await client.testConnection();
            (0, vitest_1.expect)(result.success).toBe(false);
            (0, vitest_1.expect)(result.message).toBe('Network error');
        });
    });
    (0, vitest_1.describe)('getModelCapabilities', () => {
        (0, vitest_1.it)('should return capabilities for known model', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({
                    data: [
                        {
                            id: 'gpt-4',
                            capabilities: { tools: true, vision: false, context_window: 8192 },
                        },
                    ],
                }),
            });
            const result = await client.getModelCapabilities();
            (0, vitest_1.expect)(result.supportsTools).toBe(true);
            (0, vitest_1.expect)(result.supportsVision).toBe(false);
            (0, vitest_1.expect)(result.contextWindow).toBe(8192);
        });
        (0, vitest_1.it)('should return defaults when capabilities unavailable', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404,
            });
            const result = await client.getModelCapabilities();
            (0, vitest_1.expect)(result.supportsTools).toBe(true);
            (0, vitest_1.expect)(result.supportsVision).toBe(false);
        });
    });
    (0, vitest_1.describe)('createChatCompletion', () => {
        (0, vitest_1.it)('should make correct API request', async () => {
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
            const messages = [{ role: 'user', content: 'Hi' }];
            const result = await client.createChatCompletion(messages);
            (0, vitest_1.expect)(result.choices[0].message.content).toBe('Hello');
            // Verify the request was made correctly
            (0, vitest_1.expect)(mockFetch).toHaveBeenCalledWith('https://api.openai.com/v1/chat/completions', vitest_1.expect.objectContaining({
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
            }));
        });
        (0, vitest_1.it)('should include tools in request when provided', async () => {
            const mockResponse = {
                id: 'test',
                choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
            };
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockResponse),
            });
            const tools = [
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
            (0, vitest_1.expect)(requestBody.tools).toEqual(tools);
            (0, vitest_1.expect)(requestBody.tool_choice).toBe('auto');
        });
        (0, vitest_1.it)('should throw error for API failure', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 400,
                json: () => Promise.resolve({
                    error: { message: 'Bad request' },
                }),
            });
            await (0, vitest_1.expect)(client.createChatCompletion([])).rejects.toThrow('Bad request');
        });
    });
    (0, vitest_1.describe)('formatMessages', () => {
        (0, vitest_1.it)('should format history with system prompt', () => {
            const history = [
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi there' },
            ];
            const messages = openai_1.OpenAIClient.formatMessages(history, 'You are a helpful assistant');
            (0, vitest_1.expect)(messages).toEqual([
                { role: 'system', content: 'You are a helpful assistant' },
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi there' },
            ]);
        });
        (0, vitest_1.it)('should format without system prompt', () => {
            const history = [{ role: 'user', content: 'Hello' }];
            const messages = openai_1.OpenAIClient.formatMessages(history);
            (0, vitest_1.expect)(messages).toEqual([{ role: 'user', content: 'Hello' }]);
        });
    });
    (0, vitest_1.describe)('extractToolCalls', () => {
        (0, vitest_1.it)('should extract tool calls from response', () => {
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
            const toolCalls = openai_1.OpenAIClient.extractToolCalls(response);
            (0, vitest_1.expect)(toolCalls).toHaveLength(1);
            (0, vitest_1.expect)(toolCalls[0].id).toBe('call_123');
        });
        (0, vitest_1.it)('should return empty array when no tool calls', () => {
            const response = {
                choices: [{ message: { role: 'assistant', content: 'Hello' } }],
            };
            const toolCalls = openai_1.OpenAIClient.extractToolCalls(response);
            (0, vitest_1.expect)(toolCalls).toHaveLength(0);
        });
    });
    (0, vitest_1.describe)('createToolCallResult', () => {
        (0, vitest_1.it)('should create proper tool call result message', () => {
            const result = openai_1.OpenAIClient.createToolCallResult('call_123', 'Tool output');
            (0, vitest_1.expect)(result).toEqual({
                role: 'tool',
                tool_call_id: 'call_123',
                content: 'Tool output',
            });
        });
    });
});
//# sourceMappingURL=openai.test.js.map