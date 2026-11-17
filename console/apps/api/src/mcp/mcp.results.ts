// Result helpers of the console's MCP server: what a tool returns (text,
// image, structured, error) and the JSON-RPC envelopes the dispatcher and the
// controller answer with. No Nest, no I/O: shared by the tools, the
// dispatcher and the transport.

/** How a tool reaches the console: its own REST API, as the caller. */
export interface McpContext {
  api<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  /** Raw bytes of a GET (screenshots). */
  bytes(path: string): Promise<{ mime: string; data: Buffer }>;
}

export type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface McpToolResult {
  content: McpContent[];
  /** Typed result for clients on 2025-06-18 and later (E33.4 fills it per tool). */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** A text result: a string as it is, anything else as pretty-printed JSON. */
export function textResult(v: unknown): McpToolResult {
  return { content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] };
}

/** An image result (base64), with optional text blocks after it. */
export function imageResult(data: Buffer, mimeType: string, ...texts: string[]): McpToolResult {
  return { content: [{ type: 'image', data: data.toString('base64'), mimeType }, ...texts.map((t) => ({ type: 'text' as const, text: t }))] };
}

/** A structured result: the object as `structuredContent` and, for older clients, as JSON text. */
export function structuredResult(value: Record<string, unknown>): McpToolResult {
  return { ...textResult(value), structuredContent: value };
}

/** A tool error the model sees (`isError: true`), never a JSON-RPC error. */
export function errorResult(message: string): McpToolResult {
  return { ...textResult(message), isError: true };
}

/** JSON-RPC error codes the server answers with. */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  /** Resource not found before 2026-07-28 (it is `-32602` from 2026-07-28). */
  RESOURCE_NOT_FOUND_LEGACY: -32002,
  /** 2026-07-28: HTTP headers do not match the body, or a required header is missing. */
  HEADER_MISMATCH: -32020,
  /** 2026-07-28: the request's protocol version is not supported. */
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
} as const;

export type RpcId = string | number | null;

export interface RpcResponse {
  jsonrpc: '2.0';
  id: RpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export function rpcResult(id: RpcId, result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(id: RpcId, code: number, message: string, data?: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}
