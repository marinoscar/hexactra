import { FabricError, type FabricClient } from '../src/fabric/fabric.client';
import { FabricSession, isTakeoverActive } from '../src/runner/fabric-session';

/** A FabricClient that records each request and answers every action as succeeded. */
function recordingClient() {
  const calls: [string, string, Record<string, unknown> | undefined][] = [];
  const client = {
    request: jest.fn(async (method: string, path: string, opts: { body?: Record<string, unknown> } = {}) => {
      calls.push([method, path, opts.body]);
      return { id: 'op', state: 'succeeded', result: {} };
    }),
  } as unknown as FabricClient;
  return { client, calls };
}

describe('typing a secret through the fabric', () => {
  it('posts a type_secret action naming the handoff, never a claim', async () => {
    const { client, calls } = recordingClient();
    const op = await new FabricSession(client).typeSecret('s1', { handoffId: 'h1', selector: '#otp', submit: true });
    expect(op.state).toBe('succeeded');
    expect(calls).toEqual([
      ['POST', '/v1/sessions/s1/actions', { action: { type: 'type_secret', handoff_id: 'h1', selector: '#otp', clear: true, submit: true }, timeout_ms: 45_000 }],
    ]);
    expect(calls.some(([, path]) => path.endsWith('/claim'))).toBe(false);
  });

  it('passes clear and the tab through', async () => {
    const { client, calls } = recordingClient();
    await new FabricSession(client).typeSecret('s1', { handoffId: 'h1', selector: '#pw', clear: false, tabId: 7 }, 5_000);
    expect(calls[0]![2]).toEqual({ action: { type: 'type_secret', handoff_id: 'h1', selector: '#pw', clear: false, submit: false, tab_id: 7 }, timeout_ms: 5_000 });
  });

  it('has no way to read the plaintext', () => {
    expect((FabricSession.prototype as unknown as Record<string, unknown>).claimSecret).toBeUndefined();
  });
});

describe('a person taking over the browser (#342)', () => {
  const takeover = () => new FabricError('api', 'a person is controlling this browser', 409, 'takeover_active');

  it('the goal runner waits and runs the step once they release it', async () => {
    let calls = 0;
    const client = {
      request: jest.fn(async () => {
        calls += 1;
        if (calls < 3) throw takeover();
        return { id: 'op', state: 'succeeded', result: {} };
      }),
    } as unknown as FabricClient;
    const sleeps: number[] = [];
    const op = await new FabricSession(client, async (ms) => void sleeps.push(ms)).act('s1', { type: 'click', selector: '#go' });
    expect(op.state).toBe('succeeded');
    expect(calls).toBe(3);
    expect(sleeps).toEqual([5000, 5000]);
  });

  it('an external agent is told at once (it decides when to retry)', async () => {
    const client = { request: jest.fn(async () => Promise.reject(takeover())) } as unknown as FabricClient;
    await expect(new FabricSession(client, async () => undefined).act('s1', { type: 'click' }, 45_000, { waitForTakeover: false })).rejects.toMatchObject({ code: 'takeover_active' });
    expect(isTakeoverActive(takeover())).toBe(true);
  });
});
