// The "Browser profile signed out" alert kind (E48.5, #931), without a database: which profiles breach, what clears,
// and that the account's email never reaches a label or a summary.
import { HEXACTRA_ALERT_RULES, profileSignedOutKind, setAlertSources, type AlertHost, type AlertSources } from '../src/alerts/hexactra-alert-kinds';
import { toHost } from '../src/fleet/fleet.service';

const EMAIL = 'owner.secret-mailbox@example.test';
let hosts: AlertHost[] | null;
let fail: Error | null;
const ctx = { now: new Date('2026-11-25T12:00:00Z') } as never;
const view = (config: { includeExpired?: boolean; profiles?: string[] } = {}) =>
  ({ name: 'Browser profile signed out', config: profileSignedOutKind.configSchema.parse(config) }) as never;
const host = (profiles: AlertHost['profiles'], over: Partial<AlertHost> = {}): AlertHost => ({ id: 'h-1', name: 'home-pc', online: true, draining: false, profiles, ...over });

beforeEach(() => {
  fail = null;
  hosts = [];
  setAlertSources({
    hosts: async () => {
      if (fail) throw fail;
      return hosts;
    },
  } as unknown as AlertSources);
});
afterAll(() => setAlertSources(null));

describe('the profile signed-out alert', () => {
  it('breaches per profile when signed out, and clears once it is signed in again', async () => {
    hosts = [host([{ name: 'default', signin: 'signed_out' }, { name: 'work', signin: 'signed_in' }])];
    const out = await profileSignedOutKind.evaluate(ctx, view());
    expect(out).toEqual([
      { labels: { 'host.id': 'h-1', 'host.name': 'home-pc', profile: 'default' }, value: 1, breached: true, summary: expect.stringContaining('profile default on host home-pc') },
      { labels: { 'host.id': 'h-1', 'host.name': 'home-pc', profile: 'work' }, value: 0, breached: false, summary: expect.any(String) },
    ]);
    expect(out[0]!.summary).toContain('signed out of Google');

    hosts = [host([{ name: 'default', signin: 'signed_in' }, { name: 'work', signin: 'signed_in' }])];
    expect((await profileSignedOutKind.evaluate(ctx, view())).map((o) => o.breached)).toEqual([false, false]);
  });

  it('an expired session breaches by default, and not with includeExpired off', async () => {
    hosts = [host([{ name: 'default', signin: 'expired' }])];
    const [on] = await profileSignedOutKind.evaluate(ctx, view());
    expect(on).toMatchObject({ breached: true, value: 1 });
    expect(on!.summary).toContain('Google session expired');
    const [off] = await profileSignedOutKind.evaluate(ctx, view({ includeExpired: false }));
    expect(off).toMatchObject({ breached: false, value: 0 });
  });

  it('unknown never breaches: never checked, a failed check or an old fabric', async () => {
    hosts = [host([{ name: 'default', signin: 'unknown' }]), host(undefined, { id: 'h-old', name: 'old' })];
    expect(await profileSignedOutKind.evaluate(ctx, view())).toEqual([]);
    // From the fabric's own answer: a missing or unrecognised state reads as unknown, never signed out.
    const h = toHost({ id: 'h-2', name: 'n', version: '1', online: true, browser_connected: true, on_demand: true, profiles: ['a', 'b'], running_profiles: [], last_seen: '', profile_status: [{ name: 'b', running: false, signin: 'weird' as never }] } as never);
    expect(h.profiles.map((p) => p.signin)).toEqual(['unknown', 'unknown']);
  });

  it('watches only the listed profiles when `profiles` is set', async () => {
    hosts = [host([{ name: 'default', signin: 'signed_out' }, { name: 'shop', signin: 'signed_out' }])];
    const out = await profileSignedOutKind.evaluate(ctx, view({ profiles: ['shop'] }));
    expect(out.map((o) => o.labels.profile)).toEqual(['shop']);
  });

  it('the email never appears in a label or a summary', async () => {
    // A source that wrongly passed the accounts through still leaks nothing: the kind reads only the name and the state.
    hosts = [host([{ name: 'default', signin: 'signed_out', accounts: [{ provider: 'google', email: EMAIL, state: 'signed_out' }] } as never, { name: 'work', signin: 'expired' }, { name: 'p3', signin: 'signed_in' }])];
    const out = await profileSignedOutKind.evaluate(ctx, view());
    expect(out).toHaveLength(3);
    expect(JSON.stringify(out)).not.toContain(EMAIL);
    expect(JSON.stringify(out)).not.toMatch(/@/);
    expect(profileSignedOutKind.describe!(view({ profiles: ['default'] }))).not.toMatch(/@/);
  });

  it('says nothing while the fabric is unreachable or not configured (the host-offline rule reports that)', async () => {
    fail = new Error('connect ECONNREFUSED');
    expect(await profileSignedOutKind.evaluate(ctx, view())).toEqual([]);
    fail = null;
    hosts = null;
    expect(await profileSignedOutKind.evaluate(ctx, view())).toEqual([]);
  });

  it('is a starter rule, enabled, with the default config', () => {
    const r = HEXACTRA_ALERT_RULES.find((x) => x.key === 'hexactra.profile_signed_out');
    expect(r).toMatchObject({ kind: 'hexactra_profile_signed_out', enabled: true, config: { includeExpired: true, profiles: [] } });
    expect(profileSignedOutKind.configSchema.parse({})).toEqual({ includeExpired: true, profiles: [] });
  });
});
