// The console's MCP server over Streamable HTTP, against a real database:
// the protocol, the tool list, tools that call the REST API as the caller
// (so its permissions apply), notifications and batches.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { FabricClient } from '../src/fabric/fabric.client';
import { READ_ONLY_TOOLS } from '../src/mcp/mcp.tools';
import { PrismaService } from '../src/prisma/prisma.service';

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
    expect(init.json.result.instructions).toMatch(/full authority/i);
    expect(init.json.result.instructions).toMatch(/browser_request_human/);
    expect((await rpc(t, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);

    const list = await rpc(t, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = list.json.result.tools.map((x: { name: string }) => x.name);
    expect(names).toEqual(expect.arrayContaining(['run_goal', 'run_status', 'task_create', 'task_run', 'inbox_answer', 'browser_open', 'browser_navigate', 'browser_request_human', 'browser_type_secret', 'browser_close', 'hosts_list']));
    const create = list.json.result.tools.find((x: { name: string }) => x.name === 'task_create');
    expect(create.inputSchema).toMatchObject({ type: 'object', properties: { name: {}, goal: {} } });
    expect(create.annotations).toMatchObject({ readOnlyHint: false });
    expect(list.json.result.tools.find((x: { name: string }) => x.name === 'run_status').annotations).toEqual({ readOnlyHint: true });
    // Every read-only hint names a real tool.
    for (const n of READ_ONLY_TOOLS) expect(names).toContain(n);

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

/** A tool call; its text content parsed as JSON when it is JSON. */
async function call(t: string, name: string, args: Record<string, unknown>) {
  const r = await rpc(t, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const body = String(r.json.result.content[0].text);
  let parsed: Record<string, unknown> | string = body;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // plain text
  }
  return { isError: Boolean(r.json.result.isError), body: parsed };
}

describe('MCP questions (#290)', () => {
  it('ask_human asks a free-standing question and returns at once without wait_s', async () => {
    const t = await token(`mcp-ask-${stamp}@example.test`, 'contributor');
    const list = await rpc(t, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = list.json.result.tools as { name: string; inputSchema: { properties: Record<string, unknown> }; annotations: unknown }[];
    const ask = tools.find((x) => x.name === 'ask_human')!;
    expect(Object.keys(ask.inputSchema.properties)).toEqual(expect.arrayContaining(['prompt', 'input', 'options', 'constraints', 'confirm_label', 'deny_label', 'risk', 'timeout_s', 'wait_s']));
    expect(tools.find((x) => x.name === 'question_status')!.annotations).toEqual({ readOnlyHint: true });

    const r = await call(t, 'ask_human', { prompt: 'Which seat?', input: 'choice', options: [{ id: 'w', label: 'Window', description: 'By the window' }, 'Aisle'] });
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ status: 'pending', input: 'choice', question_id: expect.any(String) });
    const q = await app.inject({ method: 'GET', url: `/api/questions/${(r.body as { question_id: string }).question_id}`, headers: { authorization: `Bearer ${t}` } });
    expect(q.json().data).toMatchObject({ askedBy: 'agent:mcp agent', options: [{ id: 'w', label: 'Window', description: 'By the window' }, { id: 'Aisle', label: 'Aisle' }] });

    // A secret is never asked free-standing, and the contract's rules apply.
    expect((await call(t, 'ask_human', { prompt: 'Password?', input: 'secret' })).body).toMatch(/Invalid arguments/);
    const bad = await call(t, 'ask_human', { prompt: 'How many?', input: 'number', constraints: { min: 5, max: 1 } });
    expect(bad.isError).toBe(true);
    expect(bad.body).toMatch(/min is greater than max/);
  });

  it('ask_human with wait_s returns the answer given meanwhile through REST', async () => {
    const t = await token(`mcp-wait-${stamp}@example.test`, 'contributor');
    const prisma = app.get(PrismaService);
    const asking = call(t, 'ask_human', { prompt: 'How much does it weigh?', input: 'number', constraints: { min: 0, max: 100, step: 0.5, unit: 'kg' }, wait_s: 20, agent_name: 'packer' });
    // The question appears, then the person answers it from another channel.
    let id: string | undefined;
    for (let i = 0; i < 50 && !id; i++) {
      await new Promise((r) => setTimeout(r, 100));
      id = (await prisma.question.findFirst({ where: { askedBy: 'agent:packer', prompt: 'How much does it weigh?', status: 'pending' } }))?.id;
    }
    expect(id).toBeDefined();
    const answered = await app.inject({ method: 'POST', url: `/api/questions/${id}/answer`, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, payload: { value: '42.5', channel: 'web' } });
    expect(answered.statusCode).toBe(200);
    const r = await asking;
    expect(r.body).toMatchObject({ question_id: id, status: 'answered', outcome: 'completed', value: '42.5', channel: 'web' });
  });

  it('question_status waits, reports pending when the wait ends, and expired after the deadline', async () => {
    const t = await token(`mcp-status-${stamp}@example.test`, 'contributor');
    const asked = await call(t, 'ask_human', { prompt: 'Go ahead?', input: 'confirm', risk: 'low', confirm_label: 'Go', deny_label: 'Stop', wait_s: 1 });
    expect(asked.body).toMatchObject({ status: 'pending', hint: expect.stringMatching(/question_status/) });
    const id = (asked.body as { question_id: string }).question_id;
    expect((await call(t, 'question_status', { question_id: id })).body).toMatchObject({ status: 'pending' });
    await app.get(PrismaService).question.updateMany({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call(t, 'question_status', { question_id: id, wait_s: 5 })).body).toMatchObject({ status: 'expired' });
    expect((await call(t, 'question_status', { question_id: id, wait_s: 301 })).body).toMatch(/Invalid arguments/);
  });

  it('inbox_answer answers a free-standing question by id, with values for multi_choice', async () => {
    const t = await token(`mcp-answer-${stamp}@example.test`, 'contributor');
    const asked = await call(t, 'ask_human', { prompt: 'Which sides?', input: 'multi_choice', options: ['A', 'B', 'C'], constraints: { max_selections: 2 } });
    const id = (asked.body as { question_id: string }).question_id;
    expect((await call(t, 'inbox_answer', { question_id: id, outcome: 'completed', values: ['A', 'B', 'C'] })).body).toMatch(/Choose between 1 and 2/);
    expect((await call(t, 'inbox_answer', { outcome: 'completed' })).isError).toBe(true);
    const r = await call(t, 'inbox_answer', { question_id: id, outcome: 'completed', values: ['A', 'C'] });
    expect(r.body).toMatchObject({ status: 'answered', values: ['A', 'C'], channel: 'mcp' });
    expect((await call(t, 'question_status', { question_id: id })).body).toMatchObject({ status: 'answered', values: ['A', 'C'] });
  });

  it('browser_request_human sends the typed contract to the fabric in snake_case', async () => {
    const t = await token(`mcp-handoff-${stamp}@example.test`, 'contributor');
    const fabric = app.get(FabricClient);
    const bodies: Record<string, unknown>[] = [];
    const spy = jest.spyOn(fabric, 'request').mockImplementation((async (method: string, path: string, opts: { body?: Record<string, unknown> } = {}) => {
      if (method === 'POST' && path === '/v1/sessions') return { id: '00000000-0000-4000-8000-0000000000aa' };
      if (method === 'POST' && path.endsWith('/handoffs')) {
        bodies.push(opts.body!);
        return { handoff: { id: randomUUID(), viewer_url: 'https://viewer.example.test/x', page: { title: 'Shop' } } };
      }
      if (method === 'DELETE') return undefined;
      throw new Error(`unexpected ${method} ${path}`);
    }) as never);
    try {
      const open = await call(t, 'browser_open', { goal: 'Pack an order' });
      const session = (open.body as { session_id: string }).session_id;
      const multi = await call(t, 'browser_request_human', {
        session_id: session,
        kind: 'other',
        prompt: 'Which items?',
        input: 'multi_choice',
        options: [{ id: 'a', label: 'Apples', description: 'Red ones' }, 'Pears'],
        constraints: { min_selections: 1, max_selections: 2 },
        timeout_s: 600,
      });
      expect(multi.isError).toBe(false);
      expect(bodies[0]).toEqual({
        kind: 'other',
        prompt: 'Which items?',
        input: 'multi_choice',
        choices: [{ id: 'a', label: 'Apples', description: 'Red ones' }, 'Pears'],
        constraints: { min_selections: 1, max_selections: 2 },
        timeout_ms: 600_000,
      });
      await call(t, 'browser_close', { session_id: session });

      const second = (await call(t, 'browser_open', { goal: 'Pay' })).body as { session_id: string };
      await call(t, 'browser_request_human', { session_id: second.session_id, kind: 'confirmation', prompt: 'Pay 20?', input: 'confirm', confirm_label: 'Pay', deny_label: 'Not now', risk: 'high' });
      expect(bodies[1]).toEqual({ kind: 'confirmation', prompt: 'Pay 20?', input: 'confirm', choices: [], confirm_label: 'Pay', deny_label: 'Not now', risk: 'high' });
      await call(t, 'browser_close', { session_id: second.session_id });

      const third = (await call(t, 'browser_open', { goal: 'Weigh' })).body as { session_id: string };
      await call(t, 'browser_request_human', { session_id: third.session_id, kind: 'other', prompt: 'Weight?', input: 'number', constraints: { min: 0, step: 0.1, unit: 'kg' } });
      expect(bodies[2]).toMatchObject({ input: 'number', constraints: { min: 0, step: 0.1, unit: 'kg' } });
      // The question is mirrored in the broker with its contract.
      const qs = await app.inject({ method: 'GET', url: '/api/questions?status=pending', headers: { authorization: `Bearer ${t}` } });
      expect(qs.json().data).toEqual(expect.arrayContaining([expect.objectContaining({ input: 'number', constraints: { min: 0, step: 0.1, unit: 'kg' }, browserBound: true })]));
      // An invalid question never reaches the fabric.
      const bad = await call(t, 'browser_request_human', { session_id: third.session_id, kind: 'other', prompt: 'Pick', input: 'choice' });
      expect(bad.body).toMatch(/needs 1-10 options/);
      expect(bodies).toHaveLength(3);
      await call(t, 'browser_close', { session_id: third.session_id });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('MCP agent policies (#409)', () => {
  const POLICY_TOOLS = ['policies_list', 'policy_get', 'policy_create', 'policy_update', 'policy_set_default', 'policies_export', 'policies_import'];

  it('lists the policy tools, marks the reads read-only and says what null and tiers mean', async () => {
    const t = await token(`mcp-pol-list-${stamp}@example.test`, 'contributor');
    const list = await rpc(t, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = list.json.result.tools as { name: string; description: string; annotations: { readOnlyHint: boolean }; inputSchema: { properties: Record<string, unknown> } }[];
    for (const n of POLICY_TOOLS) expect(tools.map((x) => x.name)).toContain(n);
    for (const n of ['policies_list', 'policy_get', 'policies_export']) expect(tools.find((x) => x.name === n)!.annotations.readOnlyHint).toBe(true);
    for (const n of ['policy_create', 'policy_update', 'policy_set_default', 'policies_import']) expect(tools.find((x) => x.name === n)!.annotations.readOnlyHint).toBe(false);
    // The descriptions teach the two rules an agent must know.
    for (const n of ['policies_list', 'policy_get', 'policy_create']) {
      const d = tools.find((x) => x.name === n)!.description;
      expect(d).toMatch(/`null` means unlimited/);
      expect(d).toMatch(/tiers, not model ids/);
    }
    // The spec input is the policy schema, with its field descriptions.
    const create = tools.find((x) => x.name === 'policy_create')!;
    expect(JSON.stringify(create.inputSchema)).toMatch(/Most browser actions a run may take/);
    // policy_id on the delegating tools.
    for (const n of ['run_goal', 'task_create', 'task_update', 'task_run', 'schedule_create']) expect(Object.keys(tools.find((x) => x.name === n)!.inputSchema.properties)).toContain('policy_id');
  });

  it('creates, reads, updates, defaults, exports and imports a policy', async () => {
    const t = await token(`mcp-pol-${stamp}@example.test`, 'contributor');
    const listed = (await call(t, 'policies_list', {})).body as unknown as { id: string; name: string; builtin: boolean; tiers: string; hasNoHardStop: boolean; budget: unknown }[];
    expect(listed.map((p) => p.id)).toEqual(expect.arrayContaining(['builtin:economy', 'builtin:balanced', 'builtin:thorough', 'builtin:unlimited']));
    const unlimited = listed.find((p) => p.id === 'builtin:unlimited')!;
    expect(unlimited).toMatchObject({ builtin: true, hasNoHardStop: true });
    expect(listed.find((p) => p.id === 'builtin:balanced')!.tiers).toMatch(/ -> /);

    const base = (await call(t, 'policy_get', { policy_id: 'builtin:balanced' })).body as unknown as { spec: Record<string, unknown> & { budget: Record<string, unknown> } };
    const spec = { ...base.spec, budget: { ...base.spec.budget, maxActions: 40, maxCostUsd: null } };
    const created = await call(t, 'policy_create', { name: `Mcp policy ${stamp}`, description: 'Made by an agent', spec });
    expect(created.isError).toBe(false);
    const policy = created.body as unknown as { id: string; version: number; spec: { budget: { maxActions: number; maxCostUsd: number | null } } };
    expect(policy.spec.budget).toMatchObject({ maxActions: 40, maxCostUsd: null });

    // An invalid spec is refused with the console's own message.
    const bad = await call(t, 'policy_create', { name: 'Bad', spec: { ...spec, budget: { ...spec.budget, maxActions: 0 } } });
    expect(bad.isError).toBe(true);

    const updated = await call(t, 'policy_update', { policy_id: policy.id, name: `Mcp policy ${stamp} v2`, version: policy.version });
    expect(updated.body).toMatchObject({ name: `Mcp policy ${stamp} v2`, version: policy.version + 1 });
    const stale = await call(t, 'policy_update', { policy_id: policy.id, name: 'Stale', version: policy.version });
    expect(stale.isError).toBe(true);
    expect(stale.body).toMatch(/^412/);

    expect((await call(t, 'policy_set_default', { policy_id: policy.id })).body).toMatchObject({ policyId: policy.id, explicit: true });
    expect(((await call(t, 'policies_list', {})).body as unknown as { id: string; isDefault: boolean }[]).find((p) => p.id === policy.id)!.isDefault).toBe(true);
    expect((await call(t, 'policy_set_default', { policy_id: null })).body).toMatchObject({ policyId: 'builtin:balanced', explicit: false });

    // Export, drop pins, import with each conflict mode.
    const file = (await call(t, 'policies_export', { ids: policy.id, include_pins: false })).body as unknown as { kind: string; policies: { name: string }[] };
    expect(file).toMatchObject({ kind: 'hexactra.agent-policies', policies: [{ name: `Mcp policy ${stamp} v2` }] });
    const renamed = (await call(t, 'policies_import', { file })).body as unknown as { created: { name: string; renamedFrom: string | null }[] };
    expect(renamed.created[0]).toMatchObject({ name: `Mcp policy ${stamp} v2 (2)`, renamedFrom: `Mcp policy ${stamp} v2` });
    expect((await call(t, 'policies_import', { file, on_conflict: 'skip' })).body).toMatchObject({ skipped: [{ name: `Mcp policy ${stamp} v2` }] });
    expect((await call(t, 'policies_import', { file, on_conflict: 'replace' })).body).toMatchObject({ replaced: [{ name: `Mcp policy ${stamp} v2` }] });
  });

  it('refuses the write tools to a read-only token and still reads', async () => {
    const t = await token(`mcp-pol-viewer-${stamp}@example.test`, 'viewer');
    expect((await call(t, 'policies_list', {})).isError).toBe(false);
    expect((await call(t, 'policy_get', { policy_id: 'builtin:thorough' })).isError).toBe(false);
    expect((await call(t, 'policies_export', {})).isError).toBe(false);
    const file = { kind: 'hexactra.agent-policies', formatVersion: 1, exportedAt: new Date().toISOString(), policies: [] };
    const writes: [string, Record<string, unknown>][] = [
      ['policy_create', { name: 'No', spec: ((await call(t, 'policy_get', { policy_id: 'builtin:balanced' })).body as unknown as { spec: unknown }).spec }],
      ['policy_update', { policy_id: 'builtin:balanced', name: 'No' }],
      ['policy_set_default', { policy_id: 'builtin:economy' }],
      ['policies_import', { file }],
    ];
    for (const [name, args] of writes) {
      const r = await call(t, name, args);
      expect([name, r.isError]).toEqual([name, true]);
      expect(r.body).toMatch(/^403/);
    }
  });

  it('passes policy_id to runs, tasks and schedules', async () => {
    const t = await token(`mcp-pol-run-${stamp}@example.test`, 'contributor');
    const prisma = app.get(PrismaService);
    const policy = (await call(t, 'policy_create', { name: `Run policy ${stamp}`, spec: ((await call(t, 'policy_get', { policy_id: 'builtin:economy' })).body as unknown as { spec: unknown }).spec })).body as unknown as { id: string };

    const run = (await call(t, 'run_goal', { goal: 'Find a fare', policy_id: policy.id })).body as unknown as { id: string };
    const row = await prisma.run.findFirstOrThrow({ where: { id: run.id } });
    expect(row).toMatchObject({ policyRef: policy.id, policySource: 'run' });
    const withBuiltin = (await call(t, 'run_goal', { goal: 'Find another', policy_id: 'builtin:thorough' })).body as unknown as { id: string };
    expect((await prisma.run.findFirstOrThrow({ where: { id: withBuiltin.id } })).policyRef).toBe('builtin:thorough');
    expect((await call(t, 'run_goal', { goal: 'x', policy_id: 'nope' })).body).toMatch(/Invalid arguments/);
    // The status tool returns the run with its policy fields as the API reports them.
    expect((await call(t, 'run_status', { run_id: run.id })).body).toHaveProperty('policy');
    expect((await call(t, 'runs_list', {})).body).toEqual(expect.arrayContaining([expect.objectContaining({ id: run.id })]));

    const task = (await call(t, 'task_create', { name: `Policy task ${stamp}`, goal: 'g', policy_id: policy.id })).body as unknown as { id: string; policyId: string };
    expect(task.policyId).toBe(policy.id);
    expect((await call(t, 'task_update', { task_id: task.id, policy_id: 'builtin:thorough' })).body).toMatchObject({ policyId: 'builtin:thorough' });
    expect((await call(t, 'task_update', { task_id: task.id, policy_id: null })).body).toMatchObject({ policyId: null });
    const taskRun = (await call(t, 'task_run', { task_id: task.id, policy_id: 'builtin:economy' })).body as unknown as { id: string };
    expect((await prisma.run.findFirstOrThrow({ where: { id: taskRun.id } }))).toMatchObject({ policyRef: 'builtin:economy', policySource: 'run' });
    const schedule = (await call(t, 'schedule_create', { task_id: task.id, cron: '0 9 * * 1-5', policy_id: policy.id })).body as unknown as { policyId: string };
    expect(schedule.policyId).toBe(policy.id);
  });
});
