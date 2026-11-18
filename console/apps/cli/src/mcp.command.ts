import { createInterface } from 'node:readline';

import type { Command } from 'commander';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';

import { consoleApi, consoleCredentials } from './console-api.js';

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

/** `GET /api/admin/mcp/status` (#465). */
export interface McpStatusView {
  externalAppsEnabled: boolean;
  patMcpEnabled: boolean;
  oauthEnabled: boolean;
  mcpUrl: string;
  publicHttps: boolean;
  connectedApps: number;
  connectedUsers: number;
  highRiskGrants: number;
}

/** The status in lines, for `hexactra mcp status`. */
export function statusLines(s: McpStatusView): string[] {
  const on = (b: boolean) => (b ? 'on' : 'OFF');
  return [
    `MCP endpoint: ${s.mcpUrl}`,
    `External AI apps (OAuth): ${on(s.externalAppsEnabled)}${s.oauthEnabled ? '' : ' (the OAuth server is off: no app can sign in)'}`,
    `Personal access tokens over MCP: ${on(s.patMcpEnabled)}`,
    `Public HTTPS address: ${s.publicHttps ? 'yes' : 'no: ChatGPT and Claude cannot reach this console (docs/runbooks/public-exposure.md)'}`,
    `Connected apps: ${s.connectedApps} (${s.connectedUsers} user${s.connectedUsers === 1 ? '' : 's'}); high-risk grants: ${s.highRiskGrants}`,
  ];
}

/** The `mcp` settings patch of `enable` / `disable`: OAuth apps by default, personal access tokens with `--pat`, both with `--all`. */
export function switchPatch(enabled: boolean, o: { pat?: boolean; all?: boolean }): Record<string, boolean> {
  if (o.all) return { externalAppsEnabled: enabled, patMcpEnabled: enabled };
  return o.pat ? { patMcpEnabled: enabled } : { externalAppsEnabled: enabled };
}

const print = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

/**
 * `hexactra mcp …`: `serve` bridges the console's MCP tools over stdio for
 * agent frameworks; `status`, `enable` and `disable` (#465) are the kill
 * switch of external AI apps for an administrator (`system_settings:read` /
 * `:write`), for an operator on the box during an incident.
 */
export const mcpCommand: CliCommandRegistration = (program: Command) => {
  const mcp = program.command('mcp').description('The console as an MCP server: serve it over stdio, or switch external AI apps on and off');
  mcp
    .command('serve')
    .description('Serve MCP over stdio (bridged to POST /api/mcp as the logged-in user)')
    .action(async () => {
      await serveMcpStdio();
    });
  mcp
    .command('status')
    .description('Whether external AI apps may connect, the public URL check and how many apps are connected (administrator)')
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean }) => {
      const s = await consoleApi().get<McpStatusView>('/admin/mcp/status');
      if (o.json) return print(JSON.stringify(s, null, 2));
      for (const line of statusLines(s)) print(line);
    });
  const toggle = (enabled: boolean) => async (o: { pat?: boolean; all?: boolean }) => {
    const patch = switchPatch(enabled, o);
    await consoleApi().patch('/system-settings', { mcp: patch });
    const what = o.all ? 'External AI apps and personal access tokens over MCP' : o.pat ? 'Personal access tokens over MCP' : 'External AI apps (OAuth)';
    print(`${what}: ${enabled ? 'on' : 'off'}. It takes effect within a few seconds.`);
  };
  mcp
    .command('disable')
    .description('Kill switch: refuse every AI app signed in with OAuth on /api/mcp (503); --pat for personal access tokens over MCP, --all for both')
    .option('--pat', 'personal access tokens over MCP instead (REST with a token keeps working)')
    .option('--all', 'both')
    .action(toggle(false));
  mcp
    .command('enable')
    .description('Let AI apps signed in with OAuth call /api/mcp again; --pat for personal access tokens, --all for both')
    .option('--pat', 'personal access tokens over MCP instead')
    .option('--all', 'both')
    .action(toggle(true));
};
