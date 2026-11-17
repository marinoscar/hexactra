import { createInterface } from 'node:readline';

import type { Command } from 'commander';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';

import { consoleCredentials } from './console-api.js';

type Fetch = typeof globalThis.fetch;

/** The 2026-07-28 `_meta` key holding a request's protocol version. */
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
/** Methods whose `Mcp-Name` header mirrors `params.name` or `params.uri` (2026-07-28). */
const NAMED: Readonly<Record<string, 'name' | 'uri'>> = { 'tools/call': 'name', 'resources/read': 'uri', 'prompts/get': 'name' };

/** A header value as the 2026-07-28 transport wants it: plain ASCII as it is, anything else in the Base64 sentinel. */
export function mcpHeaderValue(v: string): string {
  const plain = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(v) && !/^=\?base64\?.*\?=$/.test(v);
  return plain ? v : `=?base64?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

interface Message {
  id?: unknown;
  method?: unknown;
  params?: { _meta?: Record<string, unknown>; [k: string]: unknown };
}

/**
 * The MCP headers of one forwarded message. A 2026-07-28 message (its
 * version in `_meta`) carries `MCP-Protocol-Version`, `Mcp-Method` and, for
 * `tools/call`, `resources/read` and `prompts/get`, `Mcp-Name`. A message of
 * a handshake revision carries the version `initialize` negotiated, on every
 * request after `initialize`; before it, none (the console then reads the
 * version from the message, as for any client before 2025-06-18).
 */
export function mcpHeaders(msg: Message, negotiated: string | null): Record<string, string> {
  const method = typeof msg.method === 'string' ? msg.method : undefined;
  const metaVersion = msg.params?._meta?.[META_PROTOCOL_VERSION];
  if (typeof metaVersion === 'string') {
    const h: Record<string, string> = { 'mcp-protocol-version': metaVersion };
    if (method) h['mcp-method'] = method;
    const field = method ? NAMED[method] : undefined;
    const name = field ? msg.params?.[field] : undefined;
    if (typeof name === 'string') h['mcp-name'] = mcpHeaderValue(name);
    return h;
  }
  if (negotiated && method !== 'initialize') return { 'mcp-protocol-version': negotiated };
  return {};
}

/**
 * Bridge MCP over stdio (newline-delimited JSON-RPC) to the console's
 * `POST /api/mcp`, as the logged-in user. Each line in is one message; each
 * answer is one line out. Logs go to stderr only (stdout is the protocol).
 * Every revision the console speaks passes through: the bridge adds the
 * HTTP headers the revision needs (see {@link mcpHeaders}) and forwards a
 * JSON-RPC error the console answered with (a 400 or 404 carrying one) as
 * it is, so a client can read `UnsupportedProtocolVersion` and the like.
 */
export async function serveMcpStdio(opts: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream; fetch?: Fetch; credentials?: { apiBaseUrl: string; token: string } } = {}): Promise<void> {
  const creds = opts.credentials ?? consoleCredentials();
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const output = opts.output ?? process.stdout;
  const rl = createInterface({ input: opts.input ?? process.stdin, crlfDelay: Infinity });
  const pending: Promise<void>[] = [];
  /** The revision `initialize` settled on (a handshake revision), sent on every later request. */
  let negotiated: string | null = null;
  for await (const line of rl) {
    if (!line.trim()) continue;
    pending.push(
      (async () => {
        let msg: Message;
        try {
          msg = JSON.parse(line) as Message;
        } catch {
          output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
          return;
        }
        const single = msg !== null && typeof msg === 'object' && !Array.isArray(msg);
        const id: unknown = (single ? msg.id : undefined) ?? null;
        // A batch (2025-03-26 only) carries the negotiated version, like any later request.
        const extra = single ? mcpHeaders(msg, negotiated) : negotiated ? { 'mcp-protocol-version': negotiated } : {};
        try {
          const res = await fetchImpl(`${creds.apiBaseUrl}/mcp`, {
            method: 'POST',
            headers: { authorization: `Bearer ${creds.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra },
            body: line,
          });
          if (res.status === 202) return;
          const text = await res.text();
          if (!res.ok) {
            // A JSON-RPC error the console answered with (unsupported version, header mismatch, method not found): pass it on.
            let rpc: { jsonrpc?: unknown; error?: unknown } | null = null;
            try {
              rpc = JSON.parse(text) as { jsonrpc?: unknown; error?: unknown };
            } catch {
              rpc = null;
            }
            if (rpc && rpc.jsonrpc === '2.0' && rpc.error && id !== null) {
              output.write(`${JSON.stringify({ ...rpc, id })}\n`);
            } else if (id !== null) {
              output.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: `console answered ${res.status}` } })}\n`);
            }
            process.stderr.write(`hexactra mcp: console answered ${res.status}\n`);
            return;
          }
          if (single && msg.method === 'initialize') {
            try {
              const v = (JSON.parse(text) as { result?: { protocolVersion?: unknown } }).result?.protocolVersion;
              if (typeof v === 'string') negotiated = v;
            } catch {
              // not JSON: forwarded as it is below
            }
          }
          output.write(`${text.replace(/\n/g, '')}\n`);
        } catch (e) {
          if (id !== null) output.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: `cannot reach the console: ${e instanceof Error ? e.message : String(e)}` } })}\n`);
        }
      })(),
    );
  }
  await Promise.all(pending);
}

/** `hexactra mcp serve`: the console's MCP tools over stdio, for agent frameworks. */
export const mcpCommand: CliCommandRegistration = (program: Command) => {
  const mcp = program.command('mcp').description('The console as an MCP server for agent frameworks');
  mcp
    .command('serve')
    .description('Serve MCP over stdio (bridged to POST /api/mcp as the logged-in user)')
    .action(async () => {
      await serveMcpStdio();
    });
};
