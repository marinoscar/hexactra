// Which machine a run goes to when its task names one (#384).
import type { FabricHost } from '../src/fabric/fabric.client';
import { chooseHost, unavailableReason } from '../src/runner/host-choice';

const HOME = '11111111-1111-4111-8111-111111111111';
const host = (over: Partial<FabricHost> = {}): FabricHost => ({
  id: HOME,
  name: 'mini-pc',
  version: '0.1.0',
  online: true,
  browser_connected: false,
  on_demand: true,
  profiles: ['default'],
  running_profiles: [],
  draining: false,
  last_seen: '2026-11-17T00:00:00Z',
  ...over,
});

describe('chooseHost', () => {
  it('lets the fabric pick when the run names no host', () => {
    expect(chooseHost([], null, false)).toEqual({ kind: 'host', hostId: null });
  });

  it('uses the named host when it can take the run', () => {
    expect(chooseHost([host()], HOME, false)).toEqual({ kind: 'host', hostId: HOME });
    expect(chooseHost([host({ on_demand: false, browser_connected: true })], HOME, false)).toEqual({ kind: 'host', hostId: HOME });
  });

  it('falls back to another machine, with a note, when the host cannot take it', () => {
    for (const [h, why] of [
      [host({ online: false }), 'is offline'],
      [host({ draining: true }), 'is disabled'],
      [host({ on_demand: false, browser_connected: false }), 'has no browser connected'],
    ] as const) {
      expect(unavailableReason(h)).toBe(why);
      expect(chooseHost([h], HOME, true)).toEqual({ kind: 'host', hostId: null, note: `mini-pc ${why}; running on another available machine.` });
    }
    expect(chooseHost([], HOME, true)).toEqual({ kind: 'host', hostId: null, note: '11111111 is no longer in the fleet; running on another available machine.' });
  });

  it('fails, naming the host and why, when fallback is off', () => {
    expect(chooseHost([host({ online: false })], HOME, false)).toEqual({
      kind: 'fail',
      error: 'mini-pc is offline, and this task does not fall back to another machine.',
    });
  });
});
