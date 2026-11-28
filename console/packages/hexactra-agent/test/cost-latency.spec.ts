// How long the model took (E54.0): RunUsage sums each call's latency, overall and per model, and starts again at zero on `drain`.
import { RunUsage } from '../src/cost';

const prices = { 'openai:fast': { inputPerMTok: 1, outputPerMTok: 2 } } as never;

describe('RunUsage model time', () => {
  it('sums the latency of the calls, per model, rounded to the millisecond', () => {
    const u = new RunUsage();
    u.add('openai', 'fast', { inputTokens: 100, outputTokens: 10 }, prices, 1200.4);
    u.add('openai', 'fast', { inputTokens: 100, outputTokens: 10 }, prices, 800);
    u.add('openai', 'slow', { inputTokens: 100, outputTokens: 10 }, prices, 3000);
    const d = u.delta();
    expect(d.modelMs).toBe(5000);
    expect(d.byModel['openai:fast']).toMatchObject({ calls: 2, ms: 2000 });
    expect(d.byModel['openai:slow']).toMatchObject({ calls: 1, ms: 3000, costUsd: null });
  });

  it('counts a call with no latency (or a nonsense one) as 0 ms', () => {
    const u = new RunUsage();
    u.add('openai', 'fast', {}, prices);
    u.add('openai', 'fast', {}, prices, -5);
    u.add('openai', 'fast', {}, prices, Number.NaN);
    expect(u.delta()).toMatchObject({ modelCalls: 3, modelMs: 0 });
  });

  it('starts again from zero after a drain', () => {
    const u = new RunUsage();
    u.add('openai', 'fast', {}, prices, 900);
    expect(u.drain().modelMs).toBe(900);
    expect(u.delta()).toMatchObject({ modelCalls: 0, modelMs: 0, byModel: {} });
  });
});
