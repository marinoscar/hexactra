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

/** The cards of the fabric's `test` provider (E37.7, crates/hexactra-credential-resolver/src/test_provider.rs): published test numbers, granted for `CARD.merchant`. */
export const CARD = {
  id: 'test-card-1',
  id2: 'test-card-2',
  merchant: 'https://shop.example.com',
  /** The page the checkout is on: a subdomain of the merchant (grants match by registrable domain). */
  checkout: 'https://checkout.shop.example.com/pay',
  frame: 'https://pay.processor.example.net',
  number: '4242424242424242',
  expMonth: '09',
  expYear: '2031',
  /** What a combined expiry input holds after the fabric composed it. */
  expiry: '09/31',
  holder: 'Person A',
  postal: 'K1A 0B1',
  cvv: 'CANARY-CVV-4401',
  number2: '5555555555554444',
  cvv2: 'CANARY-CVV-9902',
} as const;

export interface TestCard {
  id: string;
  name: string;
  brand: string;
  number: string;
  expMonth: string;
  expYear: string;
  holder: string;
  postal: string;
  cvv: string;
  merchant: string;
  frames: string[];
  maxAmount: number;
  currency: string;
  includeSecurityCode: boolean;
}

export const defaultCards = (): TestCard[] => [
  { id: CARD.id, name: 'Everyday card', brand: 'visa', number: CARD.number, expMonth: CARD.expMonth, expYear: CARD.expYear, holder: CARD.holder, postal: CARD.postal, cvv: CARD.cvv, merchant: CARD.merchant, frames: [CARD.frame], maxAmount: 500, currency: 'USD', includeSecurityCode: true },
  { id: CARD.id2, name: 'Virtual card', brand: 'mastercard', number: CARD.number2, expMonth: '03', expYear: '2030', holder: CARD.holder, postal: CARD.postal, cvv: CARD.cvv2, merchant: CARD.merchant, frames: [], maxAmount: 20, currency: 'USD', includeSecurityCode: false },
];

/** The registrable domain, as far as the fixture needs: the last two labels. */
const site = (origin: string) => new URL(origin).hostname.split('.').slice(-2).join('.');

export type FailMode = 'unavailable' | 'disabled' | 'unauthorized' | 'rate_limited' | 'origin_mismatch' | 'typing_failed' | 'amount_exceeded' | 'limit_reached' | 'grant_expired' | 'cards_disabled';

interface Handoff {
  id: string;
  status: string;
  input: string;
  kind: string;
  prompt?: string;
  options?: unknown;
  response?: Record<string, unknown>;
  /** Created with `offer_save` (E37.4b): the fabric keeps the typed password after `type_secret` types it. */
  offerSave?: boolean;
  /** The password the person gave, until a `type_secret` action consumes it: the only place it lives besides the page. */
  secret?: string;
  /** The copy kept for saving the sign-in, with the time the fabric stops holding it (`expiresAt`, ms since the epoch). */
  offer?: { password: string; expiresAt: number };
}

/** One save-login call the fake fabric received (never the password). */
export interface SaveCall {
  owner: string;
  provider: string;
  handoffId: string;
  name: string;
  origin: string;
  runId?: string;
  clientLabel?: string;
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
    /**
     * What is at a viewport point (E37.7): an embedded frame's origin, or `null` for a frame whose origin cannot be determined.
     * A point not listed is the page itself. Keys are `x,y`.
     */
    frames: {} as Record<string, string | null>,
    /** Whether a visible password field is on the page (E37.4b): the sign-in form is still there. */
    passwordShown: false,
  };
  /** Every screenshot taken, with whether the cover was drawn and what the marks said. */
  const shots: { screen: string; covered: boolean; hasValues: boolean; markTexts: string[] }[] = [];
  const covers: string[][] = [];
  /** The points covered (E37.7) in each cover drawn: a frame's field is covered by the element at its point. */
  const coverPoints: { x: number; y: number }[][] = [];
  const targets = new Map<string, Record<string, unknown> | null>([['#pay', { tag: 'button', label: 'Pay' }]]);
  /** The page's controls for the surface graph's queries (E46.13). */
  const surface: Record<string, unknown>[] = [];
  /** What the interrupt snapshot reads (E46.15). */
  const snapshot: { title?: string; text?: string; frames?: string[] } = {};
  /** What the provider was asked (never a value). */
  const providerCalls: { op: 'lookup' | 'release' | 'one_time_code'; origin: string; itemId?: string; field?: string; purpose?: string; clientLabel?: string; runId?: string; kind?: string; part?: string; amount?: string; currency?: string; frameOrigin?: string | null }[] = [];
  const registrations: { owner: string; provider: string; kind: string }[] = [];
  const sessions: Record<string, unknown>[] = [];
  const state = {
    /** Hexactra passkeys (E47.5): what the fabric answers to passkey_sign_in and passkey_create ('ok', or a failure code). */
    passkeys: { signIn: 'ok', create: 'ok', rpId: 'example.com' },
    items: defaultItems(),
    identities: defaultIdentities(),
    cards: defaultCards(),
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
    /** Selectors that name something other than a password field: the fabric refuses a login's password there (E37.10), before the provider is asked. */
    notPassword: [] as string[],
    /** Where a save goes (E37.4b): the fake Vault's address and the access token the fabric would hold for the owner. Without it the save only records the call. */
    vault: null as null | { baseUrl: string; token: string },
    /** How long the fabric holds the password after the person answered (the real one: ten minutes). */
    offerTtlMs: 10 * 60_000,
    /** Fail the next save with this HTTP status and code (the fabric's `{ error }`). */
    failSave: null as null | { status: number; code: string },
  };
  /** Every save-login call, oldest first (E37.4b). */
  const saves: SaveCall[] = [];

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
    // "Save this login?" (E37.4b): the fabric sends the password it still holds to the provider's create route.
    const save = /^\/v1\/secrets-providers\/([^/]+)\/([^/]+)\/save-login$/.exec(path);
    if (save && method === 'POST') {
      const b = opts.body!;
      const call: SaveCall = { owner: decodeURIComponent(save[1]!), provider: decodeURIComponent(save[2]!), handoffId: String(b.handoff_id), name: String(b.name), origin: String(b.origin), ...(b.run_id ? { runId: String(b.run_id) } : {}), ...(b.client_label ? { clientLabel: String(b.client_label) } : {}) };
      saves.push(call);
      const gone = () => new FabricError('api', 'the password is no longer held', 409, 'secret_unavailable');
      const h = handoffs.get(call.handoffId);
      if (!h || !h.offerSave) throw new FabricError('api', 'handoff not found', 404, 'not_found');
      if (state.failSave) throw new FabricError('api', state.failSave.code, state.failSave.status, state.failSave.code);
      if (!h.offer || h.offer.expiresAt <= Date.now()) throw gone();
      const password = h.offer.password;
      // The built-in store (#712) is the console's own: its save route has its own test (secrets-store.db.spec.ts).
      if (!state.vault || call.provider === 'builtin') {
        delete h.offer;
        return { saved: true, item_id: 'saved-1' };
      }
      // Taken out while the call runs (one save at a time); put back unless it was saved.
      const offer = h.offer;
      delete h.offer;
      const res = await fetch(`${state.vault.baseUrl}/api/agent/v1/credentials`, {
        method: 'POST',
        headers: { authorization: `Bearer ${state.vault.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: call.name, username: h.response?.value, origin: call.origin, purpose: 'save_login', password }),
      });
      if (res.status === 201) return { saved: true, item_id: ((await res.json()) as { data: { id: string } }).data.id };
      h.offer = offer;
      if (res.status === 409) throw new FabricError('api', 'name_taken', 409, 'name_taken');
      if (res.status === 401) throw new FabricError('api', 'unauthorized', 502, 'unauthorized');
      throw new FabricError('api', 'refused', 422, 'refused');
    }
    const reg = /^\/v1\/secrets-providers\/([^/]+)\/([^/]+)$/.exec(path);
    if (reg && method === 'PUT') {
      registrations.push({ owner: decodeURIComponent(reg[1]!), provider: decodeURIComponent(reg[2]!), kind: String(opts.body?.kind) });
      return { owner_id: reg[1], provider: reg[2], kind: opts.body?.kind, registered_at: new Date().toISOString() };
    }
    if (method === 'POST' && path.endsWith('/actions')) {
      const action = opts.body!.action as Record<string, unknown>;
      // The surface graph's page queries (E46.13) read the page like describe-target: not actions, answered from `surface`.
      if (action.type === 'evaluate' && String(action.script).startsWith('/* hexactra:surface-snapshot */')) return { id: 'op', state: 'succeeded', result: { type: 'object', value: { url: page.url, title: snapshot.title ?? '', text: snapshot.text ?? '', frames: snapshot.frames ?? [] } } };
      if (action.type === 'evaluate' && String(action.script).startsWith('/* hexactra:surface-elements */')) return { id: 'op', state: 'succeeded', result: { type: 'object', value: surface } };
      if (action.type === 'evaluate' && String(action.script).startsWith('/* hexactra:surface-describe */')) {
        const where = JSON.parse(/const where = (.*);/.exec(String(action.script))![1]!) as { selector?: string };
        return { id: 'op', state: 'succeeded', result: { type: 'object', value: surface.find((e) => e.selector === where.selector || (e.selectors as string[] | undefined)?.includes(where.selector ?? '')) ?? null } };
      }
      if (action.type === 'evaluate' && String(action.script).startsWith('/* hexactra:describe-target */')) {
        const where = JSON.parse(/const where = (.*);/.exec(String(action.script))![1]!) as { selector?: string; x?: number; y?: number };
        return { id: 'op', state: 'succeeded', result: { type: 'object', value: targets.get(where.selector ?? `${where.x},${where.y}`) ?? null } };
      }
      actions.push(action);
      // The agent types the person's password (E37.4b): the page gets it, and the fabric keeps a copy only for a handoff opened with `offer_save`.
      if (action.type === 'type_secret') {
        const h = handoffs.get(String(action.handoff_id));
        if (!h?.secret) return { id: 'op', state: 'failed', error: 'secret_unavailable: the secret was already used or expired' };
        page.fields[String(action.selector)] = h.secret;
        if (h.offerSave && h.input === 'credentials') h.offer = { password: h.secret, expiresAt: (h.response?.answeredAtMs as number | undefined ?? Date.now()) + state.offerTtlMs };
        delete h.secret;
        return { id: 'op', state: 'succeeded', result: {} };
      }
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
        if (script.startsWith('/* hexactra:password-shown */')) return { id: 'op', state: 'succeeded', result: { type: 'boolean', value: page.passwordShown } };
        if (script.startsWith('/* hexactra:filled-among */')) {
          const sels = JSON.parse(/const sels = (\[.*?\]);/.exec(script)![1]!) as string[];
          const filled = JSON.parse(/const filled = (\[.*?\]);/.exec(script)![1]!) as string[];
          return { id: 'op', state: 'succeeded', result: { type: 'object', value: sels.filter((x) => filled.includes(x)) } };
        }
        if (script.startsWith('/* hexactra:cover-filled */')) {
          covers.push(JSON.parse(/for \(const s of (\[.*?\])\)/.exec(script)![1]!) as string[]);
          coverPoints.push(JSON.parse(/for \(const pt of (\[.*?\])\)/.exec(script)![1]!) as { x: number; y: number }[]);
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
        shots.push({ screen: action.type === 'screenshot' ? 'page' : 'desktop', covered: page.covered, hasValues: Object.keys(page.fields).length > 0, markTexts: marks.map((m) => m.text) });
        return { id: 'op', state: 'succeeded', result: { mime: 'image/jpeg', data: 'AAAA', width: 800, height: 600, url: page.url, title: 'Form', marks, masked: action.mask === true ? 0 : undefined } };
      }
      if (action.type === 'passkey_sign_in' || action.type === 'passkey_create') {
        const outcome = action.type === 'passkey_sign_in' ? state.passkeys.signIn : state.passkeys.create;
        if (outcome !== 'ok') return { id: 'op', state: 'failed', error: `${outcome}: the passkey step did not happen` };
        return { id: 'op', state: 'succeeded', result: action.type === 'passkey_sign_in' ? { signed_in: true, rp_id: state.passkeys.rpId } : { created: true, rp_id: state.passkeys.rpId, user_name: 'person-a@example.test' } };
      }
      if (action.type === 'secrets_lookup' && action.kind === 'card') {
        providerCalls.push({ op: 'lookup', origin, kind: 'card', ...meta });
        if (state.failAll && state.failAll !== 'origin_mismatch' && state.failAll !== 'typing_failed') return failure(state.failAll, 'lookup');
        const items = state.cards
          .filter((c) => site(c.merchant) === site(origin))
          .map((c) => ({
            id: c.id,
            name: c.name,
            origins: [],
            match_kind: 'exact',
            has_code: false,
            card: { brand: c.brand, last4: c.number.slice(-4), exp_month: c.expMonth, exp_year: c.expYear, grant: { max_amount: c.maxAmount.toFixed(2), currency: c.currency, includes_security_code: c.includeSecurityCode, expires_at: null } },
          }));
        return { id: 'op', state: 'succeeded', result: { origin, provider: 'test', items } };
      }
      if (action.type === 'type_card_field') {
        const field = String(action.field);
        const point = action.point as { x: number; y: number } | undefined;
        const frame = point ? page.frames[`${point.x},${point.y}`] : undefined;
        providerCalls.push({ op: 'release', origin, itemId: String(action.item_id), field, purpose: 'purchase', amount: String(action.amount), currency: String(action.currency), frameOrigin: frame ?? null, ...meta });
        if (state.crashOn === field) {
          state.crashOn = null;
          throw new Error('the process crashed');
        }
        if (new URL(page.url).protocol !== 'https:') return { id: 'op', state: 'failed', error: 'insecure_origin: a card is only typed into a page that uses https; nothing was typed' };
        if (frame === null) return { id: 'op', state: 'failed', error: "frame_unknown: the frame's origin cannot be determined; nothing was typed" };
        if (state.failAll) return failure(state.failAll, 'type');
        const next = state.failTyping.shift();
        if (next) return failure(next, 'type');
        const card = state.cards.find((c) => c.id === action.item_id);
        if (!card) return { id: 'op', state: 'failed', error: 'not_found: no such item' };
        if (site(card.merchant) !== site(origin)) return failure('origin_mismatch', 'type');
        if (frame && !card.frames.includes(frame)) return failure('origin_mismatch', 'type');
        if (String(action.currency) !== card.currency) return { id: 'op', state: 'failed', error: 'currency_mismatch: the currency is not the grant\'s' };
        if (Number(action.amount) > card.maxAmount) return failure('amount_exceeded', 'type');
        if (field === 'security_code' && !card.includeSecurityCode) return { id: 'op', state: 'failed', error: 'security_code_not_granted: the grant does not include the security code' };
        const value =
          field === 'number' ? card.number : field === 'expiry' ? `${card.expMonth}/${card.expYear.slice(-2)}` : field === 'exp_month' ? card.expMonth : field === 'exp_year' ? card.expYear : field === 'holder_name' ? card.holder : field === 'postal_code' ? card.postal : card.cvv;
        // The value goes into the page's own field (or the frame's) and nowhere else.
        page.fields[action.selector ? String(action.selector) : `point:${point!.x},${point!.y}`] = value;
        return { id: 'op', state: 'succeeded', result: frame ? { typed: true, frame_origin: frame } : { typed: true } };
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
        if (!isCode && field === 'password' && state.notPassword.includes(String(action.selector))) {
          return { id: 'op', state: 'failed', error: 'target_not_password: that field is not a password field; a saved password is only typed into one. Nothing was typed' };
        }
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
      handoffs.set(id, { id, status: 'pending', input: String(body.input), kind: String(body.kind), prompt: body.prompt as string, options: body.choices, ...(body.offer_save === true ? { offerSave: true } : {}) });
      return { handoff: { id } };
    }
    // The broker answers a handoff through the fabric (`QuestionsService.answer`).
    if (method === 'POST' && /\/v1\/handoffs\/[^/]+\/respond$/.test(path)) {
      const h = handoffs.get(path.split('/')[3]!);
      if (!h) return {};
      Object.assign(h, {
        status: 'completed',
        response: { outcome: opts.body!.outcome, value: opts.body!.value, value_withheld: typeof opts.body!.secret === 'string', answeredAtMs: Date.now() },
        // A sign-in's password travels in this call only and is held here, as the fabric holds it.
        ...(typeof opts.body!.secret === 'string' ? { secret: opts.body!.secret } : {}),
      });
      return {};
    }
    if (method === 'POST' && /\/v1\/handoffs\/[^/]+\/cancel$/.test(path)) return {};
    if (method === 'GET' && path.startsWith('/v1/handoffs/')) return handoffs.get(path.split('/')[3]!);
    throw new FabricError('api', 'unexpected', 500, `unexpected ${method} ${path}`);
  });

  const client = { request, config: async () => ({ url: 'http://f', token: 't' }) } as unknown as FabricClient;
  /** The provider's typing calls, oldest first. */
  const typed = () => providerCalls.filter((c) => c.op !== 'lookup');
  /** Answer the handoff the way the fabric reports a finished one. */
  const answer = (h: Handoff, response: Record<string, unknown>) => Object.assign(h, { status: 'completed', response: { outcome: 'completed', value_withheld: false, ...response } });
  return { client, request, actions, handoffs, page, targets, surface, snapshot, state, providerCalls, typed, registrations, sessions, answer, shots, covers, coverPoints, saves };
}

export type SecretsFabric = ReturnType<typeof fakeSecretsFabric>;
