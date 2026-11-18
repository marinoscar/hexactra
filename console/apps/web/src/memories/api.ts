import type { PlatformApiClient } from '@marinoscar/platform-web/core';

import type { ExportedFile } from '../policies/api';

export const MEMORY_KINDS = ['person', 'account', 'preference', 'fact'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** The group headings of the Memories page, in order. */
export const KIND_GROUP: Record<MemoryKind, string> = { person: 'People', account: 'Accounts', preference: 'Preferences', fact: 'Other' };
/** The kind in the add and edit dialog. */
export const KIND_LABEL: Record<MemoryKind, string> = { person: 'Person', account: 'Account', preference: 'Preference', fact: 'Other fact' };

/** A memory as `GET /api/memories` returns it (#551). */
export interface Memory {
  id: string;
  kind: MemoryKind;
  label: string;
  aliases: string[];
  attributes: Record<string, string>;
  note: string | null;
  status: 'active' | 'superseded' | 'archived';
  source: 'owner' | 'agent_proposed';
  sourceRunId: string | null;
  sourceConversationId: string | null;
  supersededById: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  history?: Memory[];
}

export interface MemoryInput {
  kind: MemoryKind;
  label: string;
  aliases: string[];
  attributes: Record<string, string>;
  note: string | null;
}

export function listMemories(api: PlatformApiClient, archived: boolean): Promise<Memory[]> {
  return api.get<Memory[]>(`/memories?status=${archived ? 'all' : 'active'}`);
}

export function getMemory(api: PlatformApiClient, id: string): Promise<Memory> {
  return api.get<Memory>(`/memories/${encodeURIComponent(id)}`);
}

export function createMemory(api: PlatformApiClient, input: MemoryInput): Promise<Memory> {
  return api.post<Memory>('/memories', input);
}

/**
 * Saves an edit: the label, aliases, note and kind go through `PATCH`; changed
 * values through `supersede`, which keeps the old version in the history.
 */
export async function saveMemory(api: PlatformApiClient, before: Memory, input: MemoryInput): Promise<Memory> {
  const valuesChanged = JSON.stringify(Object.entries(before.attributes)) !== JSON.stringify(Object.entries(input.attributes));
  if (valuesChanged) return api.post<Memory>(`/memories/${before.id}/supersede`, input);
  return api.patch<Memory>(`/memories/${before.id}`, { kind: input.kind, label: input.label, aliases: input.aliases, note: input.note });
}

export function setArchived(api: PlatformApiClient, id: string, archived: boolean): Promise<Memory> {
  return api.post<Memory>(`/memories/${id}/${archived ? 'archive' : 'unarchive'}`, {});
}

export function deleteMemory(api: PlatformApiClient, id: string): Promise<void> {
  return api.delete<void>(`/memories/${id}`);
}

/** The `hexactra.memories` file, with its name from `Content-Disposition`. */
export async function exportMemories(api: PlatformApiClient): Promise<ExportedFile> {
  if (!api.getBlob) throw new Error('This client cannot download files');
  const res = await api.getBlob('/memories/export');
  const disposition = res.headers.get('content-disposition') ?? '';
  const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? 'hexactra-memories.json';
  return { blob: res.blob, filename };
}

/**
 * How a value is shown in a list: a value with seven or more digits (a phone
 * or an account number) shows only its last four, the rest as typed.
 */
export function displayValue(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 7) return value;
  return `•••• ${digits.slice(-4)}`;
}

/** Lower-case words of a search, matched against the label, aliases and values. */
export function matchesSearch(m: Memory, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [m.label, ...m.aliases, ...Object.values(m.attributes)].join('\n').toLowerCase().includes(needle);
}
