// The console's MCP server over Streamable HTTP, against a real database:
// the protocol, the tool list, tools that call the REST API as the caller
// (so its permissions apply), notifications and batches.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';

let app: NestFastifyApplication;
const stamp = `${Date.now()}`;

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
});

async function token(email: string, role: 'contributor' | 'viewer') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
  return new URL(String(res.headers.location)).searchParams.get('token')!;
}

async function rpc(t: string | null, body: unknown) {
  const res = await app.inject({ method: 'POST', url: '/api/mcp', headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

describe('the console MCP server', () => {
  it('speaks MCP, lists the tools and calls them as the caller', async () => {
    const t = await token(`mcp-${stamp}@example.test`, 'contributor');
    expect((await rpc(null, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).status).toBe(401);

    const init = await rpc(t, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    expect(init.json.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'hexactra-console' }, capabilities: { tools: {} } });
    expect(init.json.result.instructions).toMatch(/never try to bypass a CAPTCHA/i);
    expect((await rpc(t, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);

    const list = await rpc(t, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = list.json.result.tools.map((x: { name: string }) => x.name);
    expect(names).toEqual(expect.arrayContaining(['run_goal', 'run_status', 'task_create', 'task_run', 'inbox_answer', 'browser_open', 'browser_navigate', 'browser_request_human', 'browser_type_secret', 'browser_close', 'hosts_list']));
    const create = list.json.result.tools.find((x: { name: string }) => x.name === 'task_create');
    expect(create.inputSchema).toMatchObject({ type: 'object', properties: { name: {}, goal: {} } });

    const made = await rpc(t, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'task_create', arguments: { name: 'Fare', goal: 'Find a fare', allowed_domains: ['flights.example.test'] } } });
    expect(made.json.result.isError).toBeFalsy();
    const task = JSON.parse(made.json.result.content[0].text);
    expect(task).toMatchObject({ name: 'Fare', allowedDomains: ['flights.example.test'] });

    // A batch: two calls in one request.
    const batch = await rpc(t, [
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tasks_list', arguments: {} } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } },
    ]);
    expect(batch.json).toHaveLength(2);
    expect(JSON.parse(batch.json[0].result.content[0].text).map((x: { id: string }) => x.id)).toContain(task.id);
    expect(batch.json[1].error.code).toBe(-32602);

    const bad = await rpc(t, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'run_status', arguments: { run_id: 'x' } } });
    expect(bad.json.result).toMatchObject({ isError: true });
    expect(bad.json.result.content[0].text).toMatch(/Invalid arguments/);
  });

  it('applies the caller\'s permissions: a viewer cannot create tasks', async () => {
    const t = await token(`mcp-viewer-${stamp}@example.test`, 'viewer');
    const r = await rpc(t, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task_create', arguments: { name: 'x', goal: 'y' } } });
    expect(r.json.result.isError).toBe(true);
    expect(r.json.result.content[0].text).toMatch(/^403/);
    const ok = await rpc(t, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tasks_list', arguments: {} } });
    expect(ok.json.result.isError).toBeFalsy();
  });
});
