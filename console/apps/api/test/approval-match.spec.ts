// Saved approval matching (#554): the registrable domain, the label
// normalisation, exact-only matching, scope, expiry, the amount limit, Pause
// all and specificity. Pure: no database.
import { findRule, normaliseLabel, normaliseRecipient, recipientCovered, recipientDomain, registrableDomain, ruleMatches, ruleSummary, type MatchQuery, type MatchableRule } from '../src/approvals/approval-match';

const NOW = new Date('2026-11-18T12:00:00.000Z');
const TASK = '11111111-1111-4111-8111-111111111111';
const OTHER_TASK = '22222222-2222-4222-8222-222222222222';
const CHAT = '33333333-3333-4333-8333-333333333333';

function rule(over: Partial<MatchableRule> = {}): MatchableRule {
  return { id: 'r1', kind: 'gate', host: 'bankofamerica.com', category: 'payment', matchKey: 'pay', taskId: null, conversationId: null, maxAmount: null, expiresAt: null, enabled: true, ...over };
}
function query(over: Partial<MatchQuery> = {}): MatchQuery {
  return { kind: 'gate', host: 'bankofamerica.com', category: 'payment', matchKey: 'pay', taskId: null, conversationId: null, amount: null, now: NOW, ...over };
}

describe('registrableDomain', () => {
  it.each([
    ['https://www.secure.bankofamerica.com/pay?x=1', 'bankofamerica.com'],
    ['https://bankofamerica.com/', 'bankofamerica.com'],
    ['http://BANKOFAMERICA.COM./x', 'bankofamerica.com'],
    ['https://secure.bankofamerica.com.evil.com/', 'evil.com'],
    ['https://bankofamerica.com.evil.test/', null],
    ['https://shop.example.co.uk/basket', 'example.co.uk'],
    ['https://someone.github.io/page', 'someone.github.io'],
    ['https://user:pw@www.example.com:8443/a', 'example.com'],
  ])('%s → %s', (url, domain) => {
    expect(registrableDomain(url)).toBe(domain);
  });

  it.each([
    ['https://127.0.0.1/pay'],
    ['http://[::1]/pay'],
    ['http://10.0.0.5:8080/'],
    ['http://localhost:3000/pay'],
    ['https://intranet/pay'],
    ['file:///home/user/pay.html'],
    ['data:text/html,<button>Pay</button>'],
    ['chrome://settings'],
    ['about:blank'],
    ['javascript:alert(1)'],
    ['not a url'],
    [''],
    [null],
    [undefined],
  ])('%s never matches (null)', (url) => {
    expect(registrableDomain(url as string | null | undefined)).toBeNull();
  });
});

describe('normaliseLabel', () => {
  it.each([
    ['Pay', 'pay'],
    ['  Pay  ', 'pay'],
    ['Pay $10.00', 'pay $#'],
    ['Pay $1,250.75 now', 'pay $# now'],
    ['Send   Money®', 'send money'],
    ['Zelle™ Send', 'zelle send'],
    ['Place your order.', 'place your order'],
    ['» Confirm transfer «', 'confirm transfer'],
    ['PAY\nNOW', 'pay now'],
    ['Checking ending 0659', 'checking ending #'],
    ['', ''],
  ])('%j → %j', (label, out) => {
    expect(normaliseLabel(label)).toBe(out);
  });

  it('caps at 200 characters', () => {
    expect(normaliseLabel('a'.repeat(500))).toHaveLength(200);
  });

  it('two amounts normalise to the same key', () => {
    expect(normaliseLabel('Pay $10.00')).toBe(normaliseLabel('Pay $975.10'));
  });
});

describe('ruleSummary', () => {
  it('reads as a plain sentence', () => {
    expect(ruleSummary({ kind: 'gate', host: 'bankofamerica.com', label: 'Pay' })).toBe("Press 'Pay' on bankofamerica.com");
    expect(ruleSummary({ kind: 'ask', host: 'bankofamerica.com', topic: 'choose_date' })).toBe('Choose dates on bankofamerica.com');
  });
});

describe('findRule', () => {
  it('matches on equal host, kind, category and key', () => {
    expect(findRule([rule()], query())?.id).toBe('r1');
  });

  it('matches exactly only: "pay" does not match "pay all" or "prepay"', () => {
    expect(findRule([rule()], query({ matchKey: 'pay all' }))).toBeNull();
    expect(findRule([rule()], query({ matchKey: 'prepay' }))).toBeNull();
    expect(findRule([rule({ matchKey: 'pay all' })], query({ matchKey: 'pay' }))).toBeNull();
  });

  it('never matches on another host, a look-alike host or an unknown host', () => {
    expect(findRule([rule()], query({ host: 'chase.com' }))).toBeNull();
    expect(findRule([rule()], query({ host: registrableDomain('https://bankofamerica.com.evil.test/') }))).toBeNull();
    expect(findRule([rule()], query({ host: null }))).toBeNull();
    expect(findRule([rule()], query({ host: registrableDomain('http://localhost/') }))).toBeNull();
  });

  it('needs the same kind and category', () => {
    expect(findRule([rule()], query({ category: 'send' }))).toBeNull();
    expect(findRule([rule()], query({ kind: 'ask', category: null }))).toBeNull();
    const ask = rule({ kind: 'ask', category: null, matchKey: 'choose_date' });
    expect(findRule([ask], query({ kind: 'ask', category: null, matchKey: 'choose_date' }))?.id).toBe('r1');
    expect(findRule([ask], query({ kind: 'ask', category: null, matchKey: 'open_menu' }))).toBeNull();
  });

  it('never matches the ask topic `other`', () => {
    expect(findRule([rule({ kind: 'ask', category: null, matchKey: 'other' })], query({ kind: 'ask', category: null, matchKey: 'other' }))).toBeNull();
  });

  it('honours a task or chat scope', () => {
    const scoped = rule({ taskId: TASK });
    expect(findRule([scoped], query({ taskId: TASK }))?.id).toBe('r1');
    expect(findRule([scoped], query({ taskId: OTHER_TASK }))).toBeNull();
    expect(findRule([scoped], query({ taskId: null, conversationId: CHAT }))).toBeNull();
    const chat = rule({ conversationId: CHAT });
    expect(findRule([chat], query({ conversationId: CHAT }))?.id).toBe('r1');
    expect(findRule([chat], query({ taskId: TASK }))).toBeNull();
  });

  it('expires', () => {
    expect(findRule([rule({ expiresAt: new Date(NOW.getTime() + 1000) })], query())?.id).toBe('r1');
    expect(findRule([rule({ expiresAt: new Date(NOW.getTime()) })], query())).toBeNull();
    expect(findRule([rule({ expiresAt: new Date(NOW.getTime() - 1000) })], query())).toBeNull();
  });

  it('with maxAmount: a known amount up to it passes; a larger or unknown amount does not', () => {
    const limited = rule({ maxAmount: '50.00' });
    expect(findRule([limited], query({ amount: 25 }))?.id).toBe('r1');
    expect(findRule([limited], query({ amount: 50 }))?.id).toBe('r1');
    expect(findRule([limited], query({ amount: 75 }))).toBeNull();
    expect(findRule([limited], query({ amount: null }))).toBeNull();
    expect(findRule([limited], query({ amount: undefined }))).toBeNull();
    expect(findRule([limited], query({ amount: Number.NaN }))).toBeNull();
    expect(findRule([rule({ maxAmount: 50 })], query({ amount: 49.99 }))?.id).toBe('r1');
  });

  it('a disabled rule and Pause all never match', () => {
    expect(findRule([rule({ enabled: false })], query())).toBeNull();
    expect(findRule([rule()], query({ paused: true }))).toBeNull();
    expect(ruleMatches(rule(), query({ paused: true }))).toBe(false);
  });

  it('the most specific match wins: scoped before unscoped', () => {
    const everywhere = rule({ id: 'everywhere' });
    const task = rule({ id: 'task', taskId: TASK });
    const limited = rule({ id: 'limited', maxAmount: 100 });
    expect(findRule([everywhere, task], query({ taskId: TASK }))?.id).toBe('task');
    expect(findRule([task, everywhere], query({ taskId: TASK }))?.id).toBe('task');
    expect(findRule([everywhere, limited], query({ amount: 10 }))?.id).toBe('limited');
    expect(findRule([everywhere, task], query({ taskId: OTHER_TASK }))?.id).toBe('everywhere');
  });

  it('no rules, no match', () => {
    expect(findRule([], query())).toBeNull();
  });
});

describe('connection rules (E39.7)', () => {
  const CONN = '44444444-4444-4444-8444-444444444444';
  const connRule = (over: Partial<MatchableRule> = {}) => rule({ kind: 'connection', host: CONN, category: null, matchKey: 'mail_send', recipients: ['person-b@example.test'], ...over });
  const connQuery = (over: Partial<MatchQuery> = {}) => query({ kind: 'connection', host: CONN, category: null, matchKey: 'mail_send', recipients: ['person-b@example.test'], ...over });

  it('normalises recipients: lower-case addresses and whole domains, nothing else', () => {
    expect(normaliseRecipient('  Person-B@Example.TEST ')).toBe('person-b@example.test');
    expect(normaliseRecipient('@Example.test')).toBe('@example.test');
    for (const bad of ['', 'person', 'person@', '@', '*@example.test', '*', 'a@b@example.test', 'a b@example.test', 'a@example', 'a@exa mple.test', '<a@example.test>', '@.test', 'a,b@example.test']) expect([bad, normaliseRecipient(bad)]).toEqual([bad, null]);
    expect(recipientDomain('Person-B@Example.test')).toBe('@example.test');
    expect(recipientDomain('@example.test')).toBeNull();
  });

  it('covers an address by itself or by its exact domain, never by a subdomain, a look-alike or "anyone"', () => {
    expect(recipientCovered(['person-b@example.test'], 'PERSON-B@example.test')).toBe(true);
    expect(recipientCovered(['person-b@example.test'], 'person-c@example.test')).toBe(false);
    expect(recipientCovered(['@example.test'], 'person-c@example.test')).toBe(true);
    expect(recipientCovered(['@example.test'], 'person-c@mail.example.test')).toBe(false);
    expect(recipientCovered(['@example.test'], 'person-c@example.test.evil.test')).toBe(false);
    expect(recipientCovered([], 'person-b@example.test')).toBe(false);
    expect(recipientCovered(['*'], 'person-b@example.test')).toBe(false);
    expect(recipientCovered(['@example.test'], '@example.test')).toBe(false);
  });

  it('matches the same connection, tool and recipients', () => {
    expect(findRule([connRule()], connQuery())?.id).toBe('r1');
  });

  it('asks again for a new recipient, even when the others are covered', () => {
    expect(findRule([connRule()], connQuery({ recipients: ['person-b@example.test', 'person-c@example.test'] }))).toBeNull();
    expect(findRule([connRule({ recipients: ['@example.test'] })], connQuery({ recipients: ['person-b@example.test', 'person-c@example.test'] }))?.id).toBe('r1');
  });

  it('covers a call that reaches no one, and a rule with no recipients covers no one', () => {
    expect(findRule([connRule({ matchKey: 'sheet_append_rows', recipients: [] })], connQuery({ matchKey: 'sheet_append_rows', recipients: [] }))?.id).toBe('r1');
    expect(findRule([connRule({ recipients: [] })], connQuery())).toBeNull();
  });

  it('needs the same connection and the same tool, and is not covered by a gate or an ask rule', () => {
    expect(findRule([connRule()], connQuery({ host: '55555555-5555-4555-8555-555555555555' }))).toBeNull();
    expect(findRule([connRule()], connQuery({ matchKey: 'calendar_create_event' }))).toBeNull();
    expect(findRule([rule({ kind: 'ask', host: CONN, category: null, matchKey: 'mail_send' })], connQuery())).toBeNull();
    expect(findRule([rule({ host: CONN, matchKey: 'mail_send', category: null })], connQuery())).toBeNull();
    expect(findRule([connRule()], connQuery({ paused: true }))).toBeNull();
  });

  it('words the rule from the connection and the tool', () => {
    expect(ruleSummary({ kind: 'connection', host: CONN, label: 'Work', topic: 'mail_send' })).toBe('mail send with Work');
  });
});
