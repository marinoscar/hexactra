// Matching a saved approval (#554): pure, no I/O. A rule is the owner's own
// standing decision, and it is matched by the SERVER on facts the model cannot
// forge: the registrable domain of the page's real URL (from the fabric), the
// gate's category and the element's label after normalisation, or the fixed
// topic of an ask. No prefix, substring or pattern matching: two labels match
// only when they are equal after `normaliseLabel`.
import { parse } from 'tldts';

/**
 * The kinds of rule: a step the server stops for (`gate`), a question the agent asks on its own (`ask`), or a call that changes something
 * through one of the owner's connections (`connection`, E39.7). A connection rule is keyed on `(connection id, tool)`: the connection's id
 * is stored in `host` and the tool's name in `matchKey`; no site is involved, and no site rule ever matches one.
 */
export const APPROVAL_RULE_KINDS = ['gate', 'ask', 'connection'] as const;
export type ApprovalRuleKind = (typeof APPROVAL_RULE_KINDS)[number];

/** The gate's categories (runner/policy.ts `RISK_CATEGORIES`, #550), repeated here so this file stays pure and dependency-free. */
export const GATE_CATEGORIES = ['payment', 'purchase', 'send', 'delete', 'submit'] as const;

/**
 * The fixed topics an ask rule is keyed on (#555): `request_human` names one; anything else is `other`,
 * which is never rememberable.
 */
export const ASK_TOPICS = ['open_menu', 'choose_date', 'choose_option', 'fill_form', 'navigate', 'dismiss_dialog', 'scroll_or_expand', 'download', 'upload', 'other'] as const;
export type AskTopic = (typeof ASK_TOPICS)[number];

/** How an ask topic reads in a rule's summary ("Choose dates on bankofamerica.com"). */
export const ASK_TOPIC_PHRASES: Readonly<Record<AskTopic, string>> = {
  open_menu: 'Open menus',
  choose_date: 'Choose dates',
  choose_option: 'Choose options',
  fill_form: 'Fill in forms',
  navigate: 'Move between pages',
  dismiss_dialog: 'Dismiss dialogs',
  scroll_or_expand: 'Scroll or expand sections',
  download: 'Download files',
  upload: 'Upload files',
  other: 'Other steps',
};

/**
 * A saved card (E37.7): a card rule is a `gate` rule of category `payment` whose key is NOT a button label but this fixed
 * phrase plus the currency (`saved card usd`), so the limit is in one currency, and whose `cardRef` names the card
 * (`<provider>:<item id>`). A rule with a `cardRef` matches only a query with the same one, and a rule without it never
 * matches a card use: the site-wide "routine steps" rule cannot cover a card.
 */
export const CARD_MATCH_KEY_PREFIX = 'saved card';

/** The match key of a card rule or query for one currency (`saved card usd`). */
export function cardMatchKey(currency: string): string {
  return `${CARD_MATCH_KEY_PREFIX} ${currency.trim().toLowerCase().slice(0, 3)}`;
}

/** The reference of a saved card in a rule: `<provider>:<item id>`; null unless both parts are plain. */
export function cardRefOf(provider: string, itemId: string): string | null {
  const ok = /^[a-z][a-z0-9_-]{0,19}$/.test(provider) && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(itemId);
  return ok ? `${provider}:${itemId}` : null;
}

/**
 * The recipients of a connection call (E39.7), as a rule stores them: an address, lower-case (`person@example.test`), or a whole domain
 * (`@example.test`, the addresses at exactly that domain: not its subdomains). Anything else is dropped. There is no "anyone".
 */
export function normaliseRecipient(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v || v.length > 254 || /[\s,;<>"()[\]\\]/.test(v) || v.includes('*')) return null;
  const at = v.lastIndexOf('@');
  if (at < 0 || v.indexOf('@') !== at) return null;
  const domain = v.slice(at + 1);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) return null;
  if (at === 0) return v;
  return /^[^@]{1,64}@/.test(v) ? v : null;
}

/** The domain entry (`@example.test`) of an address; null for an address that is not valid. */
export function recipientDomain(address: string): string | null {
  const n = normaliseRecipient(address);
  return n && !n.startsWith('@') ? n.slice(n.lastIndexOf('@')) : null;
}

/** Whether a rule's approved set covers an address: the address itself, or its domain. */
export function recipientCovered(approved: readonly string[], address: string): boolean {
  const a = normaliseRecipient(address);
  if (!a || a.startsWith('@')) return false;
  return approved.includes(a) || approved.includes(a.slice(a.lastIndexOf('@')));
}

/** At most this many characters of a normalised label. */
export const MATCH_KEY_MAX = 200;

/**
 * The registrable domain ("eTLD+1") of a page URL, lower-case: `https://www.secure.bankofamerica.com/x`
 * → `bankofamerica.com`; `bankofamerica.com.evil.test` → `evil.test`. Private suffixes count
 * (`someone.github.io` is its own site). `null` for an IP address, `localhost`, a host without a
 * public suffix, a non-web scheme (`file:`, `data:`, `chrome:`, `about:`) or anything unparsable:
 * such a page never matches a rule.
 */
export function registrableDomain(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  const p = parse(host, { allowPrivateDomains: true, extractHostname: false });
  if (p.isIp || !p.domain || (!p.isIcann && !p.isPrivate)) return null;
  return p.domain.toLowerCase();
}

/**
 * A label as a rule stores and compares it: lower-case, trademark signs removed, whitespace
 * collapsed, every run of digits (with its separators) replaced by `#`, punctuation at the ends
 * removed, at most 200 characters. "Pay $10.00" → "pay $#"; "  Send   Money® " → "send money".
 */
export function normaliseLabel(label: string | null | undefined): string {
  return (label ?? '')
    .replace(/[®™©℠]/g, '')
    .toLowerCase()
    .replace(/\d(?:[\d.,  ]*\d)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s.,:;!?·•›»‹«←→>\-–—'"()[\]]+|[\s.,:;!?·•›»‹«←→>\-–—'"()[\]]+$/g, '')
    .slice(0, MATCH_KEY_MAX);
}

/** The sentence the owner reads and the rule stores: "Press 'Pay' on bankofamerica.com", "Choose dates on bankofamerica.com". */
export function ruleSummary(r: { kind: ApprovalRuleKind; host: string; label?: string | null; topic?: string | null; card?: string | null }): string {
  if (r.card) return `Pay with ${r.card.replace(/\s+/g, ' ').trim().slice(0, 80)} on ${r.host}`.slice(0, 300);
  // A connection rule (E39.7) is worded by the server from the connection's label and the tool: `label` is the account's name, `topic` the tool.
  if (r.kind === 'connection') return `${(r.topic ?? 'a tool').replace(/_/g, ' ')} with ${(r.label ?? 'a connection').replace(/\s+/g, ' ').trim().slice(0, 60)}`.slice(0, 300);
  if (r.kind === 'ask') {
    const phrase = ASK_TOPIC_PHRASES[(r.topic ?? 'other') as AskTopic] ?? ASK_TOPIC_PHRASES.other;
    return `${phrase} on ${r.host}`.slice(0, 300);
  }
  const shown = (r.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'the button';
  return `Press '${shown}' on ${r.host}`.slice(0, 300);
}

/** The facts of a rule the matcher reads. `taskId`/`conversationId` null mean "everywhere". */
export interface MatchableRule {
  id: string;
  kind: ApprovalRuleKind;
  host: string;
  category: string | null;
  matchKey: string;
  taskId: string | null;
  conversationId: string | null;
  /** A saved card (E37.7): `<provider>:<item id>`; empty or absent for every other rule. */
  cardRef?: string | null;
  /** `connection` rules: the approved recipients (addresses or `@domain`); empty for every other rule. */
  recipients?: readonly string[] | null;
  /** A number, or a decimal string as Prisma returns it; null for no limit. */
  maxAmount: number | string | { toString(): string } | null;
  expiresAt: Date | null;
  enabled: boolean;
}

/** What is about to happen, as the server knows it. */
export interface MatchQuery {
  kind: ApprovalRuleKind;
  /** The registrable domain of the page (`registrableDomain`); null never matches. */
  host: string | null;
  /** For `gate`: the verdict's category; null for an ask. */
  category: string | null;
  /** For `gate`: `normaliseLabel(label)`; for `ask`: the topic. */
  matchKey: string;
  taskId: string | null;
  conversationId: string | null;
  /** A card use (E37.7): the card's reference. Absent for everything else, so a card rule never matches a plain click. */
  cardRef?: string | null;
  /** `connection` queries: every address the call would reach. A rule matches only when it covers all of them. */
  recipients?: readonly string[] | null;
  /** The amount at stake when the owner's inputs make one known; null or undefined when unknown. */
  amount?: number | null;
  now: Date;
  /** The owner's "Pause all" switch: when true nothing matches. */
  paused?: boolean;
}

function amountOf(v: MatchableRule['maxAmount']): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
}

/** Whether one rule allows the step; see `findRule`. */
export function ruleMatches(rule: MatchableRule, q: MatchQuery): boolean {
  if (q.paused) return false;
  if (!rule.enabled) return false;
  if (rule.expiresAt && rule.expiresAt.getTime() <= q.now.getTime()) return false;
  if (!q.host || rule.host !== q.host) return false;
  if (rule.kind !== q.kind) return false;
  if ((rule.category || null) !== (q.kind === 'gate' ? q.category || null : null)) return false;
  if (!q.matchKey || rule.matchKey !== q.matchKey) return false;
  if (q.kind === 'ask' && rule.matchKey === 'other') return false;
  if (rule.taskId && rule.taskId !== q.taskId) return false;
  if (rule.conversationId && rule.conversationId !== q.conversationId) return false;
  // A card rule matches only the same card, and a rule for no card never matches a card use (E37.7).
  if ((rule.cardRef || null) !== (q.cardRef || null)) return false;
  // A connection rule (E39.7) covers the recipients the owner approved and no one else: a call that reaches anyone outside the set asks again.
  if (q.kind === 'connection') {
    const approved = rule.recipients ?? [];
    for (const r of q.recipients ?? []) if (!recipientCovered(approved, r)) return false;
  }
  const limit = amountOf(rule.maxAmount);
  // A card rule without an amount limit matches nothing: the limit is required, whatever a row says.
  if (rule.cardRef && limit === null) return false;
  if (limit !== null) {
    if (q.amount === null || q.amount === undefined || !Number.isFinite(q.amount)) return false;
    if (q.amount > limit) return false;
  }
  return true;
}

/** How specific a rule is: a task or chat scope beats none; a limit beats none. */
function specificity(r: MatchableRule): number {
  return (r.taskId ? 4 : 0) + (r.conversationId ? 4 : 0) + (amountOf(r.maxAmount) !== null ? 2 : 0) + (r.expiresAt ? 1 : 0);
}

/**
 * The rule that allows this step, or null. A rule matches when it is enabled, not expired, its host,
 * kind, category and key equal the query's, its task or chat scope (when set) equals the run's, and,
 * when it has `maxAmount`, an amount is known and is not larger. Nothing matches while paused, on an
 * unknown host, or for the ask topic `other`. The most specific match wins (scoped before unscoped).
 */
export function findRule<R extends MatchableRule>(rules: readonly R[], q: MatchQuery): R | null {
  let best: R | null = null;
  for (const r of rules) {
    if (!ruleMatches(r, q)) continue;
    if (!best || specificity(r) > specificity(best)) best = r;
  }
  return best;
}
