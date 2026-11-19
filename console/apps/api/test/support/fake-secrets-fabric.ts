// An in-memory fabric for the saved-logins specs (E37.3, #592): sessions, actions, the page's address, handoffs and the
// `test` secrets provider of E37.1 (crates/hexactra-credential-resolver/src/test_provider.rs) with the same fixture and
// the same rules: a lookup finds the owner's items for the page's origin (exact first, same-site second), a release or a
// code is bound to the page's origin, a mismatch is `origin_mismatch`, and the value is typed into the page's own
// fields. The page's fields are the only place a value lives; nothing returns one, so a spec can assert that no
// password or code reaches the console by scanning everything it stored.
import { randomUUID } from 'node:crypto';

import { FabricError, type FabricClient } from '../../src/fabric/fabric.client';

/** The published test constants of the Rust fixture (never secrets). */
export const FIXTURE = {
  origin: 'https://login.example.test',
  siteOrigin: 'https://app.example.test',
  itemId: 'test-login-1',
  siteItemId: 'test-login-2',
  username: 'person-a@example.test',
  password: 'canary-pw-7f3a9c1e-test',
  code: '246810',
  siteUsername: 'person-b@example.test',
  sitePassword: 'canary-pw-2-b81d44aa-test',
} as const;

export interface TestItem {
  id: string;
  name: string;
  username: string;
  password: string;
  code: string | null;
  origins: string[];
}

export const defaultItems = (): TestItem[] => [
  { id: FIXTURE.itemId, name: 'Example login', username: FIXTURE.username, password: FIXTURE.password, code: FIXTURE.code, origins: [FIXTURE.origin] },
  { id: FIXTURE.siteItemId, name: 'Example app login', username: FIXTURE.siteUsername, password: FIXTURE.sitePassword, code: null, origins: [FIXTURE.siteOrigin] },
];

/** The registrable domain, as far as the fixture needs: the last two labels. */
const site = (origin: string) => new URL(origin).hostname.split('.').slice(-2).join('.');

export type FailMode = 'unavailable' | 'disabled' | 'unauthorized' | 'rate_limited' | 'origin_mismatch' | 'typing_failed';

interface Handoff {
  id: string;
  status: string;
  input: string;
  kind: string;
  prompt?: string;
  options?: unknown;
  response?: Record<string, unknown>;
}

export function fakeSecretsFabric(url: string) {
  const actions: Record<string, unknown>[] = [];
  const handoffs = new Map<string, Handoff>();
  const page = { url, fields: {} as Record<string, string> };
  const targets = new Map<string, Record<string, unknown> | null>([['#pay', { tag: 'button', label: 'Pay' }]]);
  /** What the provider was asked (never a value). */
  const providerCalls: { op: 'lookup' | 'release' | 'one_time_code'; origin: string; itemId?: string; field?: string; purpose?: string; clientLabel?: string; runId?: string }[] = [];
  const registrations: { owner: string; provider: string; kind: string }[] = [];
  const sessions: Record<string, unknown>[] = [];
  const state = {
    items: defaultItems(),
    /** Fail every provider call (lookup, release, code) with this error. */
    failAll: null as FailMode | null,
    /** Fail only typing (release and code) with this error, once per entry. */
    failTyping: [] as FailMode[],
    /** Throw a plain error (a crash) the first time this field is typed. */
    crashOn: null as string | null,
  };

  const failure = (mode: FailMode, op: string) => {
    const text =
      mode === 'rate_limited' ? 'rate_limited: rate limited; retry in 7 s' : mode === 'origin_mismatch' ? 'origin_mismatch: the page is not the site this login is saved for' : `${mode}: the provider refused (${op})`;
    return { id: 'op', state: 'failed', error: text };
  };

  const request = jest.fn(async (method: string, path: string, opts: { body?: Record<string, unknown> } = {}) => {
    if (method === 'POST' && path === '/v1/sessions') {
      sessions.push(opts.body ?? {});
      return { id: '00000000-0000-4000-8000-0000000000c1' };
    }
    if (method === 'DELETE' && path.startsWith('/v1/sessions/')) return undefined;
    const reg = /^\/v1\/secrets-providers\/([^/]+)\/([^/]+)$/.exec(path);
    if (reg && method === 'PUT') {
      registrations.push({ owner: decodeURIComponent(reg[1]!), provider: decodeURIComponent(reg[2]!), kind: String(opts.body?.kind) });
      return { owner_id: reg[1], provider: reg[2], kind: opts.body?.kind, registered_at: new Date().toISOString() };
    }
    if (method === 'POST' && path.endsWith('/actions')) {
      const action = opts.body!.action as Record<string, unknown>;
      if (action.type === 'evaluate' && String(action.script).startsWith('/* hexactra:describe-target */')) {
        const where = JSON.parse(/const where = (.*);/.exec(String(action.script))![1]!) as { selector?: string; x?: number; y?: number };
        return { id: 'op', state: 'succeeded', result: { type: 'object', value: targets.get(where.selector ?? `${where.x},${where.y}`) ?? null } };
      }
      actions.push(action);
      if (action.type === 'tabs') return { id: 'op', state: 'succeeded', result: { tabs: [{ id: 1, active: true, url: page.url, title: 'Sign in' }] } };
      const origin = new URL(page.url).origin;
      const meta = { runId: action.run_id as string | undefined, clientLabel: action.client_label as string | undefined };
      if (action.type === 'secrets_lookup') {
        providerCalls.push({ op: 'lookup', origin, ...meta });
        if (state.failAll && state.failAll !== 'origin_mismatch' && state.failAll !== 'typing_failed') return failure(state.failAll, 'lookup');
        const items = state.items
          .map((i) => ({ i, match: i.origins.includes(origin) ? 'exact' : i.origins.some((o) => site(o) === site(origin)) ? 'site' : null }))
          .filter((x) => x.match)
          .sort((a, b) => Number(b.match === 'exact') - Number(a.match === 'exact'));
        return {
          id: 'op',
          state: 'succeeded',
          result: {
            origin,
            provider: 'test',
            items: items.map(({ i, match }) => ({ id: i.id, name: i.name, username: i.username, origins: i.origins, match_kind: match, has_code: i.code !== null, updated_at: '1970-01-01T00:00:00Z' })),
          },
        };
      }
      if (action.type === 'type_from_provider' || action.type === 'type_code_from_provider') {
        const isCode = action.type === 'type_code_from_provider';
        const field = isCode ? 'code' : String(action.field);
        providerCalls.push({ op: isCode ? 'one_time_code' : 'release', origin, itemId: String(action.item_id), ...(isCode ? {} : { field }), purpose: action.purpose as string | undefined, ...meta });
        if (state.crashOn === field) {
          state.crashOn = null;
          throw new Error('the process crashed');
        }
        if (state.failAll) return failure(state.failAll, 'type');
        const next = state.failTyping.shift();
        if (next) return failure(next, 'type');
        const item = state.items.find((i) => i.id === action.item_id);
        if (!item) return { id: 'op', state: 'failed', error: 'not_found: no such item' };
        if (!item.origins.includes(origin)) return failure('origin_mismatch', 'type');
        const value = isCode ? item.code : field === 'username' ? item.username : field === 'password' ? item.password : null;
        if (value === null) return { id: 'op', state: 'failed', error: 'not_found: no such field' };
        // The value goes into the page's own field and nowhere else.
        page.fields[String(action.selector)] = value;
        return { id: 'op', state: 'succeeded', result: isCode ? { typed: true, expires_at: '2099-01-01T00:00:30Z' } : { typed: true } };
      }
      return { id: 'op', state: 'succeeded', result: {} };
    }
    if (method === 'POST' && path.endsWith('/handoffs')) {
      const id = randomUUID();
      const body = opts.body!;
      handoffs.set(id, { id, status: 'pending', input: String(body.input), kind: String(body.kind), prompt: body.prompt as string, options: body.choices });
      return { handoff: { id } };
    }
    if (method === 'GET' && path.startsWith('/v1/handoffs/')) return handoffs.get(path.split('/')[3]!);
    throw new FabricError('api', 'unexpected', 500, `unexpected ${method} ${path}`);
  });

  const client = { request, config: async () => ({ url: 'http://f', token: 't' }) } as unknown as FabricClient;
  /** The provider's typing calls, oldest first. */
  const typed = () => providerCalls.filter((c) => c.op !== 'lookup');
  /** Answer the handoff the way the fabric reports a finished one. */
  const answer = (h: Handoff, response: Record<string, unknown>) => Object.assign(h, { status: 'completed', response: { outcome: 'completed', value_withheld: false, ...response } });
  return { client, request, actions, handoffs, page, targets, state, providerCalls, typed, registrations, sessions, answer };
}

export type SecretsFabric = ReturnType<typeof fakeSecretsFabric>;
