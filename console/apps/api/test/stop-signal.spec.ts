// The owner's Stop as one signal per job (E38.1, #582): the event path, the poll path,
// disposal, throwIfRequested, and the one wrapper around tool execution.
import { defineTool } from '@marinoscar/platform-api/ai';
import { z } from 'zod';

import { RunStopRequested, RunStopSignal, stoppable, STOPPED_TEXT, stoppedResult, withinMs } from '../src/runner/stop-signal';
import { RunEvents, type RunEvent } from '../src/tasks/run-events';

const RUN = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const cancelEvent = (runId: string): RunEvent => ({ type: 'run.cancel', runId, ownerUserId: 'u' });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('RunStopSignal', () => {
  it('starts out not requested, and throwIfRequested does nothing', () => {
    const stop = RunStopSignal.start({ runId: RUN, isRequested: async () => false, pollMs: 10_000 });
    try {
      expect(stop.requested).toBe(false);
      expect(stop.abortSignal.aborted).toBe(false);
      expect(() => stop.throwIfRequested()).not.toThrow();
    } finally {
      stop.dispose();
    }
  });

  it('hears the run.cancel event of its own run at once, aborts its signal, and throws from throwIfRequested', async () => {
    const events = new RunEvents();
    const stop = RunStopSignal.start({ runId: RUN, isRequested: async () => false, subscribe: (h) => events.subscribe(h), pollMs: 10_000 });
    try {
      const aborted = jest.fn();
      stop.abortSignal.addEventListener('abort', aborted);
      await events.publish({ type: 'run.status', runId: RUN, ownerUserId: 'u', status: 'running' });
      await events.publish(cancelEvent(OTHER));
      expect(stop.requested).toBe(false);
      await events.publish(cancelEvent(RUN));
      expect(stop.requested).toBe(true);
      expect(aborted).toHaveBeenCalledTimes(1);
      expect(() => stop.throwIfRequested()).toThrow(RunStopRequested);
      // Idempotent.
      await events.publish(cancelEvent(RUN));
      expect(aborted).toHaveBeenCalledTimes(1);
    } finally {
      stop.dispose();
    }
  });

  it('polls the database flag every interval when no event arrives (another process pressed Stop)', async () => {
    let flag = false;
    const isRequested = jest.fn(async () => flag);
    const stop = RunStopSignal.start({ runId: RUN, isRequested, pollMs: 20 });
    try {
      await tick(70);
      expect(isRequested).toHaveBeenCalled();
      expect(stop.requested).toBe(false);
      flag = true;
      const started = Date.now();
      while (!stop.requested && Date.now() - started < 1000) await tick(5);
      expect(stop.requested).toBe(true);
      expect(Date.now() - started).toBeLessThan(200);
      // Once requested, it stops reading.
      const calls = isRequested.mock.calls.length;
      await tick(70);
      expect(isRequested.mock.calls.length).toBe(calls);
    } finally {
      stop.dispose();
    }
  });

  it('survives a failing poll and tries again', async () => {
    let n = 0;
    const stop = RunStopSignal.start({
      runId: RUN,
      isRequested: async () => {
        n += 1;
        if (n === 1) throw new Error('database blip');
        return true;
      },
      pollMs: 15,
    });
    try {
      await tick(80);
      expect(stop.requested).toBe(true);
    } finally {
      stop.dispose();
    }
  });

  it('disposes: no more polling, no more listening, and a request after disposal does nothing', async () => {
    const events = new RunEvents();
    const isRequested = jest.fn(async () => true);
    const stop = RunStopSignal.start({ runId: RUN, isRequested, subscribe: (h) => events.subscribe(h), pollMs: 20 });
    stop.dispose();
    await events.publish(cancelEvent(RUN));
    await tick(60);
    expect(isRequested).not.toHaveBeenCalled();
    expect(stop.requested).toBe(false);
    stop.request();
    expect(stop.requested).toBe(false);
  });

  it('stays requested after disposal', async () => {
    const stop = RunStopSignal.start({ runId: RUN, isRequested: async () => false, pollMs: 10_000 });
    stop.request();
    stop.dispose();
    expect(stop.requested).toBe(true);
  });
});

describe('stoppable (the one wrapper around tool execution)', () => {
  const run = jest.fn(async () => 'did it');
  const tool = defineTool({ name: 'click', description: 'click', parameters: z.object({ selector: z.string() }), execute: run });

  beforeEach(() => run.mockClear());

  it('runs the tool while Stop is not requested, keeping its definition', async () => {
    const onStopped = jest.fn();
    const [wrapped] = stoppable([tool], { requested: false }, onStopped);
    expect(wrapped!.tool.name).toBe('click');
    expect(wrapped!.parseArguments('{"selector":"#a"}')).toMatchObject({ success: true });
    expect(await wrapped!.execute({ selector: '#a' }, { userId: 'u' } as never)).toBe('did it');
    expect(onStopped).not.toHaveBeenCalled();
  });

  it('does not run the tool once Stop is requested, says so, and tells the runner', async () => {
    const onStopped = jest.fn();
    const stop = { requested: false };
    const [wrapped] = stoppable([tool], stop, onStopped);
    stop.requested = true;
    expect(await wrapped!.execute({ selector: '#a' }, { userId: 'u' } as never)).toBe(STOPPED_TEXT);
    expect(run).not.toHaveBeenCalled();
    expect(onStopped).toHaveBeenCalledTimes(1);
  });
});

describe('stoppedResult and withinMs', () => {
  it('names the last completed step, masked, or says that none was completed', () => {
    expect(stoppedResult([])).toBe('Stopped by the owner before any step was completed.');
    expect(stoppedResult(['(a note)', '1. navigate {"url":"https://a.example.test"} → ok: at a.example.test', '(Budget note)'])).toBe('Stopped by the owner. The last completed step was: 1. navigate {"url":"https://a.example.test"} → ok: at a.example.test');
    expect(stoppedResult(['1. click → ok: done', '2. type → ok: typed 4242 4242 4242 4242'])).not.toContain('4242 4242 4242 4242');
  });

  it('gives up on a slow extra after the limit', async () => {
    expect(await withinMs(tick(300).then(() => 'late'), 20, 'fallback')).toBe('fallback');
    expect(await withinMs(Promise.resolve('quick'), 200, 'fallback')).toBe('quick');
  });
});
