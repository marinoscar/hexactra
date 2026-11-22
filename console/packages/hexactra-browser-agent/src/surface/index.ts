// The surface graph (E46.13): a browser step stops depending on one brittle selector. An element is kept as a FINGERPRINT (role, accessible
// name, tag, input type, up to three selector candidates, an anchor, the frame) and found again at replay from several facts, through page
// queries only (never a model). Exactly one confident match is used; two equally good ones are `ambiguous` and the step fails its check.
//
// The types are plain interfaces here, not imported from @marinoscar/hexactra-kgraph: the toolset imports only the harness and itself
// (its import scan), so the host maps them onto the graph's `Element` and `Screen` (console docs/decisions/knowledge-graph.md).
import { ACTION_TIMEOUT_MS, type BrowserPort } from '../browser-port';

/** What identifies an element without its value. Never a value typed into it. */
export interface ElementFingerprint {
  role: string | null;
  /** The accessible name or label, masked by the host before it is stored. Null for an element inside a sensitive field. */
  name: string | null;
  tag: string | null;
  inputType: string | null;
  /** Up to three, best first: an id or test attribute, a short structural path, a text-based one. */
  selectors: string[];
  /** The nearest labelled ancestor or sibling (its label), or null. */
  anchor: string | null;
  /** The frame the element is in (`top` for the page itself). */
  frame: string;
}

/** A screen of a site: its registrable domain, its path as a pattern (ids and numbers as placeholders) and its view digest family. */
export interface ScreenKey {
  site: string;
  pathPattern: string;
  digestFamily: string | null;
}

/** One element the page lists for resolution. */
export interface PageElement {
  selector: string;
  role: string | null;
  name: string | null;
  tag: string | null;
  inputType: string | null;
  anchor: string | null;
  /** The element's other selector candidates (id, test attribute, structural path). */
  selectors: string[];
  /** Shown and enabled (E46.14): absent means unknown and counts as ready. */
  visible?: boolean;
  enabled?: boolean;
}

export type Resolution =
  | { kind: 'found'; selector: string; confidence: number; via: 'selector' | 'anchor' | 'page' }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'not_found' };

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Similarity of two names, 0..1: token overlap, so a slight change of text still matches. */
export function nameSimilarity(a: string | null, b: string | null): number {
  const x = new Set(norm(a).split(/[^a-z0-9]+/).filter(Boolean));
  const y = new Set(norm(b).split(/[^a-z0-9]+/).filter(Boolean));
  if (x.size === 0 && y.size === 0) return 1;
  let both = 0;
  for (const t of x) if (y.has(t)) both++;
  return both / Math.max(x.size, y.size);
}

const NAME_MATCH = 0.6;

/** Pure: find the fingerprint's element among the page's elements. */
export function matchFingerprint(fp: ElementFingerprint, elements: readonly PageElement[]): Resolution {
  // 1. A selector candidate that names exactly one element whose role still agrees.
  for (const sel of fp.selectors) {
    const hits = elements.filter((e) => (e.selector === sel || e.selectors.includes(sel)) && (fp.role === null || e.role === fp.role || e.role === null));
    if (hits.length === 1) return { kind: 'found', selector: hits[0]!.selector, confidence: 1, via: 'selector' };
  }
  const sameKind = (e: PageElement) => norm(e.role) === norm(fp.role) && norm(e.tag) === norm(fp.tag) && norm(e.inputType) === norm(fp.inputType);
  const pick = (cands: PageElement[], via: 'anchor' | 'page', confidence: number): Resolution | null => {
    if (cands.length === 0) return null;
    const scored = cands.map((e) => ({ e, s: nameSimilarity(e.name, fp.name) })).filter((x) => x.s >= NAME_MATCH);
    if (scored.length === 0) return null;
    const best = Math.max(...scored.map((x) => x.s));
    const top = scored.filter((x) => x.s === best);
    return top.length === 1 ? { kind: 'found', selector: top[0]!.e.selector, confidence: confidence * best, via } : { kind: 'ambiguous', count: top.length };
  };
  // 2. Role and name within the anchor.
  if (fp.anchor) {
    const r = pick(elements.filter((e) => sameKind(e) && norm(e.anchor) === norm(fp.anchor)), 'anchor', 0.9);
    if (r) return r;
  }
  // 3. Role and name on the page.
  return pick(elements.filter(sameKind), 'page', 0.7) ?? { kind: 'not_found' };
}

/** The page query that lists the controls a fingerprint can match. Reads no value. */
export function surfaceElementsScript(): string {
  return `/* hexactra:surface-elements */(() => {
  const out = [];
  const label = (el) => (el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
  const cssPath = (el) => { const parts = []; for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) { const i = n.parentElement ? Array.prototype.indexOf.call(n.parentElement.children, n) + 1 : 1; parts.unshift(n.tagName.toLowerCase() + ':nth-child(' + i + ')'); } return parts.join(' > '); };
  const anchorOf = (el) => { for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) { const l = n.getAttribute('aria-label') || (n.querySelector(':scope > legend, :scope > h1, :scope > h2, :scope > h3, :scope > label') || {}).innerText; if (l) return String(l).replace(/\\s+/g, ' ').trim().slice(0, 120); } return null; };
  for (const el of document.querySelectorAll('button,a[href],input,select,textarea,summary,[role]')) {
    if (out.length >= 500) break;
    const sels = [];
    if (el.id) sels.push('#' + CSS.escape(el.id));
    const t = el.getAttribute('data-testid') || el.getAttribute('data-test');
    if (t) sels.push('[data-testid="' + t.replace(/"/g, '') + '"]');
    sels.push(cssPath(el));
    const r = el.getBoundingClientRect();
    out.push({ visible: r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden', enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true', selector: sels[0], selectors: sels.slice(0, 3), role: el.getAttribute('role') || null, name: el.type === 'password' ? null : label(el) || null, tag: el.tagName.toLowerCase(), inputType: el.getAttribute('type'), anchor: anchorOf(el) });
  }
  return out;
})()`;
}

/** The page query that describes one element for capture (by selector or point). Reads no value. */
export function surfaceDescribeScript(where: { selector: string } | { x: number; y: number }): string {
  return `/* hexactra:surface-describe */(() => {
  const where = ${JSON.stringify(where)};
  let el = null;
  try { el = 'selector' in where ? document.querySelector(where.selector) : document.elementFromPoint(where.x, where.y); } catch (e) { return null; }
  if (!el) return null;
  const holder = el.closest('button,a[href],input,select,textarea,summary,[role]');
  if (holder) el = holder;
  const all = ${surfaceElementsScript().replace('/* hexactra:surface-elements */', '')};
  return all.find((x) => document.querySelector(x.selector) === el) || null;
})()`;
}

function asElement(v: unknown): PageElement | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const s = (x: unknown, n: number) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, n) : null);
  const selector = s(o.selector, 500);
  if (!selector) return null;
  const selectors = Array.isArray(o.selectors) ? o.selectors.map((x) => s(x, 500)).filter((x): x is string => x !== null).slice(0, 3) : [selector];
  return { selector, selectors, role: s(o.role, 40), name: s(o.name, 200), tag: s(o.tag, 40), inputType: s(o.inputType, 40), anchor: s(o.anchor, 120), ...(typeof o.visible === 'boolean' ? { visible: o.visible } : {}), ...(typeof o.enabled === 'boolean' ? { enabled: o.enabled } : {}) };
}

/** Every control the page lists, or null when the page cannot be asked. */
export async function pageElements(browser: BrowserPort): Promise<PageElement[] | null> {
  try {
    const op = await browser.act({ type: 'evaluate', script: surfaceElementsScript(), await_promise: false }, ACTION_TIMEOUT_MS);
    const v = op.state === 'succeeded' ? op.result?.value : null;
    return Array.isArray(v) ? v.map(asElement).filter((x): x is PageElement => x !== null) : null;
  } catch {
    return null;
  }
}

export interface CaptureOptions {
  /** The host's masking of a label before it is stored (the trace masking table). */
  mask?: (label: string) => string;
  /** The element is in a field marked sensitive: keep role and anchor only. */
  sensitive?: boolean;
}

/** Capture (E46.5 time): the fingerprint of the element a click, type or select acted on. Null when the page cannot say. */
export async function captureFingerprint(browser: BrowserPort, where: { selector: string } | { x: number; y: number }, options: CaptureOptions = {}): Promise<ElementFingerprint | null> {
  try {
    const op = await browser.act({ type: 'evaluate', script: surfaceDescribeScript(where), await_promise: false }, ACTION_TIMEOUT_MS);
    const e = asElement(op.state === 'succeeded' ? op.result?.value : null);
    if (!e) return null;
    const mask = options.mask ?? ((x: string) => x);
    return {
      role: e.role,
      name: options.sensitive || e.name === null ? null : mask(e.name),
      tag: e.tag,
      inputType: e.inputType,
      selectors: options.sensitive ? [] : e.selectors,
      anchor: e.anchor === null ? null : mask(e.anchor),
      frame: 'top',
    };
  } catch {
    return null;
  }
}

/** Replay: find the fingerprint's element on the current page. */
export async function resolveFingerprint(browser: BrowserPort, fp: ElementFingerprint): Promise<Resolution> {
  const elements = await pageElements(browser);
  return elements ? matchFingerprint(fp, elements) : { kind: 'not_found' };
}

/** A screen's key: the site, the path with ids and numbers as placeholders, the digest family. */
export function screenKeyOf(url: string, digest: string | null, registrable: (host: string) => string): ScreenKey | null {
  try {
    const u = new URL(url);
    const pathPattern = u.pathname.split('/').map((s) => (/^\d+$/.test(s) ? '*' : /^[0-9a-f-]{16,}$/i.test(s) || /^[A-Za-z0-9_-]{20,}$/.test(s) ? '*' : s)).join('/') || '/';
    return { site: registrable(u.hostname.toLowerCase()), pathPattern, digestFamily: digest ? digest.slice(0, 8) : null };
  } catch {
    return null;
  }
}

export { abortableSleep, PACING, pacingDelay, seededRandom, type PacingMode } from './pacing';
export { READINESS, readinessTimeout, waitForElement, waitUntil, type Readiness, type WaitOptions } from './conditions';
export { detectInterrupt, detectBlocked, detectConsent, detectOverlay, detectSignedOut, isConsentChoice, pageSnapshot, type Interrupt, type PageSnapshot } from './interrupts';
