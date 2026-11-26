import { describe, expect, it, vi } from 'vitest';
import { LIST_ACCOUNTS_URL, checkGoogleSignin, isGoogleAccountsUrl, parseListAccounts, profileStatusMessage, reportSignin, type ProfileStatusMessage } from '../src/signin';

// An account entry as Chromium's ParseListAccountsData reads it: [3] email,
// [9] 1 valid / 0 needs sign-in again, [10] Gaia id, [14] 1 signed out.
function account(email: string, valid: 0 | 1, signedOut = 0): unknown[] {
  const a: unknown[] = ['b', 0, 'Example Owner', email, 'https://lh3.googleusercontent.com/a/photo', 1, 1, 0, null, valid, '110248495921238986420', null, null, null, signedOut];
  return a;
}

const COOKIE = 'SID=g.a000secretcookievalue; __Secure-3PSID=g.a000another';

function respond(body: string, status = 200) {
  return vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(body, { status, headers: { 'content-type': 'application/json', 'set-cookie': COOKIE } }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe('parseListAccounts', () => {
  it('a valid session is signed in', () => {
    const r = parseListAccounts(JSON.stringify(['gaia.l.a.r', [account('owner@example.com', 1)]]));
    expect(r).toEqual({ signin: 'signed_in', accounts: [{ provider: 'google', email: 'owner@example.com', state: 'signed_in' }] });
  });

  it('an empty list, or only signed-out accounts, is signed out', () => {
    expect(parseListAccounts('["gaia.l.a.r",[]]')).toEqual({ signin: 'signed_out', accounts: [] });
    expect(parseListAccounts(JSON.stringify(['gaia.l.a.r', [account('owner@example.com', 0, 1)]]))).toEqual({ signin: 'signed_out', accounts: [] });
  });

  it('index 9 == 0 is expired; one valid account keeps the profile signed in', () => {
    expect(parseListAccounts(JSON.stringify(['gaia.l.a.r', [account('owner@example.com', 0)]]))).toEqual({
      signin: 'expired',
      accounts: [{ provider: 'google', email: 'owner@example.com', state: 'expired' }],
    });
    const two = parseListAccounts(JSON.stringify(['gaia.l.a.r', [account('owner@example.com', 0), account('work@example.org', 1)]]));
    expect(two.signin).toBe('signed_in');
    expect(two.accounts.map((a) => a.state)).toEqual(['expired', 'signed_in']);
  });

  it('anything else is unknown, never signed out', () => {
    for (const body of ['', '<html>', '{}', '["other",[]]', '["gaia.l.a.r",{}]', '["gaia.l.a.r",[1]]', JSON.stringify(['gaia.l.a.r', [account('not an email', 1)]]), JSON.stringify(['gaia.l.a.r', [['b', 0, 'x', 'a@example.com']]])]) {
      expect(parseListAccounts(body).signin, body).toBe('unknown');
    }
  });
});

describe('checkGoogleSignin', () => {
  it('POSTs ListAccounts with the profile cookies and no tab', async () => {
    const f = respond('["gaia.l.a.r",[]]');
    expect((await checkGoogleSignin(f)).signin).toBe('signed_out');
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(LIST_ACCOUNTS_URL);
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
  });

  it('a network error, a non-200 or a timeout is unknown', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await checkGoogleSignin(down)).toEqual({ signin: 'unknown', accounts: [], reason: 'network' });
    expect(await checkGoogleSignin(respond('["gaia.l.a.r",[]]', 500))).toEqual({ signin: 'unknown', accounts: [], reason: 'http_500' });
    expect(await checkGoogleSignin(respond('<html>', 200))).toEqual({ signin: 'unknown', accounts: [], reason: 'parse' });
    const hang = vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    expect(await checkGoogleSignin(hang, 20)).toEqual({ signin: 'unknown', accounts: [], reason: 'timeout' });
    // The reason is all an unknown result adds to the message.
    expect(profileStatusMessage(await checkGoogleSignin(hang, 20))).toEqual({ type: 'profile_status', signin: 'unknown', accounts: [], reason: 'timeout' });
  });
});

describe('the message sent to the agent', () => {
  it('carries only the state and the email: no cookie, no raw response', async () => {
    const body = JSON.stringify(['gaia.l.a.r', [account('owner@example.com', 1)], 'extra-token-from-google']);
    const sent: ProfileStatusMessage[] = [];
    await reportSignin((m) => sent.push(m), respond(body));
    expect(sent).toEqual([{ type: 'profile_status', signin: 'signed_in', accounts: [{ provider: 'google', email: 'owner@example.com', state: 'signed_in' }] }]);
    const wire = JSON.stringify(sent[0]);
    for (const leaked of ['SID', 'secretcookievalue', 'gaia.l.a.r', 'extra-token-from-google', 'Example Owner', 'googleusercontent', '110248495921238986420']) {
      expect(wire).not.toContain(leaked);
    }
    expect(Object.keys(sent[0]!).sort()).toEqual(['accounts', 'signin', 'type']);
    expect(Object.keys(sent[0]!.accounts[0]!).sort()).toEqual(['email', 'provider', 'state']);
  });

  it('a check asked for while one runs shares it', async () => {
    const f = respond('["gaia.l.a.r",[]]');
    const sent: ProfileStatusMessage[] = [];
    await Promise.all([reportSignin((m) => sent.push(m), f), reportSignin((m) => sent.push(m), f)]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });

  it('copies fields explicitly', () => {
    const extra = { signin: 'signed_in', accounts: [{ provider: 'google', email: 'a@example.com', state: 'signed_in', cookie: COOKIE }] };
    expect(JSON.stringify(profileStatusMessage(extra as never))).not.toContain('SID');
  });
});

describe('isGoogleAccountsUrl', () => {
  it('matches only https://accounts.google.com', () => {
    expect(isGoogleAccountsUrl('https://accounts.google.com/v3/signin/identifier')).toBe(true);
    expect(isGoogleAccountsUrl('https://accounts.google.com.evil.test/')).toBe(false);
    expect(isGoogleAccountsUrl('http://accounts.google.com/')).toBe(false);
    expect(isGoogleAccountsUrl(undefined)).toBe(false);
  });
});

describe('the native-messaging wiring', () => {
  it('checks when the agent connects, when it asks, and after an accounts.google.com page loads', async () => {
    const { startRemoteBridge } = await import('../src/remote');
    let onMessage: (m: unknown) => void = () => {};
    let onUpdated: (id: number, info: { status?: string }, tab: { url?: string }) => void = () => {};
    const posted: unknown[] = [];
    const port = {
      onMessage: { addListener: (l: typeof onMessage) => (onMessage = l) },
      onDisconnect: { addListener: () => {} },
      postMessage: (m: unknown) => posted.push(m),
    };
    vi.stubGlobal('chrome', {
      runtime: { connectNative: () => port, getManifest: () => ({ version: '9.9' }), lastError: undefined },
      tabs: { onUpdated: { addListener: (l: typeof onUpdated) => (onUpdated = l) } },
      action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn(), setTitle: vi.fn() },
    });
    const f = respond(JSON.stringify(['gaia.l.a.r', [account('owner@example.com', 1)]]));
    vi.stubGlobal('fetch', f);
    const statuses = () => posted.filter((m) => (m as { type?: string }).type === 'profile_status');
    const settle = () => new Promise((r) => setTimeout(r, 10));

    startRemoteBridge();
    expect(posted[0]).toEqual({ type: 'hello', version: '9.9' });
    onMessage({ type: 'agent_connected' });
    await settle();
    expect(statuses()).toHaveLength(1);
    onMessage({ type: 'check_signin' });
    await settle();
    expect(statuses()).toHaveLength(2);
    onUpdated(1, { status: 'complete' }, { url: 'https://example.test/' });
    onUpdated(1, { status: 'loading' }, { url: 'https://accounts.google.com/' });
    await settle();
    expect(statuses()).toHaveLength(2);
    onUpdated(1, { status: 'complete' }, { url: 'https://accounts.google.com/SignOutOptions' });
    await settle();
    expect(statuses()).toHaveLength(3);
    for (const m of statuses()) {
      expect(m).toEqual({ type: 'profile_status', signin: 'signed_in', accounts: [{ provider: 'google', email: 'owner@example.com', state: 'signed_in' }] });
      expect(JSON.stringify(m)).not.toContain('secretcookievalue');
    }
    vi.unstubAllGlobals();
  });
});
