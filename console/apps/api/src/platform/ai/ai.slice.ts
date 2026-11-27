// The AI slice: the provider gateway (OpenAI, Anthropic, Gemini, and any
// OpenAI-compatible endpoint), keys at three tiers (the user's own, the
// organization's, the deployment's), the model catalogue, policy, usage
// accounting, and the admin Config, Models and Usage pages. AI is OFF until an
// administrator switches it on at `/admin/settings/ai`.
//
// Server-side only: never import a provider SDK, never call AI from the
// browser, and an `ai.*` job is never node-eligible (CLAUDE.md, the AI rules).
import { Module } from '@nestjs/common';

import type { SystemSettingsNamespace, UserSettingsNamespace } from '@marinoscar/platform-api/settings';

import type { ApiSlice } from '../slices/slice';

export const aiSlice: ApiSlice = {
  id: 'ai',
  permissionSlices: ['ai'],
  contribute: () => {
    const ai = require('@marinoscar/platform-api/ai') as typeof import('@marinoscar/platform-api/ai');
    return {
      systemSettings: [ai.AI_SYSTEM_SETTINGS as SystemSettingsNamespace],
      userSettings: [ai.AI_USER_SETTINGS as UserSettingsNamespace],
      credentialPurposes: [ai.AI_CREDENTIAL_PURPOSE_DEF],
      // `AiModule.forRoot()` registers the same objects; listing them here only fixes the purge order.
      storagePrefixes: ai.AI_STORAGE_KEY_PREFIXES,
    };
  },
  register: () => {
    const { registerAiFeature } = require('@marinoscar/platform-api/ai') as typeof import('@marinoscar/platform-api/ai');
    const { NOTES_SUMMARY_FEATURE } = require('./notes-summary.feature') as typeof import('./notes-summary.feature');
    registerAiFeature(NOTES_SUMMARY_FEATURE);
    const { BROWSER_AGENT_FEATURE } = require('../../runner/browser-agent.feature') as typeof import('../../runner/browser-agent.feature');
    registerAiFeature(BROWSER_AGENT_FEATURE);
    const { CHAT_ORCHESTRATOR_FEATURE } = require('../../chat/chat-orchestrator.feature') as typeof import('../../chat/chat-orchestrator.feature');
    registerAiFeature(CHAT_ORCHESTRATOR_FEATURE);
    const { TASK_BUILDER_FEATURE } = require('../../task-builder/task-builder.feature') as typeof import('../../task-builder/task-builder.feature');
    registerAiFeature(TASK_BUILDER_FEATURE);
    // The OpenAI web search provider's calls (E50.9): attributed to "Web search" on the AI usage pages.
    const { WEB_SEARCH_AI_FEATURE } = require('../../web-search/web-search.feature') as typeof import('../../web-search/web-search.feature');
    registerAiFeature(WEB_SEARCH_AI_FEATURE);
    const { TASK_IMPROVER_FEATURE } = require('../../task-improver/task-improver.feature') as typeof import('../../task-improver/task-improver.feature');
    registerAiFeature(TASK_IMPROVER_FEATURE);
  },
  modules: () => {
    const { AiModule } = require('./ai.config') as typeof import('./ai.config');
    const { NotesSummaryService } = require('./notes-summary.feature') as typeof import('./notes-summary.feature');
    /** Where the example feature's service is provided; delete with the example. */
    @Module({ imports: [AiModule], providers: [NotesSummaryService], exports: [NotesSummaryService] })
    class NotesSummaryModule {}
    const { AiUsageLedgerDoctorCheck } = require('./ai-usage-ledger.doctor-check') as typeof import('./ai-usage-ledger.doctor-check');
    /** `ai.usage_ledger` in the admin Doctor (#731): whether model calls reach the AI usage ledger. */
    @Module({ providers: [AiUsageLedgerDoctorCheck] })
    class AiUsageHealthModule {}
    return [AiModule, NotesSummaryModule, AiUsageHealthModule];
  },
};
