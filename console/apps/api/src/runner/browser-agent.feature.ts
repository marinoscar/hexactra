import type { AiFeatureDefinition } from '@marinoscar/platform-api/ai';

/** The goal runner's AI feature. Stable id: never reuse it. */
export const BROWSER_AGENT_FEATURE_ID = 'browser_agent';

/** A model that answers with tool calls drives the browser. */
export const BROWSER_AGENT_FEATURE: AiFeatureDefinition = {
  id: BROWSER_AGENT_FEATURE_ID,
  label: 'Browser agent: run goals in remote browsers',
  group: 'Hexactra',
  needs: ['responses', 'tools'],
  inputModalities: ['text'],
  providers: null,
};
