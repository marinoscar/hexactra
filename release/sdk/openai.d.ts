/**
 * OpenAI-compatible API configuration
 */
export interface OpenAIConfig {
    /** Base URL for the API endpoint (e.g., https://api.openai.com/v1) */
    baseUrl: string;
    /** API key for authentication */
    apiKey?: string;
    /** Model ID to use (e.g., gpt-4, llama-3) */
    modelId: string;
    /** Optional: System prompt to set the assistant's behavior */
    systemPrompt?: string;
    /** Optional: Maximum tokens to generate */
    maxTokens?: number;
    /** Optional: Temperature for sampling */
    temperature?: number;
    /** Optional: Enable streaming responses */
    stream?: boolean;
}
/**
 * Message role types
 */
export type MessageRole = 'system' | 'user' | 'assistant';
/**
 * Chat message interface
 */
export interface ChatMessage {
    role: MessageRole;
    content: string | Array<{
        type: string;
        text?: string;
        image_url?: {
            url: string;
        };
    }>;
}
/**
 * Tool definition for function calling
 */
export interface ToolDefinition {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters: Record<string, unknown>;
    };
}
/**
 * Tool call request
 */
export interface ToolCallRequest {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}
/**
 * Tool call result
 */
export interface ToolCallResult {
    role: 'tool';
    tool_call_id: string;
    content: string;
}
/**
 * OpenAI-compatible streaming delta
 */
export interface StreamingDelta {
    role?: MessageRole;
    content?: string;
    tool_calls?: ToolCallRequest[];
}
/**
 * OpenAI-compatible response choices
 */
export interface Choice {
    index: number;
    message: {
        role: MessageRole;
        content?: string;
        tool_calls?: ToolCallRequest[];
    };
    finish_reason: string | null;
}
/**
 * OpenAI-compatible streaming choice (for chunked responses)
 */
export interface StreamingChoice {
    index: number;
    delta: StreamingDelta;
    finish_reason: string | null;
}
/**
 * OpenAI-compatible chat completion response
 */
export interface ChatCompletionResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Choice[];
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}
/**
 * OpenAI-compatible error response
 */
export interface ErrorResponse {
    error: {
        message: string;
        type: string;
        param?: string;
        code?: string;
    };
}
/**
 * OpenAI API client for chat completions
 */
export declare class OpenAIClient {
    private config;
    constructor(config: OpenAIConfig);
    /**
     * Build the authorization header
     */
    private getAuthHeaders;
    /**
     * Test the connection to the OpenAI-compatible endpoint
     */
    testConnection(): Promise<{
        success: boolean;
        message?: string;
    }>;
    /**
     * Get model capabilities (tool calling, vision, etc.)
     */
    getModelCapabilities(): Promise<{
        supportsTools: boolean;
        supportsVision: boolean;
        supportsStreaming: boolean;
        contextWindow?: number;
    }>;
    /**
     * Create a chat completion request
     */
    createChatCompletion(messages: ChatMessage[], tools?: ToolDefinition[]): Promise<ChatCompletionResponse>;
    /**
     * Create a chat completion with streaming support
     */
    createChatCompletionStream(messages: ChatMessage[], tools?: ToolDefinition[], onChunk?: (chunk: string) => void): Promise<string>;
    /**
     * Format messages for the OpenAI API
     */
    static formatMessages(history: Array<{
        role: 'user' | 'assistant' | 'system';
        content: string;
    }>, systemPrompt?: string): ChatMessage[];
    /**
     * Extract tool calls from a response
     */
    static extractToolCalls(response: ChatCompletionResponse): ToolCallRequest[];
    /**
     * Create a tool call result message
     */
    static createToolCallResult(toolCallId: string, content: string): ToolCallResult;
}
/**
 * Factory function to create an OpenAI client
 */
export declare function createOpenAIClient(config: OpenAIConfig): OpenAIClient;
//# sourceMappingURL=openai.d.ts.map