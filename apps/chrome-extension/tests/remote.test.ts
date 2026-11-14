import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleRequest, isNavigableUrl, type BridgeRequest } from '../src/remote';

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
  it('allows web pages only', () => {
    expect(isNavigableUrl('https://example.test/a')).toBe(true);
    expect(isNavigableUrl('http://localhost:8080')).toBe(true);
    expect(isNavigableUrl('about:blank')).toBe(true);
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'data:text/html,x', 'not a url']) {
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

  it('refuses non-web URLs without touching the browser', async () => {
    const r = await handleRequest(req({ type: 'navigate', url: 'javascript:alert(1)' }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/http/);
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
