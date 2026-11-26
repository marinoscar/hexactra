// @vitest-environment jsdom
//
// A code field split into boxes (E49.1): `type` (and so `type_secret`) aimed
// at the first box fills every box, through the real path (handleRequest ->
// executeScript / chrome.debugger) with the real page function run in jsdom.
// The debugger mock types like a browser: each key goes to the focused element,
// a full `maxlength` box takes nothing more, and the page's own key and input
// listeners run (so its auto-advance moves the focus, as for a person).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCdp } from '../src/cdp';
import { handleRequest, type BridgeRequest } from '../src/remote';

const HERE = location.origin;
const CODE = '585774';

type Tab = { id: number; windowId: number; url: string; title: string; active: boolean; status: string };
let tab: Tab;
let keys: string[];
let debuggerWorks: boolean;
let onKey: (n: number) => void;

/** One trusted key, delivered as a browser would: keydown, the text into the focus (within maxlength), input, keyup. */
function browserKey(params: Record<string, unknown>) {
  const target = (document.activeElement ?? document.body) as HTMLElement;
  const key = String(params.key ?? '');
  if (params.type === 'keyUp') {
    target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
    return;
  }
  const proceed = target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const text = params.text as string | undefined;
  if (!proceed || !text || text === '\r') return;
  if (target instanceof HTMLInputElement) {
    if (target.maxLength > 0 && target.value.length >= target.maxLength) return;
    target.value += text;
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
}

function makeChrome() {
  return {
    tabs: {
      get: vi.fn(async () => ({ ...tab })),
      query: vi.fn(async () => [{ ...tab }]),
      update: vi.fn(async () => tab),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn(async ({ func, args }: { func: (...a: unknown[]) => unknown; args: unknown[] }) => [{ result: await func(...args) }]),
    },
    debugger: {
      attach: vi.fn(async () => {
        if (!debuggerWorks) throw new Error('Cannot access a chrome-extension:// URL of different extension');
      }),
      sendCommand: vi.fn(async (_t: unknown, method: string, params?: Record<string, unknown>) => {
        if (method === 'Input.dispatchKeyEvent') {
          if (params?.type !== 'keyUp') {
            keys.push(String(params?.key));
            onKey(keys.length);
          }
          browserKey(params ?? {});
        }
        return {};
      }),
      onDetach: { addListener: vi.fn() },
    },
  };
}

let chromeMock: ReturnType<typeof makeChrome>;

beforeEach(() => {
  resetCdp();
  keys = [];
  debuggerWorks = true;
  onKey = () => undefined;
  tab = { id: 1, windowId: 10, url: `${HERE}/verify`, title: 'Verify', active: true, status: 'complete' };
  chromeMock = makeChrome();
  vi.stubGlobal('chrome', chromeMock);
  Element.prototype.scrollIntoView = () => undefined;
});

const req = (action: BridgeRequest['action']): BridgeRequest => ({ type: 'request', id: 'op-1', action, deadline_ms: Date.now() + 5_000 });
const boxes = () => Array.from(document.querySelectorAll<HTMLInputElement>('input.code'));
const held = () => boxes().map((b) => b.value).join('');

/** Six one-digit boxes, as the failing run's site had (`#txtCode1…#txtCode6`). */
function sixBoxes(extra = '') {
  document.body.innerHTML =
    `<form id="f"><label>6-Digit Verification Code</label><div class="row">` +
    [1, 2, 3, 4, 5, 6].map((n) => `<input class="code" id="txtCode${n}" type="text" maxlength="1" inputmode="numeric" ${extra}>`).join('') +
    `</div><button id="go" type="submit">Verify</button></form>`;
}

/** The common widget: each box moves the focus on when it is full, on `input` or on `keyup`. */
function autoAdvance(on: 'input' | 'keyup') {
  boxes().forEach((b, i, all) =>
    b.addEventListener(on, () => {
      if (b.value.length >= b.maxLength && all[i + 1]) all[i + 1].focus();
    }),
  );
}

describe('type into a segmented code field', () => {
  it('fills every box with real keys when the site advances on input', async () => {
    sixBoxes();
    autoAdvance('input');
    const r = await handleRequest(req({ type: 'type', selector: '#txtCode1', text: CODE, clear: true, sensitive: true, expect_origin: HERE, tab_id: 1 }));
    expect(r).toMatchObject({ ok: true, result: { boxes: 6, filled: 6, method: 'keys' } });
    expect(boxes().map((b) => b.value)).toEqual([...CODE]);
    expect(keys).toEqual([...CODE]);
  });

  it('fills every box with real keys when the site advances on keyup', async () => {
    sixBoxes();
    autoAdvance('keyup');
    const r = await handleRequest(req({ type: 'type', selector: '#txtCode1', text: CODE, tab_id: 1 }));
    expect(r).toMatchObject({ ok: true, result: { boxes: 6, method: 'keys' } });
    expect(held()).toBe(CODE);
  });

  it('fills box by box when the site does not advance the focus', async () => {
    sixBoxes();
    const r = await handleRequest(req({ type: 'type', selector: '#txtCode1', text: CODE, sensitive: true, expect_origin: HERE, tab_id: 1 }));
    expect(r).toMatchObject({ ok: true, result: { boxes: 6, filled: 6, method: 'boxes' } });
    expect(boxes().map((b) => b.value)).toEqual([...CODE]);
  });

  it('fills box by box when the debugger cannot attach', async () => {
    debuggerWorks = false;
    sixBoxes();
    autoAdvance('input');
    const r = await handleRequest(req({ type: 'type', selector: '#txtCode1', text: CODE, tab_id: 1 }));
    expect(r).toMatchObject({ ok: true, result: { method: 'boxes' } });
    expect(held()).toBe(CODE);
  });

  it('fills the whole group when it is aimed at a middle box', async () => {
    sixBoxes();
    autoAdvance('input');
    const r = await handleRequest(req({ type: 'type', selector: '#txtCode3', text: CODE, tab_id: 1 }));
    expect(r).toMatchObject({ ok: true, result: { boxes: 6 } });
    expect(held()).toBe(CODE);
  });

  it('clears what the boxes held before (a second code)', async () => {
    sixBoxes();
    autoAdvance('input');
    boxes().forEach((b) => (b.value = '9'));
    const r = await handleRequest(req({ type: 'type', selector: '#txtCode1', text: CODE, tab_id: 1 }));
    expect(r.ok).toBe(true);
    expect(held()).toBe(CODE);
  });

  it('presses Enter on the last box when asked to submit', async () => {
    sixBoxes();
    autoAdvance('input');
    const enter = vi.fn();
    boxes()[5].addEventListener('keydown', (e) => e.key === 'Enter' && enter());
    const r = await handleRequest(req({ type: 'type', selector: '#txtCode1', text: CODE, submit: true, tab_id: 1 }));
    expect(r.ok).toBe(true);
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it('reports success when the page moves on by itself after the last digit', async () => {
    sixBoxes();
    autoAdvance('input');
    // A site that submits on the sixth digit and replaces the form.
    boxes()[5].addEventListener('input', () => (document.body.innerHTML = '<h1>Payment details</h1>'));
    const r = await handleRequest(req({ type: 'type', selector: '#txtCode1', text: CODE, tab_id: 1 }));
    expect(r).toMatchObject({ ok: true, result: { gone: true } });
  });

  it('fails clearly, without the value, when the boxes do not take the code', async () => {
    sixBoxes();
    // A site that refuses every change but the first box's.
    boxes()
      .slice(1)
      .forEach((b) => b.addEventListener('input', () => (b.value = '')));
    const r = await handleRequest(req({ type: 'type', selector: '#txtCode1', text: CODE, sensitive: true, tab_id: 1 }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('the code field has 6 boxes and took 1 of 6 characters');
  });

  it('never returns the typed text', async () => {
    sixBoxes();
    autoAdvance('input');
    const r = await handleRequest(req({ type: 'type', selector: '#txtCode1', text: CODE, sensitive: true, expect_origin: HERE, tab_id: 1 }));
    expect(JSON.stringify(r)).not.toContain(CODE);
    for (const d of CODE) expect(JSON.stringify(r.result)).not.toContain(`"${d}"`);
  });
});

describe('the origin guard holds for code boxes', () => {
  it('types nothing when the tab is on another origin', async () => {
    sixBoxes();
    tab.url = 'https://evil.example.test/';
    const r = await handleRequest(req({ type: 'type', selector: '#txtCode1', text: CODE, expect_origin: HERE, tab_id: 1 }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^origin_mismatch: /);
    expect(held()).toBe('');
    expect(keys).toEqual([]);
  });

  it('stops part-way, with no fallback fill, when the tab moves during the typing', async () => {
    sixBoxes();
    autoAdvance('input');
    onKey = (n) => {
      if (n === 2) tab.url = 'https://evil.example.test/';
    };
    const r = await handleRequest(req({ type: 'type', selector: '#txtCode1', text: CODE, expect_origin: HERE, tab_id: 1 }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^origin_mismatch: /);
    expect(r.error).not.toContain(CODE);
    expect(held()).toBe(CODE.slice(0, 2));
  });
});

describe('fields that are not code boxes are typed as before', () => {
  it('a single code input with room for the whole code', async () => {
    document.body.innerHTML = '<input id="otp" autocomplete="one-time-code" maxlength="6">';
    const r = await handleRequest(req({ type: 'type', selector: '#otp', text: CODE, tab_id: 1 }));
    expect(r).toMatchObject({ ok: true, result: {} });
    expect((document.getElementById('otp') as HTMLInputElement).value).toBe(CODE);
    expect(keys).toEqual([]);
  });

  it('a form of short fields is never split across them', async () => {
    document.body.innerHTML = '<form><input id="a" maxlength="20"><input id="b" maxlength="20"><input id="c" maxlength="20"></form>';
    const text = 'a long street name that is too long';
    const r = await handleRequest(req({ type: 'type', selector: '#a', text, tab_id: 1 }));
    expect(r.ok).toBe(true);
    expect((document.getElementById('a') as HTMLInputElement).value).toBe(text);
    expect((document.getElementById('b') as HTMLInputElement).value).toBe('');
  });

  it('one-character boxes too few for the text are left to the plain path', async () => {
    document.body.innerHTML = '<div><input id="x" maxlength="1"><input id="y" maxlength="1"></div>';
    const r = await handleRequest(req({ type: 'type', selector: '#x', text: 'abc', tab_id: 1 }));
    expect(r.ok).toBe(true);
    expect(keys).toEqual([]);
  });

  it('hidden and disabled boxes are not part of the group', async () => {
    sixBoxes();
    autoAdvance('input');
    document.getElementById('f')!.insertAdjacentHTML('afterbegin', '<input class="decoy" type="hidden" maxlength="1"><input class="decoy" maxlength="1" disabled>');
    const r = await handleRequest(req({ type: 'type', selector: '#txtCode1', text: CODE, tab_id: 1 }));
    expect(r).toMatchObject({ ok: true, result: { boxes: 6 } });
    expect(held()).toBe(CODE);
  });
});
