// OpenAI web search (E50.9, #979): the search provider contract, answer-type, against the AI service's test double (the platform's
// real `AiService` over a scripted fake provider, `test/support/fake-ai-search.ts`); and the adapter's own rules: the request it
// makes (feature, provider, the administrator's model, the hosted tool, the fixed instruction, the small cap), no model chosen means
// not usable, the mapping (answer, citations, searches), the AI error codes, Stop reaching the AI service, the usage row under the
// "Web search" feature, and the credential check (AI on, the hosted search switched on, a key that reaches the model).
import { WEB_CAPS, isWebToolError } from '@marinoscar/hexactra-web-agent';
import { AiError } from '@marinoscar/platform-api/ai';
import { HARNESS_OTHER_USER, HARNESS_USER, HARNESS_USER_KEY } from '@marinoscar/platform-api/ai/testing';

import { mapOpenAiSearch, openAiSearchFailure, openAiSearchInput, OPENAI_SEARCH_INSTRUCTIONS, OPENAI_SEARCH_MAX_OUTPUT_TOKENS } from '../src/web-search/providers/openai.provider';
import type { ProviderAuth, SearchRequest } from '../src/web-search/search-provider';
import { WEB_SEARCH_AI_FEATURE_ID } from '../src/web-search/web-search.feature';
import { answerResponse, fakeAiSearch, HARNESS_MODEL } from './support/fake-ai-search';
import { contractHits, searchProviderContract } from './support/search-provider-contract';

const auth = (userId = HARNESS_USER): ProviderAuth => ({ kind: 'ai_service', userId, orgId: null });
const req = (over: Partial<SearchRequest> = {}): SearchRequest => ({ query: 'invented widgets', count: 5, freshness: null, site: null, signal: new AbortController().signal, ...over });
const codeOf = async (p: Promise<unknown>) => p.then(() => 'none', (e: unknown) => (isWebToolError(e) ? e.code : 'thrown'));
const sentOf = (body: string) => JSON.parse(body) as { input: string; instructions: string; tools: unknown[]; toolChoice: string; maxOutputTokens: number; model: string };

searchProviderContract(
  'OpenAI web search',
  () => {
    const f = fakeAiSearch();
    return {
      provider: f.provider,
      auth: () => auth(),
      // No key is handled by the adapter: the AI service holds it.
      secret: null,
      secretHeader: null,
      script: (s) => f.script(s),
      requests: () => f.requests(),
      hosts: () => ['api.openai.com'],
      expectFilters: (r, flt) => {
        const input = sentOf(r.body).input;
        expect(input).toContain(`site:${flt.site}`);
        expect(input).toContain(`Use only pages on ${flt.site}.`);
        expect(input).toContain(`the past ${flt.freshness}`);
      },
    };
  },
  // The AI service reports no quota of its own (a used-up OpenAI quota arrives as a rate limit); its network is the AI service's.
  { kind: 'answer', quota: false, probe: false },
);

describe('OpenAI web search', () => {
  it('calls the AI service for the feature "web_search", on OpenAI, with the administrator model, the hosted search and a fixed instruction', async () => {
    const f = fakeAiSearch();
    f.script({ kind: 'results', hits: contractHits(3) });
    await f.provider.search(req({ site: 'docs.example.test', freshness: 'week' }), auth());
    const call = f.harness.fake.calls.find((c) => c.method === 'responses.create')!;
    expect(call.request).toMatchObject({
      model: HARNESS_MODEL,
      instructions: OPENAI_SEARCH_INSTRUCTIONS,
      tools: [{ type: 'web_search', searchContextSize: 'low' }],
      toolChoice: 'required',
    });
    expect(call.request!.maxOutputTokens).toBeLessThanOrEqual(OPENAI_SEARCH_MAX_OUTPUT_TOKENS);
    expect(call.request!.input).toBe(openAiSearchInput({ query: 'invented widgets', site: 'docs.example.test', freshness: 'week' }));
    // The caller's key paid (the AI service resolved it), and the call is metered under "Web search".
    expect(call.apiKey).toBe(HARNESS_USER_KEY);
    expect(f.harness.usageEvents.at(-1)).toMatchObject({ feature: WEB_SEARCH_AI_FEATURE_ID, provider: 'openai', modelId: HARNESS_MODEL });
  });

  it('is not usable until the administrator chooses a model; an `openai:` prefix is accepted', async () => {
    const f = fakeAiSearch();
    f.settings.value = {};
    expect(await codeOf(f.provider.search(req(), auth()))).toBe('NOT_CONFIGURED');
    expect(await f.provider.diagnoseCredential({ userId: HARNESS_USER, orgId: null })).toMatchObject({ status: 'fail', code: 'MODEL_NOT_CHOSEN' });
    expect(f.harness.fake.calls.filter((c) => c.method === 'responses.create')).toHaveLength(0);
    f.settings.value = { providers: { openai: { model: `openai:${HARNESS_MODEL}` } } };
    f.script({ kind: 'results', hits: contractHits(2) });
    expect((await f.provider.search(req(), auth())).answer).not.toBeNull();
  });

  it('maps the answer, each cited page once in the provider order, and the number of searches made', () => {
    const hits = [
      { title: 'One', url: 'https://one.example.test/', snippet: 'First fact.', publishedAt: null },
      { title: 'Two', url: 'https://two.example.test/', snippet: 'Second fact.', publishedAt: null },
      { title: 'One again', url: 'https://one.example.test/', snippet: 'Again.', publishedAt: null },
    ];
    const r = mapOpenAiSearch(answerResponse(hits, 'The answer.\u0007', 3), 5);
    expect(r).toEqual({
      provider: 'openai',
      hits: [
        { title: 'One', url: 'https://one.example.test/', snippet: 'First fact.', publishedAt: null },
        { title: 'Two', url: 'https://two.example.test/', snippet: 'Second fact.', publishedAt: null },
      ],
      answer: { text: 'The answer. First fact. Second fact. Again.', citations: ['https://one.example.test/', 'https://two.example.test/'] },
      searches: 3,
    });
    const cite = [{ url: 'https://one.example.test/', title: 'One', startIndex: 0, endIndex: 2 }];
    expect([...mapOpenAiSearch({ output: [{ type: 'message', text: 'z'.repeat(9_000), citations: cite }] }, 5).answer!.text].length).toBe(WEB_CAPS.answer);
    // No searches reported: absent (the service counts one).
    expect(mapOpenAiSearch({ output: [{ type: 'message', text: 'ok', citations: cite }] }, 5).searches).toBeUndefined();
    // An answer that cites no page is no result (the searches made are still counted); no message at all is UNAVAILABLE.
    expect(mapOpenAiSearch({ output: [{ type: 'hosted_tool_call', tool: 'web_search', status: 'completed' }, { type: 'message', text: 'Uncited.' }] }, 5)).toEqual({ provider: 'openai', hits: [], answer: null, searches: 1 });
    expect(() => mapOpenAiSearch({ output: [] }, 5)).toThrow('UNAVAILABLE');
  });

  it('maps the AI service codes to closed codes; Stop is ABORTED', () => {
    const live = new AbortController().signal;
    const cases: [string, string][] = [
      ['AI_KEY_INVALID', 'AUTH_REFUSED'],
      ['AI_KEY_REQUIRED', 'AUTH_REFUSED'],
      ['AI_MODEL_NOT_REACHABLE', 'AUTH_REFUSED'],
      ['AI_TOOL_DISABLED', 'AUTH_REFUSED'],
      ['AI_DISABLED', 'AUTH_REFUSED'],
      ['AI_RATE_LIMITED', 'RATE_LIMITED'],
      ['AI_PROVIDER_UNAVAILABLE', 'UNAVAILABLE'],
      ['AI_CONTENT_FILTERED', 'UNAVAILABLE'],
    ];
    for (const [ai, code] of cases) expect([ai, openAiSearchFailure(new AiError(ai as never, 'invented'), live).code]).toEqual([ai, code]);
    expect(openAiSearchFailure(new AiError('AI_RATE_LIMITED', 'x', { retryAfterMs: 1500 }), live)).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 1500 });
    expect(openAiSearchFailure(new Error('x'), live).code).toBe('UNAVAILABLE');
    const stopped = new AbortController();
    stopped.abort();
    expect(openAiSearchFailure(new AiError('AI_PROVIDER_UNAVAILABLE', 'x'), stopped.signal).code).toBe('ABORTED');
  });

  it('Stop during the call: the abort reaches the AI service (the fake provider saw it), and the call is ABORTED', async () => {
    // The fake provider waits 5 s unless the call's signal aborts (and records that it did).
    const f = fakeAiSearch({ fake: { delayMs: 5_000 } });
    f.script({ kind: 'results', hits: contractHits(2) });
    const stop = new AbortController();
    const pending = f.provider.search(req({ signal: stop.signal }), auth());
    await new Promise((r) => setTimeout(r, 10));
    stop.abort();
    expect(await codeOf(pending)).toBe('ABORTED');
    const call = f.harness.fake.calls.find((c) => c.method === 'responses.create')!;
    expect(call.aborted).toBe(true);
  });

  it('the credential check: pass with a key that reaches the model; AI off, the hosted search off, no key and an unreachable model fail', async () => {
    const who = { userId: HARNESS_USER, orgId: null };
    expect(await fakeAiSearch().provider.diagnoseCredential(who)).toMatchObject({ status: 'pass', data: { model: HARNESS_MODEL } });
    expect(await fakeAiSearch({ policy: { enabled: false } }).provider.diagnoseCredential(who)).toMatchObject({ status: 'fail', code: 'AI_OFF' });
    expect(await fakeAiSearch({ policy: { hostedTools: { web_search: false } } }).provider.diagnoseCredential(who)).toMatchObject({ status: 'fail', code: 'HOSTED_TOOL_DISABLED' });
    // A user with no key, and no deployment key: the AI service would refuse; never a key read here.
    expect(await fakeAiSearch().provider.diagnoseCredential({ userId: HARNESS_OTHER_USER, orgId: null })).toMatchObject({ status: 'fail', code: 'AI_KEY_MISSING' });
    const f = fakeAiSearch();
    f.settings.value = { providers: { openai: { model: 'not-in-the-catalogue' } } };
    expect(await f.provider.diagnoseCredential(who)).toMatchObject({ status: 'fail', code: 'AI_MODEL_NOT_REACHABLE' });
  });

  it('a hosted search switched off by the administrator refuses the search too (the AI service gate)', async () => {
    const f = fakeAiSearch({ policy: { hostedTools: { web_search: false } } });
    expect(await codeOf(f.provider.search(req(), auth()))).toBe('AUTH_REFUSED');
  });
});
