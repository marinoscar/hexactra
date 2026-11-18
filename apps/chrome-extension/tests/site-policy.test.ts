import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleRequest, type BridgeRequest } from '../src/remote';
import {
  SITE_RULE_ID,
  applyAllowedDomains,
  hostAllowed,
  recordBlocked,
  resetSitePolicyForTests,
  takeBlocked,
  urlAllowed,
  urlHost,
} from '../src/site-policy';

// The same cases as hexactra_core::site_policy's Rust tests (#508).
describe('site matching', () => {
  const a = ['example.com'];
  it('matches the domain and its subdomains, case-insensitively', () => {
    expect(hostAllowed('example.com', a)).toBe(true);
    expect(hostAllowed('WWW.Example.com', a)).toBe(true);
    expect(hostAllowed('a.b.example.com', a)).toBe(true);
    expect(hostAllowed('badexample.com', a)).toBe(false);
    expect(hostAllowed('example.com.evil.net', a)).toBe(false);
    expect(hostAllowed('evil.net', a)).toBe(false);
    expect(hostAllowed('com', a)).toBe(false);
  });
  it('allows IP literals only when listed', () => {
    expect(hostAllowed('93.184.216.34', a)).toBe(false);
    expect(hostAllowed('[::1]', a)).toBe(false);
    const b = ['127.0.0.1', '::1'];
    expect(hostAllowed('127.0.0.1', b)).toBe(true);
    expect(hostAllowed('[::1]', b)).toBe(true);
    expect(hostAllowed('127.0.0.2', b)).toBe(false);
    expect(hostAllowed('x.127.0.0.1', b)).toBe(false);
  });
  it('allows everything with an empty list', () => {
    expect(hostAllowed('anything.test', [])).toBe(true);
    expect(urlAllowed('https://anything.test/', [])).toBe(true);
  });
  it('reads hosts from URLs', () => {
    expect(urlHost('https://user@Sub.Example.com:8080/p?q#f')).toBe('sub.example.com');
    expect(urlHost('http://[::1]:3000/')).toBe('::1');
    expect(urlHost('about:blank')).toBe(null);
    expect(urlAllowed('https://www.example.com/x', a)).toBe(true);
    expect(urlAllowed('https://evil.test/', a)).toBe(false);
    expect(urlAllowed('about:blank', a)).toBe(true);
  });
});

type UpdatedListener = (id: number, info: { url?: string; status?: string }, tab?: unknown) => void;

function makeChrome() {
  const updated = new Set<UpdatedListener>();
  const tab = { id: 1, windowId: 10, url: 'https://example.com/', title: 'Example', active: true, status: 'complete' };
  return {
    updated,
    tab,
    api: {
      declarativeNetRequest: { updateSessionRules: vi.fn(async () => undefined) },
      tabs: {
        get: vi.fn(async () => tab),
        query: vi.fn(async () => [tab]),
        update: vi.fn(async (_id: number, props: { url?: string }) => {
          if (props.url) {
            tab.url = props.url;
            setTimeout(() => {
              for (const l of updated) l(1, { status: 'complete' }, tab);
            }, 5);
          }
          return tab;
        }),
        onUpdated: { addListener: (l: UpdatedListener) => updated.add(l), removeListener: (l: UpdatedListener) => updated.delete(l) },
        onCreated: { addListener: vi.fn() },
      },
    },
  };
}

let mock: ReturnType<typeof makeChrome>;

beforeEach(() => {
  resetSitePolicyForTests();
  mock = makeChrome();
  vi.stubGlobal('chrome', mock.api);
});

const req = (action: BridgeRequest['action'], allowed?: string[]): BridgeRequest => ({
  type: 'request',
  id: 'op-1',
  action,
  deadline_ms: Date.now() + 2_000,
  ...(allowed ? { allowed_domains: allowed } : {}),
});

describe('allowed sites in the browser (#508)', () => {
  it('installs one main-frame block rule excluding the allowed sites, and removes it for an unconfined session', async () => {
    await applyAllowedDomains(['example.com', '::1']);
    expect(mock.api.declarativeNetRequest.updateSessionRules).toHaveBeenLastCalledWith({
      removeRuleIds: [SITE_RULE_ID],
      addRules: [
        {
          id: SITE_RULE_ID,
          priority: 1,
          action: { type: 'block' },
          condition: { resourceTypes: ['main_frame'], excludedRequestDomains: ['example.com', '[::1]'] },
        },
      ],
    });
    // Same list again: no browser call.
    await applyAllowedDomains(['example.com', '::1']);
    expect(mock.api.declarativeNetRequest.updateSessionRules).toHaveBeenCalledTimes(1);
    await applyAllowedDomains([]);
    expect(mock.api.declarativeNetRequest.updateSessionRules).toHaveBeenLastCalledWith({ removeRuleIds: [SITE_RULE_ID], addRules: [] });
  });

  it('refuses a navigate outside the allowed sites and reports it', async () => {
    const r = await handleRequest(req({ type: 'navigate', url: 'https://evil.test/x' }, ['example.com']));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^navigation_blocked: evil\.test/);
    expect(r.navigation_blocked).toEqual([{ host: 'evil.test', at: expect.any(String) }]);
    expect(mock.api.tabs.update).not.toHaveBeenCalled();
  });

  it('allows a navigate inside the allowed sites', async () => {
    const r = await handleRequest(req({ type: 'navigate', url: 'https://www.example.com/next' }, ['example.com']));
    expect(r.ok).toBe(true);
    expect(r.navigation_blocked).toBeUndefined();
  });

  it('reports a navigation the page started itself with the next action', async () => {
    await handleRequest(req({ type: 'tabs' }, ['example.com']));
    // A script or redirect sends the tab elsewhere; the rule blocks it and the
    // tab shows the attempted URL.
    for (const l of mock.updated) l(1, { url: 'https://Tracker.evil.test/collect?id=1' });
    for (const l of mock.updated) l(1, { url: 'https://www.example.com/fine' });
    const r = await handleRequest(req({ type: 'tabs' }, ['example.com']));
    expect(r.navigation_blocked).toEqual([{ host: 'tracker.evil.test', at: expect.any(String) }]);
    // Reported once.
    const again = await handleRequest(req({ type: 'tabs' }, ['example.com']));
    expect(again.navigation_blocked).toBeUndefined();
  });

  it('fails the action when the browser refuses the rule, instead of running unconfined', async () => {
    mock.api.declarativeNetRequest.updateSessionRules.mockRejectedValueOnce(new Error('bad rule'));
    const r = await handleRequest(req({ type: 'navigate', url: 'https://example.com/' }, ['example.com']));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/bad rule/);
    expect(mock.api.tabs.update).not.toHaveBeenCalled();
  });

  it('keeps at most one entry per host between actions', () => {
    recordBlocked('a.test');
    recordBlocked('a.test');
    recordBlocked('b.test');
    expect(takeBlocked().map((b) => b.host)).toEqual(['a.test', 'b.test']);
    expect(takeBlocked()).toEqual([]);
  });
});
