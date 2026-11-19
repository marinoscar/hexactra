/**
 * Server-side policy, checked before every action (the model's say-so is
 * never authorization). The agent is a human emulator with the owner's full
 * authority (#366): with no allowed-domain list it may open any URL a person
 * could type (`file:`, `chrome:`, `data:`...), except `javascript:` (it has
 * run_javascript for that). A task that lists allowed domains is scoped to
 * them: a hostname matches exactly or as a suffix (`example.test` allows
 * `www.example.test`; `*.example.test` allows only subdomains), and other
 * schemes are refused.
 */
export function domainAllowed(rawUrl: string, allowed: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return false;
  }
  if (u.protocol === 'javascript:') return false;
  if (allowed.length === 0) return true;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return allowed.some((d) => {
    const domain = d.toLowerCase();
    if (domain.startsWith('*.')) return host.endsWith(domain.slice(1));
    return host === domain || host.endsWith(`.${domain}`);
  });
}

/** A domain no site has: what the fabric gets when two lists leave nothing in common (an empty list means "any site"). */
export const NO_SITE = 'no-site.invalid';

/**
 * The allowed sites for the fabric's session request (#508): the task's (or chat's) list narrowed by the AI app's.
 * The fabric enforces them in the browser, for every top-level navigation, including the ones a page starts itself;
 * the console still checks each action against both lists. The fabric takes plain domains (a domain covers its
 * subdomains), so `*.example.test` is sent as `example.test`: the fabric is the backstop, the console the exact rule.
 * Empty: any site. Two lists with nothing in common give `[NO_SITE]`, never `[]`.
 */
export function fabricAllowedSites(task: readonly string[], app: readonly string[]): string[] {
  const plain = (l: readonly string[]) => [...new Set(l.map((d) => d.trim().toLowerCase().replace(/^\*\./, '')).filter(Boolean))];
  const a = plain(task);
  const b = plain(app);
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const covers = (outer: string, inner: string) => inner === outer || inner.endsWith(`.${outer}`);
  const out = new Set<string>();
  for (const x of a) for (const y of b) {
    if (covers(y, x)) out.add(x);
    else if (covers(x, y)) out.add(y);
  }
  return out.size ? [...out] : [NO_SITE];
}

/** What a commitment is about (#550): the structured key a saved approval matches on (E36.4, E36.5). */
export const RISK_CATEGORIES = ['payment', 'purchase', 'send', 'delete', 'submit'] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

/** The gate's decision about one click target. `label` is the target's own words; `why` is for the log and the question. */
export interface RiskVerdict {
  risky: boolean;
  category: RiskCategory | null;
  label: string | null;
  why: string | null;
}

/**
 * What the server knows about the element a click lands on, read from the page through the fabric
 * (never from the model's words). The model's `reason` and the selector string are deliberately not inputs.
 */
export interface TargetFacts {
  /** The accessible name or visible text of the element. */
  label?: string | null;
  /** button, link, menuitem, option, gridcell, checkbox, … (explicit or implicit). */
  role?: string | null;
  /** button, a, input, td, … */
  tag?: string | null;
  /** The `type` of an input or button: submit, button, image, … */
  inputType?: string | null;
  /** The action path of the form the element submits, when it submits one. */
  formAction?: string | null;
  /** Weak context only: never makes a target risky on its own. */
  pageTitle?: string | null;
  url?: string | null;
}

/** Amounts and trailing words a commit button may carry: "Pay $10.00", "Pay now", "Send $25 to Person A". */
const AMOUNT = String.raw`(?:[$€£¥]\s?)?\d[\d.,]*(?:\s?(?:usd|eur|gbp|dollars?))?`;
const TAIL = String.raw`(?:\s+(?:now|${AMOUNT}|all))*(?:\s+(?:to|for)\s+\S.{0,60})?`;

/**
 * The one table of commitments: per category, the whole label (after normalisation), anchored on its
 * leading verb. A label that only mentions a risky noun ("Payment activity", "Send money with Zelle") is
 * not here: navigation to a feature is not the commitment.
 */
export const COMMIT_PHRASES: Readonly<Record<RiskCategory, readonly string[]>> = {
  payment: [
    'pay', 'pay bill', 'pay this bill', 'pay balance', 'pay in full', 'pay securely', 'submit payment', 'make payment', 'make a payment', 'make the payment',
    'confirm payment', 'confirm and pay', 'authorize payment', 'authorise payment', 'complete payment', 'schedule payment', 'send payment',
  ],
  purchase: [
    'buy', 'buy now', 'buy it now', 'place order', 'place your order', 'place my order', 'submit order', 'complete order', 'complete purchase', 'confirm purchase',
    'confirm order', 'confirm and buy', 'purchase', 'purchase now', 'checkout now', 'book now', 'confirm booking', 'complete booking', 'reserve now', 'subscribe',
    'subscribe now', 'start subscription',
  ],
  send: [
    'send', 'send now', 'send money', 'send it', 'transfer', 'transfer now', 'transfer funds', 'transfer money', 'confirm transfer', 'confirm and send', 'submit transfer',
    'make transfer', 'make a transfer', 'wire', 'send wire', 'confirm wire',
  ],
  delete: [
    'delete account', 'delete my account', 'close account', 'close my account', 'delete permanently', 'permanently delete', 'cancel subscription', 'cancel my subscription',
    'cancel membership', 'cancel plan', 'remove account', 'delete all', 'erase all',
  ],
  submit: ['submit application', 'sign and submit', 'confirm and submit', 'file return', 'submit return', 'e-file', 'submit claim', 'accept and sign'],
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
const PHRASE_RE: [RiskCategory, RegExp][] = RISK_CATEGORIES.map((c) => [c, new RegExp(`^(?:${COMMIT_PHRASES[c].map(escapeRe).join('|')})${TAIL}$`, 'i')]);

/** Form actions that submit a commitment: `/payment/submit`, `/checkout/place-order`, `/transfer/confirm`. */
const COMMIT_ACTION: [RiskCategory, RegExp][] = [
  ['payment', /\/(?:pay|payments?|billpay)(?:\/[\w-]+)*\/(?:submit|confirm|complete|process|authori[sz]e|pay)\/?$/i],
  ['purchase', /\/(?:checkout|orders?|purchase|cart)(?:\/[\w-]+)*\/(?:submit|confirm|complete|place(?:-?order)?|buy)\/?$/i],
  ['send', /\/(?:transfers?|send|zelle|wire)(?:\/[\w-]+)*\/(?:submit|confirm|complete|send)\/?$/i],
  ['delete', /\/(?:account|subscription|membership)(?:\/[\w-]+)*\/(?:delete|close|cancel)\/?$/i],
];

/** Roles that never commit, whatever their text says: a date cell, an option, a field, a tab. */
const NEVER_COMMITS = new Set([
  'gridcell', 'cell', 'option', 'checkbox', 'radio', 'switch', 'textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton', 'slider', 'tab', 'tablist', 'treeitem',
  'menuitemcheckbox', 'menuitemradio', 'heading', 'img', 'presentation', 'none', 'row', 'columnheader', 'rowheader', 'text', 'paragraph', 'generic', 'listitem', 'label',
  'dialog', 'region', 'article', 'navigation', 'group',
]);
/** Tags whose implicit role never commits (only an explicit role may make them a button). */
const NEVER_COMMIT_TAGS = new Set(['td', 'th', 'tr', 'table', 'option', 'select', 'textarea', 'label', 'li', 'span', 'div', 'p', 'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'summary', 'details', 'canvas', 'svg', 'time']);
const NEVER_COMMIT_INPUTS = new Set(['text', 'checkbox', 'radio', 'date', 'datetime-local', 'month', 'week', 'time', 'number', 'email', 'tel', 'url', 'search', 'password', 'range', 'color', 'file', 'hidden']);

/** The old word list (#366): only the fallback when the target's kind cannot be read, and only ever on its label. */
const RISKY_WORDS: [RiskCategory, RegExp][] = [
  ['payment', /\b(pay|payment)\b/i],
  ['purchase', /\b(buy|purchase|place[\s_-]*order|checkout|check[\s_-]*out|confirm[\s_-]*(booking|order|purchase)|book[\s_-]*now|subscribe)\b/i],
  ['send', /\b(transfer|send[\s_-]*money)\b/i],
  ['delete', /\bdelete[\s_-]*account\b/i],
];

/** A label as the gate compares it: lower-case, trademark signs gone, whitespace collapsed, end punctuation trimmed. */
export function normaliseTargetLabel(label: string | null | undefined): string {
  return (label ?? '')
    .replace(/[®™©℠]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s.,:;!?·•›»→>\-–—]+|[\s.,:;!?·•›»→>\-–—]+$/g, '')
    .toLowerCase()
    .slice(0, 200);
}

/** The element's role as the gate reads it: the explicit role, else the implicit one of its tag; null when unknown. */
function roleOf(t: TargetFacts): string | null {
  const role = t.role?.trim().toLowerCase().split(/\s+/)[0];
  if (role) return role;
  const tag = t.tag?.trim().toLowerCase();
  const type = t.inputType?.trim().toLowerCase();
  if (!tag) return null;
  if (tag === 'button') return 'button';
  if (tag === 'a') return 'link';
  if (tag === 'input') return type && ['submit', 'button', 'image', 'reset'].includes(type) ? 'button' : 'textbox';
  if (NEVER_COMMIT_TAGS.has(tag)) return 'generic';
  return null;
}

const NOT_RISKY: RiskVerdict = { risky: false, category: null, label: null, why: null };

/**
 * The gate's verdict on one click target (#550): whether the click commits something, and what.
 * Decided from the target alone; the model's words and the selector string are never inputs. Only an
 * element that can commit (a button, a submit input, a link, a menu item) is ever risky. A link or menu
 * item is risky only when its whole label is a commitment; a submit button also when its form's action
 * commits. When the target's kind cannot be read, the old word list is matched on the label only.
 */
export function classifyTarget(t: TargetFacts): RiskVerdict {
  const raw = (t.label ?? '').replace(/\s+/g, ' ').trim();
  const label = normaliseTargetLabel(raw);
  const role = roleOf(t);
  const type = t.inputType?.trim().toLowerCase() || null;
  if (role && NEVER_COMMITS.has(role)) return NOT_RISKY;
  if (type && NEVER_COMMIT_INPUTS.has(type)) return NOT_RISKY;
  const shown = raw ? (raw.length > 80 ? `${raw.slice(0, 80)}…` : raw) : null;
  if (role === null) {
    const hit = RISKY_WORDS.find(([, re]) => re.test(label));
    return hit ? { risky: true, category: hit[0], label: shown, why: `an element labelled '${shown}' (its kind could not be read)` } : NOT_RISKY;
  }
  if (role !== 'button' && role !== 'link' && role !== 'menuitem') return NOT_RISKY;
  const phrase = PHRASE_RE.find(([, re]) => re.test(label));
  if (phrase) {
    const kind = role === 'menuitem' ? 'a menu item' : role === 'link' ? 'a link' : 'a button';
    return { risky: true, category: phrase[0], label: shown, why: `${kind} labelled '${shown}'` };
  }
  // A submit control of a form that commits: its label may say "Continue"; the form's action says what it does.
  const submits = role === 'button' && type !== 'button' && type !== 'reset';
  if (submits && t.formAction) {
    let path = t.formAction;
    try {
      path = new URL(t.formAction, 'https://form.invalid').pathname;
    } catch {
      /* keep it as given */
    }
    const hit = COMMIT_ACTION.find(([, re]) => re.test(path));
    if (hit) return { risky: true, category: hit[0], label: shown, why: `a submit button${shown ? ` labelled '${shown}'` : ''} of a form that posts to ${path.slice(0, 100)}` };
  }
  return NOT_RISKY;
}

/** A target the gate stopped, or one a person approved: what an approval covers (#550). */
export interface GateTarget {
  category: RiskCategory | null;
  label: string | null;
  /** The page's host, from the fabric's report of the active tab; null when it could not be read. */
  host: string | null;
}

/**
 * Whether an approval of `approved` lets the click on `target` through: the same category and label
 * (after normalisation), and the same host when both are known. An approval with no category exists only
 * in a run's transcript written before #550: it covers the next risky click, once, as it did then.
 */
export function approvalCovers(approved: GateTarget, target: GateTarget): boolean {
  if (approved.category === null) return true;
  if (approved.category !== target.category) return false;
  if (normaliseTargetLabel(approved.label) !== normaliseTargetLabel(target.label)) return false;
  return !approved.host || !target.host || approved.host === target.host;
}

/** The host of a URL, lower-case, or null (an unparsable URL, or one without a host). */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}
