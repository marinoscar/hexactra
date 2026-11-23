// E46.9 (#783): the bridge to the harness. Every call goes through executeTool (the wrapper's observer sees each one), a tool the run is not
// offered is a refusal, and the replay phase stops at Stop and hands over on a mismatch.
import { z } from 'zod';
import { defineRunnerTool, type HarnessMemory, type RunContext } from '@marinoscar/hexactra-agent';
import { fakeRun, textProfile } from '@marinoscar/hexactra-agent/testing';

import { harnessProbe, harnessToolInvoker, handoverNote, replayPhase, watchCalls, type ReplayMemory } from '../src/harness';
import { aVersion, call, fakePorts, lit } from '../src/testing';

type Ctx = RunContext<HarnessMemory, Record<string, never>>;
const visit = defineRunnerTool({
  name: 'visit',
  group: 'test',
  family: 'browser',
  description: 'Visit.',
  parameters: z.object({ url: z.string() }),
  execute: async (ctx: Ctx, { url }) => {
    await ctx.record('action', 'visit', { url }, true, 'there', Date.now(), undefined, { url, contentHash: 'h1' });
    return `at ${url}`;
  },
});

function setup() {
  const run = fakeRun();
  const profile = textProfile<Ctx>([visit as never]);
  const { observer, watch } = watchCalls();
  run.ctx.ports.observer = observer;
  const ports = { ...fakePorts(), tools: harnessToolInvoker(run.ctx as never, profile as never, watch), probe: harnessProbe(async () => null, watch) };
  return { run, profile, watch, ports };
}
const mem = (): ReplayMemory => ({ version: 'v1', done: [], intent: null, handedOver: false });

describe('the harness bridge', () => {
  it('invokes through executeTool: a step row is recorded and the observer saw the call', async () => {
    const { run, ports, watch } = setup();
    const r = await ports.tools.invoke({ tool: 'visit', args: { url: 'https://example.com/' }, step: 's1', commitClass: false });
    expect(r).toMatchObject({ ok: true, text: 'at https://example.com/', refused: false, stopped: false });
    expect(run.store.rows()).toHaveLength(1);
    expect(watch.last?.tool).toBe('visit');
    expect(await ports.probe.viewDigest()).toBe('h1');
  });

  it('a tool the run is not offered is a refusal, and bad arguments fail without a call', async () => {
    const { ports, run } = setup();
    expect((await ports.tools.invoke({ tool: 'teleport', args: {}, step: 's1', commitClass: false })).refused).toBe(true);
    expect((await ports.tools.invoke({ tool: 'visit', args: { url: 3 }, step: 's1', commitClass: false })).ok).toBe(false);
    expect(run.store.rows()).toHaveLength(0);
  });

  it('the replay phase completes a procedure and closes the run', async () => {
    const { run, ports } = setup();
    const memory = mem();
    const r = await replayPhase({ ctx: run.ctx as never, version: aVersion([call('c1', 'visit', { url: lit('https://example.com/') })]), inputs: {}, ports, memory, save: async () => undefined });
    expect(r.kind).toBe('finished');
    expect(memory.done).toEqual(['c1']);
  });

  it('Stop before a step: nothing runs', async () => {
    const { run, ports } = setup();
    run.control.requested = true;
    const r = await replayPhase({ ctx: run.ctx as never, version: aVersion([call('c1', 'visit', { url: lit('https://example.com/') })]), inputs: {}, ports, memory: mem(), save: async () => undefined });
    expect(r.kind).toBe('outcome');
    expect(run.store.rows().filter((x) => x.kind === 'action')).toHaveLength(0);
  });

  it('a mismatch hands over with one note in the log, and marks the run handed over', async () => {
    const { run, ports } = setup();
    const memory = mem();
    const r = await replayPhase({ ctx: run.ctx as never, version: aVersion([call('c1', 'visit', { url: lit('https://example.com/') }), call('c2', 'teleport')]), inputs: {}, ports, memory, save: async () => undefined });
    expect(r.kind).toBe('handover');
    expect(memory.handedOver).toBe(true);
    expect(run.ctx.memory.log.at(-1)).toBe('A saved procedure did steps 1 to 1 without the model. Step 2 did not match: a gate refused it. Look at the page and continue toward the goal.');
  });

  it('the note never carries page text, only what the checks compare', () => {
    expect(handoverNote({ status: 'failed_check', steps: [], outputs: {}, resume: { step: 's1', expected: { host: 'a.example', path: '/x' }, observed: { host: 'a.example', path: '/y' } }, results: { s0: { text: 'SECRET PAGE TEXT', ok: true } }, judgeCalls: 0, toolCalls: 0 })).not.toContain('SECRET');
  });
});
