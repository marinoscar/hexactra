// Remote control bridge (epic #173).
//
// The service worker connects to the native messaging host
// `com.hexactra.nativehost`, which relays frames to the local Hexactra host
// agent. The agent sends bounded actions (see crates/hexactra-core/src/remote.rs);
// this module executes them with chrome.tabs / chrome.scripting, and with
// chrome.debugger (cdp.ts) for trusted input, JavaScript and capture (#366).
//
// Wire format (both directions are JSON objects):
//   agent -> extension: { "type": "request", "id": string, "action": RemoteAction, "deadline_ms": number }
//   extension -> agent: { "type": "response", "id": string, "ok": boolean, "result"?: any, "error"?: string }
//   extension -> agent: { "type": "hello", "version": string }
//   agent <-> extension: { "type": "ping" } / { "type": "pong" }

import * as cdp from './cdp.js';

export const NATIVE_HOST_NAME = 'com.hexactra.nativehost';

type Button = 'left' | 'middle' | 'right';

export type RemoteAction =
  | { type: 'navigate'; url: string; tab_id?: number }
  | { type: 'click'; selector: string; tab_id?: number }
  | { type: 'type'; selector: string; text: string; clear?: boolean; submit?: boolean; tab_id?: number }
  | { type: 'press'; key: string; selector?: string; tab_id?: number }
  | { type: 'scroll'; dx?: number; dy?: number; selector?: string; tab_id?: number }
  | { type: 'screenshot'; marks?: boolean; tab_id?: number }
  | { type: 'evaluate'; script: string; await_promise?: boolean; tab_id?: number }
  | { type: 'click_at'; x: number; y: number; button?: Button; click_count?: number; modifiers?: string[]; tab_id?: number }
  | { type: 'mouse'; op: 'move' | 'down' | 'up'; x: number; y: number; button?: Button; tab_id?: number }
  | { type: 'drag'; from_x: number; from_y: number; to_x: number; to_y: number; steps?: number; tab_id?: number }
  | { type: 'scroll_at'; x: number; y: number; dx?: number; dy?: number; tab_id?: number }
  | { type: 'type_keys'; text: string; tab_id?: number }
  | { type: 'key'; key: string; modifiers?: string[]; tab_id?: number }
  | { type: 'text'; selector?: string; max_chars?: number; tab_id?: number }
  | { type: 'elements'; max_elements?: number; tab_id?: number }
  | { type: 'wait_for'; selector: string; timeout_ms?: number; tab_id?: number }
  | { type: 'tabs' }
  | { type: 'new_tab'; url?: string }
  | { type: 'activate_tab'; tab_id: number }
  | { type: 'close_tab'; tab_id: number }
  | { type: 'back'; tab_id?: number }
  | { type: 'forward'; tab_id?: number }
  | { type: 'reload'; tab_id?: number };

export interface BridgeRequest {
  type: 'request';
  id: string;
  action: RemoteAction;
  deadline_ms?: number;
}

export interface BridgeResponse {
  type: 'response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Error raised for an action that cannot be performed. */
export class ActionError extends Error {}

const DEFAULT_NAV_TIMEOUT_MS = 30_000;
const DEFAULT_TEXT_CHARS = 20_000;
const DEFAULT_MAX_ELEMENTS = 150;

/**
 * Any URL a person could type may be opened, except `javascript:` (use the
 * evaluate action). Mirrors check_navigable_url in Rust.
 */
export function isNavigableUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    if (u.protocol === 'javascript:') return false;
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.host.length === 0) return false;
    return true;
  } catch {
    return false;
  }
}

function remaining(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

async function resolveTab(tabId?: number): Promise<chrome.tabs.Tab> {
  if (typeof tabId === 'number') {
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      throw new ActionError(`no tab with id ${tabId}`);
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined) {
    const [any] = await chrome.tabs.query({ active: true });
    if (any?.id === undefined) throw new ActionError('no active tab');
    return any;
  }
  return tab;
}

/** Wait until a tab finishes loading (status "complete") or the deadline passes. */
export function waitForTabComplete(tabId: number, timeoutMs: number): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      fn();
    };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (id === tabId && info.status === 'complete') finish(() => resolve(tab));
    };
    const timer = setTimeout(
      () => finish(() => reject(new ActionError('page did not finish loading in time'))),
      timeoutMs,
    );
    chrome.tabs.onUpdated.addListener(listener);
    // The load may already be complete (e.g. same-document navigation).
    setTimeout(() => {
      chrome.tabs
        .get(tabId)
        .then((t) => {
          if (t.status === 'complete') finish(() => resolve(t));
        })
        .catch(() => undefined);
    }, 250);
  });
}

/** Run a page function in a tab and return its result, mapping injection errors. */
async function inPage<A extends unknown[], R>(
  tabId: number,
  func: (...args: A) => R,
  args: A,
): Promise<Awaited<R>> {
  let results: chrome.scripting.InjectionResult<Awaited<R>>[];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      func: func as unknown as () => R,
      args: args as unknown as [],
    }) as chrome.scripting.InjectionResult<Awaited<R>>[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ActionError(`cannot act on this page: ${msg}`);
  }
  const first = results?.[0] as (chrome.scripting.InjectionResult<Awaited<R>> & { error?: unknown }) | undefined;
  if (!first) throw new ActionError('script returned no result');
  if (first.error) throw new ActionError(String((first.error as { message?: string }).message ?? first.error));
  const value = first.result as Awaited<R> & { __error?: string };
  if (value && typeof value === 'object' && '__error' in value && value.__error) {
    throw new ActionError(value.__error);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Page functions. These run inside the page via chrome.scripting.executeScript
// and must be self-contained (no closures over module scope).

export function pageClick(selector: string) {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return { __error: `no element matches ${selector}` };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  if (typeof el.focus === 'function') el.focus();
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.click();
  return {};
}

export function pageType(selector: string, text: string, clear: boolean, submit: boolean) {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return { __error: `no element matches ${selector}` };
  el.scrollIntoView({ block: 'center' });
  el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const next = (clear ? '' : el.value) + text;
    if (setter) setter.call(el, next);
    else el.value = next;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (el.isContentEditable) {
    if (clear) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    document.execCommand('insertText', false, text);
  } else {
    return { __error: `element ${selector} is not editable` };
  }
  if (submit) {
    const form = (el as HTMLInputElement).form ?? el.closest('form');
    const init = { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true };
    const proceed = el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    if (proceed && form) {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
    }
  }
  return {};
}

export function pagePress(key: string, selector: string | null) {
  const target = (selector ? document.querySelector(selector) : document.activeElement) as HTMLElement | null;
  if (!target) return { __error: selector ? `no element matches ${selector}` : 'no focused element' };
  if (selector) target.focus();
  const init = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true };
  const proceed = target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
  if (proceed && key === 'Enter') {
    const form = (target as HTMLInputElement).form ?? target.closest('form');
    if (form) {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
    } else if (target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement) {
      target.click();
    }
  }
  return {};
}

export function pageScroll(dx: number, dy: number, selector: string | null) {
  if (selector) {
    const el = document.querySelector(selector);
    if (!el) return { __error: `no element matches ${selector}` };
    el.scrollIntoView({ block: 'center' });
  } else {
    window.scrollBy(dx, dy);
  }
  return { x: window.scrollX, y: window.scrollY };
}

export function pageText(selector: string | null, maxChars: number) {
  const el = (selector ? document.querySelector(selector) : document.body) as HTMLElement | null;
  if (!el) return { __error: selector ? `no element matches ${selector}` : 'page has no body' };
  const text = (el.innerText ?? el.textContent ?? '').replace(/\n{3,}/g, '\n\n');
  return { text: text.slice(0, maxChars), truncated: text.length > maxChars, url: location.href, title: document.title };
}

export function pageHistoryGo(delta: number) {
  if (history.length <= 1) return { __error: 'no history entry to go to' };
  history.go(delta);
  return {};
}

export function pageExists(selector: string) {
  return { found: document.querySelector(selector) !== null };
}

export function pageElements(max: number) {
  const query =
    'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], ' +
    '[role=checkbox], [role=tab], [role=menuitem], [role=option], [contenteditable=""], [contenteditable=true]';
  const esc = (s: string) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
  const unique = (sel: string) => {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };
  const selectorFor = (el: Element): string => {
    if (el.id && unique(`#${esc(el.id)}`)) return `#${esc(el.id)}`;
    for (const attr of ['data-testid', 'data-test', 'name', 'aria-label']) {
      const v = el.getAttribute(attr);
      if (v) {
        const s = `${el.tagName.toLowerCase()}[${attr}="${v.replace(/"/g, '\\"')}"]`;
        if (unique(s)) return s;
      }
    }
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement) {
      let part = cur.tagName.toLowerCase();
      if (cur.id && unique(`#${esc(cur.id)}`)) {
        parts.unshift(`#${esc(cur.id)}`);
        break;
      }
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  };
  const out: Record<string, unknown>[] = [];
  for (const el of Array.from(document.querySelectorAll(query))) {
    if (out.length >= max) break;
    const h = el as HTMLElement;
    const r = h.getBoundingClientRect();
    const style = getComputedStyle(h);
    if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
    const label =
      h.getAttribute('aria-label') ||
      (h as HTMLInputElement).placeholder ||
      (h.innerText || '').trim() ||
      (h as HTMLInputElement).value ||
      h.getAttribute('title') ||
      '';
    out.push({
      selector: selectorFor(h),
      tag: h.tagName.toLowerCase(),
      type: h.getAttribute('type') ?? undefined,
      role: h.getAttribute('role') ?? undefined,
      text: label.replace(/\s+/g, ' ').slice(0, 100),
      href: h instanceof HTMLAnchorElement ? h.href : undefined,
      in_viewport: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
    });
  }
  return { elements: out, url: location.href, title: document.title };
}

/** The overlay's element id. */
export const MARKS_ID = '__hexactra_marks__';

/**
 * Box and number the interactive elements in the viewport, for a model that
 * looks at the screenshot; returns them with selectors and CSS-pixel boxes.
 */
export function pageMarks(max: number, overlayId: string) {
  document.getElementById(overlayId)?.remove();
  const query =
    'a[href], button, input:not([type=hidden]), select, textarea, summary, label, [role=button], [role=link], ' +
    '[role=checkbox], [role=radio], [role=switch], [role=tab], [role=menuitem], [role=option], [role=combobox], ' +
    '[role=slider], [role=textbox], [onclick], [tabindex]:not([tabindex="-1"]), [contenteditable=""], [contenteditable=true], canvas, iframe';
  const esc = (s: string) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
  const unique = (sel: string) => {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };
  const selectorFor = (el: Element): string => {
    if (el.id && unique(`#${esc(el.id)}`)) return `#${esc(el.id)}`;
    for (const attr of ['data-testid', 'data-test', 'name', 'aria-label']) {
      const v = el.getAttribute(attr);
      if (v) {
        const s = `${el.tagName.toLowerCase()}[${attr}="${v.replace(/"/g, '\\"')}"]`;
        if (unique(s)) return s;
      }
    }
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement) {
      let part = cur.tagName.toLowerCase();
      if (cur.id && unique(`#${esc(cur.id)}`)) {
        parts.unshift(`#${esc(cur.id)}`);
        break;
      }
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  };
  const candidates = new Set<Element>(Array.from(document.querySelectorAll(query)));
  // Custom widgets: anything drawn with a pointer cursor.
  for (const el of Array.from(document.querySelectorAll('div, span, li, img, svg, td'))) {
    if (candidates.size > max * 4) break;
    if (getComputedStyle(el).cursor === 'pointer' && !(el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer')) candidates.add(el);
  }
  const overlay = document.createElement('div');
  overlay.id = overlayId;
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const palette = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080', '#9a6324', '#800000'];
  const marks: Record<string, unknown>[] = [];
  for (const el of candidates) {
    if (marks.length >= max) break;
    const h = el as HTMLElement;
    const r = h.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
    const style = getComputedStyle(h);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    // Skip elements covered by something else at their center.
    const cx = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
    const cy = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
    const top = document.elementFromPoint(cx, cy);
    if (top && top !== h && !h.contains(top) && !top.contains(h)) continue;
    const n = marks.length + 1;
    const color = palette[n % palette.length];
    const box = document.createElement('div');
    box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border:2px solid ${color};box-sizing:border-box;`;
    const tag = document.createElement('div');
    tag.textContent = String(n);
    tag.style.cssText = `position:absolute;left:-2px;top:-2px;transform:translateY(${r.top < 16 ? 0 : -100}%);background:${color};color:#fff;font:bold 11px/14px monospace;padding:0 3px;`;
    box.appendChild(tag);
    overlay.appendChild(box);
    const label =
      h.getAttribute('aria-label') ||
      (h as HTMLInputElement).placeholder ||
      (h.innerText || '').trim() ||
      (h as HTMLInputElement).value ||
      h.getAttribute('title') ||
      h.getAttribute('alt') ||
      '';
    marks.push({
      n,
      selector: selectorFor(h),
      tag: h.tagName.toLowerCase(),
      role: h.getAttribute('role') ?? undefined,
      text: label.replace(/\s+/g, ' ').slice(0, 80),
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    });
  }
  document.documentElement.appendChild(overlay);
  return { marks, ...pageViewportInfo() };

  function pageViewportInfo() {
    return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1, url: location.href, title: document.title };
  }
}

export function pageClearMarks(overlayId: string) {
  document.getElementById(overlayId)?.remove();
  return {};
}

export function pageViewport() {
  return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1, url: location.href, title: document.title };
}

/** Scale a device-pixel JPEG to CSS pixels, so image coordinates are click_at coordinates. */
async function toCssPixels(base64: string, width: number, height: number, dpr: number): Promise<string> {
  if (dpr === 1 || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return base64;
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  } catch {
    return base64;
  }
}

/** Run a CDP operation, mapping its failure to an ActionError. */
async function viaCdp<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new ActionError(e instanceof Error ? e.message : String(e));
  }
}

const DEFAULT_MAX_MARKS = 120;

async function screenshot(tabId: number | undefined, marks: boolean) {
  let tab = await resolveTab(tabId);
  let info: { width: number; height: number; dpr: number; url?: string; title?: string; marks?: unknown[] } | null = null;
  try {
    info = marks ? await inPage(tab.id!, pageMarks, [DEFAULT_MAX_MARKS, MARKS_ID]) : await inPage(tab.id!, pageViewport, []);
  } catch {
    // Pages that refuse scripts (chrome://, the web store) are still captured.
  }
  let data: string;
  try {
    if (!cdp.cdpAvailable()) throw new Error('no debugger');
    data = await cdp.captureViewport(tab.id!);
  } catch {
    if (!tab.active) tab = (await chrome.tabs.update(tab.id!, { active: true })) ?? tab;
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 });
    data = dataUrl.slice(dataUrl.indexOf(',') + 1);
  } finally {
    if (marks && info) await inPage(tab.id!, pageClearMarks, [MARKS_ID]).catch(() => undefined);
  }
  if (info) data = await toCssPixels(data, info.width, info.height, info.dpr);
  return {
    mime: 'image/jpeg',
    data,
    tab_id: tab.id,
    url: info?.url ?? tab.url,
    title: info?.title ?? tab.title,
    ...(info ? { width: info.width, height: info.height } : {}),
    ...(marks ? { marks: info?.marks ?? [] } : {}),
  };
}

// ---------------------------------------------------------------------------

/** Execute one remote action. Throws ActionError on failure. */
export async function executeAction(action: RemoteAction, deadline: number): Promise<unknown> {
  switch (action.type) {
    case 'navigate': {
      if (!isNavigableUrl(action.url)) throw new ActionError('not an openable URL (javascript: URLs are refused: use evaluate)');
      const tab = await resolveTab(action.tab_id);
      const loaded = waitForTabComplete(tab.id!, Math.min(remaining(deadline), DEFAULT_NAV_TIMEOUT_MS));
      await chrome.tabs.update(tab.id!, { url: action.url });
      const done = await loaded;
      return { tab_id: tab.id, url: done.url, title: done.title };
    }
    case 'click': {
      const tab = await resolveTab(action.tab_id);
      return inPage(tab.id!, pageClick, [action.selector]);
    }
    case 'type': {
      const tab = await resolveTab(action.tab_id);
      return inPage(tab.id!, pageType, [action.selector, action.text, !!action.clear, !!action.submit]);
    }
    case 'press': {
      const tab = await resolveTab(action.tab_id);
      return inPage(tab.id!, pagePress, [action.key, action.selector ?? null]);
    }
    case 'scroll': {
      const tab = await resolveTab(action.tab_id);
      return inPage(tab.id!, pageScroll, [action.dx ?? 0, action.dy ?? 0, action.selector ?? null]);
    }
    case 'text': {
      const tab = await resolveTab(action.tab_id);
      return inPage(tab.id!, pageText, [action.selector ?? null, action.max_chars ?? DEFAULT_TEXT_CHARS]);
    }
    case 'elements': {
      const tab = await resolveTab(action.tab_id);
      return inPage(tab.id!, pageElements, [action.max_elements ?? DEFAULT_MAX_ELEMENTS]);
    }
    case 'wait_for': {
      const tab = await resolveTab(action.tab_id);
      const until = Math.min(deadline, Date.now() + (action.timeout_ms ?? 10_000));
      for (;;) {
        try {
          const r = await inPage(tab.id!, pageExists, [action.selector]);
          if (r.found) return {};
        } catch {
          // Page may be mid-navigation; keep polling.
        }
        if (Date.now() >= until) throw new ActionError(`timed out waiting for ${action.selector}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    case 'screenshot':
      return screenshot(action.tab_id, !!action.marks);
    case 'evaluate': {
      const tab = await resolveTab(action.tab_id);
      return viaCdp(() => cdp.evaluate(tab.id!, action.script, !!action.await_promise));
    }
    case 'click_at': {
      const tab = await resolveTab(action.tab_id);
      await viaCdp(() => cdp.clickAt(tab.id!, action.x, action.y, { button: action.button, clickCount: action.click_count, modifiers: action.modifiers }));
      return {};
    }
    case 'mouse': {
      const tab = await resolveTab(action.tab_id);
      await viaCdp(() => cdp.mouse(tab.id!, action.op, action.x, action.y, action.button));
      return {};
    }
    case 'drag': {
      const tab = await resolveTab(action.tab_id);
      await viaCdp(() => cdp.drag(tab.id!, { x: action.from_x, y: action.from_y }, { x: action.to_x, y: action.to_y }, action.steps ?? 10));
      return {};
    }
    case 'scroll_at': {
      const tab = await resolveTab(action.tab_id);
      await viaCdp(() => cdp.wheel(tab.id!, action.x, action.y, action.dx ?? 0, action.dy ?? 0));
      return {};
    }
    case 'type_keys': {
      const tab = await resolveTab(action.tab_id);
      await viaCdp(() => cdp.typeText(tab.id!, action.text));
      return {};
    }
    case 'key': {
      const tab = await resolveTab(action.tab_id);
      await viaCdp(() => cdp.pressKey(tab.id!, action.key, action.modifiers ?? []));
      return {};
    }
    case 'tabs': {
      const tabs = await chrome.tabs.query({});
      return {
        tabs: tabs.map((t) => ({ id: t.id, window_id: t.windowId, url: t.url, title: t.title, active: t.active })),
      };
    }
    case 'new_tab': {
      if (action.url !== undefined && !isNavigableUrl(action.url)) {
        throw new ActionError('not an openable URL (javascript: URLs are refused: use evaluate)');
      }
      const tab = await chrome.tabs.create({ url: action.url ?? 'about:blank', active: true });
      if (action.url) await waitForTabComplete(tab.id!, Math.min(remaining(deadline), DEFAULT_NAV_TIMEOUT_MS)).catch(() => undefined);
      return { tab_id: tab.id };
    }
    case 'activate_tab': {
      const tab = await resolveTab(action.tab_id);
      await chrome.tabs.update(tab.id!, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return {};
    }
    case 'close_tab': {
      await resolveTab(action.tab_id);
      await chrome.tabs.remove(action.tab_id);
      return {};
    }
    case 'back':
    case 'forward':
    case 'reload': {
      const tab = await resolveTab(action.tab_id);
      const loaded = waitForTabComplete(tab.id!, Math.min(remaining(deadline), DEFAULT_NAV_TIMEOUT_MS));
      if (action.type === 'reload') {
        await chrome.tabs.reload(tab.id!);
      } else {
        const delta = action.type === 'back' ? -1 : 1;
        try {
          if (delta < 0) await chrome.tabs.goBack(tab.id!);
          else await chrome.tabs.goForward(tab.id!);
        } catch {
          // chrome.tabs.goBack/goForward follow the browser UI and skip entries
          // the page created without a user gesture. history.go() from the
          // page itself does not skip them.
          await inPage(tab.id!, pageHistoryGo, [delta]);
        }
      }
      await loaded.catch(() => undefined);
      return {};
    }
    default:
      throw new ActionError(`unsupported action ${(action as { type?: string }).type}`);
  }
}

/** Handle one request frame and build the response frame. */
export async function handleRequest(req: BridgeRequest): Promise<BridgeResponse> {
  const deadline = req.deadline_ms ?? Date.now() + DEFAULT_NAV_TIMEOUT_MS;
  try {
    const result = await executeAction(req.action, deadline);
    return { type: 'response', id: req.id, ok: true, result };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { type: 'response', id: req.id, ok: false, error };
  }
}

// ---------------------------------------------------------------------------
// Connection management.

let port: chrome.runtime.Port | null = null;
let retryMs = 1_000;
let started = false;

function setBadge(connected: boolean) {
  try {
    void chrome.action.setBadgeText({ text: connected ? 'ON' : '' });
    // The brand's dark coral: white badge text stays readable on it.
    void chrome.action.setBadgeBackgroundColor({ color: '#c2412a' });
    void chrome.action.setTitle({
      title: connected ? 'Hexactra AI — remote control connected' : 'Hexactra AI',
    });
  } catch {
    // Badge APIs are cosmetic.
  }
}

function connect() {
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch (e) {
    console.warn('Hexactra: native host unavailable', e);
    scheduleReconnect();
    return;
  }
  const p = port;
  p.onMessage.addListener((msg: unknown) => {
    retryMs = 1_000;
    const m = msg as { type?: string };
    if (m?.type === 'request') {
      void handleRequest(msg as BridgeRequest).then((resp) => {
        try {
          p.postMessage(resp);
        } catch (e) {
          console.warn('Hexactra: failed to send response', e);
        }
      });
    } else if (m?.type === 'ping') {
      p.postMessage({ type: 'pong' });
    } else if (m?.type === 'shutdown') {
      // The host agent is closing this browser: close every window so
      // Chromium exits normally and flushes cookies and site storage.
      void closeAllWindows();
    } else if (m?.type === 'agent_connected') {
      setBadge(true);
    } else if (m?.type === 'agent_disconnected') {
      setBadge(false);
    }
  });
  p.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message;
    if (err) console.info('Hexactra: native host disconnected:', err);
    port = null;
    setBadge(false);
    scheduleReconnect();
  });
  p.postMessage({ type: 'hello', version: chrome.runtime.getManifest().version });
}

/** Close every window; Chromium then exits normally. */
export async function closeAllWindows(): Promise<number> {
  const windows = await chrome.windows.getAll();
  await Promise.all(windows.map((w) => (w.id === undefined ? undefined : chrome.windows.remove(w.id).catch(() => undefined))));
  return windows.length;
}

function scheduleReconnect() {
  const wait = retryMs;
  retryMs = Math.min(retryMs * 2, 30_000);
  setTimeout(connect, wait);
}

/** Start the remote-control bridge once per service-worker lifetime. */
export function startRemoteBridge() {
  if (started) return;
  started = true;
  connect();
}
