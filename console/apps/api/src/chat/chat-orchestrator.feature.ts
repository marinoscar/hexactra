import type { AiFeatureDefinition } from '@marinoscar/platform-api/ai';

/** The chat's AI feature (#484). Stable id: never reuse it. */
export const CHAT_ORCHESTRATOR_FEATURE_ID = 'chat_orchestrator';

/**
 * Decides what a chat does next: reply, ask the owner one question, or start a
 * browser run. It never drives a browser itself (that is `browser_agent`), so
 * a small, fast model that answers with tool calls is enough.
 */
export const CHAT_ORCHESTRATOR_FEATURE: AiFeatureDefinition = {
  id: CHAT_ORCHESTRATOR_FEATURE_ID,
  label: 'Chat: understand the request and start jobs',
  group: 'Hexactra',
  needs: ['responses', 'tools'],
  inputModalities: ['text'],
  providers: null,
};
