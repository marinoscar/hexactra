import type { RunBudget } from '../components/runBudget';
// A chat and its messages, as the API returns them (`chatResponseSchema` and
// friends in apps/api/src/openapi/chat.responses.ts) and as the chat's event
// stream sends them (apps/api/src/chat/chat-stream.controller.ts).
import type { TaskOutput } from '@app/shared/task-fields';
import type { TaskParameter } from '@app/shared/task-params';

import type { RunActivity } from '../components/RunActivity';
import type { RunStatus, RunStopReason } from './runs';

export type ChatStatus = 'active' | 'archived';
export type ChatMessageRole = 'user' | 'assistant' | 'system';
export type ChatMessageKind = 'text' | 'clarify' | 'run' | 'result' | 'task_draft' | 'memory';

export interface Chat {
  id: string;
  /** Empty until the first message names the chat, or the owner does. */
  title: string;
  status: ChatStatus;
  profile: string;
  hostId: string | null;
  hostFallback: boolean;
  policyId: string | null;
  allowedDomains: string[];
  confirmRiskyActions: boolean;
  /** Let the chat's runs sign in from the owner's saved logins (E37.3); absent from an older console: off. */
  useSavedLogins?: boolean;
  /** Let the chat's runs fill identity details from the owner's saved details (E37.6); absent from an older console: off. */
  useSavedIdentity?: boolean;
  /** Let the chat's runs pay with a saved card (E37.7); absent from an older console: off. */
  useSavedCards?: boolean;
  lastMessageAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  /** Order within the chat, from 1. */
  seq: number;
  role: ChatMessageRole;
  kind: ChatMessageKind;
  text: string;
  runId: string | null;
  meta: unknown;
  createdAt: string;
}

export interface ChatLiveRun {
  id: string;
  status: Extract<RunStatus, 'queued' | 'running' | 'waiting_human' | 'paused'>;
}

export interface ChatListItem extends Chat {
  preview: { role: ChatMessageRole; kind: ChatMessageKind; text: string } | null;
  liveRun: ChatLiveRun | null;
}

export interface ChatPage {
  items: ChatListItem[];
  nextCursor: string | null;
}

export interface ChatDetail extends Chat {
  messages: ChatMessage[];
  hasMore: boolean;
  liveRun: ChatLiveRun | null;
  thinking: boolean;
}

/** The chat's newest run, as the stream's `run` event carries it. */
export interface ChatRun {
  id: string;
  status: RunStatus;
  goal: string;
  stepCount: number;
  activity: RunActivity | null;
  result: string | null;
  error: string | null;
  stopReason: RunStopReason | null;
  cancelRequested: boolean;
  /** Pause was pressed and the run has not paused yet (E38.2). Absent from an older console. */
  pauseRequested?: boolean;
  hostId: string | null;
  costUsd: number;
  costKnown: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** The run's budget (#537): a chat run's limits are soft, shown and never enforced. Absent from older streams. */
  budget?: RunBudget | null;
  /** The saved logins the run signed in with (E37.4): the login's name and the site. Absent from an older console. */
  usedSavedLogins?: { itemName: string; origin: string }[];
  /** The saved cards the run paid with (E37.7): brand, last four, the merchant and the amounts. */
  usedSavedCards?: { brand: string | null; last4: string | null; merchant: string; currency: string; declaredAmount: string; confirmedAmount: string | null; mismatch: boolean }[];
}

/** A task drafted from a chat (`POST /chats/:id/task-draft`, and the `meta` of a `task_draft` message). */
export interface ChatTaskDraft {
  name: string;
  goal: string;
  profile: string;
  hostId: string | null;
  hostFallback: boolean;
  policyId: string | null;
  allowedDomains: string[];
  confirmRiskyActions: boolean;
  /** The chat's saved-logins switch (E37.3), carried over to the task. */
  useSavedLogins?: boolean;
  /** The chat's saved-details switch (E37.6), carried over to the task. */
  useSavedIdentity?: boolean;
  /** The chat's saved-cards switch (E37.7), carried over to the task. */
  useSavedCards?: boolean;
  /** The goal's parameters the draft proposes (#556); absent in drafts from before. */
  parameters?: TaskParameter[];
  /** The outputs the draft proposes (E39.5), from what the finished run reported; absent in drafts from before. */
  outputs?: TaskOutput[];
}

/** What the chat hands to `/tasks/new` in the router's state: the draft to review, and the chat to tell once it is saved. */
export interface ChatDraftState {
  chatDraft: ChatTaskDraft;
  chatId: string;
}

/** What a chat's run settings dialog edits. */
export type ChatSettings = Pick<Chat, 'profile' | 'hostId' | 'hostFallback' | 'policyId' | 'allowedDomains' | 'confirmRiskyActions'> & { useSavedLogins: boolean; useSavedIdentity: boolean; useSavedCards: boolean };

/** What became of an owner message passed to a run as guidance (#490): waiting for the agent's next step, read by it, or the run ended first. */
export type ChatGuidanceState = 'queued' | 'delivered' | 'missed';
export interface ChatGuidance {
  /** The `seq` of the owner message. */
  seq: number;
  state: ChatGuidanceState;
}
