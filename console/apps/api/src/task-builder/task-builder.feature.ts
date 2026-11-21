import type { AiFeatureDefinition } from '@marinoscar/platform-api/ai';

/** The task builder's AI feature (E42). Stable id: never reuse it. */
export const TASK_BUILDER_FEATURE_ID = 'task_builder';

/**
 * Interviews the owner about a task they want and drafts it: it asks
 * questions, keeps the task spec and writes the final goal. It never drives a
 * browser and never starts a run, so a small model that answers with tool
 * calls is enough.
 */
export const TASK_BUILDER_FEATURE: AiFeatureDefinition = {
  id: TASK_BUILDER_FEATURE_ID,
  label: 'Task builder: interview the owner and draft a task',
  group: 'Hexactra',
  needs: ['responses', 'tools'],
  inputModalities: ['text'],
  providers: null,
};
