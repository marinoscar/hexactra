import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KEY_BY_KEY_MAX, resetCdp } from '../src/cdp';
import { MARKS_ID, closeAllWindows, handleRequest, isNavigableUrl, type BridgeRequest } from '../src/remote';

type Listener = (id: number, info: { status?: string }, tab: unknown) => void;

function makeChrome() {
  const listeners = new Set<Listener>();
  const tabs = new Map<number, { id: number; windowId: number; url: string; title: string; active: boolean; status: string }>([
    [1, { id: 1, windowId: 10, url: 'https://example.test/', title: 'Example', active: true, status: 'complete' }],
    [2, { id: 2, windowId: 10, url: 'https://other.test/', title: 'Other', active: false, status: 'complete' }],
  ]);
  const api = {
    tabs: {
      get: vi.fn(async (id: number) => {
        const t = tabs.get(id);
        if (!t) throw new Error('No tab');
        return t;
      }),
      query: vi.fn(async (q: { active?: boolean }) => [...tabs.values()].filter((t) => (q.active ? t.active : true))),
      update: vi.fn(async (id: number, props: { url?: string; active?: boolean }) => {
        const t = tabs.get(id)!;
        if (props.active) {
          for (const o of tabs.values()) o.active = false;
          t.active = true;
        }
        if (props.url) {
          t.url = props.url;
          t.status = 'loading';
          setTimeout(() => {
            t.status = 'complete';
            t.title = 'Loaded';
            for (const l of listeners) l(id, { status: 'complete' }, t);
          }, 5);
        }
        return t;
      }),
      create: vi.fn(async () => ({ id: 3 })),
      remove: vi.fn(async () => undefined),
      captureVisibleTab: vi.fn(async () => 'data:image/jpeg;base64,QUJD'),
      goBack: vi.fn(),
      goForward: vi.fn(),
      reload: vi.fn(),
      onUpdated: {
        addListener: (l: Listener) => listeners.add(l),
        removeListener: (l: Listener) => listeners.delete(l),
      },
    },
    scripting: { executeScript: vi.fn() },
    windows: { update: vi.fn() },
  };
  return api;
}

let chromeMock: ReturnType<typeof makeChrome>;

beforeEach(() => {
  chromeMock = makeChrome();
  vi.stubGlobal('chrome', chromeMock);
});

const req = (action: BridgeRequest['action']): BridgeRequest => ({
  type: 'request',
  id: 'op-1',
  action,
  deadline_ms: Date.now() + 2_000,
});

describe('isNavigableUrl', () => {
  it('opens whatever a person could type, except javascript: (#366)', () => {
    for (const ok of ['https://example.test/a', 'http://localhost:8080', 'about:blank', 'file:///tmp/a.pdf', 'chrome://settings', 'data:text/html,x']) {
      expect(isNavigableUrl(ok)).toBe(true);
    }
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'not a url', 'https://']) {
      expect(isNavigableUrl(bad)).toBe(false);
    }
  });
});

describe('handleRequest', () => {
  it('navigates the active tab and waits for load', async () => {
    const r = await handleRequest(req({ type: 'navigate', url: 'https://example.test/next' }));
    expect(r).toMatchObject({ type: 'response', id: 'op-1', ok: true });
    expect(r.result).toMatchObject({ tab_id: 1, url: 'https://example.test/next', title: 'Loaded' });
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(1, { url: 'https://example.test/next' });
  });

  it('refuses javascript: URLs without touching the browser', async () => {
    const r = await handleRequest(req({ type: 'navigate', url: 'javascript:alert(1)' }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/evaluate/);
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
  });

  it('lists tabs', async () => {
    const r = await handleRequest(req({ type: 'tabs' }));
    expect(r.ok).toBe(true);
    expect((r.result as { tabs: unknown[] }).tabs).toHaveLength(2);
  });

  it('maps page-side errors to a failed response', async () => {
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: { __error: 'no element matches #nope' } }]);
    const r = await handleRequest(req({ type: 'click', selector: '#nope' }));
    expect(r).toMatchObject({ ok: false, error: 'no element matches #nope' });
  });

  it('maps injection failures (restricted pages) to a failed response', async () => {
    chromeMock.scripting.executeScript.mockRejectedValue(new Error('Cannot access a chrome:// URL'));
    const r = await handleRequest(req({ type: 'text' }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('cannot act on this page');
  });

  it('returns page results for text', async () => {
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: { text: 'hello', truncated: false } }]);
    const r = await handleRequest(req({ type: 'text', tab_id: 2 }));
    expect(r).toMatchObject({ ok: true, result: { text: 'hello' } });
    expect(chromeMock.scripting.executeScript.mock.calls[0][0].target).toEqual({ tabId: 2 });
  });

  it('captures a screenshot as base64 jpeg, activating the tab first', async () => {
    const r = await handleRequest(req({ type: 'screenshot', tab_id: 2 }));
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ mime: 'image/jpeg', data: 'QUJD', tab_id: 2 });
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(2, { active: true });
  });

  it('reports a missing tab', async () => {
    const r = await handleRequest(req({ type: 'close_tab', tab_id: 99 }));
    expect(r).toMatchObject({ ok: false, error: 'no tab with id 99' });
  });

  it('times out wait_for', async () => {
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: { found: false } }]);
    const r = await handleRequest(req({ type: 'wait_for', selector: '#later', timeout_ms: 300 }));
    expect(r).toMatchObject({ ok: false, error: 'timed out waiting for #later' });
  });

  it('rejects unknown action types', async () => {
    const r = await handleRequest(req({ type: 'execute_script' } as unknown as BridgeRequest['action']));
    expect(r.ok).toBe(false);
  });
});

describe('closeAllWindows', () => {
  it('closes every window so the browser exits normally', async () => {
    const removed: number[] = [];
    vi.stubGlobal('chrome', {
      windows: {
        getAll: vi.fn(async () => [{ id: 1 }, { id: 2 }]),
        remove: vi.fn(async (id: number) => {
          removed.push(id);
        }),
      },
    });
    expect(await closeAllWindows()).toBe(2);
    expect(removed.sort()).toEqual([1, 2]);
  });
});

describe('full-power actions through chrome.debugger (#366)', () => {
  type Sent = { method: string; params?: Record<string, unknown> };
  let sent: Sent[];
  let reply: (method: string, params?: Record<string, unknown>) => unknown;

  beforeEach(() => {
    resetCdp();
    sent = [];
    reply = () => ({});
    (chromeMock as unknown as Record<string, unknown>).debugger = {
      attach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async (_t: unknown, method: string, params?: Record<string, unknown>) => {
        sent.push({ method, params });
        return reply(method, params);
      }),
      onDetach: { addListener: vi.fn() },
    };
  });

  const events = (type?: string) => sent.filter((c) => c.method === 'Input.dispatchMouseEvent' && (!type || c.params?.type === type));

  it('clicks at coordinates with trusted mouse events', async () => {
    const r = await handleRequest(req({ type: 'click_at', x: 40, y: 50, click_count: 2, modifiers: ['ctrl'] }));
    expect(r.ok).toBe(true);
    expect(events('mousePressed').map((c) => c.params?.clickCount)).toEqual([1, 2]);
    expect(events('mouseReleased')).toHaveLength(2);
    expect(events('mousePressed')[0].params).toMatchObject({ x: 40, y: 50, button: 'left', modifiers: 2 });
  });

  it('hovers, drags and wheels', async () => {
    await handleRequest(req({ type: 'mouse', op: 'move', x: 1, y: 2 }));
    expect(events('mouseMoved')[0].params).toMatchObject({ x: 1, y: 2, button: 'none' });
    sent = [];
    await handleRequest(req({ type: 'drag', from_x: 0, from_y: 0, to_x: 100, to_y: 0, steps: 4 }));
    expect(events('mouseMoved').map((c) => c.params?.x)).toEqual([0, 25, 50, 75, 100]);
    expect(events('mouseReleased')[0].params).toMatchObject({ x: 100, y: 0 });
    sent = [];
    await handleRequest(req({ type: 'scroll_at', x: 5, y: 6, dy: 300 }));
    expect(events('mouseWheel')[0].params).toMatchObject({ x: 5, y: 6, deltaX: 0, deltaY: 300 });
  });

  it('types with trusted key events and presses chords', async () => {
    await handleRequest(req({ type: 'type_keys', text: 'Hi\n' }));
    const keys = sent.filter((c) => c.method === 'Input.dispatchKeyEvent');
    expect(keys.filter((k) => k.params?.type === 'keyDown').map((k) => k.params?.text)).toEqual(['H', 'i', '\r']);
    sent = [];
    await handleRequest(req({ type: 'key', key: 'a', modifiers: ['ctrl'] }));
    const down = sent.find((c) => c.params?.type === 'rawKeyDown');
    expect(down?.params).toMatchObject({ key: 'a', code: 'KeyA', modifiers: 2 });
    expect(down?.params?.text).toBeUndefined();
  });

  it('inserts long text at once', async () => {
    await handleRequest(req({ type: 'type_keys', text: 'x'.repeat(KEY_BY_KEY_MAX + 1) }));
    expect(sent.map((c) => c.method)).toEqual(['Input.insertText']);
  });

  it('runs JavaScript and returns its value', async () => {
    reply = (method) => (method === 'Runtime.evaluate' ? { result: { type: 'string', value: 'Example' } } : {});
    const r = await handleRequest(req({ type: 'evaluate', script: 'document.title' }));
    expect(r).toMatchObject({ ok: true, result: { value: 'Example', type: 'string' } });
    expect(sent[0].params).toMatchObject({ expression: 'document.title', returnByValue: true, replMode: true, allowUnsafeEvalBlockedByCSP: true });
  });

  it('reports a script exception as a failure', async () => {
    reply = () => ({ exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: nope is not defined' } } });
    const r = await handleRequest(req({ type: 'evaluate', script: 'nope' }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ReferenceError');
  });

  it('never enables a CDP domain', async () => {
    await handleRequest(req({ type: 'click_at', x: 1, y: 1 }));
    await handleRequest(req({ type: 'evaluate', script: '1' }));
    expect(sent.some((c) => c.method.endsWith('.enable'))).toBe(false);
  });

  it('captures a marked screenshot through CDP and removes the marks', async () => {
    reply = (method) => (method === 'Page.captureScreenshot' ? { data: 'Q0RQ' } : {});
    chromeMock.scripting.executeScript
      .mockResolvedValueOnce([{ result: { marks: [{ n: 1, selector: '#go', x: 1, y: 2, w: 3, h: 4 }], width: 800, height: 600, dpr: 1, url: 'https://example.test/', title: 'Example' } }])
      .mockResolvedValueOnce([{ result: {} }]);
    const r = await handleRequest(req({ type: 'screenshot', marks: true }));
    expect(r).toMatchObject({ ok: true, result: { data: 'Q0RQ', width: 800, height: 600, marks: [{ n: 1, selector: '#go' }] } });
    const calls = chromeMock.scripting.executeScript.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][0].args).toEqual([MARKS_ID]);
    expect(chromeMock.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it('fails clearly when the debugger cannot attach', async () => {
    (chromeMock as unknown as { debugger: { attach: ReturnType<typeof vi.fn> } }).debugger.attach.mockRejectedValue(new Error('Cannot access a chrome:// URL'));
    const r = await handleRequest(req({ type: 'click_at', x: 1, y: 1 }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('cannot control this tab');
  });
});
