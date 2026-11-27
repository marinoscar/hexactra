import type { AiFeatureDefinition } from '@marinoscar/platform-api/ai';

/** "Improve this task"'s AI feature (E52.8, #1023). Stable id: never reuse it. */
export const TASK_IMPROVER_FEATURE_ID = 'task_improver';

/**
 * Reads a task's recent runs (masked steps, findings, masked trace screenshots) and proposes a better goal, each change tied to steps.
 * It never drives a browser, never starts a run and never changes a task: it writes a proposal row only.
 */
export const TASK_IMPROVER_FEATURE: AiFeatureDefinition = {
  id: TASK_IMPROVER_FEATURE_ID,
  label: 'Improve a task: read its runs and propose a better goal',
  group: 'Hexactra',
  needs: ['responses', 'structured_output'],
  inputModalities: ['text', 'image'],
  providers: null,
};
