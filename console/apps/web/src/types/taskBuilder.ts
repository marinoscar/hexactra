// The task builder (E42, #717): what its routes answer.
import type { ChatTaskDraft } from './chat';

/** A schedule of a builder's draft, in the shape `POST /tasks` takes (inputs by parameter key). */
export interface TaskBuilderDraftSchedule {
  cron: string;
  timezone: string;
  enabled: boolean;
  concurrency: 'skip' | 'queue';
  policyId: null;
  inputs?: Record<string, string>;
}

/** `POST /task-builder/:id/draft`: the chat draft's shape, plus the schedules and what the owner should check. */
export interface TaskBuilderDraft extends ChatTaskDraft {
  unattendedPayments?: 'ask' | 'allow';
  needsBrowser?: 'auto' | 'always' | 'never';
  schedules?: TaskBuilderDraftSchedule[];
  warnings?: string[];
}

/** What the builder hands to `/tasks/new` in the router's state (never in the URL). */
export interface BuilderDraftState {
  builderId: string;
  builderDraft: TaskBuilderDraft;
}
