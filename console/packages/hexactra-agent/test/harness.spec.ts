// The generic agent harness on its own (E38.5, #586): the gate pipeline, the one wrapper around every tool call, the input builder, checkpoints and
// crash recovery, and the loop, against the in-memory fakes. No database, no browser, no model, no NestJS: this is what a second host runs on.
import { z } from 'zod';

import {
  buildRoundText,
  buildStatus,
  composeInstructions,
  computeEffectiveBudget,
  defineRunnerTool,
  GatePipeline,
  inCommitTool,
  LeaseLost,
  PAUSED_TEXT,
  reconcileSteps,
  STOPPED_TEXT,
  ToolRegistry,
  type Gate,
  type RunContext,
  type HarnessMemory,
} from '../src';
import { executeTool, runLoop } from '../src/engine';
import { fakeRun, ScriptedModel, textProfile } from '../src/testing';

type Ctx = RunContext<HarnessMemory, Record<string, never>>;

/** A trivial tool defined by the test: it records a step, as a real one does through the context. */
const echo = defineRunnerTool({
  name: 'echo',
  group: 'test',
  description: 'Say a thing back.',
  parameters: z.object({ text: z.string() }),
  execute: async (ctx: Ctx, { text }) => {
    await ctx.record('action', 'echo', { text }, true, `echoed ${text.length} characters`, Date.now());
    return `echo: ${text}`;
  },
});

const finish = defineRunnerTool({
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

const allow = (name: string, order: string[], data?: unknown): Gate<Ctx> => ({
  name,
  check: async () => {
    order.push(`gate:${name}`);
    return { kind: 'allow', data };
  },
});

describe('the gate pipeline', () => {
  const gated = (names: string[]) => defineRunnerTool({ name: 't', group: 'test', description: '', parameters: z.object({}), gated: Object.fromEntries(names.map((n) => [n, () => ({ for: n })])), execute: () => 'ran' });

  it('runs the gates a tool names in the order its map lists them and hands their data to the tool', async () => {
    const { ctx } = fakeRun();
    const order: string[] = [];
    const pipeline = new GatePipeline<Ctx>([allow('site', order, 1), allow('risk', order, 2)]);
    expect(await pipeline.run(ctx, gated(['risk', 'site']) as never, {})).toEqual({ kind: 'allow', decision: { risk: 2, site: 1 } });
    expect(order).toEqual(['gate:risk', 'gate:site']);
  });

  it('stops at the first gate that does not allow, and runs no later gate', async () => {
    const { ctx } = fakeRun();
    const order: string[] = [];
    const refusing: Gate<Ctx> = { name: 'site', check: async () => (order.push('gate:site'), { kind: 'refuse', text: 'no' }) };
    const pipeline = new GatePipeline<Ctx>([refusing, allow('risk', order)]);
    expect(await pipeline.run(ctx, gated(['site', 'risk']) as never, {})).toEqual({ kind: 'refuse', text: 'no' });
    expect(order).toEqual(['gate:site']);
  });

  it('gives a gate the request the tool built for it', async () => {
    const { ctx } = fakeRun();
    const seen: unknown[] = [];
    const spy: Gate<Ctx> = { name: 'site', check: async (_c, request) => (seen.push(request), { kind: 'allow' }) };
    await new GatePipeline<Ctx>([spy]).run(ctx, gated(['site']) as never, {});
    expect(seen).toEqual([{ for: 'site' }]);
  });

  it('never lets a tool run ungated: a tool that names a gate nobody registered is an error', async () => {
    const { ctx } = fakeRun();
    await expect(new GatePipeline<Ctx>().run(ctx, gated(['risk']) as never, {})).rejects.toThrow(/"risk".*not registered/);
  });

  it('refuses two gates of one name', () => {
    expect(() => new GatePipeline<Ctx>([allow('a', []), allow('a', [])])).toThrow(/twice/);
  });
});

describe('executeTool: the one wrapper around every tool call', () => {
  const pipelineOf = (...gates: Gate<Ctx>[]) => new GatePipeline<Ctx>(gates);

  it('checks Stop, then Pause, before anything else: nothing is gated, traced, executed or recorded', async () => {
    const run = fakeRun();
    const order: string[] = [];
    const tool = defineRunnerTool({ name: 'echo', group: 'test', description: '', parameters: z.object({}), gated: { site: () => 1 }, execute: () => (order.push('executed'), 'ran') });
    const pipeline = pipelineOf(allow('site', order));
    run.control.requested = true;
    expect(await executeTool(run.ctx, tool as never, {}, pipeline as never)).toBe(STOPPED_TEXT);
    expect(run.ctx.state.stop).toBe('cancel');
    run.control.requested = false;
    run.control.pauseRequested = true;
    run.ctx.state.stop = null;
    expect(await executeTool(run.ctx, tool as never, {}, pipeline as never)).toBe(PAUSED_TEXT);
    expect(run.ctx.state.stop).toBe('owner_pause');
    expect(order).toEqual([]);
    expect(run.telemetry.calls).toEqual([]);
    expect(run.store.rows()).toEqual([]);
  });

  it('opens the trace span, then runs the gates, then the tool, in that order', async () => {
    const run = fakeRun();
    const order: string[] = [];
    const toolCall = run.telemetry.toolCall.bind(run.telemetry);
    run.telemetry.toolCall = (name, fn) => (order.push(`span:${name}`), toolCall(name, fn));
    const tool = defineRunnerTool({ name: 'echo', group: 'test', description: '', parameters: z.object({}), gated: { site: () => 1 }, execute: () => (order.push('executed'), 'ran') });
    expect(await executeTool(run.ctx, tool as never, {}, pipelineOf(allow('site', order)) as never)).toBe('ran');
    expect(order).toEqual(['span:echo', 'gate:site', 'executed']);
  });

  it('records a refusal as a failed step and does not run the tool', async () => {
    const run = fakeRun();
    let executed = false;
    const refuse: Gate<Ctx> = { name: 'site', check: async () => ({ kind: 'refuse', text: 'Refused: not allowed.', step: { action: 'navigate', args: { url: 'https://x.test/' }, summary: 'refused by policy', reasoning: 'because' } }) };
    const tool = defineRunnerTool({ name: 'navigate', group: 'test', description: '', parameters: z.object({}), gated: { site: () => 1 }, execute: () => ((executed = true), 'ran') });
    expect(await executeTool(run.ctx, tool as never, {}, pipelineOf(refuse) as never)).toBe('Refused: not allowed.');
    expect(executed).toBe(false);
    expect(run.ctx.state.stepCount).toBe(1);
    expect(run.store.rows()).toMatchObject([{ seq: 1, kind: 'action', action: 'navigate', ok: false, summary: 'refused by policy', phase: 'done' }]);
  });

  it('opens the question of an ask verdict and tells the model to wait', async () => {
    const run = fakeRun();
    const ask: Gate<Ctx> = { name: 'risk', check: async () => ({ kind: 'ask', question: { kind: 'confirmation', input: 'confirm', prompt: 'Pay 10?' }, text: 'Asked the owner.' }) };
    const tool = defineRunnerTool({ name: 'click', group: 'test', description: '', parameters: z.object({}), gated: { risk: () => 1 }, execute: () => 'ran' });
    expect(await executeTool(run.ctx, tool as never, {}, pipelineOf(ask) as never)).toBe('Asked the owner.');
    expect(run.questions.opened).toMatchObject([{ prompt: 'Pay 10?' }]);
    expect(run.ctx.state).toMatchObject({ stop: 'pause', handoffId: 'handoff-1' });
  });

  it('waits on a question that has no browser handoff, and records only its one-line summary (E39.7)', async () => {
    const run = fakeRun();
    run.questions.noHandoff = true;
    const ask: Gate<Ctx> = { name: 'connection', check: async () => ({ kind: 'ask', question: { kind: 'confirmation', input: 'confirm', prompt: 'To: person-b@example.test\nMessage: PRIVATE-BODY-TEXT', stepSummary: 'approval of: send an email from Work to 1 recipient', action: { tool: 'mail_send' } }, text: 'Asked the owner.' }) };
    const tool = defineRunnerTool({ name: 'mail_send', group: 'connection', description: '', parameters: z.object({}), gated: { connection: () => 1 }, execute: () => 'sent' });
    expect(await executeTool(run.ctx, tool as never, {}, pipelineOf(ask) as never)).toBe('Asked the owner.');
    // The run is to wait for the person even though there is no handoff id to wait on.
    expect(run.ctx.state).toMatchObject({ stop: 'pause', handoffId: null, handoffAsk: { prompt: 'approval of: send an email from Work to 1 recipient', kind: 'confirmation', input: 'confirm' } });
    expect(run.ctx.memory.askedPrompt).toBe('approval of: send an email from Work to 1 recipient');
    const dump = JSON.stringify(run.store.rows());
    expect(dump).toContain('approval of: send an email from Work to 1 recipient');
    expect(dump).not.toContain('PRIVATE-BODY-TEXT');
  });

  it('marks a commit-class tool for the duration of its call and no other', async () => {
    const run = fakeRun();
    const seen: Record<string, boolean> = {};
    const mk = (name: string, commits: boolean) => defineRunnerTool({ name, group: 'test', description: '', parameters: z.object({}), commits, execute: () => ((seen[name] = inCommitTool()), 'ok') });
    await executeTool(run.ctx, mk('sends', true) as never, {}, pipelineOf() as never);
    await executeTool(run.ctx, mk('reads', false) as never, {}, pipelineOf() as never);
    expect(seen).toEqual({ sends: true, reads: false });
    expect(inCommitTool()).toBe(false);
  });

  it('writes an intent row before a commit-class action is sent, finishes it after, and stops when the run was taken', async () => {
    const run = fakeRun();
    const intent = await run.ctx.openIntent('click', { selector: '#pay' }, { category: 'payment', label: 'Pay now', host: 'shop.example.test' });
    expect(intent).toBe(1);
    expect(run.store.rows()).toMatchObject([{ seq: 1, phase: 'intent', ok: true, summary: "about to press 'Pay now'" }]);
    await run.ctx.record('action', 'click', { selector: '#pay' }, true, 'done', Date.now(), undefined, undefined, intent);
    expect(run.store.rows()).toMatchObject([{ seq: 1, phase: 'done', summary: 'done' }]);
    run.store.lost = true;
    expect(await run.ctx.openIntent('click', { selector: '#pay' }, null)).toBeNull();
    expect(run.ctx.state.stop).toBe('lease');
  });
});

describe('the input builder and the instructions: the stable prefix', () => {
  const base = { goal: 'Book a table', aboutOwner: 'About the owner: likes window seats.', context: undefined, contextLines: ['Allowed sites: any.'], logLines: 60, warnings: [], confirmedTarget: null };

  it('keeps everything before the progress log byte-identical between rounds, and puts the changing tail last', () => {
    const round1 = buildRoundText({ ...base, log: ['1. navigate → ok'] });
    const round2 = buildRoundText({ ...base, log: ['1. navigate → ok', '2. click → ok'] });
    const prefix = (t: string) => t.slice(0, t.indexOf('Progress so far'));
    expect(prefix(round1)).toBe(prefix(round2));
    expect(prefix(round1)).toBe('Goal: Book a table\n\nAbout the owner: likes window seats.\n\nAllowed sites: any.\n\n');
    // The volatile status is a separate part the model reads after the screenshots.
    expect(buildStatus({ stepCount: 2, actionsLimit: 100, askLine: null })).toBe('Steps used: 2 of 100.');
    expect(buildStatus({ stepCount: 2, actionsLimit: null, askLine: 'Ask rules: none.' })).toBe('Steps used: 2 (no limit).\nAsk rules: none.');
  });

  it('shows only the last lines of the log, warnings and a nudge after the approval line, and ends with the instruction to continue', () => {
    const log = Array.from({ length: 5 }, (_, i) => `${i + 1}. step`);
    const text = buildRoundText({ ...base, log, logLines: 2, warnings: ['Budget warning.'], nudge: 'Try another way.', confirmedTarget: { category: 'payment', label: 'Pay now', host: null } });
    expect(text).toContain('Progress so far (latest last):\n4. step\n5. step');
    expect(text).not.toContain('3. step');
    expect(text.endsWith("The person approved one step: pressing 'Pay now' (payment). Any other commitment needs its own confirmation.\n\nBudget warning.\n\nTry another way.\n\nContinue toward the goal.")).toBe(true);
    expect(buildRoundText({ ...base, log: [] })).toContain('Nothing has been done yet. Start by navigating or observing the page.');
  });

  it('composes the instructions from sections, and adds the tools usage notes after them, deterministically', () => {
    expect(composeInstructions(['A', 'B'])).toBe('A\n\nB');
    expect(composeInstructions(['A', 'B'], ['use x first', 'then y'])).toBe('A\n\nB\n\nTool notes:\n- use x first\n- then y');
    expect(composeInstructions(['A'], ['n'])).toBe(composeInstructions(['A'], ['n']));
  });

  it('offers the tools of the registry in registration order, hides the ones that are not available, and collects usage notes', () => {
    const { ctx } = fakeRun();
    const t = (name: string, extra: object = {}) => defineRunnerTool({ name, group: 'test', description: '', parameters: z.object({}), execute: () => name, ...extra });
    const registry = new ToolRegistry<Ctx>().registerAll([t('b', { usage: 'b is for x' }) as never, t('a', { available: () => false }) as never, t('c') as never]);
    expect(registry.list(ctx).map((x) => x.name)).toEqual(['b', 'c']);
    expect(registry.usageNotes(ctx)).toEqual(['b is for x']);
    expect(() => registry.register(t('b') as never)).toThrow(/twice/);
  });
});

describe('the loop: a scripted goal runs to completion with only the harness and one trivial tool', () => {
  it('succeeds, records every step once, and keeps the instructions and the stable prefix identical across rounds', async () => {
    const model = new ScriptedModel([[['echo', { text: 'hello' }]], [['echo', { text: 'again' }], ['finish', { success: true, result: 'All done.' }]]]);
    const run = fakeRun({ model });
    const outcome = await runLoop(run.ctx, textProfile<Ctx>([echo as never, finish as never]) as never);
    expect(outcome).toBe('succeeded');
    expect(run.store.finished).toEqual({ to: 'succeeded', patch: { result: 'All done.', stopReason: 'finished' } });
    expect(run.store.rows().map((r) => `${r.seq}:${r.kind}:${r.action ?? '-'}`)).toEqual(['1:action:echo', '2:action:echo', '3:finish:-', '4:end:-']);
    expect(run.ctx.state.stepCount).toBe(3);
    // The model was called twice; the tools offered and the instructions did not change.
    expect(model.requests).toHaveLength(2);
    expect(new Set(model.requests.map((r) => r.instructions)).size).toBe(1);
    expect(model.requests[0]!.tools.map((t) => t.name)).toEqual(['echo', 'finish']);
    const [first, second] = model.requests.map((r) => String(r.input));
    // The prefix ends where the progress log starts (or the line that says there is none yet).
    const prefix = (t: string) => t.slice(0, t.search(/Progress so far|Nothing has been done yet/));
    expect(prefix(first!)).toBe('Goal: Do the thing\n\n');
    expect(prefix(first!)).toBe(prefix(second!));
    expect(first).toContain('Nothing has been done yet.');
    expect(second).toContain('1. echo {"text_length":5} → ok: echoed 5 characters');
    expect(first).toMatch(/Steps used: 0 \(no limit\)\.$/);
    expect(second).toMatch(/Steps used: 1 \(no limit\)\.$/);
    // Spans: one per tool call; the memory the run left is what the next job would read.
    expect(run.telemetry.calls.filter((c) => c.startsWith('tool:'))).toEqual(['tool:echo', 'tool:echo', 'tool:finish']);
    expect(run.store.memory?.log).toHaveLength(3);
  });

  it('is cancelled before anything is asked when the owner pressed Stop', async () => {
    const model = new ScriptedModel([[['echo', { text: 'x' }]]]);
    const run = fakeRun({ model });
    run.control.requested = true;
    expect(await runLoop(run.ctx, textProfile<Ctx>([echo as never, finish as never]) as never)).toBe('cancelled');
    expect(model.requests).toHaveLength(0);
    expect(run.store.finished).toMatchObject({ to: 'cancelled', patch: { error: 'Cancelled by the user', stopReason: 'cancelled' } });
  });

  it('pauses before the next chunk when the owner pressed Pause, and keeps the run', async () => {
    const run = fakeRun();
    run.control.pauseRequested = true;
    expect(await runLoop(run.ctx, textProfile<Ctx>([echo as never, finish as never]) as never)).toBe('paused');
    expect(run.store.paused).toBe(true);
    expect(run.store.finished).toBeNull();
  });

  it('waits for a person when a chunk ends on a question, and tells the owner', async () => {
    const ask = defineRunnerTool({
      name: 'ask',
      group: 'human',
      description: '',
      parameters: z.object({}),
      execute: async (ctx: Ctx) => ((await ctx.askPerson({ kind: 'other', input: 'text', prompt: 'Which size?' }, Date.now())) ? 'Waiting for the person.' : 'Could not reach a person.'),
    });
    const run = fakeRun({ model: new ScriptedModel([[['ask', {}]]]) });
    expect(await runLoop(run.ctx, textProfile<Ctx>([ask as never, finish as never]) as never)).toBe('waiting_human');
    expect(run.store.transitions).toEqual([{ to: 'waiting_human', patch: { handoffId: 'handoff-1', handoffExpiresAt: null } }]);
    expect(run.events.notified).toEqual(['Which size?']);
    expect(run.store.rows().map((r) => r.kind)).toEqual(['handoff']);
  });

  it('asks the model for a last word with only `finish` when a budget is spent, and ends on the typed stop reason', async () => {
    const budget = computeEffectiveBudget({ maxActions: 1, maxModelCalls: null, maxActiveMinutes: null, maxInputTokens: null, maxOutputTokens: null, maxCostUsd: null, warnAtPercent: 80 }, null);
    const model = new ScriptedModel([[['echo', { text: 'one' }]], [['finish', { success: false, result: 'Ran out of steps.' }]]]);
    const run = fakeRun({ model, policy: { effectiveBudget: budget } });
    expect(await runLoop(run.ctx, textProfile<Ctx>([echo as never, finish as never]) as never)).toBe('failed');
    expect(model.requests[1]!.tools.map((t) => t.name)).toEqual(['finish']);
    expect(model.requests[1]!.maxSteps).toBe(1);
    expect(run.store.finished).toMatchObject({ to: 'failed', patch: { result: 'Ran out of steps.', stopReason: 'budget_actions' } });
  });

  it('hands the run on to a new job when this one has worked long enough', async () => {
    const run = fakeRun({ clockStep: 60_000 });
    run.ctx.hopAfterMs = 1;
    expect(await runLoop(run.ctx, textProfile<Ctx>([echo as never, finish as never]) as never)).toBe('continue');
  });

  it('throws LeaseLost when another job took the run in the middle of a chunk, and writes nothing after', async () => {
    // Every conditional write finds the lease gone: the first step is the one that notices.
    const lost = fakeRun({ model: new ScriptedModel([[['echo', { text: 'x' }]]]) });
    lost.store.lost = true;
    await expect(runLoop(lost.ctx, textProfile<Ctx>([echo as never, finish as never]) as never)).rejects.toBeInstanceOf(LeaseLost);
    expect(lost.store.rows()).toEqual([]);
  });
});

describe('checkpoints and crash recovery', () => {
  it('saves the memory and the chunk usage, and says so when another job holds the run', async () => {
    const run = fakeRun({ memory: { log: ['1. echo → ok'], chunks: 2 } });
    await run.ctx.checkpoint();
    expect(run.store.memory).toMatchObject({ chunks: 2, log: ['1. echo → ok'] });
    run.store.lost = true;
    await expect(run.ctx.checkpoint()).rejects.toBeInstanceOf(LeaseLost);
  });

  it('finds a step left in intent by a crash, marks it unknown and tells the model not to repeat it', async () => {
    const run = fakeRun({ memory: { log: ['1. navigate → ok'], chunks: 1, lastSeq: 1, confirmedTarget: { category: 'payment', label: 'Pay now', host: 'shop.example.test' } } });
    run.store.seed({ seq: 1, kind: 'action', action: 'navigate', args: {}, summary: 'at https://shop.example.test/' });
    run.store.seed({ seq: 2, kind: 'action', action: 'click', phase: 'intent', ok: true, summary: "about to press 'Pay now'", args: { selector: '#pay', what: "press 'Pay now'", gate: { category: 'payment', label: 'Pay now', host: 'shop.example.test' } } });
    const done = await reconcileSteps(run.store, { memory: run.ctx.memory, stepCount: 1, interrupted: true });
    expect(done).toMatchObject({ appended: 1, recovered: true, unknown: [{ seq: 2, what: "press 'Pay now'", category: 'payment' }] });
    expect(run.store.rows()[1]).toMatchObject({ seq: 2, phase: 'unknown', ok: false });
    const memory = run.ctx.memory;
    expect(memory.log.join('\n')).toContain('2. click {"selector":"#pay"} → UNKNOWN: the job stopped before the result was recorded');
    expect(memory.log.join('\n')).toContain('Step 2 (press \'Pay now\') may or may not have happened. Do not repeat it.');
    // The approval was for the step that may have happened: it is spent, and the next job asks again.
    expect(memory.confirmedTarget).toBeNull();
    expect(memory.unknownSteps).toMatchObject([{ seq: 2, category: 'payment' }]);
    expect(memory.lastSeq).toBe(2);
  });
});
