// @vitest-environment jsdom
//
// A key press is a real key press (E52.12, #1030): `press` focuses its target and sends the key as a trusted CDP key event, so a
// composer that sends only on a real Enter sends. Without the debugger it falls back to the script key events, and says so.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCdp } from '../src/cdp';
import { handleRequest, type BridgeRequest } from '../src/remote';

let debuggerWorks: boolean;
let keys: string[];
/** The events `Input.dispatchKeyEvent` produced: what a browser reports with `isTrusted: true` (jsdom's cannot be set). */
const trusted = new WeakSet<Event>();

function browserKey(params: Record<string, unknown>) {
  const target = (document.activeElement ?? document.body) as HTMLElement;
  const type = params.type === 'keyUp' ? 'keyup' : 'keydown';
  const ev = new KeyboardEvent(type, { key: String(params.key ?? ''), bubbles: true, cancelable: true });
  trusted.add(ev);
  if (type === 'keydown') keys.push(String(params.key));
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
        if (method === 'Input.dispatchKeyEvent') browserKey(params ?? {});
        return {};
      }),
      onDetach: { addListener: vi.fn() },
    },
  };
}

const req = (action: BridgeRequest['action']): BridgeRequest => ({ type: 'request', id: 'op-1', action, deadline_ms: Date.now() + 5_000 });

let sent: string[];

/** A message composer that, like many web apps, sends only on a real Enter. */
function composer() {
  document.body.innerHTML = '<div id="box" contenteditable="true" tabindex="0">Hello Sam</div>';
  const box = document.getElementById('box')!;
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && trusted.has(e)) sent.push(box.textContent ?? '');
  });
  return box;
}

beforeEach(() => {
  resetCdp();
  debuggerWorks = true;
  keys = [];
  sent = [];
  vi.stubGlobal('chrome', makeChrome());
  Element.prototype.scrollIntoView = () => undefined;
});

describe('press (E52.12)', () => {
  it('sends Enter as a trusted key to the element a selector names', async () => {
    composer();
    const r = await handleRequest(req({ type: 'press', key: 'Enter', selector: '#box', tab_id: 1 }));
    expect(r).toMatchObject({ ok: true, result: { method: 'keys' } });
    expect(sent).toEqual(['Hello Sam']);
    expect(keys).toEqual(['Enter']);
  });

  it('sends the key to the focused element when no selector is given', async () => {
    composer().focus();
    const r = await handleRequest(req({ type: 'press', key: 'Enter', tab_id: 1 }));
    expect(r).toMatchObject({ ok: true, result: { method: 'keys' } });
    expect(sent).toEqual(['Hello Sam']);
  });

  it('falls back to the script key events when the debugger is not available, and says so', async () => {
    debuggerWorks = false;
    const box = composer();
    let scripted = 0;
    box.addEventListener('keydown', () => (scripted += 1));
    const r = await handleRequest(req({ type: 'press', key: 'Enter', selector: '#box', tab_id: 1 }));
    expect(r).toMatchObject({ ok: true, result: { method: 'synthetic' } });
    expect(scripted).toBe(1);
    expect(sent).toEqual([]);
  });

  it('keeps the error of a selector that matches nothing; with no selector the key goes to the focus (the body at least)', async () => {
    document.body.innerHTML = '<p>nothing to type in</p>';
    expect(await handleRequest(req({ type: 'press', key: 'Enter', selector: '#none', tab_id: 1 }))).toMatchObject({ ok: false, error: 'no element matches #none' });
    (document.activeElement as HTMLElement | null)?.blur?.();
    const r = await handleRequest(req({ type: 'press', key: 'Enter', tab_id: 1 }));
    // jsdom keeps <body> as the active element, as a browser does: the key goes there.
    expect(r.ok).toBe(true);
    expect(keys).toEqual(['Enter']);
  });
});

describe('type with submit (E52.12)', () => {
  it('types, then sends a trusted Enter at the field', async () => {
    document.body.innerHTML = '<input id="msg" type="text">';
    const field = document.getElementById('msg') as HTMLInputElement;
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && trusted.has(e)) sent.push(field.value);
    });
    const r = await handleRequest(req({ type: 'type', selector: '#msg', text: 'See you at 7', clear: true, submit: true, tab_id: 1 }));
    expect(r).toMatchObject({ ok: true, result: { submitted: 'keys' } });
    expect(sent).toEqual(['See you at 7']);
  });

  it('falls back to the script submit without the debugger', async () => {
    debuggerWorks = false;
    document.body.innerHTML = '<form id="f"><input id="msg" type="text"></form>';
    let submitted = 0;
    const form = document.getElementById('f') as HTMLFormElement;
    form.requestSubmit = () => {
      submitted += 1;
    };
    const r = await handleRequest(req({ type: 'type', selector: '#msg', text: 'See you at 7', submit: true, tab_id: 1 }));
    expect(r).toMatchObject({ ok: true, result: { submitted: 'synthetic' } });
    expect(submitted).toBe(1);
  });

  it('types nothing more and sends no Enter when the tab moved to another origin', async () => {
    document.body.innerHTML = '<input id="msg" type="text">';
    const chromeApi = (globalThis as unknown as { chrome: { tabs: { get: ReturnType<typeof vi.fn> } } }).chrome;
    let calls = 0;
    chromeApi.tabs.get.mockImplementation(async () => {
      calls += 1;
      return { id: 1, windowId: 10, url: calls > 1 ? 'https://elsewhere.example.test/' : `${location.origin}/chat`, title: 'Chat', active: true, status: 'complete' };
    });
    const r = await handleRequest(req({ type: 'type', selector: '#msg', text: 'x', submit: true, expect_origin: location.origin, tab_id: 1 }));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('origin_mismatch') });
    // The text was typed while the tab was still on the page; the Enter was not sent.
    expect((document.getElementById('msg') as HTMLInputElement).value).toBe('x');
    expect(keys).toEqual([]);
  });
});
