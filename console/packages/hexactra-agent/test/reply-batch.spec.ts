// Several actions in one model reply (E54.1, #1082). Off by default: with one action per reply nothing changes. With more, fill-type actions
// may follow each other, and the first action that may change the page, fails or ends the turn ends the reply: the rest records nothing and
// reaches no gate or tool. The next reply starts fresh.
import { z } from 'zod';

import { defineRunnerTool, GatePipeline, type RunContext, type HarnessMemory } from '../src';
import { runLoop } from '../src/engine';
import { executeTool, notRunText } from '../src/execute-tool';
import { fakeRun, ScriptedModel, textProfile } from '../src/testing';

type Ctx = RunContext<HarnessMemory, Record<string, never>>;
const ran: string[] = [];
const tool = (name: string, opts: { batch?: 'fill'; ok?: boolean; stop?: boolean } = {}) =>
  defineRunnerTool({
    name,
    group: 'test',
    description: '',
    parameters: z.object({}),
    ...(opts.batch ? { batch: opts.batch } : {}),
    execute: async (ctx: Ctx) => {
      ran.push(name);
      await ctx.record('action', name, {}, opts.ok ?? true, name, Date.now());
      if (opts.stop) ctx.state.stop = 'pause';
      return `${name} done`;
    },
  });
const type = tool('type_text', { batch: 'fill' });
const read = tool('read_text', { batch: 'fill' });
const click = tool('click');
const badType = tool('type_text', { batch: 'fill', ok: false });
const ask = tool('request_human', { stop: true });
const pipeline = new GatePipeline<Ctx>([]);
const exec = (ctx: Ctx, t: ReturnType<typeof tool>) => executeTool(ctx, t as never, {}, pipeline as never);

beforeEach(() => {
  ran.length = 0;
});

describe('one action per reply (the default)', () => {
  it('runs every call of a reply, as before, and keeps no reply state', async () => {
    const run = fakeRun();
    for (const t of [click, type, click]) await exec(run.ctx as Ctx, t);
    expect(ran).toEqual(['click', 'type_text', 'click']);
    expect(run.ctx.state.reply).toBeUndefined();
  });
});

describe('several actions per reply', () => {
  it('runs fill actions, then the action that may change the page, and skips the rest', async () => {
    const run = fakeRun({ policy: { actionsPerReply: 5 } });
    const ctx = run.ctx as Ctx;
    const texts = [];
    for (const t of [type, read, type, click, type]) texts.push(await exec(ctx, t));
    expect(ran).toEqual(['type_text', 'read_text', 'type_text', 'click']);
    expect(texts.at(-1)).toBe(notRunText('click may have changed the page'));
    // The skipped call recorded nothing.
    expect(run.store.rows().map((r) => r.action)).toEqual(['type_text', 'read_text', 'type_text', 'click']);
  });

  it('decides from the arguments when the tool says so: typing that submits ends the reply', async () => {
    const typeMaybe = defineRunnerTool({
      name: 'type_text',
      group: 'test',
      description: '',
      parameters: z.object({ submit: z.boolean() }),
      batch: (a) => !a.submit,
      execute: async (ctx: Ctx) => (ran.push('type_text'), await ctx.record('action', 'type_text', {}, true, 't', Date.now()), 'typed'),
    });
    const run = fakeRun({ policy: { actionsPerReply: 5 } });
    const ctx = run.ctx as Ctx;
    await executeTool(ctx, typeMaybe as never, { submit: false }, pipeline as never);
    await executeTool(ctx, typeMaybe as never, { submit: true }, pipeline as never);
    expect(await executeTool(ctx, typeMaybe as never, { submit: false }, pipeline as never)).toBe(notRunText('type_text may have changed the page'));
    expect(ran).toEqual(['type_text', 'type_text']);
  });

  it('stops at the limit of actions per reply', async () => {
    const run = fakeRun({ policy: { actionsPerReply: 2 } });
    for (const t of [type, type, type]) await exec(run.ctx as Ctx, t);
    expect(ran).toEqual(['type_text', 'type_text']);
  });

  it('ends the reply after an action that did not work', async () => {
    const run = fakeRun({ policy: { actionsPerReply: 5 } });
    expect(await exec(run.ctx as Ctx, badType)).toBe('type_text done');
    expect(await exec(run.ctx as Ctx, type)).toBe(notRunText('type_text did not work'));
    expect(ran).toEqual(['type_text']);
  });

  it('ends the reply after an action that ended the turn (a question to a person)', async () => {
    const run = fakeRun({ policy: { actionsPerReply: 5 } });
    await exec(run.ctx as Ctx, ask);
    expect(await exec(run.ctx as Ctx, type)).toBe(notRunText('request_human ended this turn'));
  });

  it('checks Stop before the reply: a stopped run runs nothing', async () => {
    const run = fakeRun({ policy: { actionsPerReply: 5 } });
    run.control.requested = true;
    await exec(run.ctx as Ctx, type);
    expect(ran).toEqual([]);
  });

  it('starts every model reply fresh, in the loop', async () => {
    const finish = defineRunnerTool({
      name: 'finish',
      group: 'control',
      description: '',
      parameters: z.object({}),
      execute: async (ctx: Ctx) => {
        ctx.state.finished = { success: true, result: 'ok' };
        ctx.state.stop = 'finish';
        await ctx.record('finish', null, null, true, 'ok', Date.now());
        return 'Finished.';
      },
    });
    // Reply 1: type, click, type (the last is skipped); reply 2: type, then finish.
    const model = new ScriptedModel([
      async (req) => {
        for (const name of ['type_text', 'click', 'type_text']) await req.tools.find((t) => t.name === name)!.execute({} as never);
        req.onStep({ response: { usage: {} } });
        for (const name of ['type_text', 'finish']) await req.tools.find((t) => t.name === name)!.execute({} as never);
        req.onStep({ response: { usage: {} } });
      },
    ]);
    const run = fakeRun({ model, policy: { actionsPerReply: 3 } });
    await runLoop(run.ctx as never, textProfile<Ctx>([type, click, finish] as never) as never);
    expect(ran).toEqual(['type_text', 'click', 'type_text']);
    expect(run.store.rows().map((r) => r.action ?? r.kind)).toEqual(['type_text', 'click', 'type_text', 'finish', 'end']);
  });
});
