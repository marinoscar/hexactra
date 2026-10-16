//! MCP (Model Context Protocol) contract types

export interface McpRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  id: string;
  result?: Record<string, unknown>;
  error?: {
    code: number;
    message: string;
  };
}
