import { createInterface } from 'node:readline';

import type { Command } from 'commander';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';

import { consoleCredentials } from './console-api.js';

type Fetch = typeof globalThis.fetch;

/**
 * Bridge MCP over stdio (newline-delimited JSON-RPC) to the console's
 * `POST /api/mcp`, as the logged-in user. Each line in is one message; each
 * answer is one line out. Logs go to stderr only (stdout is the protocol).
 */
export async function serveMcpStdio(opts: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream; fetch?: Fetch; credentials?: { apiBaseUrl: string; token: string } } = {}): Promise<void> {
  const creds = opts.credentials ?? consoleCredentials();
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const output = opts.output ?? process.stdout;
  const rl = createInterface({ input: opts.input ?? process.stdin, crlfDelay: Infinity });
  const pending: Promise<void>[] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    pending.push(
      (async () => {
        let id: unknown = null;
        try {
          id = (JSON.parse(line) as { id?: unknown }).id ?? null;
        } catch {
          output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
          return;
        }
        try {
          const res = await fetchImpl(`${creds.apiBaseUrl}/mcp`, {
            method: 'POST',
            headers: { authorization: `Bearer ${creds.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: line,
          });
          if (res.status === 202) return;
          const text = await res.text();
          if (!res.ok) {
            if (id !== null) output.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: `console answered ${res.status}` } })}\n`);
            process.stderr.write(`hexactra mcp: console answered ${res.status}\n`);
            return;
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
