// A debugger command that never answers (E54.7, #1088): on one real run, seven debugger-driven actions in a row each waited the host's full
// 45 s while plain page reads answered in under 300 ms. A command now gives up after its limit, detaches the tab, and the next command
// attaches a fresh session.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CDP_COMMAND_TIMEOUT_MS, CdpError, evaluate, resetCdp, send } from '../src/cdp';

let hangNext: number;
let calls: string[];
function makeChrome() {
  return {
    debugger: {
      attach: vi.fn(async () => {
        calls.push('attach');
      }),
      detach: vi.fn(async () => {
        calls.push('detach');
      }),
      sendCommand: vi.fn((_t: unknown, method: string) => {
        calls.push(method);
        if (hangNext > 0) {
          hangNext -= 1;
          return new Promise(() => undefined);
        }
        return Promise.resolve({ result: { type: 'number', value: 42 } });
      }),
      onDetach: { addListener: vi.fn() },
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  hangNext = 0;
  calls = [];
  resetCdp();
  (globalThis as unknown as { chrome: unknown }).chrome = makeChrome();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a debugger command that does not answer', () => {
  it('gives up at the limit, detaches, and the next command attaches a fresh session', async () => {
    hangNext = 1;
    const first = send(7, 'Input.dispatchMouseEvent', {});
    const failed = expect(first).rejects.toThrow(new CdpError(`Input.dispatchMouseEvent: the page did not answer the debugger in ${CDP_COMMAND_TIMEOUT_MS / 1000} s; the debugger was reconnected for the next action`));
    await vi.advanceTimersByTimeAsync(CDP_COMMAND_TIMEOUT_MS);
    await failed;
    expect(calls).toEqual(['attach', 'Input.dispatchMouseEvent', 'detach']);
    await expect(send(7, 'Input.dispatchMouseEvent', {})).resolves.toMatchObject({ result: { value: 42 } });
    expect(calls.slice(3)).toEqual(['attach', 'Input.dispatchMouseEvent']);
  });

  it('lets a script run for its own budget plus 2 s before giving up', async () => {
    hangNext = 1;
    const run = evaluate(7, 'slow()', true, 30_000);
    let settled = false;
    run.catch(() => undefined).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(CDP_COMMAND_TIMEOUT_MS + 5_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(7_000);
    await expect(run).rejects.toThrow(/Runtime.evaluate: the page did not answer the debugger in 32 s/);
  });

  it('leaves a command that answers in time as it was', async () => {
    await expect(evaluate(7, '1 + 1', false, 5_000)).resolves.toEqual({ value: 42, type: 'number' });
    expect(calls).toEqual(['attach', 'Runtime.evaluate']);
  });
});
