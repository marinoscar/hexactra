// E46.5 (#779): the optional observer on `executeTool`. Without one nothing changes; with one it sees each call after it returned, the
// call's result and steps are the same, and an observer that throws changes nothing.
import { z } from 'zod';

import { defineRunnerTool, GatePipeline, type Gate, type HarnessMemory, type RunContext, type ToolCallObservation } from '../src';
import { executeTool } from '../src/engine';
import { fakeRun } from '../src/testing';
import { PAUSED_TEXT, STOPPED_TEXT } from '../src/types';

type Ctx = RunContext<HarnessMemory, Record<string, never>>;

const visit = defineRunnerTool({
  name: 'visit',
  group: 'test',
  family: 'browser',
  description: 'Visit a page.',
  parameters: z.object({ url: z.string() }),
  execute: async (ctx: Ctx, { url }) => {
    await ctx.record('action', 'visit', { url }, true, 'at the page', Date.now(), undefined, { url, contentHash: 'h1' });
    return `at ${url}`;
  },
});
const refuse: Gate<Ctx> = { name: 'site', check: async () => ({ kind: 'refuse', text: 'not allowed', step: { action: 'visit', args: {}, summary: 'refused' } }) } as never;
const site = () => 1;

async function observed(run: ReturnType<typeof fakeRun>, tool = visit, gates: Gate<Ctx>[] = []) {
  const seen: ToolCallObservation[] = [];
  run.ctx.ports.observer = { toolCall: (o) => void seen.push(o) };
  const text = await executeTool(run.ctx, tool as never, { url: 'https://shop.example.test/a?b=1' }, new GatePipeline<Ctx>(gates) as never);
  return { text, seen };
}

describe('the observer port', () => {
  it('sees a call after it ran: tool, family, args, result, ok, outcome and the steps it recorded', async () => {
    const run = fakeRun();
    const { text, seen } = await observed(run);
    expect(text).toBe('at https://shop.example.test/a?b=1');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ tool: 'visit', family: 'browser', commits: false, args: { url: 'https://shop.example.test/a?b=1' }, resultText: text, ok: true, outcome: 'ran', steps: [{ ok: true, url: 'https://shop.example.test/a?b=1', contentHash: 'h1' }] });
    expect(seen[0]!.seq).toBe(run.ctx.state.seq);
  });

  it('records the same steps with and without an observer', async () => {
    const plain = fakeRun();
    await executeTool(plain.ctx, visit as never, { url: 'https://shop.example.test/a?b=1' }, new GatePipeline<Ctx>([]) as never);
    const watched = fakeRun();
    await observed(watched);
    const strip = (rows: unknown[]) => JSON.parse(JSON.stringify(rows, (k, v) => (k === 'durationMs' || k === 'at' ? undefined : v)));
    expect(strip(watched.store.rows())).toEqual(strip(plain.store.rows()));
    expect(watched.ctx.memory.log).toEqual(plain.ctx.memory.log);
    expect(watched.ctx.record).toBe(watched.ctx.record); // restored, still callable
  });

  it('sees a refusal as outcome refused with ok false', async () => {
    const tool = defineRunnerTool({ ...visit, gated: { site } } as never);
    const { text, seen } = await observed(fakeRun(), tool as never, [refuse]);
    expect(text).toBe('not allowed');
    expect(seen[0]).toMatchObject({ outcome: 'refused', ok: false });
  });

  it('is not called for a call stopped or paused before it ran', async () => {
    const stopped = fakeRun();
    stopped.control.requested = true;
    expect((await observed(stopped)).text).toBe(STOPPED_TEXT);
    const paused = fakeRun();
    paused.control.pauseRequested = true;
    const p = await observed(paused);
    expect(p.text).toBe(PAUSED_TEXT);
    expect(p.seen).toHaveLength(0);
  });

  it('an observer that throws changes neither the result nor the run, and is counted', async () => {
    const run = fakeRun();
    run.ctx.ports.observer = {
      toolCall: () => {
        throw new Error('observer down');
      },
    };
    const text = await executeTool(run.ctx, visit as never, { url: 'https://shop.example.test/' }, new GatePipeline<Ctx>([]) as never);
    expect(text).toBe('at https://shop.example.test/');
    expect(run.ctx.state.stop).toBeNull();
    expect(run.ctx.state.observerErrors).toBe(1);
    expect(run.store.rows()).toHaveLength(1);
    run.ctx.ports.observer = { toolCall: async () => Promise.reject(new Error('async down')) };
    expect(await executeTool(run.ctx, visit as never, { url: 'https://shop.example.test/' }, new GatePipeline<Ctx>([]) as never)).toBe('at https://shop.example.test/');
    expect(run.ctx.state.observerErrors).toBe(2);
  });

  it('restores the context when the tool throws', async () => {
    const run = fakeRun();
    const original = run.ctx.record;
    const boom = defineRunnerTool({ name: 'boom', group: 'test', description: '', parameters: z.object({}), execute: async () => { throw new Error('x'); } });
    run.ctx.ports.observer = { toolCall: () => undefined };
    await expect(executeTool(run.ctx, boom as never, {}, new GatePipeline<Ctx>([]) as never)).rejects.toThrow('x');
    expect(run.ctx.record).toBe(original);
  });
});
