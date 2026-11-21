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

/** The builder's live task spec (`taskBuilderSpecSchema` of the API): every field optional, never a secret. */
export interface TaskBuilderSpec {
  name?: string;
  objective?: string;
  goal?: string;
  sites?: string[];
  allowedDomains?: string[];
  accounts?: { label: string; access: 'read' | 'read_write' }[];
  parameters?: { name: string; type: string; default?: string; memory?: string; attribute?: string; why?: string }[];
  outputs?: { label: string; type: string; help?: string }[];
  guardrails?: { confirmRiskyActions?: boolean; useSavedLogins?: boolean; useSavedIdentity?: boolean; useSavedCards?: boolean; unattendedPayments?: 'ask' | 'allow' };
  needsBrowser?: 'auto' | 'always' | 'never';
  policy?: { ref: string | null; why?: string };
  schedules?: { cron: string; timezone: string; inputs?: Record<string, string>; description?: string }[];
  edgeCases?: string[];
  openQuestions?: string[];
  suggestions?: string[];
  ready?: boolean;
}

/** `GET /task-builder/:id`. */
export interface TaskBuilderDetail {
  id: string;
  title: string;
  status: 'active' | 'archived';
  spec: TaskBuilderSpec;
  createdAt: string;
  updatedAt: string;
  messages: import('./chat').ChatMessage[];
  hasMore: boolean;
  thinking: boolean;
}
