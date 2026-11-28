// What the server asks the page itself, outside `act`: not actions, so no step, no budget and no stall. Never the model's words.
import { clip } from '@marinoscar/hexactra-agent';
import { ACTION_TIMEOUT_MS, type BrowserPort } from './browser-port';
import type { BrowserContext } from './context';
import { hostOf, type TargetFacts } from './policy';

/**
 * The page script that describes a click target for the gate (#550): the element a selector names or the one
 * under a viewport point, widened to the control that holds it, as `{ label, role, tag, inputType, formAction }`.
 * It reads; it never acts. The marker comment lets a test fabric recognise it.
 */
export function describeScript(where: { selector: string } | { x: number; y: number }): string {
  return `/* hexactra:describe-target */(() => {
  const where = ${JSON.stringify(where)};
  let el = null;
  try { el = 'selector' in where ? document.querySelector(where.selector) : document.elementFromPoint(where.x, where.y); } catch (e) { return null; }
  if (!el) return null;
  const holder = el.closest('button,a[href],input,select,textarea,option,summary,[role]');
  if (holder) el = holder;
  const tag = el.tagName.toLowerCase();
  const text = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || el.getAttribute('alt') || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
  const form = el.form || null;
  const formAction = el.getAttribute('formaction') || (form && form.getAttribute('action')) || null;
  return { label: text, role: el.getAttribute('role'), tag, inputType: el.getAttribute('type') || (tag === 'button' && form ? 'submit' : null), formAction };
})()`;
}

/**
 * What the page says about a click target (#550): one evaluate, outside `act`. The element under a point, or the one a selector names,
 * widened to the control that holds it. Null when the page cannot be asked (a failure, a cross-origin frame).
 */
export async function describeTarget(ctx: BrowserContext, where: { selector: string } | { x: number; y: number }): Promise<TargetFacts | null> {
  try {
    const op = await ctx.ext.browser.act({ type: 'evaluate', script: describeScript(where), await_promise: false }, ACTION_TIMEOUT_MS);
    const v = op.state === 'succeeded' ? (op.result?.value as Record<string, unknown> | null | undefined) : null;
    if (!v || typeof v !== 'object') return null;
    const str = (x: unknown, n: number) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, n) : null);
    const facts: TargetFacts = { label: str(v.label, 200), role: str(v.role, 40), tag: str(v.tag, 40), inputType: str(v.inputType, 40), formAction: str(v.formAction, 500) };
    // An iframe holds the real target in another document: its facts are unknown, not the frame's.
    return facts.tag === 'iframe' || facts.tag === 'frame' ? null : facts;
  } catch {
    return null;
  }
}

/** The URL of the active tab, as the browser reports it (#550, #555): never the model's words. Not an action. */
export const currentUrl = (ctx: BrowserContext): Promise<string | null> => currentUrlOf(ctx.ext.browser);

export async function currentUrlOf(browser: BrowserPort): Promise<string | null> {
  try {
    const op = await browser.act({ type: 'tabs' }, ACTION_TIMEOUT_MS);
    const tabs = (op.result?.tabs as Record<string, unknown>[] | undefined) ?? [];
    const active = tabs.find((t) => t.active === true);
    return typeof active?.url === 'string' ? active.url : null;
  } catch {
    return null;
  }
}

/** The host of the active tab, as the browser reports it (#550): never the model's words. Not an action. */
export async function currentHost(ctx: BrowserContext): Promise<string | null> {
  return hostOf(await currentUrl(ctx));
}

/** Whether the last step this job recorded after `seqBefore` was a successful action. */
export async function lastStepOk(ctx: BrowserContext, seqBefore: number): Promise<boolean> {
  if (ctx.state.seq === seqBefore) return false;
  const step = await ctx.ports.store.getStep(ctx.state.seq);
  return Boolean(step?.ok && step.kind === 'action');
}

/**
 * The page script that hashes what a person would see change (E52.3, #1018): the address, the title, the visible text, the number of
 * elements, what has the focus, the open dialogs, and the length (never the value) of each field. One 32-bit FNV-1a hash, 8 hex
 * characters: no page text and no field value leaves the page. The marker comment lets a test fabric recognise it.
 */
export function digestScript(withPlace = false): string {
  // E54.2: with `withPlace`, the same check also says where the page is (address, title, open dialogs): no second call. Without it the script
  // is byte-identical to before, so a run under a policy without `delta` sends exactly what it sent.
  const place = withPlace
    ? `, u: location.href.slice(0, 2000), t: String(document.title || '').slice(0, 300), d: document.querySelectorAll('[role=dialog], dialog[open], [aria-modal=true]').length`
    : '';
  return `/* hexactra:page-digest */(() => {
  let h = 0x811c9dc5;
  const add = (s) => { s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } h ^= 0x7c; h = Math.imul(h, 0x01000193) >>> 0; };
  add(location.href); add(document.title);
  add(((document.body && document.body.innerText) || '').slice(0, 200000));
  add(document.getElementsByTagName('*').length);
  const a = document.activeElement; add(a ? a.tagName + '#' + (a.id || '') + '@' + (a.getAttribute('name') || '') : '');
  add(document.querySelectorAll('[role=dialog], dialog[open], [aria-modal=true]').length);
  for (const f of document.querySelectorAll('input:not([type=password]), textarea, select, [contenteditable]')) {
    const v = 'value' in f && f.tagName !== 'DIV' ? f.value : f.textContent;
    add(String(v == null ? '' : v).length); add(f.checked ? 1 : 0);
  }
  return { h: (h >>> 0).toString(16).padStart(8, '0')${place} };
})()`;
}

/** The page digest (E52.3): one evaluate outside `act`, so no step, no budget and no stall feed. Null when the page cannot be asked. */
export async function pageDigest(ctx: BrowserContext): Promise<string | null> {
  const delta = ctx.ports.policy.policy.actionResults === 'delta';
  try {
    const op = await ctx.ext.browser.act({ type: 'evaluate', script: digestScript(delta), await_promise: false }, ACTION_TIMEOUT_MS);
    const v = op.state === 'succeeded' ? (op.result?.value as { h?: unknown; u?: unknown; t?: unknown; d?: unknown } | null | undefined) : null;
    const ok = v && typeof v.h === 'string' && /^[0-9a-f]{8}$/.test(v.h);
    if (delta && ok && typeof v.u === 'string') ctx.ext.state.place = { url: v.u, title: typeof v.t === 'string' ? v.t : '', dialogs: typeof v.d === 'number' ? v.d : 0 };
    return ok ? (v.h as string) : null;
  } catch {
    return null;
  }
}

/** When the digest is read again after an action (E52.3), in milliseconds after it returned. */
export const SETTLE_DELAYS_MS: readonly number[] = [0, 150, 300, 600];

/**
 * Whether an action changed nothing on the page (E52.3): the digest after it, read at each of the delays until one differs, equals the
 * digest before. A failed read, a page that is gone, or Stop or Pause pressed while waiting are "changed" (never claim what is not known).
 */
export async function unchangedAfter(ctx: BrowserContext, before: string | null): Promise<boolean> {
  if (before === null) return false;
  const delays = ctx.ext.settleDelaysMs ?? SETTLE_DELAYS_MS;
  let waited = 0;
  for (const at of delays) {
    if (at > waited) await new Promise((r) => setTimeout(r, at - waited));
    waited = Math.max(waited, at);
    if (ctx.ports.control.requested || ctx.ports.control.pauseRequested) return false;
    const now = await pageDigest(ctx);
    if (now === null || now !== before) return false;
  }
  return true;
}

/**
 * Where the page is now, for the model after a click or key press that changed it (E54.2, #1083): one sentence from the last page check.
 * Page text: the title is the site's words, quoted as data.
 */
export function placeNote(place: { url: string; title: string; dialogs: number }): string {
  const title = place.title ? ` — "${clip(place.title, 120)}"` : '';
  return ` Now at ${clip(place.url, 300)}${title}${place.dialogs > 0 ? '; a dialog is open' : ''}.`;
}

/**
 * The open tabs, for the round's status (E54.2): `Tabs: 3 open; active: "Title" at https://…`. One tabs read outside `act` (no step, no
 * budget). Null when the browser cannot be asked or there is one tab whose page the round's screenshot already shows.
 */
export async function tabsLine(ctx: BrowserContext): Promise<string | null> {
  try {
    const op = await ctx.ext.browser.act({ type: 'tabs' }, ACTION_TIMEOUT_MS);
    const tabs = (op.result?.tabs as Record<string, unknown>[] | undefined) ?? [];
    if (tabs.length < 2) return null;
    const active = tabs.find((t) => t.active === true);
    const what = active ? `active: "${clip(String(active.title ?? ''), 80)}" at ${clip(String(active.url ?? ''), 200)}` : 'none active';
    return `Tabs: ${tabs.length} open; ${what}. switch_tab changes it; you do not need tabs to find out.`;
  } catch {
    return null;
  }
}
