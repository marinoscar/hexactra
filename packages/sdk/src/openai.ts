//! OpenAI-compatible model adapter for Hexactra
//!
//! This module provides an interface to interact with any OpenAI-compatible API endpoint.
//! It supports chat completions, tool calling, and streaming responses.

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
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
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
export class OpenAIClient {
  private config: OpenAIConfig;

  constructor(config: OpenAIConfig) {
    this.config = { ...config, stream: config.stream ?? false };
  }

  /**
   * Build the authorization header
   */
  private getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    return headers;
  }

  /**
   * Test the connection to the OpenAI-compatible endpoint
   */
  async testConnection(): Promise<{ success: boolean; message?: string }> {
    try {
      // Try a simple ping with a minimal request
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify({
          model: this.config.modelId,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
          stream: false,
        }),
      });

      if (response.ok) {
        return { success: true, message: 'Connection successful' };
      }

      const errorData = await response.json().catch(() => ({}));
      return {
        success: false,
        message: errorData.error?.message || `HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get model capabilities (tool calling, vision, etc.)
   */
  async getModelCapabilities(): Promise<{
    supportsTools: boolean;
    supportsVision: boolean;
    supportsStreaming: boolean;
    contextWindow?: number;
  }> {
    try {
      // Try to get model info if available
      const response = await fetch(`${this.config.baseUrl}/models`, {
        headers: this.getAuthHeaders(),
      });

      if (response.ok) {
        const data = await response.json();
        const models = (data as { data?: Array<{ id: string; capabilities?: Record<string, unknown> }> }).data;
        const modelInfo = models?.find((m) => m.id === this.config.modelId);

        return {
          supportsTools: typeof modelInfo?.capabilities?.tools === 'boolean' ? modelInfo?.capabilities?.tools : true,
          supportsVision: typeof modelInfo?.capabilities?.vision === 'boolean' ? modelInfo?.capabilities?.vision : false,
          supportsStreaming: true,
          contextWindow: (modelInfo?.capabilities?.context_window as number | undefined) ?? undefined,
        };
      }
    } catch (error) {
      // If we can't fetch capabilities, assume defaults
      console.warn('Could not fetch model capabilities:', error);
    }

    return {
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
    };
  }

  /**
   * Create a chat completion request
   */
  async createChatCompletion(
    messages: ChatMessage[],
    tools?: ToolDefinition[]
  ): Promise<ChatCompletionResponse> {
    const body: Record<string, unknown> = {
      model: this.config.modelId,
      messages: messages,
      stream: this.config.stream,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
    };

    if (tools && tools.length > 0) {
      body['tools'] = tools;
      body['tool_choice'] = 'auto';
    }

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as ErrorResponse;
      throw new Error(
        errorData.error?.message || `API request failed with status ${response.status}`
      );
    }

    return (await response.json()) as ChatCompletionResponse;
  }

  /**
   * Create a chat completion with streaming support
   */
  async createChatCompletionStream(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.config.modelId,
      messages: messages,
      stream: true,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
    };

    if (tools && tools.length > 0) {
      body['tools'] = tools;
      body['tool_choice'] = 'auto';
    }

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as ErrorResponse;
      throw new Error(
        errorData.error?.message || `API request failed with status ${response.status}`
      );
    }

    let fullContent = '';
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    if (!reader) {
      throw new Error('Response body is not readable');
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter((line) => line.trim() !== '');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data) as { choices: StreamingChoice[] };
            const content = parsed.choices[0]?.delta?.content;
            if (content) {
              fullContent += content;
              onChunk?.(content);
            }
          } catch (error) {
            // Ignore non-JSON lines
            console.debug('Failed to parse chunk:', error);
          }
        }
      }
    }

    return fullContent;
  }

  /**
   * Format messages for the OpenAI API
   */
  static formatMessages(
    history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
    systemPrompt?: string
  ): ChatMessage[] {
    const messages: ChatMessage[] = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of history) {
      messages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content,
      });
    }

    return messages;
  }

  /**
   * Extract tool calls from a response
   */
  static extractToolCalls(response: ChatCompletionResponse): ToolCallRequest[] {
    return response.choices[0]?.message.tool_calls ?? [];
  }

  /**
   * Create a tool call result message
   */
  static createToolCallResult(toolCallId: string, content: string): ToolCallResult {
    return {
      role: 'tool',
      tool_call_id: toolCallId,
      content,
    };
  }
}

/**
 * Factory function to create an OpenAI client
 */
export function createOpenAIClient(config: OpenAIConfig): OpenAIClient {
  return new OpenAIClient(config);
}
