// @vitest-environment jsdom
//
// A selector click is a real mouse click (E52.1, #1016): `click` finds a point on the element with the page's own hit test and
// clicks there with trusted CDP mouse events, so a page that ignores script events (`event.isTrusted === false`) still gets the
// click. When the mouse cannot reach the element, or the debugger cannot attach, it clicks by script, as before, and says so.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCdp } from '../src/cdp';
import { handleRequest, pageClickPoint, type BridgeRequest } from '../src/remote';

type Rect = { left: number; top: number; width: number; height: number };
let rects: Map<Element, Rect>;
let debuggerWorks: boolean;
let mouse: Array<{ type: string; x: number; y: number }>;
/** The events `Input.dispatchMouseEvent` produced: what a browser reports with `isTrusted: true`. */
const trusted = new WeakSet<Event>();

/** jsdom has no layout: each element gets the rectangle a test gives it, and the hit test returns the topmost one under a point. */
function layout(el: Element, r: Rect) {
  rects.set(el, r);
}
function hitTest(x: number, y: number): Element | null {
  let hit: Element | null = null;
  for (const [el, r] of rects) {
    if (x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height) hit = el; // later = on top
  }
  return hit;
}

/** A trusted mouse press and release, delivered as a browser would: to the element under the point, `isTrusted` true. */
function browserMouse(params: Record<string, unknown>) {
  const type = String(params.type);
  const x = Number(params.x);
  const y = Number(params.y);
  mouse.push({ type, x, y });
  if (type !== 'mouseReleased') return;
  const target = hitTest(x, y) as HTMLElement | null;
  if (!target) return;
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y });
  // jsdom's `isTrusted` cannot be set: the test marks the events a real input would make trusted instead.
  trusted.add(ev);
  target.dispatchEvent(ev);
}

function makeChrome() {
  const tab = { id: 1, windowId: 10, url: 'https://example.test/chat', title: 'Chat', active: true, status: 'complete' };
  return {
    tabs: { get: vi.fn(async () => tab), query: vi.fn(async () => [tab]), update: vi.fn(async () => tab), onUpdated: { addListener: vi.fn(), removeListener: vi.fn() } },
    scripting: { executeScript: vi.fn(async ({ func, args }: { func: (...a: unknown[]) => unknown; args: unknown[] }) => [{ result: await func(...args) }]) },
    debugger: {
      attach: vi.fn(async () => {
        if (!debuggerWorks) throw new Error('Cannot attach to the target with an attached client');
      }),
      sendCommand: vi.fn(async (_t: unknown, method: string, params?: Record<string, unknown>) => {
        if (method === 'Input.dispatchMouseEvent') browserMouse(params ?? {});
        return {};
      }),
      onDetach: { addListener: vi.fn() },
    },
  };
}

const JsdomMouseEvent = window.MouseEvent;
class NoViewMouseEvent extends JsdomMouseEvent {
  constructor(type: string, init: MouseEventInit = {}) {
    const { view: _view, ...rest } = init;
    super(type, rest);
  }
}

const req = (action: BridgeRequest['action']): BridgeRequest => ({ type: 'request', id: 'op-1', action, deadline_ms: Date.now() + 5_000 });

let sent: string[];

beforeEach(() => {
  resetCdp();
  rects = new Map();
  debuggerWorks = true;
  mouse = [];
  sent = [];
  vi.stubGlobal('chrome', makeChrome());
  Element.prototype.scrollIntoView = () => undefined;
  // jsdom has no PointerEvent, and refuses the `view` the script click passes (its window is not vitest's global): drop it.
  vi.stubGlobal('MouseEvent', NoViewMouseEvent);
  vi.stubGlobal('PointerEvent', NoViewMouseEvent);
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const r = rects.get(this) ?? { left: 0, top: 0, width: 0, height: 0 };
    return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
  };
  document.elementFromPoint = (x: number, y: number) => hitTest(x, y);
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
});

/** A Send button whose handler, like many web apps, ignores script events. */
function trustedOnlyButton() {
  document.body.innerHTML = `<div id="composer"><button id="send" aria-label="Send message">Send</button></div>`;
  const button = document.getElementById('send')!;
  layout(document.body, { left: 0, top: 0, width: 1280, height: 800 });
  layout(button, { left: 1200, top: 700, width: 40, height: 40 });
  button.addEventListener('click', (e) => {
    if (!trusted.has(e)) return; // the page's `if (!event.isTrusted) return;`
    sent.push('Sam Example');
  });
  return button;
}

describe('click by selector (E52.1)', () => {
  it('activates a button that ignores untrusted events, with a real mouse click at its centre', async () => {
    trustedOnlyButton();
    const r = await handleRequest(req({ type: 'click', selector: '#send', tab_id: 1 }));
    expect(r).toMatchObject({ ok: true, result: { method: 'pointer', x: 1220, y: 720, disabled: false } });
    expect(sent).toEqual(['Sam Example']);
    expect(mouse.map((m) => m.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
  });

  it('falls back to the script click when the debugger cannot attach, and says why', async () => {
    debuggerWorks = false;
    const button = trustedOnlyButton();
    let scripted = 0;
    button.addEventListener('click', () => (scripted += 1));
    const r = await handleRequest(req({ type: 'click', selector: '#send', tab_id: 1 }));
    expect(r).toMatchObject({ ok: true, result: { method: 'synthetic', why: 'no_debugger' } });
    expect(scripted).toBe(1);
    expect(sent).toEqual([]);
  });

  it('falls back to the script click when the element is covered, and a page that accepts script events still gets it', async () => {
    document.body.innerHTML = `<button id="b">Open</button><div id="veil"></div>`;
    const b = document.getElementById('b')!;
    layout(b, { left: 10, top: 10, width: 100, height: 40 });
    layout(document.getElementById('veil')!, { left: 0, top: 0, width: 1280, height: 800 });
    let clicks = 0;
    b.addEventListener('click', () => (clicks += 1));
    const r = await handleRequest(req({ type: 'click', selector: '#b', tab_id: 1 }));
    expect(r).toMatchObject({ ok: true, result: { method: 'synthetic', why: 'covered' } });
    expect(clicks).toBe(1);
    expect(mouse).toEqual([]);
  });

  it('keeps the exact error of a selector that matches nothing', async () => {
    document.body.innerHTML = '<p>empty</p>';
    const r = await handleRequest(req({ type: 'click', selector: 'a[aria-label="Start chat"]', tab_id: 1 }));
    expect(r).toMatchObject({ ok: false, error: 'no element matches a[aria-label="Start chat"]' });
  });
});

describe('pageClickPoint', () => {
  it('uses the centre when the page hits the element there', () => {
    document.body.innerHTML = '<button id="b">Go</button>';
    layout(document.getElementById('b')!, { left: 100, top: 100, width: 80, height: 40 });
    expect(pageClickPoint('#b')).toEqual({ point: { x: 140, y: 120 }, disabled: false });
  });

  it('uses a quarter point when the centre is covered', () => {
    document.body.innerHTML = '<button id="b">Go</button><span id="badge"></span>';
    layout(document.getElementById('b')!, { left: 100, top: 100, width: 80, height: 40 });
    layout(document.getElementById('badge')!, { left: 130, top: 110, width: 20, height: 20 });
    expect(pageClickPoint('#b')).toEqual({ point: { x: 120, y: 110 }, disabled: false });
  });

  it('counts a hit on a child of the element as the element', () => {
    document.body.innerHTML = '<a id="row" href="#"><span id="name">Sam Example</span></a>';
    layout(document.getElementById('row')!, { left: 0, top: 200, width: 400, height: 60 });
    layout(document.getElementById('name')!, { left: 0, top: 200, width: 400, height: 60 });
    expect(pageClickPoint('#row')).toEqual({ point: { x: 200, y: 230 }, disabled: false });
  });

  it('counts a hit on the label of a control as the control', () => {
    document.body.innerHTML = '<label id="l" for="c">Remember me</label><input id="c" type="checkbox">';
    const c = document.getElementById('c')!;
    layout(c, { left: 10, top: 10, width: 20, height: 20 });
    layout(document.getElementById('l')!, { left: 0, top: 0, width: 200, height: 40 });
    expect(pageClickPoint('#c')).toEqual({ point: { x: 20, y: 20 }, disabled: false });
  });

  it('reports a fully covered element, a zero-size one and one off screen', () => {
    document.body.innerHTML = '<button id="a">A</button><button id="z">Z</button><button id="o">O</button><div id="veil"></div>';
    layout(document.getElementById('a')!, { left: 10, top: 10, width: 50, height: 20 });
    layout(document.getElementById('o')!, { left: 10, top: 5000, width: 50, height: 20 });
    layout(document.getElementById('veil')!, { left: 0, top: 0, width: 300, height: 300 });
    expect(pageClickPoint('#a')).toMatchObject({ point: null, why: 'covered' });
    expect(pageClickPoint('#z')).toMatchObject({ point: null, why: 'zero_size' });
    expect(pageClickPoint('#o')).toMatchObject({ point: null, why: 'offscreen' });
  });

  it('reports a disabled control', () => {
    document.body.innerHTML = '<button id="b" disabled>Send</button><div id="d" role="button" aria-disabled="true">Send</div>';
    layout(document.getElementById('b')!, { left: 0, top: 0, width: 50, height: 20 });
    layout(document.getElementById('d')!, { left: 0, top: 100, width: 50, height: 20 });
    expect(pageClickPoint('#b')).toMatchObject({ disabled: true });
    expect(pageClickPoint('#d')).toMatchObject({ disabled: true });
  });

  it('returns the exact error text for no match', () => {
    document.body.innerHTML = '';
    expect(pageClickPoint('#none')).toEqual({ __error: 'no element matches #none' });
  });
});
