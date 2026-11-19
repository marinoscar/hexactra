// Google Drive, Docs and Sheets behind the neutral DocumentsCapability (E39.3, #601).
//
// What the permission model allows (decision record, E39.1): the only Drive permission is `drive.file`, which sees ONLY files the
// app created or the owner picked in the Google Picker (E39.10). So:
//   * `searchFiles`, `getFile`, uploads into a folder and `registerPickedFile` work on those files only;
//   * `readDocument`, `appendToDocument`, `readSheet` and `appendRows` go to the Docs and Sheets APIs, which accept a file id the
//     owner pasted (an id or a link) as long as the account itself may open that file;
//   * nothing here can list or search the rest of the owner's Drive. docs/connections.md says so in plain words.
//
// Rules of the issue that live here: sheet values are written RAW (a value starting with `=` is text, never a formula; there is no
// flag to change that); an append whose outcome is unknown is NOT retried and is returned as `ambiguous: true`.
import { randomBytes } from 'node:crypto';

import {
  CapabilityError,
  pageSizeOf,
  type AppendResult,
  type Cell,
  type CapabilityContext,
  type DocumentText,
  type DocumentsCapability,
  type FileInfo,
  type FileQuery,
  type NewDocument,
  type NewFolder,
  type NewSpreadsheet,
  type Page,
  type SheetRange,
  type SheetValues,
  type UploadInput,
} from '../capabilities';
import { GOOGLE } from './google.constants';
import { GoogleHttp, type TokenSource } from './google-http';

const MIME = {
  document: 'application/vnd.google-apps.document',
  spreadsheet: 'application/vnd.google-apps.spreadsheet',
  folder: 'application/vnd.google-apps.folder',
  pdf: 'application/pdf',
} as const;

const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,webViewLink,parents';

interface GFile {
  id: string;
  name?: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
  parents?: string[];
}

export function toFileInfo(f: GFile): FileInfo {
  const mimeType = f.mimeType ?? 'application/octet-stream';
  const kind = mimeType === MIME.document ? 'document' : mimeType === MIME.spreadsheet ? 'spreadsheet' : mimeType === MIME.folder ? 'folder' : mimeType === MIME.pdf ? 'pdf' : 'other';
  const size = f.size !== undefined ? Number(f.size) : NaN;
  return { id: f.id, name: f.name ?? '', kind, mimeType, size: Number.isFinite(size) ? size : null, modifiedAt: f.modifiedTime ?? null, webUrl: f.webViewLink ?? null, parentId: f.parents?.[0] ?? null };
}

/**
 * A file id from an id or a link the owner pasted (`.../document/d/<id>/edit`, `...?id=<id>`, `.../folders/<id>`). Anything that
 * is neither is returned unchanged for the provider to refuse.
 */
export function googleFileId(input: string): string {
  const v = input.trim();
  const m = /\/(?:d|folders)\/([A-Za-z0-9_-]{10,})/.exec(v) ?? /[?&]id=([A-Za-z0-9_-]{10,})/.exec(v);
  return m ? m[1]! : v;
}

/** Drive query strings: a value is a quoted string, with its backslashes and quotes escaped; it cannot add a clause. */
// eslint-disable-next-line no-control-regex
export const driveQuote = (v: string): string => `'${v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function buildDriveQuery(q: FileQuery): string {
  const clauses = ['trashed = false'];
  if (q.text?.trim()) clauses.push(`fullText contains ${driveQuote(q.text.trim())}`);
  if (q.type && q.type !== 'any') clauses.push(`mimeType = '${MIME[q.type]}'`);
  if (q.folderId) clauses.push(`${driveQuote(googleFileId(q.folderId))} in parents`);
  return clauses.join(' and ');
}

/** `'Tab name'!A1:D20`, `A1:D20` or `'Tab name'`: a tab name is quoted, so it cannot carry a range of its own. */
export function a1(sheet: string | undefined, range: string | undefined): string {
  const tab = sheet ? `'${sheet.replace(/'/g, "''")}'` : '';
  return tab && range ? `${tab}!${range}` : tab || range || 'A1';
}

interface GDocElement {
  paragraph?: { elements?: { textRun?: { content?: string } }[] };
  table?: { tableRows?: { tableCells?: { content?: GDocElement[] }[] }[] };
  tableOfContents?: { content?: GDocElement[] };
}

/** The text of a document's structure: paragraphs as their text, tables as tab-separated rows. */
export function flattenDocument(content: readonly GDocElement[] | undefined): string {
  let out = '';
  for (const el of content ?? []) {
    if (el.paragraph) out += (el.paragraph.elements ?? []).map((e) => e.textRun?.content ?? '').join('');
    else if (el.table) {
      for (const row of el.table.tableRows ?? []) out += (row.tableCells ?? []).map((c) => flattenDocument(c.content).replace(/\n+$/g, '').replace(/\n/g, ' ')).join('\t') + '\n';
    } else if (el.tableOfContents) out += flattenDocument(el.tableOfContents.content);
  }
  return out;
}

const SHEET_ROWS = 5000;

function cellOut(v: unknown): Cell {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return typeof v === 'number' && !Number.isFinite(v) ? null : v;
  return v === null || v === undefined ? null : String(v);
}

export class GoogleDocuments implements DocumentsCapability {
  constructor(
    private readonly ctx: CapabilityContext,
    private readonly http: GoogleHttp,
    private readonly tokens: TokenSource,
  ) {}

  private drive<T>(op: string, method: 'GET' | 'POST', path: string, o: { query?: Record<string, string | number | boolean | undefined>; json?: unknown; idempotent: boolean; accept?: number[] }) {
    return this.http.call<T>(this.tokens, this.ctx, { service: 'drive', op, method, url: `${GOOGLE.drive}/${path}`, query: { supportsAllDrives: true, ...o.query }, json: o.json, idempotent: o.idempotent, accept: o.accept });
  }

  async searchFiles(q: FileQuery): Promise<Page<FileInfo>> {
    const res = await this.drive<{ files?: GFile[]; nextPageToken?: string }>('files.list', 'GET', 'files', {
      query: { q: buildDriveQuery(q), pageSize: pageSizeOf(q), pageToken: q.pageToken, orderBy: 'modifiedTime desc', includeItemsFromAllDrives: false, fields: `files(${FILE_FIELDS}),nextPageToken` },
      idempotent: true,
    });
    return { items: (res.data?.files ?? []).map(toFileInfo), nextPageToken: res.data?.nextPageToken ?? null };
  }

  async getFile(id: string): Promise<FileInfo> {
    const res = await this.drive<GFile>('files.get', 'GET', `files/${encodeURIComponent(googleFileId(id))}`, { query: { fields: FILE_FIELDS }, idempotent: true });
    if (!res.data) throw new CapabilityError('PROVIDER_ERROR', { status: res.status, reason: 'EMPTY' });
    return toFileInfo(res.data);
  }

  async registerPickedFile(id: string): Promise<FileInfo> {
    try {
      return await this.getFile(id);
    } catch (e) {
      // With `drive.file`, a file the owner has not picked answers "not found": say both possibilities.
      if (e instanceof CapabilityError && e.code === 'NOT_FOUND') throw new CapabilityError('NOT_FOUND', { reason: 'NOT_PICKED_OR_MISSING', status: 404 });
      throw e;
    }
  }

  async readDocument(id: string): Promise<DocumentText> {
    const res = await this.http.call<{ body?: { content?: GDocElement[] } }>(this.tokens, this.ctx, {
      service: 'docs',
      op: 'documents.get',
      method: 'GET',
      url: `${GOOGLE.docs}/${encodeURIComponent(googleFileId(id))}`,
      query: { fields: 'body(content)' },
      idempotent: true,
      maxBytes: 16 * 1024 * 1024,
    });
    const text = flattenDocument(res.data?.body?.content);
    const limit = this.ctx.limits.bodyChars;
    return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false };
  }

  private async insertText(docId: string, text: string): Promise<void> {
    await this.http.call(this.tokens, this.ctx, {
      service: 'docs',
      op: 'documents.batchUpdate',
      method: 'POST',
      url: `${GOOGLE.docs}/${encodeURIComponent(docId)}:batchUpdate`,
      json: { requests: [{ insertText: { text, endOfSegmentLocation: {} } }] },
      idempotent: false,
    });
  }

  async createDocument(d: NewDocument): Promise<FileInfo> {
    const res = await this.drive<GFile>('files.create', 'POST', 'files', {
      query: { fields: FILE_FIELDS },
      json: { name: d.title, mimeType: MIME.document, ...(d.folderId ? { parents: [googleFileId(d.folderId)] } : {}) },
      idempotent: false,
    });
    if (!res.data) throw new CapabilityError('PROVIDER_ERROR', { status: res.status, reason: 'EMPTY', outcomeUnknown: true });
    if (d.text.length > 0) await this.insertText(res.data.id, d.text);
    return toFileInfo(res.data);
  }

  async appendToDocument(id: string, text: string): Promise<void> {
    await this.insertText(googleFileId(id), text);
  }

  async readSheet(id: string, range: SheetRange): Promise<SheetValues> {
    const cap = this.ctx.limits.sheetCells;
    const defaulted = !range.range;
    const rangeA1 = a1(range.sheet, range.range ?? `A1:ZZ${SHEET_ROWS}`);
    const res = await this.http.call<{ values?: unknown[][] }>(this.tokens, this.ctx, {
      service: 'sheets',
      op: 'values.get',
      method: 'GET',
      url: `${GOOGLE.sheets}/${encodeURIComponent(googleFileId(id))}/values/${encodeURIComponent(rangeA1)}`,
      query: { valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING', majorDimension: 'ROWS' },
      idempotent: true,
      maxBytes: 16 * 1024 * 1024,
    });
    const rows = res.data?.values ?? [];
    const values: Cell[][] = [];
    let cells = 0;
    let truncated = defaulted && rows.length >= SHEET_ROWS;
    for (const row of rows) {
      if (cells + row.length > cap) {
        const room = cap - cells;
        if (room > 0) values.push(row.slice(0, room).map(cellOut));
        truncated = true;
        break;
      }
      cells += row.length;
      values.push(row.map(cellOut));
    }
    return { values, truncated };
  }

  async appendRows(id: string, sheet: string | undefined, rows: Cell[][]): Promise<AppendResult> {
    try {
      const res = await this.http.call<{ updates?: { updatedRange?: string } }>(this.tokens, this.ctx, {
        service: 'sheets',
        op: 'values.append',
        method: 'POST',
        url: `${GOOGLE.sheets}/${encodeURIComponent(googleFileId(id))}/values/${encodeURIComponent(a1(sheet, 'A1'))}:append`,
        // RAW: what the caller wrote is what the cell holds. `=HYPERLINK(...)` stays text; there is no way to ask for a formula.
        query: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', includeValuesInResponse: false },
        json: { majorDimension: 'ROWS', values: rows },
        idempotent: false,
      });
      return { updatedRange: res.data?.updates?.updatedRange ?? null, ambiguous: false };
    } catch (e) {
      // The request may have been applied (a timeout, a reset, a 5xx): do NOT retry blindly, which could duplicate the rows.
      if (e instanceof CapabilityError && e.details.outcomeUnknown) return { updatedRange: null, ambiguous: true };
      throw e;
    }
  }

  async createSpreadsheet(s: NewSpreadsheet): Promise<FileInfo> {
    const res = await this.drive<GFile>('files.create', 'POST', 'files', {
      query: { fields: FILE_FIELDS },
      json: { name: s.title, mimeType: MIME.spreadsheet, ...(s.folderId ? { parents: [googleFileId(s.folderId)] } : {}) },
      idempotent: false,
    });
    if (!res.data) throw new CapabilityError('PROVIDER_ERROR', { status: res.status, reason: 'EMPTY', outcomeUnknown: true });
    if (s.headers && s.headers.length > 0) {
      await this.http.call(this.tokens, this.ctx, {
        service: 'sheets',
        op: 'values.update',
        method: 'PUT',
        url: `${GOOGLE.sheets}/${encodeURIComponent(res.data.id)}/values/A1`,
        query: { valueInputOption: 'RAW' },
        json: { majorDimension: 'ROWS', values: [s.headers] },
        idempotent: true, // the same cells set to the same values
      });
    }
    return toFileInfo(res.data);
  }

  async uploadFile(f: UploadInput): Promise<FileInfo> {
    const boundary = `hx_${randomBytes(12).toString('hex')}`;
    const meta = JSON.stringify({ name: f.name, ...(f.folderId ? { parents: [googleFileId(f.folderId)] } : {}) });
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      meta,
      `--${boundary}`,
      `Content-Type: ${f.contentType}`,
      'Content-Transfer-Encoding: base64',
      '',
      f.bytes.toString('base64'),
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const res = await this.http.call<GFile>(this.tokens, this.ctx, {
      service: 'drive',
      op: 'files.upload',
      method: 'POST',
      url: `${GOOGLE.driveUpload}/files`,
      query: { uploadType: 'multipart', supportsAllDrives: true, fields: FILE_FIELDS },
      raw: { contentType: `multipart/related; boundary=${boundary}`, body },
      idempotent: false,
      timeoutMs: 120_000,
    });
    if (!res.data) throw new CapabilityError('PROVIDER_ERROR', { status: res.status, reason: 'EMPTY', outcomeUnknown: true });
    return toFileInfo(res.data);
  }

  async createFolder(f: NewFolder): Promise<FileInfo> {
    const res = await this.drive<GFile>('files.create', 'POST', 'files', {
      query: { fields: FILE_FIELDS },
      json: { name: f.name, mimeType: MIME.folder, ...(f.parentId ? { parents: [googleFileId(f.parentId)] } : {}) },
      idempotent: false,
    });
    if (!res.data) throw new CapabilityError('PROVIDER_ERROR', { status: res.status, reason: 'EMPTY', outcomeUnknown: true });
    return toFileInfo(res.data);
  }
}
