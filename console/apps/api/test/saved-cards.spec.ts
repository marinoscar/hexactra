// The pure side of saved cards (E37.7, #596): amounts, the model's view, the error-to-instruction table, the approval's matching.
import { cardMatchKey, cardRefOf, findRule, ruleMatches, type MatchableRule, type MatchQuery } from '../src/approvals/approval-match';
import { cardCovers, reconcileCardsOnStart } from '../src/runner/saved-card-tools';
import {
  amountOfCents,
  amountsAgree,
  appendUsedSavedCard,
  cardFailureOf,
  cardForModel,
  cardLookupOf,
  cardLookupText,
  cardWords,
  cents,
  isAmount,
  normaliseAmount,
  normaliseCurrency,
  readUsedSavedCards,
  type SavedCardsMemory,
} from '../src/runner/saved-cards';
import { SECRETS_ERROR_CODES, type ItemSummary } from '../src/secrets/secrets-provider.port';

describe('amounts', () => {
  it('reads plain decimals with at most two places and nothing else', () => {
    for (const [raw, out] of [['42.5', '42.50'], ['7', '7.00'], ['$ 7', null], ['1,234.50', '1234.50'], ['$9.99', '9.99'], ['0', null], ['0.00', null], ['-5', null], ['1e3', null], ['12.345', null], ['10000000.01', null], ['10000000', '10000000.00'], ['forty', null], ['', null]] as const) {
      expect(normaliseAmount(raw)).toBe(out);
    }
    expect(normaliseAmount(42.5)).toBe('42.50');
    expect(normaliseAmount(Number.NaN)).toBeNull();
    expect(isAmount('42.50') && isAmount('7') && !isAmount('0.00') && !isAmount('4242 4242 4242 4242')).toBe(true);
    expect(cents('42.5')).toBe(4250);
    expect(amountOfCents(4205)).toBe('42.05');
    expect(normaliseCurrency(' usd ')).toBe('USD');
    expect(normaliseCurrency('US')).toBeNull();
    expect(normaliseCurrency('US$')).toBeNull();
  });

  it('agrees within one cent or one percent, whichever is larger, and not beyond', () => {
    expect(amountsAgree('100.00', '100.00')).toBe(true);
    expect(amountsAgree('100.00', '100.99')).toBe(true);
    expect(amountsAgree('100.00', '101.00')).toBe(true);
    expect(amountsAgree('100.00', '101.01')).toBe(false);
    expect(amountsAgree('100.00', '99.00')).toBe(true);
    expect(amountsAgree('100.00', '98.99')).toBe(false);
    expect(amountsAgree('0.50', '0.51')).toBe(true);
    expect(amountsAgree('0.50', '0.52')).toBe(false);
    expect(amountsAgree('100.00', 'x')).toBe(false);
  });
});

describe('what a run records', () => {
  const entry = { provider: 'vault', itemName: 'Everyday card', brand: 'visa', last4: '4242', merchant: 'shop.example.com', origin: 'https://shop.example.com', currency: 'USD', declaredAmount: '42.50', at: new Date('2026-11-19T10:00:00Z') };

  it('keeps brand, last four and amounts, ten at most, and drops a malformed entry or a long digit run', () => {
    const one = appendUsedSavedCard(null, entry);
    expect(one).toEqual([{ ...entry, at: '2026-11-19T10:00:00.000Z', confirmedAmount: null, mismatch: false }]);
    // A "last four" that is more than four digits is never stored.
    expect(appendUsedSavedCard(null, { ...entry, last4: '4242424242424242' })[0]!.last4).toBeNull();
    let many: unknown = null;
    for (let i = 0; i < 14; i += 1) many = appendUsedSavedCard(many, entry);
    expect(readUsedSavedCards(many)).toHaveLength(10);
    expect(readUsedSavedCards([{ provider: 'vault' }, null, 5, { ...one[0], declaredAmount: '4242 4242 4242 4242' }, { ...one[0], currency: 'usd' }])).toEqual([]);
    expect(readUsedSavedCards('x')).toEqual([]);
  });
});

describe('the model\'s view of a lookup', () => {
  const item = (over: Partial<ItemSummary> = {}): ItemSummary => ({
    id: 'card-id-1',
    name: 'Everyday  card',
    origins: [],
    matchKind: 'exact',
    hasCode: false,
    card: { brand: 'visa', last4: '4242', expMonth: '09', expYear: '2031', grant: { maxAmount: '500.00', currency: 'USD', includesSecurityCode: false, expiresAt: null } },
    ...over,
  });

  it('shows a reference, the brand, the last four and the limit; never the provider id, the expiry or a number', () => {
    const memory: SavedCardsMemory = { refs: {} };
    const lookup = cardLookupOf(memory, { origin: 'https://shop.example.com', provider: 'vault', items: [item()] });
    const model = cardForModel(lookup.cards[0]!);
    expect(model).toEqual({ ref: 'card-1', name: 'Everyday card', brand: 'visa', last4: '4242', limit: 'up to 500.00 USD at this shop', expires: null, securityCode: 'not allowed: ask the owner to type it' });
    const text = cardLookupText(lookup, false);
    expect(text).not.toContain('card-id-1');
    expect(text).not.toContain('2031');
    expect(JSON.stringify(memory)).not.toContain('2031');
    expect(cardWords(lookup.cards[0]!)).toBe('Visa ending 4242');
    // The reference is stable within a run, and the card ref a rule is bound to is the provider's and the id.
    expect(cardLookupOf(memory, { origin: 'https://shop.example.com', provider: 'vault', items: [item()] }).cards[0]!.ref).toBe('card-1');
    expect(lookup.cards[0]!.cardRef).toBe('vault:card-id-1');
    expect(memory.seenCards).toEqual([{ itemId: 'card-id-1', provider: 'vault', name: 'Everyday card' }]);
  });

  it('drops a card with no grant, an amount that is not an amount or an id that cannot be a reference; a last four with more digits is cut', () => {
    const memory: SavedCardsMemory = { refs: {} };
    const bad = [
      item({ id: 'a', card: { brand: 'visa', last4: '4242' } }),
      item({ id: 'b', card: { grant: { maxAmount: 'lots', currency: 'USD', includesSecurityCode: false } } }),
      item({ id: 'bad id!', card: { grant: { maxAmount: '5.00', currency: 'USD', includesSecurityCode: false } } }),
      item({ id: 'c', card: { last4: '4242424242424242', grant: { maxAmount: '5.00', currency: 'USD', includesSecurityCode: true } } }),
      item({ id: 'd', card: undefined }),
    ];
    const cards = cardLookupOf(memory, { origin: 'https://shop.example.com', provider: 'vault', items: bad }).cards;
    expect(cards.map((c) => c.itemId)).toEqual(['c']);
    expect(cards[0]!.last4).toBeNull();
    expect(cardLookupText({ origin: 'https://shop.example.com', provider: 'vault', cards: [] }, false)).toMatch(/^none: .*Do not enter a card yourself/);
  });
});

describe('the error-to-instruction table', () => {
  it('has a row for every code a provider can answer, none lets the model type a card itself, and none carries a provider message', () => {
    for (const code of SECRETS_ERROR_CODES) {
      const f = cardFailureOf(code, 7);
      expect(f.text.length).toBeGreaterThan(10);
      expect(f.summary.length).toBeGreaterThan(3);
      expect(f.text).not.toMatch(/type (it|the card) yourself(?!\.| \()/i);
    }
    // The rows that matter, by what the model is told to do next.
    expect(cardFailureOf('origin_mismatch').warn).toBe(true);
    expect(cardFailureOf('origin_mismatch').text).toContain('do not try another card');
    expect(cardFailureOf('amount_exceeded').text).toContain('do not try another card, another amount');
    expect(cardFailureOf('security_code_not_granted').text).toContain('type_handoff_secret');
    expect(cardFailureOf('frame_unknown').text).toContain('Do not type the card yourself');
    expect(cardFailureOf('insecure_origin').text).toContain('https');
    expect(cardFailureOf('unauthorized').outcome).toBe('UNAUTHORIZED');
    expect(cardFailureOf('rate_limited', 7).text).toContain('7 seconds');
    expect(cardFailureOf('rate_limited', 7).outcome).toBe('RATE_LIMITED');
    expect(cardFailureOf('unavailable').outcome).toBe('UNAVAILABLE');
    expect(cardFailureOf('grant_expired').warn).toBe(false);
  });
});

describe('matching a saved approval for a card', () => {
  const rule = (over: Partial<MatchableRule> = {}): MatchableRule => ({
    id: 'r1',
    kind: 'gate',
    host: 'example.com',
    category: 'payment',
    matchKey: cardMatchKey('USD'),
    taskId: null,
    conversationId: null,
    cardRef: 'vault:card-1',
    maxAmount: 100,
    expiresAt: null,
    enabled: true,
    ...over,
  });
  const q = (over: Partial<MatchQuery> = {}): MatchQuery => ({ kind: 'gate', host: 'example.com', category: 'payment', matchKey: cardMatchKey('USD'), cardRef: 'vault:card-1', taskId: null, conversationId: null, amount: 60, now: new Date(), ...over });

  it('matches the same site, card, currency and an amount under the limit, and nothing else', () => {
    expect(ruleMatches(rule(), q())).toBe(true);
    expect(ruleMatches(rule(), q({ amount: 100 }))).toBe(true);
    expect(ruleMatches(rule(), q({ amount: 100.01 }))).toBe(false);
    expect(ruleMatches(rule(), q({ amount: null }))).toBe(false);
    expect(ruleMatches(rule(), q({ cardRef: 'vault:card-2' }))).toBe(false);
    expect(ruleMatches(rule(), q({ cardRef: null }))).toBe(false);
    expect(ruleMatches(rule(), q({ host: 'example.org' }))).toBe(false);
    expect(ruleMatches(rule(), q({ matchKey: cardMatchKey('EUR') }))).toBe(false);
    expect(ruleMatches(rule({ enabled: false }), q())).toBe(false);
    expect(ruleMatches(rule({ expiresAt: new Date(Date.now() - 1000) }), q())).toBe(false);
  });

  it('a card rule has a limit or matches nothing, and a rule for no card never covers a card use', () => {
    expect(ruleMatches(rule({ maxAmount: null }), q())).toBe(false);
    // The site-wide label rule of #555, keyed on "pay": it does not cover a card query, and a card rule does not cover a click.
    const label = rule({ cardRef: null, matchKey: 'pay', maxAmount: null });
    expect(ruleMatches(label, q())).toBe(false);
    expect(ruleMatches(rule(), { ...q(), cardRef: null, matchKey: 'pay' })).toBe(false);
    expect(findRule([label, rule()], q())?.id).toBe('r1');
  });

  it('the card reference and the key are built from plain parts only', () => {
    expect(cardRefOf('vault', 'abc-123')).toBe('vault:abc-123');
    expect(cardRefOf('Vault', 'abc')).toBeNull();
    expect(cardRefOf('vault', 'a b')).toBeNull();
    expect(cardMatchKey(' USD ')).toBe('saved card usd');
  });
});

describe('the pay click and a crash', () => {
  const mem = (approval: SavedCardsMemory['approval']): SavedCardsMemory => ({ refs: {}, approval });
  const approval = (over: Record<string, unknown> = {}) => ({ cardRef: 'vault:c', itemId: 'c', provider: 'vault', site: 'example.com', amount: '10.00', currency: 'USD', via: 'owner' as const, typed: true, ...over });
  const target = (over: Record<string, unknown> = {}) => ({ category: 'payment' as const, label: 'Pay now', host: 'checkout.shop.example.com', ...over });

  it('covers the pay button of the approved shop after the card is typed, once, and never after a payment that may have happened', () => {
    expect(cardCovers(mem(approval()), target())).toBe(true);
    expect(cardCovers(mem(approval({ typed: false })), target())).toBe(false);
    expect(cardCovers(mem(approval({ pay: 'done' })), target())).toBe(false);
    expect(cardCovers(mem(approval({ pay: 'unknown' })), target())).toBe(false);
    expect(cardCovers({ ...mem(approval()), paymentUnknown: true }, target())).toBe(false);
    expect(cardCovers({ ...mem(approval()), stopped: true }, target())).toBe(false);
    expect(cardCovers(mem(approval()), target({ host: 'evil.example.net' }))).toBe(false);
    expect(cardCovers(mem(approval()), target({ category: 'delete' }))).toBe(false);
    expect(cardCovers(mem(approval()), target({ category: 'purchase' }))).toBe(true);
    expect(cardCovers(undefined, target())).toBe(false);
    expect(cardCovers(mem(null), target())).toBe(false);
  });

  it('a pay click that was sent and not recorded becomes unknown; a field that was being typed is typed again', () => {
    const m: SavedCardsMemory = { refs: {}, approval: approval({ pay: 'intent' }), fields: { number: 'typed', security_code: 'typing' } };
    const lines = reconcileCardsOnStart(m);
    expect(m.approval!.pay).toBe('unknown');
    expect(m.paymentUnknown).toBe(true);
    expect(m.fields).toEqual({ number: 'typed' });
    expect(lines).toHaveLength(2);
    expect(lines.join(' ')).toContain('Do not press pay again');
    expect(reconcileCardsOnStart(undefined)).toEqual([]);
    expect(reconcileCardsOnStart({ refs: {}, approval: approval() })).toEqual([]);
  });
});
