// The file routes of a connection (E39.10, #607): what the spreadsheet and folder choosers of the delivery editor call, and the
// activity of an account. Names are data; nothing here is a token except the picker session, which the picker uses once.
import type { PlatformApiClient } from '@marinoscar/platform-web/core';

export type FileKind = 'document' | 'spreadsheet' | 'folder' | 'pdf' | 'other';

export interface ConnectionFile {
  id: string;
  name: string;
  kind: FileKind;
  mimeType: string;
  size: number | null;
  modifiedAt: string | null;
  /** Where the owner can open it at the provider. */
  webUrl: string | null;
  parentId: string | null;
}

export interface FilesPage {
  items: ConnectionFile[];
  nextPageToken: string | null;
}

export interface PickerSession {
  accessToken: string;
  appId: string | null;
  apiKey: string | null;
  expiresAt: string | null;
}

export interface ConnectionActivityItem {
  kind: 'tool' | 'delivery';
  operation: string;
  ok: boolean;
  at: string;
  runId: string | null;
}

export const listFiles = (api: PlatformApiClient, connectionId: string, q: { q?: string; type?: 'spreadsheet' | 'folder' | 'document' | 'any'; folderId?: string; pageToken?: string } = {}) => {
  const params = new URLSearchParams();
  if (q.q) params.set('q', q.q);
  if (q.type) params.set('type', q.type);
  if (q.folderId) params.set('folderId', q.folderId);
  if (q.pageToken) params.set('pageToken', q.pageToken);
  const query = params.toString();
  return api.get<FilesPage>(`/connections/${connectionId}/files${query ? `?${query}` : ''}`);
};
export const getFile = (api: PlatformApiClient, connectionId: string, fileId: string) => api.get<ConnectionFile>(`/connections/${connectionId}/files/${encodeURIComponent(fileId)}`);
export const registerPickedFile = (api: PlatformApiClient, connectionId: string, fileId: string) => api.post<ConnectionFile>(`/connections/${connectionId}/files/picked`, { fileId });
export const createFolder = (api: PlatformApiClient, connectionId: string, body: { name: string; parentId?: string }) => api.post<ConnectionFile>(`/connections/${connectionId}/folders`, body);
export const openPicker = (api: PlatformApiClient, connectionId: string) => api.post<PickerSession>(`/connections/${connectionId}/picker`, {});
export const connectionActivity = (api: PlatformApiClient, connectionId: string) => api.get<{ items: ConnectionActivityItem[] }>(`/connections/${connectionId}/activity`);

/** A Google spreadsheet's or document's id from its address (`https://docs.google.com/spreadsheets/d/<id>/edit`), or null. */
export function fileIdFromLink(text: string): string | null {
  const t = text.trim();
  const m = /^https:\/\/(?:docs|drive)\.google\.com\/(?:spreadsheets|document|file|drive\/folders)\/(?:u\/\d+\/)?(?:d\/|folders\/)?([A-Za-z0-9_-]{10,})/.exec(t);
  if (m) return m[1]!;
  return /^[A-Za-z0-9_-]{25,}$/.test(t) ? t : null;
}
