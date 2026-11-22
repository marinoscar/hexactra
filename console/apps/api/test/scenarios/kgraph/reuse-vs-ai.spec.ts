// The E46 phase-2 gate (#786): the fixture task (search mail → open its link → read the total → append a sheet row → send a summary) run
// AI only and in `reuse` mode, against a scripted model, a fake site and fake account tools, through the real harness loop and the real
// replay bridge. `reuse` must make fewer model calls and return the same outputs. Free and deterministic; part of `npm test`.
import { z } from 'zod';
import { defineRunnerTool, type HarnessMemory, type RunContext } from '@marinoscar/hexactra-agent';
import { runLoop } from '@marinoscar/hexactra-agent/engine';
import { fakeRun, ScriptedModel, textProfile } from '@marinoscar/hexactra-agent/testing';
import { compileTrace, noopTelemetry, type TraceEvent } from '@marinoscar/hexactra-kgraph';
import { harnessJudge, harnessProbe, harnessToolInvoker, replayPhase, watchCalls } from '@marinoscar/hexactra-kgraph/harness';
import { FakeClock, InMemoryProcedureStore, SequentialIds } from '@marinoscar/hexactra-kgraph/testing';

type Ctx = RunContext<HarnessMemory, Record<string, never>>;

/** The fake world: one mailbox, one report page, one sheet, one outbox. */
function world() {
  const sheet: string[][] = [];
  const outbox: { to: string[]; subject: string; body: string }[] = [];
  let at = 'https://reports.example.com/';
  const tools = [
    defineRunnerTool({ name: 'mail_search', group: 'accounts', family: 'accounts', description: 'Search mail.', parameters: z.object({ q: z.string() }), execute: async (ctx: Ctx, a) => (await ctx.record('action', 'mail_search', a, true, 'found 1', Date.now()), JSON.stringify({ items: [{ id: 'm1', link: 'https://reports.example.com/daily/1122', subject: 'daily numbers' }] })) }),
    defineRunnerTool({ name: 'navigate', group: 'browser', family: 'browser', description: 'Open a page.', parameters: z.object({ url: z.string() }), execute: async (ctx: Ctx, a) => ((at = a.url), await ctx.record('action', 'navigate', a, true, 'opened', Date.now(), undefined, { url: a.url, contentHash: 'page' }), `at ${a.url}`) }),
    defineRunnerTool({ name: 'read_text', group: 'browser', family: 'browser', description: 'Read text.', parameters: z.object({ selector: z.string() }), execute: async (ctx: Ctx, a) => (await ctx.record('action', 'read_text', a, true, 'read', Date.now()), at.endsWith('/1122') ? 'Total: 4,512.07' : '') }),
    defineRunnerTool({ name: 'sheet_append', group: 'accounts', family: 'accounts', description: 'Append a row.', parameters: z.object({ sheet: z.string(), values: z.array(z.string()) }), execute: async (ctx: Ctx, a) => (sheet.push(a.values), await ctx.record('action', 'sheet_append', { sheet: a.sheet }, true, 'appended', Date.now()), JSON.stringify({ appended: 1 })) }),
    defineRunnerTool({ name: 'mail_send', group: 'accounts', family: 'accounts', commits: true, description: 'Send mail.', parameters: z.object({ to: z.array(z.string()), subject: z.string(), body: z.string() }), execute: async (ctx: Ctx, a) => (outbox.push(a), await ctx.record('action', 'mail_send', { to: a.to }, true, 'sent', Date.now()), JSON.stringify({ id: 'sent-1' })) }),
    defineRunnerTool({ name: 'finish', group: 'control', description: 'Finish.', parameters: z.object({ success: z.boolean(), result: z.string() }), execute: async (ctx: Ctx, a) => ((ctx.state.finished = a), (ctx.state.stop = 'finish'), await ctx.record('finish', null, null, a.success, a.result, Date.now()), 'Finished.') }),
  ];
  return { tools, sheet, outbox };
}

const BODY = 'Today: 4,512.07';
/** What the model does AI only: one model round per step (a screenshot each time), then finish. */
const aiScript = [
  [['mail_search', { q: 'daily numbers' }]],
  [['navigate', { url: 'https://reports.example.com/daily/1122' }]],
  [['read_text', { selector: '#total' }]],
  [['sheet_append', { sheet: 'Numbers', values: ['4,512.07'] }]],
  [['mail_send', { to: ['finance@example.com'], subject: 'daily numbers', body: BODY }]],
  [['finish', { success: true, result: 'Sent.' }]],
] as [string, Record<string, unknown>][][];

const trace: TraceEvent[] = [
  { seq: 1, tool: 'mail_search', family: 'accounts', commits: false, ok: true, outcome: 'ran', bindings: { q: { kind: 'literal', value: 'daily numbers' } }, post: { resultShape: '{items:[{id:string,link:string,subject:string}]}' } },
  { seq: 2, tool: 'navigate', family: 'browser', commits: false, ok: true, outcome: 'ran', bindings: { url: { kind: 'output', seq: 1, path: 'items.0.link' } }, post: { host: 'reports.example.com', path: '/daily/1122' } },
  { seq: 3, tool: 'read_text', family: 'browser', commits: false, ok: true, outcome: 'ran', bindings: { selector: { kind: 'literal', value: '#total' } }, post: { host: 'reports.example.com', path: '/daily/1122' } },
  { seq: 4, tool: 'sheet_append', family: 'accounts', commits: false, ok: true, outcome: 'ran', bindings: { sheet: { kind: 'literal', value: 'Numbers' }, 'values.0': { kind: 'output', seq: 3, pattern: '\\d\\,\\d{3}\\.\\d{2}' } }, post: { resultShape: '{appended:number}' } },
  { seq: 5, tool: 'mail_send', family: 'accounts', commits: true, ok: true, outcome: 'ran', bindings: { 'to.0': { kind: 'literal', value: 'finance@example.com' }, subject: { kind: 'literal', value: 'daily numbers' }, body: { kind: 'model' } }, post: { resultShape: '{id:string}' } },
];

describe('the Knowledge Graph phase-2 gate: reuse vs AI only (#786)', () => {
  it('reuse makes fewer model calls and produces the same sheet row and the same mail', async () => {
    // AI only.
    const ai = world();
    const aiModel = new ScriptedModel(aiScript as never);
    const aiRun = fakeRun({ model: aiModel });
    expect(await runLoop(aiRun.ctx as never, textProfile<Ctx>(ai.tools as never) as never)).toBe('succeeded');
    const aiCalls = aiModel.requests.length;

    // Reuse: the procedure compiled from the AI run's trace, replayed through executeTool; the judge writes the mail body.
    const compiled = compileTrace({ procedure: 'p1', version: 'v1', number: 1, createdAt: '2026-11-22T00:00:00.000Z', sourceRun: 'r1', trace, tools: ai.tools.map((t) => ({ name: t.name, family: t.family ?? 'control', commits: t.commits === true })), parameters: [] });
    expect(compiled.status).toBe('candidate');
    const version = compiled.status === 'candidate' ? { ...compiled.version, state: 'active' as const } : null!;
    const re = world();
    const judgeModel = new ScriptedModel([[['answer', { body: BODY }]]] as never);
    const reRun = fakeRun({ model: judgeModel });
    const profile = textProfile<Ctx>(re.tools as never);
    const { observer, watch } = watchCalls();
    reRun.ctx.ports.observer = observer;
    const result = await replayPhase({
      ctx: reRun.ctx as never,
      version,
      inputs: {},
      ports: { store: new InMemoryProcedureStore(), tools: harnessToolInvoker(reRun.ctx as never, profile as never, watch), probe: harnessProbe(async () => 'https://reports.example.com/daily/1122', watch), judge: harnessJudge(reRun.ctx as never, reRun.ctx.ports.policy.routing.route('fast')), clock: new FakeClock(), ids: new SequentialIds(), telemetry: noopTelemetry },
      memory: { version: 'v1', done: [], intent: null, handedOver: false },
      save: async () => undefined,
    });
    expect(result.kind).toBe('finished');
    const reuseCalls = judgeModel.requests.length;

    expect(re.sheet).toEqual(ai.sheet);
    expect(re.outbox).toEqual(ai.outbox);
    expect(reuseCalls).toBeLessThan(aiCalls);
    // The numbers recorded on the phase epic.
    process.stdout.write(`kgraph gate: AI only ${aiCalls} model calls, reuse ${reuseCalls} (the judge); same outputs\n`);
    expect([aiCalls, reuseCalls]).toEqual([6, 1]);
  });
});
