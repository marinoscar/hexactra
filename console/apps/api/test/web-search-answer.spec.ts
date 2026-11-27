// Answer-type providers in the web search service (E50.9, #979), with in-memory stores: an `ai_service` provider is offered only while
// its own credential check passes; with allowed sites it is skipped for the call and a result-type provider answers, or the call is
// UNAVAILABLE with nothing sent or counted; the searches an answer reports count each for the per-day count, the fee and the per-run
// limit; and the run's binding (`bindWeb`) asks for result-type providers only when the run has allowed sites.
import { WebToolError, isWebToolError, type WebSearchResult } from '@marinoscar/hexactra-web-agent';

import type { StageOutcome } from '../src/diagnostics/stages';
import { bindWeb, webSites } from '../src/runner/host/web-port';
import type { ServiceCredentialPort } from '../src/service-credentials/service-credential.port';
import { SearchProviderRegistry, type ProviderAuth, type ProviderSearchResult, type SearchRequest } from '../src/web-search/search-provider';
import { FakeSearchProvider } from '../src/web-search/testing/fake-search-provider';
import { WebSearchService } from '../src/web-search/web-search.service';
import type { WebSearchSystemSettings } from '../src/web-search/web-search.settings';
import type { WebSearchUsage } from '../src/web-search/web-search.usage';

const ALICE = { userId: 'u-alice', orgId: 'o-acme' };
const req = (over: Partial<SearchRequest> = {}): SearchRequest => ({ query: 'example widgets', count: 5, freshness: null, site: null, signal: new AbortController().signal, ...over });
const codeOf = async (p: Promise<unknown>) => p.then(() => 'none', (e: unknown) => (isWebToolError(e) ? e.code : 'thrown'));

/** An answer-type provider through the AI service: its credential check is scripted; each answer reports `searches`. */
class FakeAnswerProvider extends FakeSearchProvider {
  override readonly kind = 'answer' as never;
  credentialOutcome: StageOutcome = { status: 'pass' };
  searches = 1;
  constructor() {
    super('answerer', 'Fake answerer', 'ai_service', 0.01);
  }
  async diagnoseCredential(): Promise<StageOutcome> {
    return this.credentialOutcome;
  }
  override async search(r: SearchRequest, auth: ProviderAuth): Promise<ProviderSearchResult> {
    const base: WebSearchResult = await super.search(r, auth);
    return { ...base, answer: { text: 'An invented answer.', citations: base.hits.map((h) => h.url) }, searches: this.searches };
  }
}

class MemoryUsage {
  rows: { provider: string; failed: boolean; costUsd: number | null; calls: number }[] = [];
  async record(_userId: string, provider: string, _at: Date, o: { failed: boolean; costUsd: number | null; calls?: number }) {
    this.rows.push({ provider, failed: o.failed, costUsd: o.costUsd, calls: o.calls ?? 1 });
  }
  async callsOn() {
    return this.rows.reduce((n, r) => n + r.calls, 0);
  }
}

function service(order: string[] = ['answerer', 'open'], extra: WebSearchSystemSettings = {}) {
  const registry = new SearchProviderRegistry();
  const answer = new FakeAnswerProvider();
  const open = new FakeSearchProvider('open', 'Open', 'none');
  registry.register(answer);
  registry.register(open);
  const usage = new MemoryUsage();
  const settings = { getNamespace: async () => ({ order, providers: { open: { baseUrl: 'https://open.search.example.test' } }, ...extra }) };
  const prisma = { userSettings: { findUnique: async () => null } };
  const svc = new WebSearchService(registry, {} as ServiceCredentialPort, usage as unknown as WebSearchUsage, prisma as never, settings as never, { add: jest.fn(), record: jest.fn() } as never);
  return { svc, answer, open, usage };
}

describe('answer-type providers in the service', () => {
  it('answers first when listed first and usable; its auth is the AI service (no key)', async () => {
    const { svc, answer, open } = service();
    const r = await svc.search(ALICE, req());
    expect(r.provider).toBe('answerer');
    expect(r.answer?.text).toBe('An invented answer.');
    expect(answer.log[0]).toMatchObject({ authKind: 'ai_service', keyPresent: false });
    expect(open.log).toHaveLength(0);
    expect((await svc.status(ALICE.userId, ALICE.orgId)).provider).toEqual({ id: 'answerer', label: 'Fake answerer', tier: null });
  });

  it('is not offered while its credential check fails (no model, AI off, no key, hosted search off)', async () => {
    const { svc, answer, open } = service();
    answer.credentialOutcome = { status: 'fail', code: 'MODEL_NOT_CHOSEN' };
    expect((await svc.search(ALICE, req())).provider).toBe('open');
    expect(answer.log).toHaveLength(0);
    expect(open.log).toHaveLength(1);
    const alone = service(['answerer']);
    alone.answer.credentialOutcome = { status: 'fail', code: 'HOSTED_TOOL_DISABLED' };
    expect(await alone.svc.forUser(ALICE.userId, ALICE.orgId)).toBeNull();
    expect((await alone.svc.status(ALICE.userId, ALICE.orgId)).reason).toBe('no_key');
  });

  it('with allowed sites the answer-type provider is skipped for the call and a result-type provider answers', async () => {
    const { svc, answer, open } = service();
    const r = await svc.search(ALICE, req(), { resultsOnly: true });
    expect(r.provider).toBe('open');
    expect(r.answer).toBeNull();
    expect(answer.log).toHaveLength(0);
    expect(open.log).toHaveLength(1);
  });

  it('with allowed sites and no result-type provider usable: UNAVAILABLE for that call, nothing sent or counted', async () => {
    const { svc, answer, usage } = service(['answerer']);
    expect(await codeOf(svc.search(ALICE, req(), { resultsOnly: true }))).toBe('UNAVAILABLE');
    expect(answer.log).toHaveLength(0);
    expect(usage.rows).toHaveLength(0);
    // The tool stays offered (E50.17): the port exists and says so per call.
    const port = (await svc.forUser(ALICE.userId, ALICE.orgId, { resultsOnly: true }))!;
    expect(port).not.toBeNull();
    expect(await codeOf(port.search(req()))).toBe('UNAVAILABLE');
    // Without allowed sites it answers.
    expect((await (await svc.forUser(ALICE.userId, ALICE.orgId))!.search(req())).provider).toBe('answerer');
  });

  it('each search an answer reports counts: the per-day count, the fee (per search) and the per-run limit; a failure is one', async () => {
    const { svc, answer, usage } = service(['answerer'], { limits: { perRun: 4 } });
    answer.searches = 3;
    const port = (await svc.forUser(ALICE.userId, ALICE.orgId))!;
    const r = await port.search(req());
    expect(r).not.toHaveProperty('searches');
    expect(usage.rows).toEqual([{ provider: 'answerer', failed: false, costUsd: 0.01, calls: 3 }]);
    await port.search(req());
    // 3 + 3 > 4: the next call of the run is refused before reaching the provider.
    expect(await codeOf(port.search(req()))).toBe('LIMIT_REACHED');
    answer.failNext('UNAVAILABLE');
    await codeOf(svc.search(ALICE, req()));
    expect(usage.rows.at(-1)).toEqual({ provider: 'answerer', failed: true, costUsd: 0.01, calls: 1 });
  });

  it("bindWeb asks for result-type providers only when the run has allowed sites", async () => {
    const calls: unknown[] = [];
    const webSearch = { forUser: async (...a: unknown[]) => (calls.push(a[2]), { search: async () => Promise.reject(new WebToolError('UNAVAILABLE')) }) };
    const d = { webSearch, webFetch: null, log: { warn: jest.fn() } } as never;
    const web = { search: true, fetch: false, maxCalls: null } as never;
    await bindWeb(d, { userId: 'u', orgId: null, runId: 'r', web, sites: webSites(() => true, ['docs.example.test'], []), earlierCalls: async () => 0 });
    await bindWeb(d, { userId: 'u', orgId: null, runId: 'r', web, sites: null, earlierCalls: async () => 0 });
    expect(calls).toEqual([{ resultsOnly: true }, { resultsOnly: false }]);
  });
});
