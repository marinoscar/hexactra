// Payment cards the agent pays with without seeing them (E37.7, #596). Pure functions and types: no I/O, no clock, no Nest.
//
// A card works on any site, so a site binding cannot protect it. The protection is the owner's decision per merchant and per
// amount, enforced outside the model: the provider's merchant grant, and this module's side of Hexactra's own rules (a declared
// charge, an approval per merchant, an amount limit for a remembered one). The model names a CARD by a per-run reference and the
// FIELDS by target; the fabric reads the merchant's origin, asks the provider with the amount and types. What lands in a step, the
// run's memory, a tool result or a notification is a card's brand and last four digits, a merchant's host and amounts: never a
// number, an expiry or a security code.
import { cardMatchKey, cardRefOf, registrableDomain } from '../approvals/approval-match';
import type { CardSummary, ItemSummary, SecretsErrorCode } from '../secrets/secrets-provider.port';
import { maskSensitive } from '../tasks/mask';
import type { CardFieldName } from './fabric-session';

/** One card payment a run made, as `runs.used_saved_cards` stores it. */
export interface UsedSavedCard {
  provider: string;
  /** The card's name as the owner gave it ("Everyday card"). */
  itemName: string;
  brand: string | null;
  /** The last four digits, at most. */
  last4: string | null;
  /** The merchant's host as the page reported it when the card was typed. */
  merchant: string;
  /** `scheme://host[:port]` the card was typed on. */
  origin: string;
  currency: string;
  /** The amount the agent declared before paying: a decimal with two places. */
  declaredAmount: string;
  /** The amount the agent read on the confirmation page; null while unknown. */
  confirmedAmount: string | null;
  /** The confirmed amount differs from the declared one by more than the tolerance. */
  mismatch: boolean;
  /** ISO time the card was typed. */
  at: string;
}

/** At most this many payments per run. */
export const MAX_USED_SAVED_CARDS = 10;

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);

/** Read `runs.used_saved_cards`: a malformed entry is dropped, a field that cannot be what it should be becomes null. */
export function readUsedSavedCards(value: unknown): UsedSavedCard[] {
  if (!Array.isArray(value)) return [];
  const out: UsedSavedCard[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const v = raw as Record<string, unknown>;
    const provider = str(v.provider, 20);
    const itemName = str(v.itemName, 200);
    const merchant = str(v.merchant, 255);
    const origin = str(v.origin, 300);
    const currency = str(v.currency, 3);
    const declared = str(v.declaredAmount, 16);
    const at = str(v.at, 40);
    if (!provider || itemName === null || !merchant || !origin || !currency || !declared || !at || !isAmount(declared) || !/^[A-Z]{3}$/.test(currency)) continue;
    const last4 = str(v.last4, 4);
    const confirmed = str(v.confirmedAmount, 16);
    out.push({
      provider,
      itemName,
      brand: str(v.brand, 30),
      last4: last4 && /^\d{1,4}$/.test(last4) ? last4 : null,
      merchant,
      origin,
      currency,
      declaredAmount: declared,
      confirmedAmount: confirmed && isAmount(confirmed) ? confirmed : null,
      mismatch: v.mismatch === true,
      at,
    });
  }
  return out.slice(0, MAX_USED_SAVED_CARDS);
}

/** The list with one more payment (the oldest ten are kept). */
export function appendUsedSavedCard(current: unknown, entry: Omit<UsedSavedCard, 'at' | 'confirmedAmount' | 'mismatch'> & { at: Date }): UsedSavedCard[] {
  const list = readUsedSavedCards(current);
  if (list.length >= MAX_USED_SAVED_CARDS) return list;
  return [
    ...list,
    {
      provider: entry.provider.slice(0, 20),
      itemName: entry.itemName.slice(0, 200),
      brand: entry.brand ? entry.brand.slice(0, 30) : null,
      last4: entry.last4 && /^\d{1,4}$/.test(entry.last4) ? entry.last4 : null,
      merchant: entry.merchant.slice(0, 255),
      origin: entry.origin.slice(0, 300),
      currency: entry.currency,
      declaredAmount: entry.declaredAmount,
      confirmedAmount: null,
      mismatch: false,
      at: entry.at.toISOString(),
    },
  ];
}

// ---------------------------------------------------------------------------------------------------- amounts

/** A decimal amount with at most two places, greater than zero and at most 10,000,000.00: `"42.50"`, `"7"`. */
export function isAmount(v: string): boolean {
  return /^\d{1,8}(\.\d{1,2})?$/.test(v) && cents(v) > 0 && cents(v) <= 1_000_000_000;
}

/** An amount in hundredths. `NaN` for something that is not an amount. */
export function cents(v: string): number {
  const m = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(v.trim());
  if (!m) return Number.NaN;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
}

/** `4250` → `"42.50"`. */
export function amountOfCents(c: number): string {
  const n = Math.round(c);
  return `${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`;
}

/** The amount as a decimal with two places (`"7"` → `"7.00"`), or null when it is not an amount. */
export function normaliseAmount(v: string | number): string | null {
  const s = typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(2) : '') : v.trim().replace(/,/g, '');
  const m = /^\$?(\d{1,8})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const out = amountOfCents(Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0'));
  return isAmount(out) ? out : null;
}

/** The currency as three upper-case letters, or null. */
export function normaliseCurrency(v: string): string | null {
  const c = v.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : null;
}

/**
 * Whether the amount on the confirmation page is the declared one, within a small tolerance: one cent, or one percent of the
 * declared amount, whichever is larger (a rounding of a tax, not a different price).
 */
export function amountsAgree(declared: string, confirmed: string): boolean {
  const d = cents(declared);
  const c = cents(confirmed);
  if (!Number.isFinite(d) || !Number.isFinite(c)) return false;
  return Math.abs(d - c) <= Math.max(1, Math.round(d * 0.01));
}

// ---------------------------------------------------------------------------------------------------- the model's view

/** One field the model gives a target for. Exactly one of `selector` and a point. */
export interface CardTarget {
  selector: string | null;
  x: number | null;
  y: number | null;
}

/** The fields `pay_with_saved_card` types, in the order they are typed: the security code is always last. */
export const CARD_FIELD_ORDER: readonly CardFieldName[] = ['number', 'expiry', 'exp_month', 'exp_year', 'holder_name', 'postal_code', 'security_code'];

/** A card as the model reads it: a per-run reference, never the provider's id; no number, no expiry, no code. */
export interface LookedUpCard {
  ref: string;
  /** The provider's id for the card. Kept in the run's memory to map a reference back; never shown to the model. */
  itemId: string;
  /** `<provider>:<item id>`: what a saved approval is bound to. Never shown to the model. */
  cardRef: string;
  name: string;
  brand: string | null;
  last4: string | null;
  /** The owner's limit for this card at this merchant: the grant's maximum. */
  maxAmount: string;
  currency: string;
  /** The owner allowed the security code for this card at this merchant. */
  securityCode: boolean;
  /** When the owner's permission ends (ISO), or null. */
  grantExpiresAt: string | null;
}

/** The lookup of the merchant the model is on. */
export interface SavedCardLookup {
  /** The merchant's top-level origin as the browser reported it. */
  origin: string;
  provider: string;
  cards: LookedUpCard[];
}

/** What the agent declared it is about to pay: the server shows it to the owner and the provider checks it against the grant. */
export interface IntendedCharge {
  /** A decimal with two places. */
  amount: string;
  /** ISO 4217. */
  currency: string;
  /** The merchant's host as the fabric reported it when the charge was declared: never the model's words. */
  merchantHost: string;
  /** What is being bought, one line, masked like the rest of the trace. */
  description: string;
  declaredAt: string;
}

/** The owner's approval for one card at one merchant for one declared charge, in this run. */
export interface CardApproval {
  cardRef: string;
  itemId: string;
  provider: string;
  /** The merchant's registrable domain. */
  site: string;
  amount: string;
  currency: string;
  /** The owner answered a question in this run, or a remembered approval matched. */
  via: 'owner' | 'rule';
  /** The remembered approval that matched (`via: rule`). */
  ruleId?: string;
  /** Every field was typed: the next click on the merchant's pay button is covered. */
  typed: boolean;
  /**
   * The pay click: `intent` before it is sent, `done` after it was carried out. A job that dies with `intent` leaves `unknown`:
   * the payment may or may not have happened, and no card tool pays again in this run.
   */
  pay?: 'intent' | 'done' | 'unknown';
  /** The entry of `used_saved_cards` this payment is, by index. */
  usedIndex?: number;
}

/** What the run asked the owner and is waiting on (the next `pay_with_saved_card` for it goes ahead once they approved). */
export interface CardAsk {
  cardRef: string;
  itemId: string;
  provider: string;
  site: string;
  amount: string;
  currency: string;
}

/** What a run remembers about saved cards between chunks and jobs (`runs.transcript.savedCards`). Never a value. */
export interface SavedCardsMemory {
  /** References handed out so far, by the provider's item id: one per card per run. */
  refs: Record<string, string>;
  lookup?: SavedCardLookup | null;
  /** Card ids seen on earlier lookups of this run (any merchant): the only cards a grant request can name. */
  seenCards?: { itemId: string; provider: string; name: string }[];
  charge?: IntendedCharge | null;
  asking?: CardAsk | null;
  approval?: CardApproval | null;
  /** Fields typed (`typed`) or being typed (`typing`) for the approval's payment; a job cut off between two fields finds them. */
  fields?: Partial<Record<CardFieldName, 'typing' | 'typed'>>;
  /** The owner chose a card for this run (several grants for one merchant): only this one may be used. */
  chosen?: string | null;
  /** A page was refused as the wrong shop or frame: no card tool works for the rest of the run. */
  stopped?: boolean;
  /** A payment of this run may already have happened and cannot be told: no card tool pays again. */
  paymentUnknown?: boolean;
  /** Where a card field was typed inside an embedded frame (a point, never a value): the model's screenshots cover the element there. */
  points?: { page: string; x: number; y: number }[];
}

/** The reference of a card in this run, handing out the next one (`card-1`, `card-2`, …) the first time. */
export function cardRefFor(memory: SavedCardsMemory, itemId: string): string {
  const known = memory.refs[itemId];
  if (known) return known;
  const ref = `card-${Object.keys(memory.refs).length + 1}`;
  memory.refs[itemId] = ref;
  return ref;
}

/** A label or a name as the model and the trace may read it: one line, masked like any text of the trace, at most `max` characters. */
export function safeText(text: string, max = 80): string {
  return maskSensitive(text.replace(/\s+/g, ' ').trim().slice(0, max)).text;
}

/** The brand as a word the owner reads ("visa" → "Visa"). */
export function brandWord(brand: string | null | undefined): string {
  const b = (brand ?? '').trim();
  if (!b) return 'Card';
  return b
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
    .slice(0, 30);
}

/** "Visa ending 4242", or "Card" when nothing is known: what the owner and the trace read. */
export function cardWords(c: { brand: string | null; last4: string | null }): string {
  return `${brandWord(c.brand)}${c.last4 ? ` ending ${c.last4}` : ''}`;
}

/** The amount and currency as the owner reads them ("42.50 USD"). */
export function moneyWords(amount: string, currency: string): string {
  return `${amount} ${currency}`;
}

function lookedUpCard(provider: string, memory: SavedCardsMemory, i: ItemSummary & { card: CardSummary }): LookedUpCard | null {
  const g = i.card.grant;
  const cardRef = cardRefOf(provider, i.id);
  if (!g || !cardRef) return null;
  const max = normaliseAmount(g.maxAmount);
  const currency = normaliseCurrency(g.currency);
  if (!max || !currency) return null;
  return {
    ref: cardRefFor(memory, i.id),
    itemId: i.id,
    cardRef,
    name: safeText(i.name, 120),
    brand: i.card.brand ? safeText(i.card.brand, 30) : null,
    last4: i.card.last4 && /^\d{1,4}$/.test(i.card.last4) ? i.card.last4 : null,
    maxAmount: max,
    currency,
    securityCode: g.includesSecurityCode === true,
    grantExpiresAt: g.expiresAt ? g.expiresAt.toISOString() : null,
  };
}

/** A provider's cards for a merchant as the lookup the model reads and the runner remembers. A card with no grant is dropped. */
export function cardLookupOf(memory: SavedCardsMemory, result: { origin: string; provider: string; items: ItemSummary[] }): SavedCardLookup {
  const cards = result.items
    .filter((i): i is ItemSummary & { card: CardSummary } => i.card !== undefined)
    .map((i) => lookedUpCard(result.provider, memory, i))
    .filter((c): c is LookedUpCard => c !== null);
  // Remember which cards exist (for a grant request on another merchant): ids and names, never more.
  const seen = memory.seenCards ?? [];
  for (const c of cards) if (!seen.some((s) => s.itemId === c.itemId && s.provider === result.provider)) seen.push({ itemId: c.itemId, provider: result.provider, name: c.name });
  memory.seenCards = seen.slice(-10);
  return { origin: result.origin, provider: result.provider, cards };
}

/** The model-facing form of one card: `{ ref, name, brand, last4, limit, expires, securityCode }`. No number, no card expiry, no code. */
export function cardForModel(c: LookedUpCard) {
  return {
    ref: c.ref,
    name: c.name,
    brand: c.brand,
    last4: c.last4,
    limit: `up to ${moneyWords(c.maxAmount, c.currency)} at this shop`,
    expires: c.grantExpiresAt ? c.grantExpiresAt.slice(0, 10) : null,
    securityCode: c.securityCode ? 'allowed by the owner' : 'not allowed: ask the owner to type it',
  };
}

/** What `saved_cards` tells the model about a page. */
export function cardLookupText(lookup: SavedCardLookup, requestable: boolean): string {
  if (lookup.cards.length === 0) {
    return requestable
      ? 'none: the owner has not allowed any saved card at this shop. A request for permission was sent to the owner, who approves it in their provider. Do not enter a card yourself; tell the owner and finish, or wait for their answer.'
      : 'none: the owner has not allowed any saved card at this shop. They can allow one in their provider (Settings → Secrets links to it). Do not enter a card yourself: tell the owner what is missing.';
  }
  return (
    `${JSON.stringify(lookup.cards.map(cardForModel))}\n` +
    'To pay: (1) read the total on the page and call declare_charge with that exact amount, its currency and what is being bought; ' +
    '(2) call pay_with_saved_card with a card ref and where each field goes (a selector, or x and y for a field inside an embedded payment frame); ' +
    '(3) press the pay button. You never see a card number, an expiry or a code, and you never type one yourself. The owner is asked before a card is typed at a shop for the first time. ' +
    'After paying, read the amount on the confirmation page and call confirm_charge.'
  );
}

/** The host of a charge or a page as a registrable domain (the unit a shop is approved at). Null for an unknown host. */
export function siteOfHost(host: string | null | undefined): string | null {
  return host ? registrableDomain(`https://${host}/`) : null;
}

/** The match key and the summary a card approval is remembered as. */
export function cardRuleFacts(c: { brand: string | null; last4: string | null }, site: string, currency: string): { matchKey: string; summary: string } {
  return { matchKey: cardMatchKey(currency), summary: `Pay with ${cardWords(c)} on ${site}` };
}

// ---------------------------------------------------------------------------------------------------- failures

/** What a card refusal becomes: the words the model reads, one line for the trace, and what the connection records. */
export interface CardFailure {
  text: string;
  summary: string;
  /** Reported to the connection's status (`UNAUTHORIZED` makes it `needs_reconnect`); null when it says nothing about the connection. */
  outcome: 'UNAUTHORIZED' | 'RATE_LIMITED' | 'UNAVAILABLE' | null;
  /** The shop or frame is not what the owner allowed: the run asks the owner with a warning card and saved cards are off for the rest of the run. */
  warn: boolean;
}

const TELL_OWNER = 'Tell the owner (request_human) and do not try another card, another amount or another shop.';

/**
 * The error-to-instruction table of a card use. Branch on the code, never on a message. Every row says what the model does next;
 * none lets it type a card itself.
 */
export function cardFailureOf(code: SecretsErrorCode, retryAfterSeconds?: number): CardFailure {
  switch (code) {
    case 'origin_mismatch':
      return { text: `Stop. This shop, or the payment frame on it, is not what the owner allowed this card for. Nothing was typed. ${TELL_OWNER}`, summary: 'refused: the shop or payment frame is not the one the owner allowed', outcome: null, warn: true };
    case 'frame_unknown':
      return { text: "Stop. The payment field is in a frame whose address cannot be verified, so nothing was typed. Do not type the card yourself. Tell the owner (request_human).", summary: "refused: the payment frame's address could not be verified", outcome: null, warn: false };
    case 'amount_exceeded':
      return { text: `Stop. The amount is above what the owner allowed for this card at this shop. Nothing was typed. ${TELL_OWNER}`, summary: "refused: the amount is above the owner's limit for this card", outcome: null, warn: false };
    case 'currency_mismatch':
      return { text: `Stop. The owner allowed this card at this shop in a different currency. Nothing was typed. ${TELL_OWNER}`, summary: "refused: not the currency the owner allowed", outcome: null, warn: false };
    case 'security_code_not_granted':
      return {
        text: 'The owner did not allow the security code for this card at this shop. Ask the owner to type it: call request_human with kind "other" and input "secret", then type_handoff_secret into the code field. Do not ask for the card number.',
        summary: 'refused: the security code is not allowed for this card',
        outcome: null,
        warn: false,
      };
    case 'grant_expired':
      return { text: `The owner's permission for this card at this shop has expired. Nothing was typed. ${TELL_OWNER}`, summary: "refused: the owner's permission for this card has expired", outcome: null, warn: false };
    case 'limit_reached':
      return { text: `The limit on how often this card may be used (per day or period) is reached. Nothing was typed. ${TELL_OWNER}`, summary: "refused: the card's usage limit is reached", outcome: null, warn: false };
    case 'cards_disabled':
    case 'disabled':
      return { text: 'Paying with a saved card is switched off in the owner\'s provider. Nothing was typed. Tell the owner (request_human); do not enter a card yourself.', summary: 'refused: card release is switched off in the provider', outcome: null, warn: false };
    case 'not_found':
      return { text: 'No saved card is available for this shop (the owner has not allowed one, or it was closed). Nothing was typed. Tell the owner (request_human); do not enter a card yourself.', summary: 'refused: no saved card for this shop', outcome: null, warn: false };
    case 'insecure_origin':
      return { text: 'This page does not use https, so a card is never typed here. Nothing was typed. Tell the owner; do not enter a card on this page.', summary: 'refused: the page does not use https', outcome: null, warn: false };
    case 'typing_failed':
      return { text: 'Could not type into that field. Look at the page (observe_elements, or look for a field inside a frame) and call pay_with_saved_card again for the fields that are not filled.', summary: 'could not type into a card field', outcome: null, warn: false };
    case 'origin_unavailable':
      return { text: 'The page address could not be read, so nothing was typed. Wait for the page to load and try again once.', summary: 'the page address could not be read', outcome: null, warn: false };
    case 'unauthorized':
      return { text: 'Saved cards are not available right now (the connection to the owner\'s provider needs to be renewed). Nothing was typed. Tell the owner (request_human).', summary: 'the provider refused the connection', outcome: 'UNAUTHORIZED', warn: false };
    case 'rate_limited':
      return { text: `The provider asked to wait${retryAfterSeconds ? ` ${retryAfterSeconds} seconds` : ''}. Nothing was typed. Tell the owner (request_human) rather than retrying in a loop.`, summary: 'the provider asked to wait', outcome: 'RATE_LIMITED', warn: false };
    case 'cancelled':
      return { text: 'The step was cancelled.', summary: 'cancelled', outcome: null, warn: false };
    default:
      return { text: 'Saved cards are not available right now. Nothing was typed. Tell the owner (request_human); do not enter a card yourself.', summary: 'saved cards could not be used', outcome: code === 'unavailable' ? 'UNAVAILABLE' : null, warn: false };
  }
}

/** The merchant's host of a URL, for the declared charge and the approval. Null for an address that is not an https URL. */
export function merchantHostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.hostname.toLowerCase() || null : null;
  } catch {
    return null;
  }
}
