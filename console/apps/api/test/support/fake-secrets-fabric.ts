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

/** The Rust fixture's identity item (E37.6): the date of birth and the ID number are sensitive and allowed only on `FIXTURE.origin`. */
export const IDENTITY = {
  itemId: 'test-identity-1',
  name: 'Passport',
  fullName: 'Person A Canary-Name',
  dob: '1990-03-27',
  idNumber: 'CANARY-ID-5521-7788',
  country: 'Canada',
  city: 'Exampleton',
} as const;

export interface TestIdentityField {
  key: string;
  label: string;
  value: string;
  sensitive: boolean;
}
export interface TestIdentity {
  id: string;
  name: string;
  allowedOrigins: string[];
  fields: TestIdentityField[];
}

export const defaultIdentities = (): TestIdentity[] => [
  {
    id: IDENTITY.itemId,
    name: IDENTITY.name,
    allowedOrigins: [FIXTURE.origin],
    fields: [
      { key: 'full_name', label: 'Full name', value: IDENTITY.fullName, sensitive: false },
      { key: 'date_of_birth', label: 'Date of birth', value: IDENTITY.dob, sensitive: true },
      { key: 'id_number', label: 'ID number', value: IDENTITY.idNumber, sensitive: true },
      { key: 'country', label: 'Country', value: IDENTITY.country, sensitive: false },
      { key: 'city', label: 'City', value: IDENTITY.city, sensitive: false },
    ],
  },
];

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
  const page = {
    url,
    /** What each input of the page holds now: typed or chosen from a provider. The only place a value lives. */
    fields: {} as Record<string, string>,
    /** The selectors the page lists as interactive elements (a form), as `observe_elements` and the marks show them. */
    inputs: [] as { selector: string; tag: string }[],
    /** Whether the runner's cover is over the filled inputs right now (the picture is taken while it is). */
    covered: false,
  };
  /** Every screenshot taken, with whether the cover was drawn and what the marks said. */
  const shots: { screen: string; covered: boolean; markTexts: string[] }[] = [];
  const covers: string[][] = [];
  const targets = new Map<string, Record<string, unknown> | null>([['#pay', { tag: 'button', label: 'Pay' }]]);
  /** What the provider was asked (never a value). */
  const providerCalls: { op: 'lookup' | 'release' | 'one_time_code'; origin: string; itemId?: string; field?: string; purpose?: string; clientLabel?: string; runId?: string; kind?: string; part?: string }[] = [];
  const registrations: { owner: string; provider: string; kind: string }[] = [];
  const sessions: Record<string, unknown>[] = [];
  const state = {
    items: defaultItems(),
    identities: defaultIdentities(),
    /** Whether the fake's screenshots work (the default fabric answers none). */
    screenshots: false,
    /** Runs after an identity lookup answered (a test moves the page here). */
    afterLookup: null as null | (() => void),
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
      // The page itself (E37.6): the elements it lists, its text, scripts that cover and read, and pictures.
      if (action.type === 'elements') {
        return { id: 'op', state: 'succeeded', result: { elements: page.inputs.map((i) => ({ selector: i.selector, tag: i.tag, text: page.fields[i.selector] ?? '', type: 'text' })) } };
      }
      if (action.type === 'text') {
        const sel = typeof action.selector === 'string' ? action.selector : null;
        return { id: 'op', state: 'succeeded', result: { text: sel ? (page.fields[sel] ?? '') : 'Apply for a card' } };
      }
      if (action.type === 'evaluate') {
        const script = String(action.script);
        if (script.startsWith('/* hexactra:filled-among */')) {
          const sels = JSON.parse(/const sels = (\[.*?\]);/.exec(script)![1]!) as string[];
          const filled = JSON.parse(/const filled = (\[.*?\]);/.exec(script)![1]!) as string[];
          return { id: 'op', state: 'succeeded', result: { type: 'object', value: sels.filter((x) => filled.includes(x)) } };
        }
        if (script.startsWith('/* hexactra:cover-filled */')) {
          covers.push(JSON.parse(/for \(const s of (\[.*?\])\)/.exec(script)![1]!) as string[]);
          page.covered = true;
          return { id: 'op', state: 'succeeded', result: { type: 'boolean', value: true } };
        }
        if (script.startsWith('/* hexactra:uncover-filled */')) {
          page.covered = false;
          return { id: 'op', state: 'succeeded', result: { type: 'boolean', value: true } };
        }
        // run_javascript: it reads the input's value, as a page script would.
        const readSel = /querySelector\('([^']+)'\)\.value/.exec(script)?.[1];
        if (readSel) return { id: 'op', state: 'succeeded', result: { type: 'string', value: page.fields[readSel] ?? '' } };
        return { id: 'op', state: 'succeeded', result: { type: 'undefined', value: null } };
      }
      if (action.type === 'screenshot' || action.type === 'desktop_screenshot') {
        if (!state.screenshots) return { id: 'op', state: 'failed', error: 'no screenshots in this fake' };
        const marks = page.inputs.map((i, n) => ({ n: n + 1, selector: i.selector, tag: i.tag, text: page.fields[i.selector] ?? '', x: 10, y: 10 + n * 30, w: 100, h: 20 }));
        shots.push({ screen: action.type === 'screenshot' ? 'page' : 'desktop', covered: page.covered, markTexts: marks.map((m) => m.text) });
        return { id: 'op', state: 'succeeded', result: { mime: 'image/jpeg', data: 'AAAA', width: 800, height: 600, url: page.url, title: 'Form', marks, masked: action.mask === true ? 0 : undefined } };
      }
      if (action.type === 'secrets_lookup' && action.kind === 'identity') {
        providerCalls.push({ op: 'lookup', origin, kind: 'identity', ...meta });
        if (state.failAll && state.failAll !== 'origin_mismatch' && state.failAll !== 'typing_failed') return failure(state.failAll, 'lookup');
        const items = state.identities
          .map((i) => ({ i, allowed: i.allowedOrigins.includes(origin) }))
          .sort((a, b) => Number(b.allowed) - Number(a.allowed))
          .map(({ i, allowed }) => ({
            id: i.id,
            name: i.name,
            origins: [],
            match_kind: allowed ? 'exact' : 'site',
            has_code: false,
            fields: i.fields.map((f) => ({ key: f.key, label: f.label, sensitive: f.sensitive, usable_here: !f.sensitive || allowed })),
          }));
        state.afterLookup?.();
        return { id: 'op', state: 'succeeded', result: { origin, provider: 'test', items } };
      }
      if ((action.type === 'type_from_provider' || action.type === 'select_from_provider') && state.identities.some((i) => i.id === action.item_id)) {
        const field = String(action.field);
        providerCalls.push({ op: 'release', origin, itemId: String(action.item_id), field, purpose: (action.purpose as string | undefined) ?? 'form', ...(action.part ? { part: String(action.part) } : {}), ...meta });
        if (state.failAll) return failure(state.failAll, 'type');
        const next = state.failTyping.shift();
        if (next) return failure(next, 'type');
        const item = state.identities.find((i) => i.id === action.item_id)!;
        const f = item.fields.find((x) => x.key === field);
        if (!f) return { id: 'op', state: 'failed', error: 'not_found: no such field' };
        if (f.sensitive && new URL(page.url).protocol !== 'https:') return { id: 'op', state: 'failed', error: 'insecure_origin: this detail is only typed into a page that uses https; nothing was typed' };
        if (f.sensitive && !item.allowedOrigins.includes(origin)) return failure('origin_mismatch', 'type');
        page.fields[String(action.selector)] = action.type === 'select_from_provider' && action.part ? `${f.value}#${String(action.part)}` : f.value;
        return { id: 'op', state: 'succeeded', result: action.type === 'select_from_provider' ? { selected: true } : { typed: true } };
      }
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
  return { client, request, actions, handoffs, page, targets, state, providerCalls, typed, registrations, sessions, answer, shots, covers };
}

export type SecretsFabric = ReturnType<typeof fakeSecretsFabric>;
