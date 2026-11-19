// A second, minimal host (E38.9): not the console, no browser, no database, no framework. It binds the ports to the package's fakes, defines two tools
// of its own and runs a scripted goal to completion through `createRunLoop`. This is the proof that the harness is embeddable.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { defineRunnerTool, noopTelemetry, type HarnessMemory, type Ports, type RunContext } from '../src';
import { createRunLoop } from '../src/engine';
import { FakeControl, FakeQuestions, FakeRunStore, ScriptedModel, fakePolicy, textProfile } from '../src/testing';

type Ctx = RunContext<HarnessMemory, { notes: string[] }>;

/** The host's own tool: it keeps notes, and records its step through the context like any tool. */
const note = defineRunnerTool({
  name: 'note',
  group: 'memory',
  description: 'Write a note.',
  parameters: z.object({ text: z.string() }),
  execute: async (ctx: Ctx, { text }) => {
    ctx.ext.notes.push(text);
    await ctx.record('action', 'note', { text }, true, `noted ${text.length} characters`, Date.now());
    return `noted: ${text}`;
  },
});

const done = defineRunnerTool({
  name: 'finish',
  group: 'control',
  description: 'End the run.',
  parameters: z.object({ success: z.boolean(), result: z.string() }),
  execute: async (ctx: Ctx, { success, result }) => {
    ctx.state.finished = { success, result };
    ctx.state.stop = 'finish';
    await ctx.record('finish', null, null, success, result, Date.now());
    return 'Finished.';
  },
});

function host(model: ScriptedModel) {
  const store = new FakeRunStore();
  const control = new FakeControl();
  const ports: Ports = {
    model,
    store,
    questions: new FakeQuestions(),
    control,
    policy: fakePolicy(),
    events: {
      step: () => undefined,
      tokens: () => undefined,
      modelCalls: () => undefined,
      inputTokensPerCall: () => undefined,
      recovered: () => undefined,
      stepRecorded: async () => undefined,
      overBudget: async () => undefined,
      needsYou: async () => undefined,
    },
    telemetry: noopTelemetry,
    clock: { now: () => Date.now() },
    ids: { uuid: () => randomUUID() },
  };
  const notes: string[] = [];
  const loop = createRunLoop<HarnessMemory, { notes: string[] }>(ports, {
    run: { id: 'run-1', userId: 'user-1', orgId: null, goal: 'Write two notes, then finish.', trigger: null, taskId: null, conversationId: null },
    memory: { log: [], chunks: 0 },
    ext: { notes },
  });
  return { loop, store, control, notes, model };
}

describe('a second host runs a scripted goal to completion with only the fakes', () => {
  it('succeeds, writes every step once, and leaves the memory a retried job would read', async () => {
    const model = new ScriptedModel([[['note', { text: 'first' }]], [['note', { text: 'second' }], ['finish', { success: true, result: 'Two notes written.' }]]]);
    const { loop, store, notes } = host(model);
    const outcome = await loop.run(textProfile<Ctx>([note as never, done as never]) as never);
    expect(outcome).toBe('succeeded');
    expect(notes).toEqual(['first', 'second']);
    expect(store.finished).toEqual({ to: 'succeeded', patch: { result: 'Two notes written.', stopReason: 'finished' } });
    expect(store.rows().map((r) => `${r.seq}:${r.kind}:${r.action ?? '-'}`)).toEqual(['1:action:note', '2:action:note', '3:finish:-', '4:end:-']);
    expect(store.memory?.log).toHaveLength(3);
    expect(loop.context.state.stepCount).toBe(3);
  });

  it('honours the owner pressing Stop: the model is never called', async () => {
    const model = new ScriptedModel([[['note', { text: 'never' }]]]);
    const { loop, control, notes, store } = host(model);
    control.requested = true;
    expect(await loop.run(textProfile<Ctx>([note as never, done as never]) as never)).toBe('cancelled');
    expect(model.requests).toHaveLength(0);
    expect(notes).toEqual([]);
    expect(store.finished).toMatchObject({ to: 'cancelled' });
  });
});
