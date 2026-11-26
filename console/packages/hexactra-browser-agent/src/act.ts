// Running one browser action under the run's rules (E38.5), and turning its result into the text the model reads and the step a person
// reads. Every browser tool that acts goes through `act`; none of them records the step itself.
import { actionTarget, clip, digest, inCommitTool, LEASE_LOST_TEXT, mutatingAction, redactUrl, STOPPED_TEXT, type GateTarget } from '@marinoscar/hexactra-agent';
import { ACTION_TIMEOUT_MS, BrowserAborted, BrowserError } from './browser-port';
import type { BrowserContext } from './context';
import { codeBoxesNote } from './fill-report';

/** What the stall detector learns from a result beyond its arguments (#405): where the page is, and whether new content came back. */
type StallExtra = { url?: string | null; title?: string | null; contentHash?: string; resultKey?: string };

/** Run one browser action under the policy, record it, and return what the model sees. */
export async function act(ctx: BrowserContext, action: Record<string, unknown>, reason?: string, target?: { x: number; y: number; w?: number; h?: number }, commits?: GateTarget | null): Promise<string> {
  const started = Date.now();
  const type = String(action.type);
  // Another job took the run, Stop or Pause was pressed, or a budget is spent: nothing is sent and nothing is recorded.
  const refused = await ctx.preflight();
  if (refused) return refused;
  await ctx.setActivity('acting', { action, reason, timeoutMs: ACTION_TIMEOUT_MS, target: target ?? actionTarget(action, ctx.ext.state.marks.values()) });
  try {
    // An action that can commit something (a gated click, a commit-class tool, any action after an approved confirmation)
    // is written as an intent before it is sent (E38.3).
    const commit = commits || inCommitTool() || (mutatingAction(type) && Boolean(ctx.memory.pendingConfirmation || ctx.memory.confirmedTarget));
    const intent = commit ? await ctx.openIntent(type, action, commits ?? null) : null;
    if (commit && intent === null) return LEASE_LOST_TEXT;
    return await runAction(ctx, action, type, started, reason, intent);
  } finally {
    // Back to the model, which reads the result and picks the next step.
    await ctx.setActivity('thinking');
  }
}

async function runAction(ctx: BrowserContext, action: Record<string, unknown>, type: string, started: number, reason?: string, intent: number | null = null): Promise<string> {
  const { browser, state: page, masking, observationChars } = ctx.ext;
  let op;
  try {
    op = await browser.act(action, ACTION_TIMEOUT_MS, { signal: ctx.ports.control.abortSignal });
  } catch (e) {
    // Stop ended the wait (E38.1): the host finishes the action by itself, so its effect is not known.
    if (e instanceof BrowserAborted) {
      ctx.state.stop = 'cancel';
      await ctx.record('action', type, action, false, 'Stopped by the owner while this was running; its effect on the page is not known.', started, reason);
      return STOPPED_TEXT;
    }
    const msg = e instanceof BrowserError ? e.message : String(e);
    await ctx.record('action', type, action, false, msg, started, reason, undefined, intent);
    return `Error: ${msg}`;
  }
  const blockedNote = await recordBlocked(ctx, op.navigation_blocked);
  if (op.state !== 'succeeded') {
    const msg = op.error ?? op.state;
    await ctx.record('action', type, action, false, msg, started, reason, undefined, intent);
    return `Failed (${op.state}): ${msg}${blockedNote}`;
  }
  const result = op.result ?? {};
  let summary = 'done';
  let forModel = 'ok';
  let extra: StallExtra = {};
  if (type === 'navigate') {
    extra = { url: String(result.url ?? ''), title: typeof result.title === 'string' ? result.title : null };
    // The model needs the real URL; the stored step gets it without its query.
    forModel = `at ${String(result.url ?? '')} — ${String(result.title ?? '')}`;
    summary = `at ${redactUrl(String(result.url ?? ''))} — ${clip(String(result.title ?? ''), 200)}`;
  }
  // Inputs the host filled from a provider (an identity detail, a saved login's password) are never read back (E37.6).
  const filledHere = await masking.filledNow();
  if (type === 'text') {
    let text = String(result.text ?? '');
    const asked = typeof action.selector === 'string' ? action.selector : null;
    // A read of the filled input itself, or of an element that holds one, returns the marker instead of the page's text.
    const hidden = asked && filledHere.length ? await masking.maskedText(asked, filledHere) : null;
    if (hidden !== null) text = hidden;
    extra = { contentHash: digest(text) };
    summary = `read ${text.length} characters`;
    forModel = clip(text, observationChars);
  }
  if (type === 'elements') {
    let els = (result.elements as Array<Record<string, unknown>> | undefined) ?? [];
    if (filledHere.length) els = await masking.maskElements(els, filledHere);
    page.labels.clear();
    extra = { contentHash: digest(JSON.stringify(els.map((el) => [el.selector, el.text, el.name]))) };
    for (const el of els) {
      const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
      page.labels.set(String(el.selector), { label: str(el.aria_label) ?? str(el.text) ?? str(el.name), role: str(el.role), tag: str(el.tag), inputType: str(el.type) });
    }
    summary = `${els.length} interactive elements`;
    forModel = clip(JSON.stringify(els.map((el) => ({ selector: el.selector, tag: el.tag, role: el.role, text: el.text, type: el.type, name: el.name }))), observationChars);
  }
  if (type === 'scroll') extra = { resultKey: `y${String(result.y ?? '')}` };
  if (type === 'scroll') summary = forModel = `scrolled to ${String(result.y ?? '?')}`;
  if (type === 'evaluate') {
    // A script that could read a form control's value, while a filled input is on the page: best effort, deliberately broad.
    const hidden = filledHere.length > 0 && masking.hidesScript(String(action.script ?? ''));
    const value = hidden ? JSON.stringify(masking.marker) : (JSON.stringify(result.value ?? null) ?? 'undefined');
    extra = { contentHash: digest(value) };
    summary = `returned ${String(result.type ?? typeof result.value)} (${value.length} characters)`;
    forModel = hidden ? `string: ${value}` : clip(`${String(result.type ?? '')}: ${value}${result.description ? ` (${String(result.description)})` : ''}`, observationChars);
  }
  if (type === 'tabs') {
    const tabs = (result.tabs as Record<string, unknown>[] | undefined) ?? [];
    const active = tabs.find((t) => t.active === true);
    if (active && typeof active.url === 'string') extra = { url: active.url, title: typeof active.title === 'string' ? active.title : null };
    summary = `${tabs.length} tabs`;
    forModel = clip(JSON.stringify(tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active }))), observationChars);
  }
  if (type === 'new_tab') summary = forModel = `opened tab ${String(result.tab_id ?? '?')}`;
  if (type === 'type') {
    // A code split into boxes (E49.1, #958): how many were filled, or that the page moved on. A plain field keeps "ok".
    const note = codeBoxesNote(result);
    if (note) summary = forModel = note.startsWith('into') ? `typed ${note}` : `typed; ${note}`;
  }
  await ctx.record('action', type, action, true, summary, started, reason, extra, intent);
  return `${forModel}${blockedNote}`;
}

/**
 * Navigations the browser blocked under the run's allowed sites (#508), each as its own step. Like a routing step it takes a `seq`,
 * never the step count or the actions budget. Returns a note for the model, or ''.
 */
async function recordBlocked(ctx: BrowserContext, blocked: Array<{ host: string; at: string }> | undefined): Promise<string> {
  const hosts = [...new Set((blocked ?? []).map((b) => String(b.host)).filter(Boolean))].slice(0, 10);
  for (const host of hosts) {
    ctx.state.seq += 1;
    await ctx.ports.store.appendStep({ seq: ctx.state.seq, kind: 'navigation_blocked', action: null, args: { host }, ok: false, summary: clip(`blocked a page on ${host}: not in this run's allowed sites`, 1_900), durationMs: 0 });
  }
  return hosts.length ? `\n(The browser blocked a page on ${hosts.join(', ')}: not in this run's allowed sites.)` : '';
}
