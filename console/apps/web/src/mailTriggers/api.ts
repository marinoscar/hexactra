// The wire shapes and calls of email triggers (E39.8, #605). Nothing here carries a subject or a body: the API holds none, and the
// preview cuts the subject to 60 characters.
import type { PlatformApiClient } from '@marinoscar/platform-web/core';

export type MailTriggerStatus = 'ok' | 'needs_reconnect' | 'failing' | 'rate_limited' | 'connection_paused' | 'connection_removed';
export type EventOutcome = 'started' | 'skipped_limit' | 'skipped_unverified' | 'skipped_loop' | 'failed';

export interface TriggerMatch {
  from: string[];
  to?: string;
  subjectContains?: string;
  textContains?: string;
  hasAttachment?: boolean;
  label?: string;
}

/** How a task parameter gets its value from the message. */
export type InputSource = { fixed: string } | { header: 'subject' | 'from' | 'date' } | { capture: { source: 'subject' | 'text'; pattern: string; ignoreCase?: boolean } };
export type TriggerInputs = Record<string, InputSource>;

export interface MailTrigger {
  id: string;
  taskId: string;
  connectionId: string;
  connectionLabel: string | null;
  name: string;
  enabled: boolean;
  match: TriggerMatch;
  inputs: TriggerInputs | null;
  afterStart: string;
  pollSeconds: number;
  maxRunsPerDay: number;
  acceptUnverified: boolean;
  status: MailTriggerStatus;
  statusReason: string | null;
  lastCheckedAt: string | null;
  lastMatchedAt: string | null;
  runsToday: number;
  createdAt: string;
  updatedAt: string;
}

export interface TriggerBody {
  name?: string;
  connectionId?: string;
  match?: TriggerMatch;
  inputs?: TriggerInputs | null;
  afterStart?: string;
  pollSeconds?: number;
  maxRunsPerDay?: number;
  acceptUnverified?: boolean;
  enabled?: boolean;
}

export interface TriggerEvent {
  id: string;
  outcome: EventOutcome;
  reason: string | null;
  runId: string | null;
  messageAt: string | null;
  createdAt: string;
}

export interface PreviewMessage {
  date: string | null;
  subject: string;
  from: string | null;
  wouldStart: boolean;
  reason: 'before_enabled' | 'own_message' | 'sender_not_verified' | 'sender_not_checked' | null;
  senderVerified: 'pass' | 'fail' | 'unknown';
}
export interface TriggerPreview {
  messages: PreviewMessage[];
  note: string | null;
}

export const listTriggers = (api: PlatformApiClient, taskId: string) => api.get<MailTrigger[]>(`/tasks/${encodeURIComponent(taskId)}/mail-triggers`);
export const createTrigger = (api: PlatformApiClient, taskId: string, body: TriggerBody) => api.post<MailTrigger>(`/tasks/${encodeURIComponent(taskId)}/mail-triggers`, body);
export const updateTrigger = (api: PlatformApiClient, id: string, body: TriggerBody) => api.patch<MailTrigger>(`/mail-triggers/${encodeURIComponent(id)}`, body);
export const deleteTrigger = (api: PlatformApiClient, id: string) => api.delete<void>(`/mail-triggers/${encodeURIComponent(id)}`);
export const testTrigger = (api: PlatformApiClient, id: string) => api.post<TriggerPreview>(`/mail-triggers/${encodeURIComponent(id)}/test`, {});
export const listEvents = (api: PlatformApiClient, id: string, limit = 30) => api.get<TriggerEvent[]>(`/mail-triggers/${encodeURIComponent(id)}/events?limit=${limit}`);
