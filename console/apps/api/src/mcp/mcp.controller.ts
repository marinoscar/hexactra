import { Body, Controller, Get, HttpCode, Logger, Post, Req, Res } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ApiTags } from '@nestjs/swagger';
import { Auth } from '@marinoscar/platform-api/identity';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { MCP_INSTRUCTIONS, MCP_TOOLS, type McpContext, type McpToolResult } from './mcp.tools';

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'hexactra-console', version: '0.1.0' };

interface Rpc {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** An error a REST route answered with, shown to the model as a tool error. */
class ApiCallError extends Error {}

/**
 * `POST /api/mcp`: the Model Context Protocol over Streamable HTTP
 * (stateless, JSON responses), authenticated like the rest of the API (a
 * personal access token or a session). Every tool calls the console's own
 * REST routes in-process as the caller, so permissions, validation,
 * redaction and run recording are exactly the REST API's.
 */
@ApiTags('MCP')
@Controller('mcp')
export class McpController {
  private readonly log = new Logger(McpController.name);

  constructor(private readonly adapter: HttpAdapterHost) {}

  private ctx(authorization: string): McpContext {
    const fastify = this.adapter.httpAdapter.getInstance<FastifyInstance>();
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fastify.inject({
        method: method as 'GET',
        url: `/api${path}`,
        headers: { authorization, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
      });
      return res;
    };
    return {
      async api<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
        const res = await call(method, path, body);
        if (res.statusCode === 204) return { ok: true } as T;
        const parsed = res.body ? (JSON.parse(res.body) as { data?: T; message?: string; code?: string }) : {};
        if (res.statusCode >= 400) throw new ApiCallError(`${res.statusCode} ${parsed.code ?? ''}: ${parsed.message ?? res.statusMessage}`.trim());
        return (parsed.data ?? parsed) as T;
      },
      async bytes(path: string) {
        const res = await call('GET', path);
        if (res.statusCode >= 400) throw new ApiCallError(`${res.statusCode}: could not fetch ${path}`);
        return { mime: String(res.headers['content-type'] ?? 'application/octet-stream'), data: res.rawPayload };
      },
    };
  }

  private async handle(msg: Rpc, authorization: string): Promise<object | null> {
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id ?? null, result });
    const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
    if (msg.id === undefined) return null; // a notification: nothing to answer
    switch (msg.method) {
      case 'initialize': {
        const asked = String(msg.params?.protocolVersion ?? '');
        return reply({
          protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: MCP_INSTRUCTIONS,
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({
          tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.input, { io: 'input' }) })),
        });
      case 'tools/call': {
        const name = String(msg.params?.name ?? '');
        const tool = MCP_TOOLS.find((t) => t.name === name);
        if (!tool) return error(-32602, `Unknown tool ${name}`);
        const args = tool.input.safeParse(msg.params?.arguments ?? {});
        if (!args.success) return reply({ content: [{ type: 'text', text: `Invalid arguments: ${args.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` }], isError: true });
        let result: McpToolResult;
        try {
          result = await tool.call(args.data as Record<string, unknown>, this.ctx(authorization));
        } catch (e) {
          result = { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
        }
        this.log.log(`mcp tool ${name}${result.isError ? ' (error)' : ''}`);
        return reply(result);
      }
      default:
        return error(-32601, `Method not found: ${msg.method ?? ''}`);
    }
  }

  @Post()
  @HttpCode(200)
  @Auth()
  async post(@Req() req: FastifyRequest, @Body() body: unknown, @Res() res: FastifyReply): Promise<void> {
    const authorization = String(req.headers.authorization ?? '');
    const batch = Array.isArray(body);
    const msgs = (batch ? body : [body]) as Rpc[];
    const out = (await Promise.all(msgs.map((m) => this.handle(m, authorization)))).filter(Boolean);
    if (out.length === 0) {
      await res.status(202).send();
      return;
    }
    await res.header('content-type', 'application/json').send(JSON.stringify(batch ? out : out[0]));
  }

  /** No server-initiated stream (stateless server). */
  @Get()
  @Auth()
  get(@Res() res: FastifyReply): void {
    void res.status(405).header('allow', 'POST').send();
  }
}
