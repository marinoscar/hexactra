// E46.22 (#796): a procedure called as a tool inside a run. Every call goes through executeTool (step rows, the gates), a gate's refusal stops
// the walk, depth 2 is refused, parameters are bound from the call and a sensitive one only from the run's own inputs.
import { z } from 'zod';
import { defineRunnerTool, type Gate, type HarnessMemory, type RunContext } from '@marinoscar/hexactra-agent';
import { fakeRun, textProfile } from '@marinoscar/hexactra-agent/testing';

import { bindParameters, harnessToolInvoker, insideSubProcedure, runSubProcedure, watchCalls } from '../src/harness';
import type { ProcedureVersion } from '../src/schema';
import { aVersion, call, fakePorts, lit, param } from '../src/testing';

type Ctx = RunContext<HarnessMemory, Record<string, never>>;
const visit = defineRunnerTool({
  name: 'visit',
  group: 'test',
  family: 'browser',
  description: 'Visit.',
  parameters: z.object({ url: z.string() }),
  gated: { site: (_ctx: Ctx, a: { url: string }) => a.url },
  execute: async (ctx: Ctx, { url }) => {
    await ctx.record('action', 'visit', { url }, true, 'there', Date.now());
    return `at ${url}`;
  },
});
const siteGate: Gate<Ctx> = { name: 'site', check: async (_c, url) => (String(url).includes('blocked') ? { kind: 'refuse', text: 'not an allowed site' } : { kind: 'allow' }) };

function setup(extra: unknown[] = []) {
  const run = fakeRun();
  const profile = textProfile<Ctx>([visit as never, ...(extra as never[])], [siteGate as never]);
  const { observer, watch } = watchCalls();
  run.ctx.ports.observer = observer;
  const ports = { ...fakePorts(), tools: harnessToolInvoker(run.ctx as never, profile as never, watch) };
  return { run, profile, ports };
}
const withParams = (v: ProcedureVersion): ProcedureVersion => ({
  ...v,
  parameters: [
    { id: 'p:where', name: 'Where', type: 'string', sensitive: false, required: true },
    { id: 'p:pin', name: 'PIN', type: 'string', sensitive: true, required: false },
  ],
});

describe('runSubProcedure', () => {
  it('walks the procedure through executeTool with the parameters bound from the call', async () => {
    const { run, ports } = setup();
    const version = withParams(aVersion([call('c1', 'visit', { url: param('p:where') })], { state: 'active' }));
    const r = await runSubProcedure({ ctx: run.ctx as never, version, given: { where: 'https://example.com/' }, ports, goal: 'Go' });
    expect(r.ok).toBe(true);
    expect(run.store.rows().filter((x) => x.kind === 'action').map((x) => x.args)).toEqual([{ url: 'https://example.com/' }]);
  });

  it('respects the gates: a refusal stops the walk and nothing ran', async () => {
    const { run, ports } = setup();
    const r = await runSubProcedure({ ctx: run.ctx as never, version: aVersion([call('c1', 'visit', { url: lit('https://blocked.example/') }), call('c2', 'visit', { url: lit('https://example.com/') })]), given: {}, ports, goal: 'Go' });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('a gate refused it');
    expect(run.store.rows().filter((x) => x.kind === 'action' && x.ok)).toHaveLength(0);
  });

  it('refuses depth 2: a sub-procedure that calls run_procedure again gets a refusal and the inner walk never starts', async () => {
    const inner = aVersion([call('i1', 'visit', { url: lit('https://example.com/inner') })]);
    let innerText = '';
    const runProcedure = defineRunnerTool({
      name: 'run_procedure',
      group: 'test',
      description: 'Run a procedure.',
      parameters: z.object({}),
      execute: async (ctx: Ctx) => {
        innerText = (await runSubProcedure({ ctx: ctx as never, version: inner, given: {}, ports: s.ports, goal: 'Inner' })).text;
        return innerText;
      },
    });
    const s = setup([runProcedure]);
    expect(insideSubProcedure(s.run.ctx)).toBe(false);
    const r = await runSubProcedure({ ctx: s.run.ctx as never, version: aVersion([call('c1', 'run_procedure', {}), call('c2', 'visit', { url: lit('https://example.com/after') })]), given: {}, ports: s.ports, goal: 'Outer' });
    expect(innerText).toContain('one level only');
    expect(r.ok).toBe(true);
    expect(s.run.store.rows().filter((x) => x.kind === 'action').map((x) => (x.args as { url: string }).url)).toEqual(['https://example.com/after']);
    expect(insideSubProcedure(s.run.ctx)).toBe(false);
  });

  it('Stop before a step: nothing runs', async () => {
    const { run, ports } = setup();
    run.control.requested = true;
    const r = await runSubProcedure({ ctx: run.ctx as never, version: aVersion([call('c1', 'visit', { url: lit('https://example.com/') })]), given: {}, ports, goal: 'Go' });
    expect(r.ok).toBe(false);
    expect(run.store.rows().filter((x) => x.kind === 'action')).toHaveLength(0);
  });

  it('a missing required parameter or a sensitive value from the call is refused before any step', async () => {
    const { run, ports } = setup();
    const version = withParams(aVersion([call('c1', 'visit', { url: param('p:where') })]));
    expect((await runSubProcedure({ ctx: run.ctx as never, version, given: {}, ports, goal: 'Go' })).text).toContain('needs: Where');
    expect((await runSubProcedure({ ctx: run.ctx as never, version, given: { where: 'x', PIN: '1234' }, ports, goal: 'Go' })).text).toContain('Never pass a sensitive value');
    expect(run.store.rows()).toHaveLength(0);
  });
});

describe('bindParameters', () => {
  it('binds by name or key, case-insensitive; a sensitive one only from the trusted inputs', () => {
    const v = withParams(aVersion([call('c1', 'visit', { url: lit('x') })]));
    expect(bindParameters(v, { WHERE: 'a' }, { pin: '9' })).toEqual({ inputs: { 'p:where': 'a', 'p:pin': '9' }, missing: [], refused: [] });
    expect(bindParameters(v, { 'p:where': 'b', pin: '1' })).toEqual({ inputs: { 'p:where': 'b' }, missing: [], refused: ['PIN'] });
    expect(bindParameters(v, {})).toEqual({ inputs: {}, missing: ['Where'], refused: [] });
  });
});
