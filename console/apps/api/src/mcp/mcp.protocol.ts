// The protocol layer of the console's MCP server: the revisions it speaks,
// how the revision of one request is determined, the 2026-07-28 header rules,
// and the per-request context the dispatcher works with. Pure functions, no
// Nest and no I/O, so every rule here is unit tested
// (test/mcp-protocol.spec.ts).
//
// Specification: https://modelcontextprotocol.io/specification (revisions
// 2024-11-05 to 2026-07-28); differences from issue #461 are listed in
// docs/mcp.md, "Protocol versions".
import type { AuthCredentialInfo } from '@marinoscar/platform-api/identity';

import { RPC } from './mcp.results';
import type { StepUpForm } from './mcp.settings';

/** What one revision gets from this server. */
export interface McpVersionFlags {
  /** `initialize` / `notifications/initialized` (every revision before 2026-07-28). */
  handshake: boolean;
  /** JSON-RPC batches (2025-03-26 only: added then, removed in 2025-06-18). */
  batching: boolean;
  /** `structuredContent` and `outputSchema` on tools (2025-06-18 and later). */
  structuredContent: boolean;
  /** `title` on tools (2025-06-18 and later). */
  toolTitle: boolean;
  /** Version, client info and capabilities in every request's `_meta`; `Mcp-Method`/`Mcp-Name` headers (2026-07-28). */
  perRequestMeta: boolean;
  /** `ttlMs` and `cacheScope` on list results, `resultType` on every result (2026-07-28). */
  listCacheHints: boolean;
  /** Multi round-trip requests (`resultType: "input_required"`) instead of server-initiated requests (2026-07-28). */
  multiRoundTrip: boolean;
}

/** Every revision this server speaks, newest first. */
export const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export type McpVersion = (typeof SUPPORTED_VERSIONS)[number];

export const MCP_VERSIONS: Readonly<Record<McpVersion, McpVersionFlags>> = {
  '2026-07-28': { handshake: false, batching: false, structuredContent: true, toolTitle: true, perRequestMeta: true, listCacheHints: true, multiRoundTrip: true },
  '2025-11-25': { handshake: true, batching: false, structuredContent: true, toolTitle: true, perRequestMeta: false, listCacheHints: false, multiRoundTrip: false },
  '2025-06-18': { handshake: true, batching: false, structuredContent: true, toolTitle: true, perRequestMeta: false, listCacheHints: false, multiRoundTrip: false },
  '2025-03-26': { handshake: true, batching: true, structuredContent: false, toolTitle: false, perRequestMeta: false, listCacheHints: false, multiRoundTrip: false },
  '2024-11-05': { handshake: true, batching: false, structuredContent: false, toolTitle: false, perRequestMeta: false, listCacheHints: false, multiRoundTrip: false },
};

/** The answer to an `initialize` asking for a revision this server does not speak (the latest handshake revision). */
export const LATEST_HANDSHAKE_VERSION: McpVersion = '2025-11-25';
/** A request with no header and no `_meta` version (the transport's rule for clients before 2025-06-18). */
export const DEFAULT_VERSION: McpVersion = '2025-03-26';

/** The `_meta` keys of 2026-07-28 (schema `RequestMetaObject` / `ResultMetaObject`). */
export const META = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
} as const;

/** `tools/list` and `server/discover` freshness on 2026-07-28: five minutes. */
export const LIST_TTL_MS = 300_000;
/** The list depends on the caller (scopes, role): shared caches must never reuse it across authorizations. */
export const LIST_CACHE_SCOPE = 'private' as const;

/** Methods that carry `Mcp-Name` on 2026-07-28, and the param it mirrors. */
const NAMED_METHODS: Readonly<Record<string, 'name' | 'uri'>> = { 'tools/call': 'name', 'resources/read': 'uri', 'prompts/get': 'name' };

export function isSupportedVersion(v: unknown): v is McpVersion {
  return typeof v === 'string' && (SUPPORTED_VERSIONS as readonly string[]).includes(v);
}

/** A JSON-RPC message as it arrives (not yet validated). */
export interface RpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/** Client software as it names itself (`clientInfo`). */
export interface McpClientInfo {
  name: string;
  version?: string;
  title?: string;
}

/** Everything the dispatcher knows about one request. */
export interface McpRequestContext {
  version: McpVersion;
  flags: McpVersionFlags;
  /** From `_meta` (2026-07-28) or the `initialize` params; absent on legacy requests after the handshake. */
  clientInfo?: McpClientInfo;
  /** From `_meta` (2026-07-28) or the `initialize` params. */
  clientCapabilities?: Record<string, unknown>;
  /** Which credential admitted the request (`null` never happens on `/api/mcp`, which requires one). */
  credential: AuthCredentialInfo | null;
}

/** A refusal at the transport level: an HTTP status plus a JSON-RPC error. */
export class McpProtocolError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export function unsupportedVersion(requested: string): McpProtocolError {
  return new McpProtocolError(400, RPC.UNSUPPORTED_PROTOCOL_VERSION, `Unsupported protocol version: ${requested}. Supported: ${SUPPORTED_VERSIONS.join(', ')}`, {
    supported: [...SUPPORTED_VERSIONS],
    requested,
  });
}

function headerMismatch(message: string): McpProtocolError {
  return new McpProtocolError(400, RPC.HEADER_MISMATCH, `Header mismatch: ${message}`);
}

function record(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** The `_meta` object of a message's params, if any. */
export function requestMeta(msg: RpcMessage): Record<string, unknown> | undefined {
  return record(record(msg.params)?._meta);
}

/**
 * Decode a header value that may use the 2026-07-28 Base64 sentinel
 * (`=?base64?...?=`) for non-ASCII or unsafe values.
 */
export function decodeHeaderValue(v: string): string {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : v;
}

/** Encode a value for `Mcp-Name` (the client side of {@link decodeHeaderValue}). */
export function encodeHeaderValue(v: string): string {
  const plain = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(v) && !/^=\?base64\?.*\?=$/.test(v);
  return plain ? v : `=?base64?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

/** The request headers this layer reads (lower-case names). */
export interface McpHeaders {
  protocolVersion?: string;
  method?: string;
  name?: string;
}

/**
 * The revision of one request, in order: the `MCP-Protocol-Version` header,
 * the `_meta` version, the `initialize` params' `protocolVersion`, else
 * `2025-03-26`. An unsupported header or `_meta` version is a `400` with
 * `UnsupportedProtocolVersion` (-32022) naming the supported versions; an
 * `initialize` asking for an unknown revision is answered with the latest
 * handshake revision (lifecycle rule), never refused.
 */
export function resolveVersion(headers: McpHeaders, msg: RpcMessage): McpVersion {
  const header = headers.protocolVersion?.trim();
  if (header) {
    if (!isSupportedVersion(header)) throw unsupportedVersion(header);
    return header;
  }
  const meta = requestMeta(msg)?.[META.protocolVersion];
  if (typeof meta === 'string') {
    if (!isSupportedVersion(meta)) throw unsupportedVersion(meta);
    return meta;
  }
  if (msg.method === 'initialize') return negotiateInitialize(record(msg.params)?.protocolVersion);
  return DEFAULT_VERSION;
}

/** The revision an `initialize` answers with: the one asked for when it is a handshake revision, else the latest handshake revision. */
export function negotiateInitialize(asked: unknown): McpVersion {
  return isSupportedVersion(asked) && MCP_VERSIONS[asked].handshake ? asked : LATEST_HANDSHAKE_VERSION;
}

/**
 * The 2026-07-28 Streamable HTTP rules (`basic/transports/streamable-http`,
 * "Server Validation"): the version header is required and equals the
 * `_meta` version; a request carries `Mcp-Method` equal to its `method`;
 * `tools/call`, `resources/read` and `prompts/get` carry `Mcp-Name` equal to
 * `params.name` / `params.uri`. Any miss is `400` with `HeaderMismatch`
 * (-32020). On every revision a header that IS present must agree with the
 * body: a gateway routing on the header must never see a different call
 * from the one the server runs.
 */
export function validateHeaders(version: McpVersion, headers: McpHeaders, msg: RpcMessage): void {
  const strict = MCP_VERSIONS[version].perRequestMeta;
  const isRequest = msg.id !== undefined;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const metaVersion = requestMeta(msg)?.[META.protocolVersion];
  const headerVersion = headers.protocolVersion?.trim();

  if (strict) {
    if (!headerVersion) throw headerMismatch('the MCP-Protocol-Version header is required');
    if (metaVersion !== headerVersion) throw headerMismatch(`MCP-Protocol-Version header value '${headerVersion}' does not match _meta["${META.protocolVersion}"] '${String(metaVersion ?? '')}'`);
  } else if (headerVersion && typeof metaVersion === 'string' && metaVersion !== headerVersion) {
    throw headerMismatch(`MCP-Protocol-Version header value '${headerVersion}' does not match _meta["${META.protocolVersion}"] '${metaVersion}'`);
  }

  const methodHeader = headers.method;
  if (methodHeader !== undefined) {
    if (methodHeader !== method) throw headerMismatch(`Mcp-Method header value '${methodHeader}' does not match body value '${method}'`);
  } else if (strict && isRequest) {
    throw headerMismatch('the Mcp-Method header is required');
  }

  const field = NAMED_METHODS[method];
  if (!field) return;
  const bodyName = record(msg.params)?.[field];
  const nameHeader = headers.name !== undefined ? decodeHeaderValue(headers.name) : undefined;
  if (nameHeader !== undefined) {
    if (nameHeader !== bodyName) throw headerMismatch(`Mcp-Name header value '${nameHeader}' does not match body value '${String(bodyName ?? '')}'`);
  } else if (strict && isRequest) {
    throw headerMismatch(`the Mcp-Name header is required for ${method}`);
  }
}

function clientInfoOf(v: unknown): McpClientInfo | undefined {
  const r = record(v);
  if (!r || typeof r.name !== 'string') return undefined;
  return {
    name: r.name.slice(0, 64),
    ...(typeof r.version === 'string' ? { version: r.version.slice(0, 64) } : {}),
    ...(typeof r.title === 'string' ? { title: r.title.slice(0, 128) } : {}),
  };
}

/**
 * Validate the headers and build the context of one message: its revision,
 * that revision's flags, and the client info and capabilities it carries
 * (from `_meta` on 2026-07-28, from the params of `initialize` before).
 */
export function requestContext(headers: McpHeaders, msg: RpcMessage, credential: AuthCredentialInfo | null): McpRequestContext {
  const version = resolveVersion(headers, msg);
  validateHeaders(version, headers, msg);
  const meta = requestMeta(msg);
  const params = record(msg.params);
  const fromInit = msg.method === 'initialize';
  const clientInfo = clientInfoOf(meta?.[META.clientInfo] ?? (fromInit ? params?.clientInfo : undefined));
  const clientCapabilities = record(meta?.[META.clientCapabilities] ?? (fromInit ? params?.capabilities : undefined));
  return {
    version,
    flags: MCP_VERSIONS[version],
    ...(clientInfo ? { clientInfo } : {}),
    ...(clientCapabilities ? { clientCapabilities } : {}),
    credential,
  };
}

/** Client buckets of the MCP metrics (low cardinality; the span carries the name itself). */
export const CLIENT_BUCKETS = ['claude', 'chatgpt', 'claude-code', 'hermes', 'openclaw', 'pi', 'other'] as const;
export type ClientBucket = (typeof CLIENT_BUCKETS)[number];

/** The metric bucket of a client name (`clientInfo.name` or, failing that, the User-Agent). */
export function clientBucket(name: string | undefined): ClientBucket {
  const n = (name ?? '').toLowerCase();
  if (!n) return 'other';
  if (n.includes('claude-code') || n.includes('claude code') || n.includes('claude_code')) return 'claude-code';
  if (n.includes('claude') || n.includes('anthropic')) return 'claude';
  if (n.includes('chatgpt') || n.includes('openai')) return 'chatgpt';
  if (n.includes('openclaw')) return 'openclaw';
  if (n.includes('hermes')) return 'hermes';
  if (/^pi(?:$|[\s/@_-])/.test(n)) return 'pi';
  return 'other';
}

/** The hosts an OAuth client of ChatGPT lives on (a subdomain counts): its client id document, redirect URI or `client_uri`. */
export const CHATGPT_CLIENT_HOSTS: readonly string[] = ['chatgpt.com', 'openai.com'];

/** A self-asserted `clientInfo.name` of ChatGPT. */
const CHATGPT_CLIENT_NAME = /openai|chatgpt/i;

/**
 * Whether the caller is ChatGPT (#531), for the one place the console answers
 * it differently: the form of a step-up (`stepUpTransport`). True when one of
 * the OAuth client's hosts (the platform-derived `host`, a redirect URI's
 * host, `client_uri`'s host) is `chatgpt.com` or `openai.com` or a subdomain,
 * or when the request's `clientInfo.name` (the `initialize` params, or
 * `_meta` on 2026-07-28; absent on a later request of a handshake revision)
 * names OpenAI or ChatGPT. Presentation only: it never decides what a caller
 * may do.
 */
export function isChatGptCaller(c: { clientHosts?: readonly (string | null | undefined)[]; clientInfoName?: string | null }): boolean {
  for (const raw of c.clientHosts ?? []) {
    const host = (raw ?? '').trim().toLowerCase().replace(/\.$/, '');
    if (host && CHATGPT_CLIENT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  }
  return Boolean(c.clientInfoName && CHATGPT_CLIENT_NAME.test(c.clientInfoName));
}

/**
 * How a step-up is sent (#531): `http` (the `403 insufficient_scope` with
 * `WWW-Authenticate`) or `tool` (a tool error result carrying the same
 * challenge in `_meta["mcp/www_authenticate"]`). Only an OAuth caller steps
 * up, so anything else is `http`. The `mcp.stepUpForm` setting: `http` and
 * `tool` force their form on every OAuth caller; `auto` gives ChatGPT `tool`.
 */
export function stepUpTransport(setting: StepUpForm, credentialKind: string | undefined, chatGpt: boolean): 'http' | 'tool' {
  if (credentialKind !== 'oauth') return 'http';
  if (setting === 'http' || setting === 'tool') return setting;
  return chatGpt ? 'tool' : 'http';
}

/** Loopback hosts whose origins (any port, http or https) may call the endpoint from a browser. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * `mcp.allowedOrigins`: the origins a browser-based client may call
 * `/api/mcp` from. The console's own origin (`APP_URL`) always; loopback
 * origins on any port (local tools such as the MCP Inspector); plus any
 * extra origins given. A request without an `Origin` header (a hosted
 * client's server, a CLI, an SDK) is not a browser and passes.
 */
export function isAllowedOrigin(origin: string, appUrl: string | undefined, extra: readonly string[] = []): boolean {
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (o.origin !== origin.replace(/\/+$/, '')) return false; // a path, credentials or junk: not an origin
  if ((o.protocol === 'http:' || o.protocol === 'https:') && LOOPBACK_HOSTS.has(o.hostname)) return true;
  const own = originOf(appUrl);
  if (own && own === o.origin) return true;
  return extra.some((e) => originOf(e) === o.origin);
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The `Accept` rule: absent, `application/json`, `application/*` or `*\/*` passes; anything else is `406`. */
export function acceptsJson(accept: string | undefined): boolean {
  if (accept === undefined || accept.trim() === '') return true;
  return accept
    .split(',')
    .map((p) => p.split(';')[0].trim().toLowerCase())
    .some((t) => t === 'application/json' || t === 'application/*' || t === '*/*');
}
