// Whether a run gets web search (E50.7, #977): the rule as a table (every row of the issue), the snapshot field, the reading of the
// services, and the run's web port (its budget across jobs, the allowed sites, Stop). No database, no network.
import { GatePipeline, STOPPED_TEXT } from '@marinoscar/hexactra-agent';
import { executeTool } from '@marinoscar/hexactra-agent/engine';
import { webFetch, webSearch, WEB_SENTENCES } from '@marinoscar/hexactra-web-agent';
import { fakeWebRun, FakeWebFetch, FakeWebSearch } from '@marinoscar/hexactra-web-agent/testing';

import { readSnapshotWeb, runWeb, webAvailability, type WebAvailabilityInputs } from '../src/runner/host/web-availability';
import { bindWeb, limitSearch, webSites } from '../src/runner/host/web-port';
import { runWebUsage } from '../src/tasks/run-web-usage';

const ON: WebAvailabilityInputs = { providerUsable: true, deploymentOn: true, userOn: true, fetchOn: true, appAllows: null };

describe('webAvailability: the rule (E50.7, the web half of E50.17)', () => {
  it.each<[string, Partial<WebAvailabilityInputs>, { search: boolean; fetch: boolean }]>([
    ['a provider is usable and both switches are on: on, for every run and chat', {}, { search: true, fetch: true }],
    ['no usable provider (no key): off', { providerUsable: false }, { search: false, fetch: false }],
    ["the deployment's switch is off: off", { deploymentOn: false }, { search: false, fetch: false }],
    ["the owner's switch is off: off", { userOn: false }, { search: false, fetch: false }],
    ["an AI app whose owner switched allowWebSearch off: off", { appAllows: false }, { search: false, fetch: false }],
    ['an AI app that allows it (the default): on', { appAllows: true }, { search: true, fetch: true }],
    ["the administrator's web_fetch switch off: search only", { fetchOn: false }, { search: true, fetch: false }],
  ])('%s', (_name, change, want) => {
    expect(webAvailability({ ...ON, ...change })).toEqual(want);
  });

  it('has no other input: a task, a chat, allowed sites or a model cannot turn it on or off', () => {
    expect(Object.keys(ON).sort()).toEqual(['appAllows', 'deploymentOn', 'fetchOn', 'providerUsable', 'userOn']);
  });
});

describe('readSnapshotWeb', () => {
  it('is off when absent or malformed, and reads the stored field', () => {
    expect(readSnapshotWeb(null)).toBeNull();
    expect(readSnapshotWeb({})).toBeNull();
    expect(readSnapshotWeb({ web: { search: 'yes' } as never })).toBeNull();
    expect(readSnapshotWeb({ web: { search: true, fetch: true, maxCalls: 30, costPerCallUsd: 0.005 } })).toEqual({ search: true, fetch: true, maxCalls: 30, costPerCallUsd: 0.005 });
    expect(readSnapshotWeb({ web: { search: true } as never })).toEqual({ search: true, fetch: false, maxCalls: null, costPerCallUsd: null });
  });
});

function service(o: { enabled?: boolean; user?: boolean; fetch?: boolean; candidates?: number; throws?: boolean } = {}) {
  const calls = { candidates: 0 };
  return {
    calls,
    svc: {
      system: async () => {
        if (o.throws) throw new Error('down');
        return { enabled: o.enabled ?? true, fetch: { enabled: o.fetch ?? true } };
      },
      userSettings: async () => ({ enabled: o.user ?? true, provider: null }),
      candidates: async () => {
        calls.candidates += 1;
        return Array.from({ length: o.candidates ?? 1 }, () => ({ provider: { id: 'brave' }, tier: 'user' }));
      },
      costOf: () => 0.005,
      forUser: async () => new FakeWebSearch(),
    } as never,
  };
}
const log = { warn: jest.fn() } as never;

describe('runWeb: what the snapshot gets', () => {
  it('on: search, fetch, the budget and the cost estimate', async () => {
    expect(await runWeb({ webSearch: service().svc, log }, { userId: 'u', orgId: null }, null, 30)).toEqual({ search: true, fetch: true, maxCalls: 30, costPerCallUsd: 0.005 });
  });

  it('off for each switch, and the key lookup is skipped when a switch is off', async () => {
    const off = service({ user: false });
    expect(await runWeb({ webSearch: off.svc, log }, { userId: 'u', orgId: null }, null, null)).toBeNull();
    expect(off.calls.candidates).toBe(0);
    expect(await runWeb({ webSearch: service({ enabled: false }).svc, log }, { userId: 'u', orgId: null }, null, null)).toBeNull();
    expect(await runWeb({ webSearch: service({ candidates: 0 }).svc, log }, { userId: 'u', orgId: null }, null, null)).toBeNull();
    expect(await runWeb({ webSearch: service().svc, log }, { userId: 'u', orgId: null }, { allowWebSearch: false }, null)).toBeNull();
  });

  it('without the module, or when the settings cannot be read: off, and the run goes on', async () => {
    expect(await runWeb({ log }, { userId: 'u', orgId: null }, null, null)).toBeNull();
    expect(await runWeb({ webSearch: service({ throws: true }).svc, log }, { userId: 'u', orgId: null }, null, null)).toBeNull();
  });
});

describe('the run\'s web port', () => {
  const on = { search: true, fetch: true, maxCalls: 2, costPerCallUsd: null };

  it('is not bound when the snapshot says off', async () => {
    expect(await bindWeb({ webSearch: service().svc, log }, { userId: 'u', orgId: null, runId: 'r', web: null, sites: null, earlierCalls: async () => 0 })).toBeNull();
  });

  it('counts searches and reads together, from the earlier jobs: over the budget, LIMIT_REACHED and no call', async () => {
    const search = new FakeWebSearch();
    const fetch = new FakeWebFetch();
    fetch.pages.set('https://a.example.test/', { title: 'A', text: 'a' });
    const d = { webSearch: { ...(service().svc as object), forUser: async () => search } as never, webFetch: { forRun: async () => fetch }, log };
    const web = (await bindWeb(d, { userId: 'u', orgId: null, runId: 'r', web: on, sites: null, earlierCalls: async () => 1 }))!;
    await web.fetch!.fetch({ url: 'https://a.example.test/', maxChars: 100, signal: new AbortController().signal });
    await expect(web.search!.search({ query: 'q', count: 1, freshness: null, site: null, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'LIMIT_REACHED' });
    expect(search.calls).toEqual([]);
    expect(fetch.calls).toHaveLength(1);
  });

  it('reaching the budget does not stop the run: the tool answers its sentence', async () => {
    const run = fakeWebRun();
    run.ctx.ext.web!.search = limitSearch(run.search, { used: 1, max: 1 });
    const text = await executeTool(run.ctx, webSearch as never, { query: 'anything', count: null, freshness: null, site: null }, new GatePipeline(run.gates as never) as never);
    expect(text).toBe(WEB_SENTENCES.searchLimit);
    expect(run.ctx.state.stop).toBeNull();
  });

  it('a Stop pressed while a search is in flight cancels it, and nothing reaches the provider after it', async () => {
    const run = fakeWebRun();
    run.search.latencyMs = 5_000;
    const pipeline = new GatePipeline(run.gates as never) as never;
    const pending = executeTool(run.ctx, webSearch as never, { query: 'slow one', count: null, freshness: null, site: null }, pipeline);
    await new Promise((r) => setTimeout(r, 20));
    run.stop.stop();
    expect(await pending).toBe(STOPPED_TEXT);
    const after = run.search.calls.length;
    await executeTool(run.ctx, webSearch as never, { query: 'after stop', count: null, freshness: null, site: null }, pipeline);
    await executeTool(run.ctx, webFetch as never, { url: 'https://a.example.test/', max_chars: null }, pipeline);
    expect(run.search.calls.length).toBe(after);
    expect(run.search.calls.map((c) => c.query)).toEqual(['slow one']);
    expect(run.fetch.calls).toEqual([]);
  });

  it('allowed sites: the hosts of the task, else of the app; none when neither lists any', () => {
    const allowed = () => true;
    expect(webSites(allowed, [], [])).toBeNull();
    expect(webSites(allowed, ['docs.example.test'], ['app.example.test'])!.hosts()).toEqual(['docs.example.test']);
    expect(webSites(allowed, [], ['app.example.test'])!.hosts()).toEqual(['app.example.test']);
  });
});

describe('runWebUsage: the run summary', () => {
  it('counts searches and reads (not refusals) and estimates the search cost apart from the AI cost', () => {
    const steps = [
      { action: 'web_search', summary: 'searched the web for "a" (3 results, brave)' },
      { action: 'web_search', summary: 'refused: the query looks like it holds secret material' },
      { action: 'web_fetch', summary: 'read docs.example.test/a' },
      { action: 'web_search', summary: 'web search failed (UNAVAILABLE)' },
      { action: 'navigate', summary: 'opened a page' },
    ];
    expect(runWebUsage(steps, { web: { search: true, fetch: true, maxCalls: null, costPerCallUsd: 0.005 } })).toEqual({ searches: 2, reads: 1, estimatedSearchCostUsd: 0.01 });
    expect(runWebUsage(steps, null)).toEqual({ searches: 2, reads: 1, estimatedSearchCostUsd: null });
    expect(runWebUsage([{ action: 'navigate', summary: 'x' }], null)).toBeNull();
  });
});
