// The AI service's test double for the OpenAI web search provider (E50.9, #979): the platform's own AI runtime harness
// (`createAiRuntimeHarness`: the REAL `AiService`, key resolution, gates and usage recorder over a scripted fake provider registered
// as `openai`, in memory), with the hosted `web_search` tool switched on, and a script queue that answers each call the way the
// search provider contract asks (`ContractScript`). Invented data only; nothing leaves the process.
import { AiError, getAiFeature, registerAiFeature, type AiOutputItem } from '@marinoscar/platform-api/ai';
import { createAiRuntimeHarness, FAKE_TEXT_MODEL_CAPABILITIES, type AiRuntimeHarness, type AiRuntimeHarnessOptions } from '@marinoscar/platform-api/ai/testing';

import { OpenAiSearchProvider } from '../../src/web-search/providers/openai.provider';
import { SearchProviderRegistry } from '../../src/web-search/search-provider';
import { WEB_SEARCH_AI_FEATURE } from '../../src/web-search/web-search.feature';
import type { WebSearchService } from '../../src/web-search/web-search.service';
import { resolveWebSearchSystemSettings, type WebSearchSystemSettings } from '../../src/web-search/web-search.settings';
import { PROVIDER_TEXT } from '../../src/web-search/testing/fake-json-endpoint';
import type { ContractHitInput, ContractRequest, ContractScript } from './search-provider-contract';

/** The catalogue's search model: text responses plus provider-hosted tools (the platform's default fake model has none). */
export const SEARCH_MODEL = 'fake-search-model';
/** Kept for the tests' wording. */
export const HARNESS_MODEL = SEARCH_MODEL;

/** Registers the "Web search" AI feature once per process (the platform registry is process-wide). */
export function ensureWebSearchFeature(): void {
  if (!getAiFeature(WEB_SEARCH_AI_FEATURE.id)) registerAiFeature(WEB_SEARCH_AI_FEATURE);
}

/** An answer citing `hits`: the answer text, then each hit's snippet as the span its citation points at. */
export function answerResponse(hits: ContractHitInput[], answer = 'An invented answer.', searches = 1): { output: AiOutputItem[] } {
  let text = answer;
  const citations = hits.map((h) => {
    text += ' ';
    const startIndex = text.length;
    text += h.snippet;
    return { url: h.url, title: h.title, startIndex, endIndex: text.length };
  });
  const calls: AiOutputItem[] = Array.from({ length: searches }, (_v, i) => ({ type: 'hosted_tool_call', id: `ws_${i}`, tool: 'web_search', status: 'completed', result: { queries: ['invented'], sources: hits.map((h) => ({ url: h.url })) } }) as AiOutputItem);
  return { output: [...calls, { type: 'message', text, citations }] };
}

const failure = (code: ConstructorParameters<typeof AiError>[0], opts: { retryAfterMs?: number } = {}) => new AiError(code, `invented ${PROVIDER_TEXT}`, opts);

export interface FakeAiSearch {
  harness: AiRuntimeHarness;
  provider: OpenAiSearchProvider;
  /** The settings the provider reads its model from; a test changes `value`. */
  settings: { value: WebSearchSystemSettings };
  script(s: ContractScript | { kind: 'answer'; output: AiOutputItem[] }): void;
  /** Every responses call that reached the fake provider, as a contract request (host: the provider's API host). */
  requests(): ContractRequest[];
}

/** The provider over the real AI service of the platform's harness. `opts` are the harness's (policy, keys). */
export function fakeAiSearch(opts: AiRuntimeHarnessOptions = {}): FakeAiSearch {
  ensureWebSearchFeature();
  const queue: (ContractScript | { kind: 'answer'; output: AiOutputItem[] })[] = [];
  const harness = createAiRuntimeHarness({
    models: [{ modelId: SEARCH_MODEL, capabilities: { ...FAKE_TEXT_MODEL_CAPABILITIES, capabilities: [...FAKE_TEXT_MODEL_CAPABILITIES.capabilities, 'hosted_tools'] } }],
    ...opts,
    policy: { ...(opts.policy ?? {}), hostedTools: { web_search: true, ...(opts.policy?.hostedTools ?? {}) } },
    fake: {
      hostedTools: ['web_search'],
      ...(opts.fake ?? {}),
      responses: (_req, ctx) => {
        const s = queue.shift() ?? { kind: 'results', hits: [] };
        switch (s.kind) {
          case 'answer':
            return { output: s.output };
          case 'results':
            return answerResponse(s.hits, s.answer);
          case 'auth_refused':
            throw failure('AI_KEY_INVALID');
          case 'rate_limited':
            throw failure('AI_RATE_LIMITED', s.retryAfterS === undefined ? {} : { retryAfterMs: s.retryAfterS * 1000 });
          case 'quota':
            throw failure('AI_RATE_LIMITED');
          case 'server_error':
          case 'transport':
            throw failure('AI_PROVIDER_UNAVAILABLE');
          case 'malformed':
            return { output: [] };
          case 'throw':
            throw new Error(`boom ${PROVIDER_TEXT}`);
          case 'hang':
            return new Promise((_resolve, reject) => {
              const stop = () => reject(new DOMException('aborted', 'AbortError'));
              if (ctx.signal?.aborted) stop();
              else ctx.signal?.addEventListener('abort', stop, { once: true });
            });
          default:
            throw failure('AI_PROVIDER_UNAVAILABLE');
        }
      },
    },
  });
  const settings = { value: { providers: { openai: { model: HARNESS_MODEL } } } as WebSearchSystemSettings };
  const service = { system: async () => resolveWebSearchSystemSettings(settings.value) } as unknown as WebSearchService;
  const provider = new OpenAiSearchProvider(new SearchProviderRegistry(), service);
  provider.aiDeps = { ai: harness.ai, usableModels: harness.usableModels, config: harness.aiConfig };
  return {
    harness,
    provider,
    settings,
    script: (s) => queue.push(s),
    requests: () =>
      harness.fake.calls
        .filter((c) => c.method === 'responses.create')
        .map((c) => ({ host: 'api.openai.com', url: 'ai-service:responses', headers: {}, body: JSON.stringify(c.request ?? {}) })),
  };
}
