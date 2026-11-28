// The model port measures how long the model took for each round trip (E54.0, #1081): the time since the previous step (or the start)
// less the tools that step ran, as the platform's tool loop calls `onStep` after a step's tools and asks the model again at once.
import type { AiService } from '@marinoscar/platform-api/ai';

import { AiModelPort } from '../src/runner/host/model-port';

describe('AiModelPort latency', () => {
  afterEach(() => jest.useRealTimers());

  it('gives each step the model time: elapsed since the previous step, less its tools', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const runTools = jest.fn(async (req: { onStep: (s: unknown) => void }) => {
      jest.advanceTimersByTime(1_500); // the model answers in 1.5 s, then its tool runs 400 ms
      jest.advanceTimersByTime(400);
      req.onStep({ step: 1, response: { usage: {} }, calls: [{ callId: 'a', name: 'click', status: 'ok', durationMs: 400 }] });
      jest.advanceTimersByTime(2_000); // the next answer takes 2 s and calls nothing
      req.onStep({ step: 2, response: { usage: {} }, calls: [] });
      return { final: { outputText: '' }, steps: [], stopReason: 'completed' };
    });
    const ai = { forUser: () => ({ runTools }) } as unknown as AiService;
    const seen: number[] = [];
    await new AiModelPort(ai, 'u', null).runTools({
      route: { params: {} } as never,
      instructions: 'i',
      input: [] as never,
      tools: [],
      maxSteps: 4,
      signal: new AbortController().signal,
      onStep: (s: { latencyMs?: number }) => seen.push(s.latencyMs ?? -1),
    } as never);
    expect(seen).toEqual([1_500, 2_000]);
  });

  it('never reports a negative time when the tools outlast the clock (a skewed duration)', async () => {
    const runTools = jest.fn(async (req: { onStep: (s: unknown) => void }) => {
      req.onStep({ step: 1, response: { usage: {} }, calls: [{ callId: 'a', name: 'click', status: 'ok', durationMs: 60_000 }] });
      return { final: { outputText: '' }, steps: [], stopReason: 'completed' };
    });
    const seen: number[] = [];
    await new AiModelPort({ forUser: () => ({ runTools }) } as unknown as AiService, 'u', null).runTools({ route: { params: {} }, instructions: 'i', input: [], tools: [], maxSteps: 1, signal: new AbortController().signal, onStep: (s: { latencyMs?: number }) => seen.push(s.latencyMs ?? -1) } as never);
    expect(seen).toEqual([0]);
  });
});
