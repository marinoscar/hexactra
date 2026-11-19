// The fakes the database-backed runner specs share (E38.6): an in-memory fabric (sessions, actions, handoffs) behind the console's
// `FabricClient`, and a scripted `AiService` that plays back tool calls. They sit at the console's own seams (the fabric HTTP client and
// the AI service), so a spec runs the whole stack above them: the host, the harness and the browser layer. The scenario runner of the
// replay suite (`run-scenario.ts`) sits lower, on the harness ports, and needs neither a database nor these.
//
// The kit ships in `src/` and is compiled without jest's types, so a spec hands in its mock factory: `fakeFabric(jest.fn)`.
import { randomUUID } from 'node:crypto';

import type { AiService } from '@marinoscar/platform-api/ai';

import { FabricError, type FabricClient } from '../../src/fabric/fabric.client';

export type FabricRequest = (method: string, path: string, opts?: { body?: Record<string, unknown> }) => Promise<unknown>;

/** The fabric's real handoff view (crates/hexactra-core/src/remote.rs `HandoffView`). */
export interface FakeHandoff {
  id: string;
  status: string;
  input: string;
  kind: string;
  remember?: { label: string };
  response?: { outcome?: string; value?: string; value_withheld: boolean; remember?: boolean; channel?: string; by?: string; answered_at?: string };
}

/** An in-memory fabric: sessions, actions and handoffs. `mockFn` is the spec's `jest.fn`, so `request` is a mock a spec may inspect and replace. */
export function fakeFabric<R extends FabricRequest>(mockFn: (impl: FabricRequest) => R) {
  const actions: Record<string, unknown>[] = [];
  const handoffs = new Map<string, FakeHandoff>();
  const typed = new Set<string>();
  let ended = 0;
  // What the page says about a click target (#550): by selector, or by point as "x,y". The gate's reads go to `probes`, not `actions`.
  const targets = new Map<string, Record<string, unknown> | null>([['#pay', { tag: 'button', label: 'Pay', role: null }]]);
  const probes: Record<string, unknown>[] = [];
  const page = { url: 'https://bank.example.test/review' };
  const request = mockFn(async (method, path, opts = {}) => {
    if (method === 'POST' && path === '/v1/sessions') return { id: '00000000-0000-4000-8000-00000000000a' };
    if (method === 'DELETE' && path.startsWith('/v1/sessions/')) return void (ended += 1);
    if (method === 'POST' && path.endsWith('/actions')) {
      const action = opts.body!.action as Record<string, unknown>;
      if (action.type === 'evaluate' && String(action.script).startsWith('/* hexactra:describe-target */')) {
        probes.push(action);
        const where = JSON.parse(/const where = (.*);/.exec(String(action.script))![1]!) as { selector?: string; x?: number; y?: number };
        const key = where.selector ?? `${where.x},${where.y}`;
        return { id: 'op', state: 'succeeded', result: { type: 'object', value: targets.get(key) ?? null } };
      }
      actions.push(action);
      if (action.type === 'tabs') return { id: 'op', state: 'succeeded', result: { tabs: [{ id: 1, active: true, url: page.url, title: 'Review' }] } };
      if (action.type === 'navigate') return { id: 'op', state: 'succeeded', result: { url: action.url, title: 'Shop' } };
      if (action.type === 'elements') return { id: 'op', state: 'succeeded', result: { elements: [{ selector: '#buy', tag: 'button', text: 'Place order' }] } };
      if (action.type === 'type_secret') {
        // The fabric types the answer itself, once; the console only names the handoff.
        const h = handoffs.get(String(action.handoff_id));
        if (!h || (h.input !== 'secret' && h.input !== 'credentials') || h.status !== 'completed' || typed.has(h.id)) throw new FabricError('api', 'secret_unavailable', 409, 'secret_unavailable');
        typed.add(h.id);
        return { id: 'op', state: 'succeeded', result: {} };
      }
      return { id: 'op', state: 'succeeded', result: {} };
    }
    if (method === 'POST' && path.endsWith('/handoffs')) {
      // Unique per run of the suite: the question broker mirrors handoffs by id.
      const id = randomUUID();
      handoffs.set(id, { id, status: 'pending', input: String(opts.body!.input), kind: String(opts.body!.kind), ...(opts.body!.remember ? { remember: opts.body!.remember as { label: string } } : {}) });
      return { handoff: { id } };
    }
    if (method === 'GET' && path.startsWith('/v1/handoffs/')) return handoffs.get(path.split('/')[3]!);
    // The deprecated claim route returns the plaintext: the console must never call it.
    if (method === 'POST' && path.endsWith('/claim')) throw new Error('the console called the secret claim route');
    throw new Error(`unexpected ${method} ${path}`);
  });
  const claimed = () => (request as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(([, path]) => String(path).endsWith('/claim'));
  return { client: { request, config: async () => ({ url: 'http://f', token: 't' }) } as unknown as FabricClient, request, actions, handoffs, ended: () => ended, claimed, targets, probes, page };
}

export type ScriptedCall = [name: string, args: Record<string, unknown>];

interface ToolsRequest {
  tools: { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> }[];
  onStep?: (s: unknown) => void;
  input: string;
}
export type RunToolsFn = (req: ToolsRequest) => Promise<{ final: { outputText: string }; steps: unknown[]; stopReason: string }>;

/** A model that makes the scripted tool calls, one script per runTools call. `mockFn` is the spec's `jest.fn`. */
export function scriptedAi<R extends RunToolsFn>(
  mockFn: (impl: RunToolsFn) => R,
  scripts: ScriptedCall[][],
  served: { provider: string; model: string; cachedInputTokens?: number } | null = null,
  usage: { inputTokens: number; outputTokens: number } = { inputTokens: 10, outputTokens: 5 },
) {
  const outputs: string[] = [];
  const runTools = mockFn(async (req) => {
    const script = scripts.shift() ?? [];
    let step = 0;
    for (const [name, args] of script) {
      const t = req.tools.find((x) => x.tool.name === name)!;
      outputs.push(String(await t.execute(args, { userId: 'u' })));
      req.onStep?.({ step: ++step, response: { ...(served ? { provider: served.provider, model: served.model } : {}), usage: { ...usage, ...(served?.cachedInputTokens ? { cachedInputTokens: served.cachedInputTokens } : {}) } }, calls: [] });
    }
    return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
  });
  return { ai: { forUser: () => ({ runTools }) } as unknown as AiService, runTools, outputs };
}
