// The file routes of a connection (E39.10, #607): browse an account's spreadsheets and folders, create a folder, make a picked file
// usable, and open Google's file picker. Everything goes through the provider-neutral documents capability, so the capability gate, the
// limits and the typed errors of E39.3 apply; a `CapabilityError` is turned into the `ConnectionError` code a client can read.
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { isCapabilityError, type CapabilityError, type FileInfo, type FileQuery } from './capabilities';
import { ConnectionApps } from './connection-apps.service';
import { ConnectionCapabilities } from './connection-capabilities.service';
import { ConnectionTokensService } from './connection-tokens.service';
import { CONNECTION_AUDIT, ConnectionEvents } from './connections.events';
import { ConnectionError, notFound } from './connections.errors';
import { isCapability } from './connections.constants';

export interface FilesPage {
  items: FileInfo[];
  nextPageToken: string | null;
}

/** The project number of a Google OAuth client id (`<number>-<random>.apps.googleusercontent.com`): what the picker calls the app id. */
export function googleProjectNumber(clientId: string | null | undefined): string | null {
  const m = /^(\d{6,20})-/.exec(clientId ?? '');
  return m ? m[1]! : null;
}

/** A capability failure as the error the HTTP filter renders (and a client reads by `code`). Never a provider message. */
export function connectionErrorOf(e: unknown, label?: string): unknown {
  if (!isCapabilityError(e)) return e;
  const c: CapabilityError = e;
  switch (c.code) {
    case 'CONNECTION_NOT_FOUND':
      return notFound();
    case 'CONNECTION_NEEDS_RECONNECT':
      return new ConnectionError('CONNECTION_NEEDS_RECONNECT', 'This connection must be connected again.', { label: c.details.label ?? label, ...(c.details.reason ? { reason: c.details.reason } : {}) });
    case 'CONNECTION_PAUSED':
      return new ConnectionError('CONNECTION_PAUSED', 'This connection is paused.', { label: c.details.label ?? label });
    case 'CAPABILITY_OFF':
      return new ConnectionError('CONNECTION_CAPABILITY_OFF', 'This is not switched on for the account.', { label: c.details.label ?? label, ...(c.details.capability ? { capability: c.details.capability } : {}) });
    case 'PERMISSION_MISSING':
      return new ConnectionError('CONNECTION_PERMISSION_MISSING', 'The provider did not grant the permission this needs.', { ...(c.details.capability ? { capability: c.details.capability } : {}), ...(c.details.reason ? { reason: c.details.reason } : {}) });
    case 'NOT_FOUND':
      return new ConnectionError('CONNECTION_FILE_NOT_FOUND', 'The file was not found.');
    case 'ADMIN_CONSENT_REQUIRED':
      return new ConnectionError('CONNECTION_UNAVAILABLE', 'An administrator of the account\'s organization has to approve this app first.', { reason: 'admin_consent_required' });
    default:
      return new ConnectionError('CONNECTION_UNAVAILABLE', 'The provider could not do it. Nothing was changed; try again.', { reason: c.code.toLowerCase() });
  }
}

@Injectable()
export class ConnectionFilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: ConnectionCapabilities,
    private readonly tokens: ConnectionTokensService,
    private readonly apps: ConnectionApps,
    private readonly events: ConnectionEvents,
  ) {}

  private docs(userId: string, connectionId: string) {
    return this.capabilities.documents({ connectionId, userId });
  }

  private async guard<T>(userId: string, connectionId: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (e) {
      throw connectionErrorOf(e, await this.labelOf(userId, connectionId));
    }
  }

  private async labelOf(userId: string, connectionId: string): Promise<string | undefined> {
    return (await this.prisma.connection.findFirst({ where: { id: connectionId, userId }, select: { label: true } }))?.label;
  }

  async list(userId: string, connectionId: string, q: { q?: string; type?: 'spreadsheet' | 'folder' | 'document' | 'any'; folderId?: string; pageToken?: string }): Promise<FilesPage> {
    const query: FileQuery = { ...(q.q ? { text: q.q } : {}), type: q.type ?? 'any', ...(q.folderId ? { folderId: q.folderId } : {}), ...(q.pageToken ? { pageToken: q.pageToken } : {}), pageSize: 25 };
    return this.guard(userId, connectionId, () => this.docs(userId, connectionId).searchFiles(query));
  }

  async get(userId: string, connectionId: string, fileId: string): Promise<FileInfo> {
    return this.guard(userId, connectionId, () => this.docs(userId, connectionId).getFile(fileId));
  }

  /** The server side of a pick: confirms the account can reach the file and returns its details. Nothing is stored. */
  async registerPicked(userId: string, connectionId: string, fileId: string): Promise<FileInfo> {
    const file = await this.guard(userId, connectionId, () => this.docs(userId, connectionId).registerPickedFile(fileId));
    await this.events.audit(userId, CONNECTION_AUDIT.filePicked, connectionId, { kind: file.kind });
    return file;
  }

  async createFolder(userId: string, connectionId: string, input: { name: string; parentId?: string }): Promise<FileInfo> {
    const folder = await this.guard(userId, connectionId, () => this.docs(userId, connectionId).createFolder({ name: input.name, ...(input.parentId ? { parentId: input.parentId } : {}) }));
    await this.events.audit(userId, CONNECTION_AUDIT.folderCreated, connectionId, {});
    return folder;
  }

  /**
   * What the browser needs to open Google's file picker: a short-lived access token, the project number and the administrator's picker key.
   * The one place a token leaves the server, so it is narrow: Google only, an active connection with the Documents switch on, no caching,
   * and an audit event (never the token). The picker lets the owner choose files the app may then use under the `drive.file` permission.
   */
  async pickerSession(userId: string, connectionId: string): Promise<{ accessToken: string; appId: string | null; apiKey: string | null; expiresAt: string | null }> {
    const row = await this.prisma.connection.findFirst({ where: { id: connectionId, userId } });
    if (!row) throw notFound();
    if (row.provider !== 'google') throw new ConnectionError('CONNECTION_PICKER_UNAVAILABLE', 'The file picker is Google\'s: use the file list for this account.', { reason: 'not_google' });
    if (!row.capabilities.some((c) => isCapability(c) && (c === 'docs_read' || c === 'docs_write'))) throw new ConnectionError('CONNECTION_PICKER_UNAVAILABLE', 'Switch Documents on for this account first.', { reason: 'no_documents', label: row.label });
    const accessToken = await this.tokens.getAccessToken(connectionId, userId);
    const google = (await this.apps.system()).google;
    const after = await this.prisma.connection.findFirst({ where: { id: connectionId, userId }, select: { accessExpiresAt: true } });
    await this.events.audit(userId, CONNECTION_AUDIT.pickerOpened, connectionId, { provider: 'google' });
    return { accessToken, appId: googleProjectNumber(google.clientId), apiKey: google.pickerApiKey, expiresAt: after?.accessExpiresAt?.toISOString() ?? null };
  }
}
