import type { FabricClient } from '../src/fabric/fabric.client';
import { FabricSession } from '../src/runner/fabric-session';

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
