// What the server asks the page itself, outside `act`: not actions, so no step, no budget and no stall. Never the model's words.
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
