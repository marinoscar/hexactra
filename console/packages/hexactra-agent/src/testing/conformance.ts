// The host conformance suite (E38.9): a host runs it against its real bindings to prove they behave the way the harness relies on. It checks
// the guarantees written in the doc comments of the ports, not the host's internals: a checkpoint survives a crash, the run belongs to one job at
// a time, a Stop is seen before the next tool, a question's answer is delivered once.
//
// It uses the `describe`, `it` and `expect` globals of Jest or Vitest, so it is imported from `@marinoscar/hexactra-agent/testing` in a spec
// file only. The host supplies `open()`: a new run, bound to the host's real ports, plus the few levers the suite needs from outside the job
// (another job claiming the run, the owner pressing Stop, a person answering).
import { z } from 'zod';

import type { UsageDelta } from '../cost';
import { STOPPED_TEXT, type HarnessMemory } from '../types';
import { executeTool } from '../execute-tool';
import { GatePipeline } from '../gate-pipeline';
import type { ControlPort, QuestionPort, RunStorePort } from '../ports';
import { defineRunnerTool } from '../tool-def';
import { fakeRun } from './context';

/** One job's bindings of the three ports the suite exercises. */
export interface HostedJob {
  store: RunStorePort;
  control: ControlPort;
  questions: QuestionPort;
}

/** A new run held by a first job, and the levers outside it. */
export interface HostedRun {
  /** The bindings of the job that holds the run now. */
  job: HostedJob;
  /**
   * Another job claims the run: a retried job after the first died, or a duplicate. Returns its bindings. From now on the first job's
   * `holdsRun()` answers false and its conditional writes answer false.
   */
  claimAgain(): Promise<HostedJob>;
  /** The owner presses Stop, through the host's own route and from outside the job (the API, not the job's signal). */
  pressStop(): Promise<void>;
  /** A person answers the question opened as `handoffId`, through the host's route. True: the run received the answer. False: refused (already answered). */
  answer(handoffId: string): Promise<boolean>;
  /** The run's memory as the host stored it, read from the store and not through a job's port. */
  readMemory(): Promise<HarnessMemory | null>;
  /** Releases what the run held: signals, timers, rows. Always called. */
  close(): Promise<void>;
}

export interface HarnessHost {
  /** Shown in the test names: `harness host conformance: <name>`. */
  name: string;
  open(): Promise<HostedRun>;
  /** How long a Stop pressed from outside may take to reach the job's `control` (the guarantee is "about a second"). Default 5000. */
  stopWithinMs?: number;
}

const usage: UsageDelta = { modelCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, costKnown: true, byModel: {}, modelMs: 0 };

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

export function runHarnessHostConformance(host: HarnessHost): void {
  const stopWithin = host.stopWithinMs ?? 5000;
  let run: HostedRun;
  beforeEach(async () => {
    run = await host.open();
  });
  afterEach(async () => {
    await run.close();
  });

  describe(`harness host conformance: ${host.name}`, () => {
    it('a checkpoint survives a simulated crash: the next job finds the memory, the steps and the intent left open', async () => {
      const { store } = run.job;
      expect(await store.holdsRun()).toBe(true);
      const first: HarnessMemory = { log: ['1. navigate → ok'], chunks: 1 };
      expect(await store.commitStep({ memory: first, stepCount: 1, step: { seq: 1, kind: 'action', action: 'navigate', args: { url: 'https://shop.example.test/' }, ok: true, summary: 'at https://shop.example.test/' }, finishesIntent: false })).toBe(true);
      const second: HarnessMemory = { log: ['1. navigate → ok'], chunks: 2, lastSeq: 1 };
      expect(await store.openIntent(second, { seq: 2, kind: 'action', action: 'click', args: { selector: '#pay' }, ok: true, phase: 'intent', summary: "about to press 'Pay now'" })).toBe(true);
      const saved: HarnessMemory = { log: ['1. navigate → ok'], chunks: 3, lastSeq: 1 };
      expect(await store.checkpoint({ memory: saved, usage })).toBe(true);

      // The job dies here: nothing is cleaned up. A new job claims the run.
      const next = await run.claimAgain();
      expect(await run.readMemory()).toMatchObject({ chunks: 3, log: ['1. navigate → ok'] });
      expect(await next.store.newestSeq()).toBe(2);
      expect(await next.store.stepsToReconcile(undefined)).toMatchObject([{ seq: 2, phase: 'intent', action: 'click' }]);
      expect(await next.store.getStep(1)).toMatchObject({ seq: 1, action: 'navigate', phase: 'done' });
      await next.store.markUnknown(2, 'the job stopped before the result was recorded');
      expect(await next.store.stepsToReconcile(undefined)).toEqual([]);
      expect(await next.store.getStep(2)).toMatchObject({ phase: 'unknown', ok: false });
    });

    it('the run belongs to one job at a time: after another job claims it, the first writes nothing and says so', async () => {
      const first = run.job;
      expect(await first.store.holdsRun()).toBe(true);
      const second = await run.claimAgain();
      expect(await second.store.holdsRun()).toBe(true);
      expect(await first.store.holdsRun()).toBe(false);

      const before = await run.readMemory();
      const lost: HarnessMemory = { log: ['written by the job that lost the run'], chunks: 99 };
      expect(await first.store.checkpoint({ memory: lost, usage })).toBe(false);
      expect(await first.store.saveMemory(lost)).toBe(false);
      expect(await first.store.commitStep({ memory: lost, stepCount: 1, step: { seq: 1, kind: 'action', action: 'click', args: null, ok: true, summary: 'x' }, finishesIntent: false })).toBe(false);
      expect(await first.store.openIntent(lost, { seq: 1, kind: 'action', action: 'click', args: null, ok: true, phase: 'intent', summary: 'x' })).toBe(false);
      expect(await run.readMemory()).toEqual(before);
      expect(await second.store.newestSeq()).toBe(0);

      const mine: HarnessMemory = { log: ['written by the job that holds it'], chunks: 1 };
      expect(await second.store.checkpoint({ memory: mine, usage })).toBe(true);
      expect(await run.readMemory()).toMatchObject({ chunks: 1 });
    });

    it('a Stop pressed from outside is seen before the next tool: nothing is gated, executed or recorded', async () => {
      let executed = false;
      const tool = defineRunnerTool({
        name: 'probe',
        group: 'test',
        description: 'Does something.',
        parameters: z.object({}),
        execute: () => {
          executed = true;
          return 'ran';
        },
      });
      const { ctx } = fakeRun({ ports: { store: run.job.store, control: run.job.control, questions: run.job.questions } });
      expect(run.job.control.requested).toBe(false);
      await run.pressStop();
      expect(await until(() => run.job.control.requested, stopWithin)).toBe(true);
      expect((await run.job.control.readFlags()).cancelRequested).toBe(true);
      expect(await executeTool(ctx, tool as never, {}, new GatePipeline() as never)).toBe(STOPPED_TEXT);
      expect(executed).toBe(false);
      expect(ctx.state.stop).toBe('cancel');
      expect(await run.job.store.newestSeq()).toBe(0);
    });

    it("a question's answer is delivered once: the second answer to the same question is refused", async () => {
      const { questions } = run.job;
      expect(questions.parse({})).toMatchObject({ ok: false });
      const asked = questions.prepare({ kind: 'other', input: 'text', prompt: 'Which size?' });
      const opened = await questions.open(asked);
      // A question that needs no browser has no handoff id (E39.7): it is answered through its own id.
      const key = opened.handoffId ?? opened.questionId ?? '';
      expect(typeof key).toBe('string');
      expect(key).not.toBe('');
      expect(await run.answer(key)).toBe(true);
      expect(await run.answer(key)).toBe(false);
    });
  });
}
