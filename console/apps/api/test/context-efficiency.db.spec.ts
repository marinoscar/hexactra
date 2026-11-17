// Context efficiency (#406) end to end: the policy's `context` knobs reach the
// model request (chunk size, observation size, screenshot window), the
// instructions and tool definitions are the same for every run, and Balanced
// sends fewer input tokens than the old fixed settings on the same scripted run.
import { createHash } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import type { FabricClient } from '../src/fabric/fabric.client';
import { GoalRunnerService } from '../src/runner/goal-runner.service';
import { TasksService } from '../src/tasks/tasks.service';
import { balancedSpec } from '../src/policies/builtin-policies';
import type { AgentPolicySpec } from '../src/policies/agent-policy.schema';
import { estimateTokens } from '../src/runner/context-settings';

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

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return me.json<{ data: { id: string } }>().data.id;
}

/** An in-memory fabric whose page is large: long text, many elements, a distinct screenshot per request. */
function pageFabric() {
  const actions: Record<string, unknown>[] = [];
  let shots = 0;
  const request = jest.fn(async (method: string, path: string, opts: { body?: Record<string, unknown> } = {}) => {
    if (method === 'POST' && path === '/v1/sessions') return { id: '00000000-0000-4000-8000-00000000000a' };
    if (method === 'DELETE') return undefined;
    if (method === 'POST' && path.endsWith('/actions')) {
      const action = opts.body!.action as Record<string, unknown>;
      actions.push(action);
      if (action.type === 'screenshot') return { id: 'op', state: 'succeeded', result: { mime: 'image/jpeg', data: Buffer.from(`shot-${(shots += 1)}`).toString('base64'), width: 800, height: 600, url: 'https://shop.example.test/', title: 'Shop', marks: [] } };
      if (action.type === 'text') return { id: 'op', state: 'succeeded', result: { text: 'lorem ipsum '.repeat(2000) } };
      if (action.type === 'evaluate') return { id: 'op', state: 'succeeded', result: { type: 'string', value: 'x'.repeat(30_000) } };
      if (action.type === 'elements') {
        const max = Number(action.max_elements ?? 80);
        return { id: 'op', state: 'succeeded', result: { elements: Array.from({ length: max }, (_, i) => ({ selector: `#el-${i}`, tag: 'button', role: 'button', text: `Option number ${i}` })) } };
      }
      return { id: 'op', state: 'succeeded', result: {} };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { client: { request, config: async () => ({ url: 'http://f', token: 't' }) } as unknown as FabricClient, actions };
}

type Call = [name: string, args: Record<string, unknown>];
type Req = { tools: { tool: { name: string; description?: string; parameters?: unknown }; execute: (a: unknown, c: unknown) => Promise<unknown> }[]; onStep?: (s: unknown) => void; input: unknown; instructions: string; maxSteps: number };

const IMAGE_TOKENS = 850;
const textOf = (input: unknown): { chars: number; images: string[] } => {
  if (typeof input === 'string') return { chars: input.length, images: [] };
  let chars = 0;
  const images: string[] = [];
  for (const m of input as { content: { type: string; text?: string; url?: string }[] }[]) {
    for (const p of m.content) {
      if (p.type === 'text') chars += p.text!.length;
      else images.push(p.url!);
    }
  }
  return { chars, images };
};

/**
 * A scripted model. Every runTools call performs at most `maxSteps` of the
 * remaining script. Each call's reported input tokens are the size of what a
 * real provider would be sent: instructions, tool definitions, the round input
 * and every earlier tool output of the chunk (characters / 4), plus a fixed
 * cost per image.
 */
function chunkModel(script: Call[]) {
  const requests: { maxSteps: number; input: unknown; instructions: string; tools: Req['tools'] }[] = [];
  const perCall: number[] = [];
  const outputs: string[] = [];
  const runTools = jest.fn(async (req: Req) => {
    requests.push({ maxSteps: req.maxSteps, input: req.input, instructions: req.instructions, tools: req.tools });
    const { chars, images } = textOf(req.input);
    let context = req.instructions.length + JSON.stringify(req.tools.map((t) => t.tool)).length + chars;
    let step = 0;
    while (script.length && step < req.maxSteps) {
      const [name, args] = script.shift()!;
      const out = String(await req.tools.find((x) => x.tool.name === name)!.execute(args, { userId: 'u' }));
      outputs.push(out);
      const inputTokens = estimateTokens(context) + images.length * IMAGE_TOKENS;
      perCall.push(inputTokens);
      req.onStep?.({ step: ++step, response: { usage: { inputTokens, outputTokens: 20 } }, calls: [] });
      context += out.length;
    }
    return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
  });
  return { ai: { forUser: () => ({ runTools }) } as unknown as AiService, requests, perCall, outputs };
}

const snapshotOf = (spec: AgentPolicySpec) => ({ schemaVersion: 1, ref: 'builtin:balanced', name: 'Balanced', version: 1, builtin: true, source: 'run', spec, tiers: null, takenAt: new Date().toISOString() });
const withContext = (c: Partial<AgentPolicySpec['context']>): AgentPolicySpec => {
  const s = balancedSpec();
  return { ...s, context: { ...s.context, ...c } };
};

async function newRun(label: string, spec: AgentPolicySpec, goal = 'Browse the shop') {
  const userId = await login(`ctx-${label}-${stamp}@example.test`);
  const prisma = app.get(PrismaService);
  const db = prisma.forUser({ userId });
  const run = await db.run.create({ data: { userId, goal, policyRef: 'builtin:balanced', policySource: 'run', policyVersion: 1, policySnapshot: snapshotOf(spec) as never } });
  return { userId, prisma, db, run };
}

/** The same 30 browser actions, then finish. */
function thirtyActions(): Call[] {
  const kinds: Call[] = [
    ['read_text', { selector: null }],
    ['observe_elements', {}],
    ['run_javascript', { script: 'document.title', reason: 'read the title' }],
    ['click', { selector: '#el-1', reason: 'open it' }],
    ['scroll', { dy: 400 }],
  ];
  const out: Call[] = Array.from({ length: 30 }, (_, i) => kinds[i % kinds.length]!);
  out.push(['finish', { success: true, result: 'Done' }]);
  return out;
}

describe('the context knobs reach the model request (#406)', () => {
  it('callsPerChunk becomes maxSteps, and the run continues across chunks with its log intact', async () => {
    const { userId, prisma, db, run } = await newRun('chunk', withContext({ callsPerChunk: 5 }));
    const fabric = pageFabric();
    const script = thirtyActions().slice(0, 12);
    script.push(['finish', { success: true, result: 'Done' }]);
    const m = chunkModel(script);
    const runner = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, m.ai);
    expect(await runner.advance(run.id, userId, null)).toBe('succeeded');
    expect(m.requests.map((r) => r.maxSteps)).toEqual([5, 5, 5]);
    // The second chunk's input carries the first chunk's log.
    const second = textOf(m.requests[1]!.input);
    expect(second.chars).toBeGreaterThan(0);
    const secondText = JSON.stringify(m.requests[1]!.input);
    expect(secondText).toContain('1. text ');
    expect(secondText).toContain('5. scroll');
    expect((await db.run.findFirstOrThrow({ where: { id: run.id } })).stepCount).toBe(13);
  });

  it('observationChars truncates read_text, run_javascript and observe_elements, and scales max_elements', async () => {
    const { userId, run } = await newRun('obs', withContext({ observationChars: 600 }));
    const fabric = pageFabric();
    const m = chunkModel([['read_text', { selector: null }], ['run_javascript', { script: '1', reason: 'r' }], ['observe_elements', {}], ['finish', { success: true, result: 'ok' }]]);
    await new GoalRunnerService(app.get(PrismaService), app.get(TasksService), fabric.client, m.ai).advance(run.id, userId, null);
    // 600 characters and the ellipsis.
    for (const out of m.outputs.slice(0, 3)) expect(out.length).toBeLessThanOrEqual(601);
    expect(fabric.actions.find((a) => a.type === 'text')).toMatchObject({ max_chars: 600 });
    expect(fabric.actions.find((a) => a.type === 'elements')).toMatchObject({ max_elements: 8 });
  });

  it('screenshotsKept 2 sends two images, 1 sends one, 0 turns vision off; no image is persisted', async () => {
    const counts: Record<number, number[]> = {};
    for (const kept of [0, 1, 2]) {
      const { userId, prisma, db, run } = await newRun(`kept${kept}`, withContext({ screenshotsKept: kept, callsPerChunk: 2, pruneBatch: 10 }));
      const fabric = pageFabric();
      const m = chunkModel([...Array.from({ length: 7 }, (): Call => ['scroll', { dy: 1 }]), ['finish', { success: true, result: 'ok' }]]);
      await new GoalRunnerService(prisma, app.get(TasksService), fabric.client, m.ai).advance(run.id, userId, null);
      counts[kept] = m.requests.map((r) => textOf(r.input).images.length);
      expect(fabric.actions.filter((a) => a.type === 'screenshot')).toHaveLength(kept === 0 ? 0 : m.requests.length);
      const stored = await db.run.findFirstOrThrow({ where: { id: run.id } });
      expect(JSON.stringify(stored.transcript)).not.toContain('data:image');
      if (kept > 0) expect((stored.transcript as { shots: string[] }).shots).toHaveLength(Math.min(kept, m.requests.length));
    }
    expect(counts[0]).toEqual([0, 0, 0, 0]);
    expect(counts[1]).toEqual([1, 1, 1, 1]);
    // Two images from the second chunk on; the older one stays while the window is stable.
    expect(counts[2]).toEqual([1, 2, 2, 2]);
  });

  it('puts the stable parts first and the budget status after the screenshots', async () => {
    const { userId, prisma, run } = await newRun('order', withContext({ screenshotsKept: 1 }), 'Find the thing');
    const m = chunkModel([['scroll', { dy: 1 }], ['finish', { success: true, result: 'ok' }]]);
    await new GoalRunnerService(prisma, app.get(TasksService), fabric(), m.ai).advance(run.id, userId, null);
    const parts = (m.requests[0]!.input as { content: { type: string; text?: string }[] }[])[0]!.content;
    expect(parts.map((p) => p.type)).toEqual(['text', 'image', 'text']);
    expect(parts[0]!.text).toMatch(/^Goal: Find the thing\n\nAllowed sites: any\./);
    expect(parts[0]!.text).not.toContain('Steps used');
    expect(parts[2]!.text).toMatch(/Attached: a screenshot[\s\S]*Steps used: 0 of 60\.$/);
  });
});

function fabric(): FabricClient {
  return pageFabric().client;
}

describe('a stable prompt prefix (#406)', () => {
  it('sends identical instructions and tool definitions for different goals and policies', async () => {
    const hashes: string[] = [];
    for (const [label, goal, spec] of [
      ['a', 'Find a flight to Place A', withContext({ callsPerChunk: 4 })],
      ['b', 'Compare prices of Product X on shop.example.test', withContext({ observationChars: 1000, screenshotsKept: 0, pruneBatch: 3 })],
    ] as const) {
      const { userId, prisma, run } = await newRun(`prefix-${label}`, spec, goal);
      const m = chunkModel([['finish', { success: true, result: 'ok' }]]);
      await new GoalRunnerService(prisma, app.get(TasksService), fabric(), m.ai).advance(run.id, userId, null);
      const r = m.requests[0]!;
      hashes.push(createHash('sha256').update(JSON.stringify({ instructions: r.instructions, tools: r.tools.map((t) => t.tool) })).digest('hex'));
    }
    expect(hashes[0]).toBe(hashes[1]);
  });
});

describe('measurement: the old fixed settings against Balanced (#406)', () => {
  it('uses fewer input tokens on the same 30-action run', async () => {
    const rows: { name: string; chunks: number; calls: number; tokens: number; status: string }[] = [];
    for (const [name, ctx] of [
      ['Old (20 calls, 6000 chars, 1 shot)', { callsPerChunk: 20, observationChars: 6000, screenshotsKept: 1, pruneBatch: 10 }],
      ['Balanced', balancedSpec().context],
    ] as const) {
      const { userId, prisma, db, run } = await newRun(`measure-${name.split(' ')[0]}`, withContext(ctx));
      const m = chunkModel(thirtyActions());
      await new GoalRunnerService(prisma, app.get(TasksService), pageFabric().client, m.ai).advance(run.id, userId, null);
      const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
      rows.push({ name, chunks: m.requests.length, calls: m.perCall.length, tokens: m.perCall.reduce((a, b) => a + b, 0), status: done.status });
      expect(done.inputTokens).toBe(rows[rows.length - 1]!.tokens);
    }
    const [old, balanced] = rows as [(typeof rows)[number], (typeof rows)[number]];
    expect(old.status).toBe('succeeded');
    expect(balanced.status).toBe('succeeded');
    expect(balanced.calls).toBe(old.calls);
    expect(balanced.tokens).toBeLessThan(old.tokens);
    const pct = Math.round((1 - balanced.tokens / old.tokens) * 100);
    // eslint-disable-next-line no-console
    console.log(['| Settings | Chunks | Model calls | Input tokens | Success |', '|---|---|---|---|---|', ...rows.map((r) => `| ${r.name} | ${r.chunks} | ${r.calls} | ${r.tokens} | ${r.status} |`), `Balanced saves ${pct}%`].join('\n'));
  });
});
