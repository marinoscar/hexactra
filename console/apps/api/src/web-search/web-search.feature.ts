// The AI feature of the OpenAI web search provider (E50.9, #979): registered with the platform (`registerAiFeature`, the AI slice's
// `register`), so every call is attributed to "Web search" on the AI usage pages and its tokens land in the AI usage ledger. The
// search fee is counted apart, in `web_search_usage` (docs/web-search.md, "Cost").
//
// This is not the browser agent's feature: a web search call is never a `browser_agent` call, so the run's model tiers do not choose
// its model (the administrator's `webSearch.providers.openai.model` does).
import type { AiFeatureDefinition } from '@marinoscar/platform-api/ai';

/** The feature id. Stable: never reuse it for something else. */
export const WEB_SEARCH_AI_FEATURE_ID = 'web_search';

export const WEB_SEARCH_AI_FEATURE: AiFeatureDefinition = {
  id: WEB_SEARCH_AI_FEATURE_ID,
  label: 'Web search',
  group: 'Hexactra',
  needs: ['responses', 'hosted_tools'],
  inputModalities: ['text'],
  providers: ['openai'],
  requiresHostedTools: ['web_search'],
};
