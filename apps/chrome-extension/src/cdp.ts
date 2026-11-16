// Chrome DevTools Protocol through chrome.debugger (epic #366).
//
// The agent is a human emulator: its clicks, keys and wheel events must be
// the ones a person makes. Events dispatched with `Input.*` reach the page as
// trusted (`isTrusted: true`), unlike synthetic DOM events; `Runtime.evaluate`
// runs any script, whatever the page's CSP.
//
// Stealth: no CDP domain is ever `enable`d (pages can detect `Runtime.enable`
// by its side effects), and the host agent launches Chrome with
// `--silent-debugger-extension-api`, so no "is debugging this browser" bar.

const PROTOCOL_VERSION = '1.3';

/** Raised when a tab cannot be driven through the debugger. */
export class CdpError extends Error {}

const attached = new Set<number>();
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  try {
    chrome.debugger.onDetach.addListener((source) => {
      if (source.tabId !== undefined) attached.delete(source.tabId);
    });
  } catch {
    // Tests and old Chrome without onDetach: attach is retried on failure.
  }
}

/** Whether chrome.debugger is available (the manifest grants `debugger`). */
export function cdpAvailable(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.debugger && typeof chrome.debugger.attach === 'function';
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function attach(tabId: number): Promise<void> {
  if (!cdpAvailable()) throw new CdpError('the debugger API is not available (the extension needs the "debugger" permission)');
  listen();
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  } catch (e) {
    if (!/already attached/i.test(message(e))) throw new CdpError(`cannot control this tab: ${message(e)}`);
  }
  attached.add(tabId);
}

/** Send one CDP command to a tab, attaching (or re-attaching) as needed. */
export async function send<T = Record<string, unknown>>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
  await attach(tabId);
  try {
    return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
  } catch (e) {
    if (!/not attached|detached|no tab/i.test(message(e))) throw new CdpError(`${method}: ${message(e)}`);
    attached.delete(tabId);
    await attach(tabId);
    try {
      return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
    } catch (e2) {
      throw new CdpError(`${method}: ${message(e2)}`);
    }
  }
}

/** Forget the attachment state (tests). */
export function resetCdp() {
  attached.clear();
  listening = false;
}

// ---------------------------------------------------------------------------
// Input

export type Button = 'left' | 'middle' | 'right';

const MODIFIER_BITS: Record<string, number> = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const BUTTON_BITS: Record<Button, number> = { left: 1, right: 2, middle: 4 };

/** CDP's modifier bitmask for `alt`, `ctrl`, `meta`, `shift`. */
export function modifierMask(modifiers: readonly string[] = []): number {
  return modifiers.reduce((m, k) => m | (MODIFIER_BITS[k] ?? 0), 0);
}

function mouseEvent(tabId: number, type: string, x: number, y: number, extra: Record<string, unknown> = {}) {
  return send(tabId, 'Input.dispatchMouseEvent', { type, x, y, ...extra });
}

/** A trusted click (or double/triple click) at viewport CSS pixels. */
export async function clickAt(tabId: number, x: number, y: number, opts: { button?: Button; clickCount?: number; modifiers?: string[] } = {}) {
  const button = opts.button ?? 'left';
  const modifiers = modifierMask(opts.modifiers);
  const clicks = opts.clickCount ?? 1;
  await mouseEvent(tabId, 'mouseMoved', x, y, { button: 'none', modifiers });
  for (let n = 1; n <= clicks; n++) {
    await mouseEvent(tabId, 'mousePressed', x, y, { button, buttons: BUTTON_BITS[button], clickCount: n, modifiers });
    await mouseEvent(tabId, 'mouseReleased', x, y, { button, buttons: 0, clickCount: n, modifiers });
  }
}

/** A trusted pointer move, press or release. */
export async function mouse(tabId: number, op: 'move' | 'down' | 'up', x: number, y: number, button: Button = 'left') {
  if (op === 'move') return mouseEvent(tabId, 'mouseMoved', x, y, { button: 'none' });
  if (op === 'down') return mouseEvent(tabId, 'mousePressed', x, y, { button, buttons: BUTTON_BITS[button], clickCount: 1 });
  return mouseEvent(tabId, 'mouseReleased', x, y, { button, buttons: 0, clickCount: 1 });
}

/** A trusted drag with intermediate moves, as a hand would make it. */
export async function drag(tabId: number, from: { x: number; y: number }, to: { x: number; y: number }, steps = 10) {
  await mouseEvent(tabId, 'mouseMoved', from.x, from.y, { button: 'none' });
  await mouseEvent(tabId, 'mousePressed', from.x, from.y, { button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
    await mouseEvent(tabId, 'mouseMoved', x, y, { button: 'left', buttons: 1 });
  }
  await mouseEvent(tabId, 'mouseReleased', to.x, to.y, { button: 'left', buttons: 0, clickCount: 1 });
}

/** A trusted mouse-wheel scroll at a point. */
export function wheel(tabId: number, x: number, y: number, dx: number, dy: number) {
  return mouseEvent(tabId, 'mouseWheel', x, y, { deltaX: dx, deltaY: dy });
}

interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED_KEYS: Record<string, [code: string, keyCode: number, text?: string]> = {
  Enter: ['Enter', 13, '\r'],
  Tab: ['Tab', 9],
  Escape: ['Escape', 27],
  Backspace: ['Backspace', 8],
  Delete: ['Delete', 46],
  Insert: ['Insert', 45],
  Home: ['Home', 36],
  End: ['End', 35],
  PageUp: ['PageUp', 33],
  PageDown: ['PageDown', 34],
  ArrowUp: ['ArrowUp', 38],
  ArrowDown: ['ArrowDown', 40],
  ArrowLeft: ['ArrowLeft', 37],
  ArrowRight: ['ArrowRight', 39],
  ' ': ['Space', 32, ' '],
  Space: ['Space', 32, ' '],
  Shift: ['ShiftLeft', 16],
  Control: ['ControlLeft', 17],
  Alt: ['AltLeft', 18],
  Meta: ['MetaLeft', 91],
  CapsLock: ['CapsLock', 20],
  ContextMenu: ['ContextMenu', 93],
};
for (let i = 1; i <= 12; i++) NAMED_KEYS[`F${i}`] = [`F${i}`, 111 + i];

const ALIASES: Record<string, string> = { Esc: 'Escape', Return: 'Enter', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', Del: 'Delete' };

/** The DOM key definition of a key name (`Enter`, `a`, `F5`, `ArrowDown`). */
export function keyDef(name: string): KeyDef {
  const key = ALIASES[name] ?? name;
  const named = NAMED_KEYS[key];
  if (named) return { key: key === 'Space' ? ' ' : key, code: named[0], keyCode: named[1], text: named[2] };
  if ([...key].length === 1) {
    const upper = key.toUpperCase();
    if (/[A-Z]/.test(upper)) return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: key };
    if (/[0-9]/.test(key)) return { key, code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key };
    return { key, code: '', keyCode: 0, text: key };
  }
  throw new CdpError(`unknown key ${JSON.stringify(name)}`);
}

/** One trusted key press with modifiers. */
export async function pressKey(tabId: number, name: string, modifiers: string[] = []) {
  const def = keyDef(name);
  const mask = modifierMask(modifiers);
  // A chord with ctrl/alt/meta produces no text (it is a shortcut).
  const text = mask & (1 | 2 | 4) ? undefined : (mask & 8 && def.text ? def.text.toUpperCase() : def.text);
  const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers: mask };
  await send(tabId, 'Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: def.text } : {}) });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** Above this length, text is inserted at once rather than key by key. */
export const KEY_BY_KEY_MAX = 300;

/** Trusted typing at the focus: key events per character, or one insert for long text. */
export async function typeText(tabId: number, text: string) {
  if (text.length > KEY_BY_KEY_MAX) {
    await send(tabId, 'Input.insertText', { text });
    return;
  }
  for (const ch of text) {
    if (ch === '\n') {
      await pressKey(tabId, 'Enter');
    } else if (ch === '\t') {
      await pressKey(tabId, 'Tab');
    } else {
      const def = [...ch].length === 1 && /[a-zA-Z0-9]/.test(ch) ? keyDef(ch) : { key: ch, code: '', keyCode: 0 };
      await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, text: ch, unmodifiedText: ch });
      await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode });
    }
  }
}

// ---------------------------------------------------------------------------
// Script and capture

interface RemoteObject {
  type?: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  unserializableValue?: string;
}

/** Run JavaScript in the page's main world; returns its JSON value. */
export async function evaluate(tabId: number, script: string, awaitPromise: boolean) {
  const r = await send<{ result?: RemoteObject; exceptionDetails?: { text?: string; exception?: RemoteObject } }>(tabId, 'Runtime.evaluate', {
    expression: script,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
    // REPL mode: top-level await and the last expression's value, like the console.
    replMode: true,
    allowUnsafeEvalBlockedByCSP: true,
  });
  if (r.exceptionDetails) {
    const ex = r.exceptionDetails.exception;
    throw new CdpError(`script threw: ${ex?.description ?? ex?.value ?? r.exceptionDetails.text ?? 'an exception'}`);
  }
  const res = r.result ?? {};
  return {
    value: res.value ?? (res.unserializableValue !== undefined ? res.unserializableValue : null),
    type: res.subtype ?? res.type ?? 'undefined',
    ...(res.value === undefined && res.description ? { description: res.description } : {}),
  };
}

/** A JPEG of the tab's viewport, base64 (device pixels). */
export async function captureViewport(tabId: number): Promise<string> {
  const r = await send<{ data: string }>(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 80, fromSurface: true });
  return r.data;
}
