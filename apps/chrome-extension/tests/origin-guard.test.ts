// @vitest-environment jsdom
//
// The origin guard of a sensitive `type` / `type_keys` (E37.10, #625), through
// the real path (handleRequest -> executeScript / chrome.debugger) with the
// real page function run in jsdom. The control plane sends `expect_origin`, the
// origin it verified; the tab must still be on it when the text is typed, or
// nothing is typed and the error is `origin_mismatch`.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCdp } from '../src/cdp';
import { assertTabOrigin, handleRequest, originOf, type BridgeRequest } from '../src/remote';

// jsdom's own page address.
const HERE = location.origin;

type Tab = { id: number; windowId: number; url: string; title: string; active: boolean; status: string };
let tab: Tab;
let sent: { method: string; params?: Record<string, unknown> }[];
let onKey: (n: number) => void;

function makeChrome() {
  return {
    tabs: {
      get: vi.fn(async () => ({ ...tab })),
      query: vi.fn(async () => [{ ...tab }]),
      update: vi.fn(async () => tab),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    // Runs the page function in this (jsdom) document, as Chrome would in the tab.
    scripting: {
      executeScript: vi.fn(async ({ func, args }: { func: (...a: unknown[]) => unknown; args: unknown[] }) => [{ result: await func(...args) }]),
    },
    debugger: {
      attach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async (_t: unknown, method: string, params?: Record<string, unknown>) => {
        sent.push({ method, params });
        if (method === 'Input.dispatchKeyEvent' && params?.type === 'keyDown') onKey(sent.filter((c) => c.params?.type === 'keyDown').length);
        return {};
      }),
      onDetach: { addListener: vi.fn() },
    },
  };
}

let chromeMock: ReturnType<typeof makeChrome>;

beforeEach(() => {
  resetCdp();
  sent = [];
  onKey = () => undefined;
  tab = { id: 1, windowId: 10, url: `${HERE}/signin`, title: 'Sign in', active: true, status: 'complete' };
  chromeMock = makeChrome();
  vi.stubGlobal('chrome', chromeMock);
  document.body.innerHTML = '<input id="pw" type="password" value="">';
  // jsdom has no layout, so no scrolling.
  Element.prototype.scrollIntoView = () => undefined;
});

const req = (action: BridgeRequest['action']): BridgeRequest => ({ type: 'request', id: 'op-1', action, deadline_ms: Date.now() + 5_000 });
const value = () => (document.getElementById('pw') as HTMLInputElement).value;
const keyDowns = () => sent.filter((c) => c.method === 'Input.dispatchKeyEvent' && c.params?.type === 'keyDown').map((c) => c.params?.text);

describe('originOf / assertTabOrigin', () => {
  it('compares scheme, host and port only', () => {
    expect(originOf('https://App.Example.test:443/a?b=1#c')).toBe('https://app.example.test');
    expect(originOf('http://localhost:8080/x')).toBe('http://localhost:8080');
    expect(originOf('about:blank')).toBeNull();
    expect(originOf('data:text/html,x')).toBeNull();
    expect(originOf(undefined)).toBeNull();
    expect(() => assertTabOrigin({ url: 'https://a.test/x' }, 'https://a.test')).not.toThrow();
    expect(() => assertTabOrigin({ url: 'https://a.test.evil.test/' }, 'https://a.test')).toThrow(/^origin_mismatch/);
    expect(() => assertTabOrigin({ url: 'https://a.test:8443/' }, 'https://a.test')).toThrow(/^origin_mismatch/);
    expect(() => assertTabOrigin({ url: 'about:blank' }, 'https://a.test')).toThrow(/^origin_mismatch/);
    // No expectation, no check.
    expect(() => assertTabOrigin({ url: 'about:blank' }, undefined)).not.toThrow();
  });
});

describe('type with expect_origin', () => {
  it('types while the tab is on that origin', async () => {
    const r = await handleRequest(req({ type: 'type', selector: '#pw', text: 'hunter2', clear: true, expect_origin: HERE, tab_id: 1 }));
    expect(r).toMatchObject({ ok: true });
    expect(value()).toBe('hunter2');
  });

  it('types nothing when the tab has moved to another origin', async () => {
    tab.url = 'https://evil.example.test/';
    const r = await handleRequest(req({ type: 'type', selector: '#pw', text: 'hunter2', expect_origin: HERE, tab_id: 1 }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^origin_mismatch: /);
    expect(r.error).not.toContain('evil');
    expect(r.error).not.toContain('hunter2');
    expect(value()).toBe('');
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('checks the page itself too, in the step that types', async () => {
    // The tab record is stale (it still says the saved origin) but the page is elsewhere.
    tab.url = 'https://login.example.test/signin';
    const r = await handleRequest(req({ type: 'type', selector: '#pw', text: 'hunter2', expect_origin: 'https://login.example.test', tab_id: 1 }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^origin_mismatch: /);
    expect(value()).toBe('');
    expect(chromeMock.scripting.executeScript).toHaveBeenCalledTimes(1);
  });

  it('is not required: an ordinary type works on any page', async () => {
    tab.url = 'https://anything.example.test/';
    const r = await handleRequest(req({ type: 'type', selector: '#pw', text: 'abc', tab_id: 1 }));
    expect(r).toMatchObject({ ok: true });
    expect(value()).toBe('abc');
  });
});

describe('type_keys with expect_origin', () => {
  it('types while the tab is on that origin', async () => {
    const r = await handleRequest(req({ type: 'type_keys', text: 'abc', expect_origin: HERE, tab_id: 1 }));
    expect(r).toMatchObject({ ok: true });
    expect(keyDowns()).toEqual(['a', 'b', 'c']);
  });

  it('sends no key when the tab is on another origin', async () => {
    tab.url = 'https://evil.example.test/';
    const r = await handleRequest(req({ type: 'type_keys', text: 'abc', expect_origin: HERE, tab_id: 1 }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^origin_mismatch: /);
    expect(sent).toEqual([]);
  });

  it('stops when the page navigates part-way through the typing', async () => {
    onKey = (n) => {
      if (n === 2) tab.url = 'https://evil.example.test/';
    };
    const r = await handleRequest(req({ type: 'type_keys', text: 'abcdef', expect_origin: HERE, tab_id: 1 }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^origin_mismatch: /);
    expect(keyDowns()).toEqual(['a', 'b']);
  });

  it('checks a long text (inserted at once) before inserting', async () => {
    tab.url = 'https://evil.example.test/';
    const r = await handleRequest(req({ type: 'type_keys', text: 'x'.repeat(400), expect_origin: HERE, tab_id: 1 }));
    expect(r.ok).toBe(false);
    expect(sent.filter((c) => c.method === 'Input.insertText')).toEqual([]);
  });

  it('is not required: ordinary keystrokes work on any page', async () => {
    tab.url = 'https://anything.example.test/';
    const r = await handleRequest(req({ type: 'type_keys', text: 'ab', tab_id: 1 }));
    expect(r).toMatchObject({ ok: true });
    expect(keyDowns()).toEqual(['a', 'b']);
  });
});
