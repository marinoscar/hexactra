// Which browser actions of an AI app signed in with OAuth need the user's
// approval first (#465). Deterministic rules, never a model: a hosted model
// reads page text a stranger wrote, so a page could talk it into a payment, a
// password form or a script that sends the user's data away. Defence in depth:
// none of this replaces the per-task opt-ins (allowed sites, confirmation
// before purchases), and the runner's own delegated runs are unchanged.
//
//   type_handoff_secret      always (it types a secret the user gave)
//   click/click_at/press/key/type+submit
//                            when the page's last element snapshot has a password
//                            or a payment field, or the page (or the link) is on
//                            a host of `mcp.sensitiveHosts`
//   navigate/new_tab         to a host of `mcp.sensitiveHosts`
//   desktop_click/type/key/drag
//                            always: the console cannot tell whether the point is
//                            inside the browser window, so it is treated as outside
//   evaluate                 when the source names fetch(, XMLHttpRequest,
//                            sendBeacon, document.cookie, localStorage or
//                            navigator.credentials: a tripwire, not a sandbox
//                            (`window['fe'+'tch']` passes it)
import { createHash } from 'node:crypto';
import { registerErrorCode } from '@marinoscar/platform-api/core';

// Registered at import, so the platform's exception filter keeps them and the OpenAPI document lists them.
registerErrorCode({ code: 'CONFIRMATION_REQUIRED', status: 409, description: "An AI app's sensitive browser action needs the user's approval: a high-risk confirm is waiting in their inbox (`details.questionId`). Retry the same action within 2 minutes of the approval." });
registerErrorCode({ code: 'CONFIRMATION_PENDING', status: 409, description: 'The approval of this sensitive action is still waiting for the user (`details.questionId`).' });
registerErrorCode({ code: 'CONFIRMATION_DENIED', status: 409, description: 'The user did not approve this sensitive action.' });

/** What the console remembers of the session's page from its last element list (`transcript.page`). */
export interface PageSnapshot {
  /** The page's URL when the snapshot was taken. */
  url: string | null;
  /** The page has a password field. */
  password: boolean;
  /** The page has a payment field (card number, security code, expiry, IBAN). */
  payment: boolean;
  /** The host each link's selector points to (at most 300). */
  links?: Record<string, string>;
}

/** One element of an element list, as the fabric returns it. */
export interface SnapshotElement {
  selector?: unknown;
  tag?: unknown;
  type?: unknown;
  role?: unknown;
  text?: unknown;
  href?: unknown;
  autocomplete?: unknown;
}

const PASSWORD_HINT = /\b(current-password|new-password)\b|type=["']?password/i;
const PAYMENT_HINT = /\bcc-(number|csc|exp|exp-month|exp-year|name|type)\b|card[\s_-]?number|cardnumber|\bcvc\b|\bcvv\b|\bcsc\b|security[\s_-]?code|\biban\b|expir(y|ation)[\s_-]?date/i;
const LINKS_MAX = 300;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** The host of a URL, lowercased; null when it is not an http(s) URL. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Whether `host` is one of `list` or under one (suffix match on a label boundary). */
export function hostListed(host: string | null, list: readonly string[]): boolean {
  if (!host) return false;
  return list.some((h) => {
    const d = h.toLowerCase().replace(/^\*\./, '').replace(/^\.+/, '');
    return d !== '' && (host === d || host.endsWith(`.${d}`));
  });
}

/** The snapshot of an element list (`elements` action result). */
export function snapshotOf(result: { url?: unknown; elements?: unknown } | undefined): PageSnapshot {
  const elements = Array.isArray(result?.elements) ? (result!.elements as SnapshotElement[]) : [];
  let password = false;
  let payment = false;
  const links: Record<string, string> = {};
  for (const e of elements) {
    const type = str(e.type).toLowerCase();
    const hint = `${str(e.selector)} ${str(e.autocomplete)} ${type === 'password' ? 'type=password' : ''} ${str(e.tag).toLowerCase() === 'input' ? str(e.text) : ''}`;
    if (type === 'password' || PASSWORD_HINT.test(hint)) password = true;
    if (PAYMENT_HINT.test(hint)) payment = true;
    const host = hostOf(str(e.href));
    if (host && str(e.selector) && Object.keys(links).length < LINKS_MAX) links[str(e.selector)] = host;
  }
  return { url: typeof result?.url === 'string' ? result.url : null, password, payment, links };
}

/** The JavaScript names that reach the network or the user's stored credentials. */
export const EVALUATE_TRIPWIRES = ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'document.cookie', 'localStorage', 'navigator.credentials'] as const;

/** The tripwires a script trips (whitespace before `(` is ignored). */
export function evaluateTripwires(script: string): string[] {
  const compact = script.replace(/fetch\s+\(/g, 'fetch(');
  return EVALUATE_TRIPWIRES.filter((t) => compact.includes(t));
}

/** Why an action needs the user's approval, and what the approval is bound to. */
export interface SensitiveVerdict {
  /** The rule: `secret`, `password_form`, `payment_form`, `sensitive_host`, `desktop`, `evaluate`. */
  rule: 'secret' | 'password_form' | 'payment_form' | 'sensitive_host' | 'desktop' | 'evaluate';
  /** The action kind (`click`, `navigate`, ...). */
  kind: string;
  /** What the action acts on: a selector, a host, a point, a script digest. Part of the approval's key. */
  target: string;
  /** What the user is asked about, in words: "submit a form with a password field on example.test". */
  describe: string;
}

const SUBMIT_KEYS = new Set(['enter', 'return', 'numpadenter', ' ', 'space']);

function sha(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Classifies one action of `POST /browser/sessions/:id/actions`. `null`: no
 * approval needed. Pure.
 */
export function classifySensitiveAction(action: Record<string, unknown>, ctx: { page: PageSnapshot | null; sensitiveHosts: readonly string[] }): SensitiveVerdict | null {
  const kind = str(action.type);
  const page = ctx.page;
  const pageHost = hostOf(page?.url ?? null);
  const where = pageHost ? ` on ${pageHost}` : '';

  if (kind === 'type_handoff_secret') {
    return { rule: 'secret', kind, target: `${str(action.handoffId)}|${str(action.selector)}`, describe: `type a secret you gave it into ${str(action.selector) || 'the page'}${where}` };
  }
  if (kind === 'evaluate') {
    const script = str(action.script);
    const trips = evaluateTripwires(script);
    if (trips.length === 0) return null;
    return { rule: 'evaluate', kind, target: sha(script), describe: `run JavaScript${where} that uses ${trips.join(', ')} (it can send data away or read stored sign-ins)` };
  }
  if (kind === 'desktop_click' || kind === 'desktop_type' || kind === 'desktop_key' || kind === 'desktop_drag') {
    const target =
      kind === 'desktop_type' ? `text:${sha(str(action.text))}` : kind === 'desktop_key' ? `key:${str(action.key)}` : `${String(action.x ?? action.from_x ?? '')},${String(action.y ?? action.from_y ?? '')}`;
    const what = kind === 'desktop_type' ? 'type on the desktop, outside the browser' : kind === 'desktop_key' ? `press ${str(action.key)} on the desktop, outside the browser` : 'click on the desktop, outside the browser';
    return { rule: 'desktop', kind, target, describe: what };
  }
  if (kind === 'navigate' || kind === 'new_tab') {
    const host = hostOf(str(action.url));
    if (host && hostListed(host, ctx.sensitiveHosts)) return { rule: 'sensitive_host', kind, target: host, describe: `open ${host}` };
    return null;
  }

  const submits =
    kind === 'click' ||
    kind === 'click_at' ||
    (kind === 'press' && SUBMIT_KEYS.has(str(action.key).toLowerCase())) ||
    (kind === 'key' && SUBMIT_KEYS.has(str(action.key).toLowerCase())) ||
    (kind === 'type' && action.submit === true);
  if (!submits) return null;
  const target = kind === 'click_at' ? `${String(action.x)},${String(action.y)}` : kind === 'press' || kind === 'key' ? `key:${str(action.key)}` : str(action.selector);
  const linkHost = kind === 'click' ? (page?.links?.[str(action.selector)] ?? null) : null;
  if (linkHost && hostListed(linkHost, ctx.sensitiveHosts)) return { rule: 'sensitive_host', kind, target: `${linkHost}|${target}`, describe: `follow a link to ${linkHost}` };
  if (pageHost && hostListed(pageHost, ctx.sensitiveHosts)) return { rule: 'sensitive_host', kind, target: `${pageHost}|${target}`, describe: `${kind === 'type' ? 'submit a form' : kind === 'press' || kind === 'key' ? `press ${str(action.key)}` : 'click'} on ${pageHost}` };
  if (page?.payment) return { rule: 'payment_form', kind, target, describe: `${kind === 'type' ? 'submit' : 'act on'} a form with a payment field${where}` };
  if (page?.password) return { rule: 'password_form', kind, target, describe: `${kind === 'type' ? 'submit' : 'act on'} a form with a password field${where}` };
  return null;
}

/** The key an approval is bound to: the session, the action kind and the target. */
export function approvalKey(sessionRunId: string, v: Pick<SensitiveVerdict, 'kind' | 'target'>): string {
  return sha(`${sessionRunId}\n${v.kind}\n${v.target}`).slice(0, 40);
}

/** How long an approval lets the action through. */
export const APPROVAL_TTL_MS = 2 * 60_000;
/** How long a "no" stands before the app may ask again. */
export const DENIAL_TTL_MS = 10 * 60_000;
/** How long the question stays open. */
export const APPROVAL_QUESTION_TIMEOUT_MS = 10 * 60_000;

/** One approval request, kept in the session's transcript (`transcript.approvals`, the last 20). */
export interface ApprovalEntry {
  key: string;
  questionId: string;
  /** Set when the approved action went through (an approval lets it through once). */
  usedAt?: string | null;
}
