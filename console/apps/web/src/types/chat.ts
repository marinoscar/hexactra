// A chat and its messages, as the API returns them (`chatResponseSchema` and
// friends in apps/api/src/openapi/chat.responses.ts) and as the chat's event
// stream sends them (apps/api/src/chat/chat-stream.controller.ts).
import type { RunActivity } from '../components/RunActivity';
import type { RunStatus, RunStopReason } from './runs';

export type ChatStatus = 'active' | 'archived';
export type ChatMessageRole = 'user' | 'assistant' | 'system';
export type ChatMessageKind = 'text' | 'clarify' | 'run' | 'result' | 'task_draft';

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
  status: Extract<RunStatus, 'queued' | 'running' | 'waiting_human'>;
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
  hostId: string | null;
  costUsd: number;
  costKnown: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** What a chat's run settings dialog edits. */
export type ChatSettings = Pick<Chat, 'profile' | 'hostId' | 'hostFallback' | 'policyId' | 'allowedDomains' | 'confirmRiskyActions'>;
