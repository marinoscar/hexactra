// OneDrive, Word and Excel through Microsoft Graph (E39.4, #602): the `DocumentsCapability` for a Microsoft account.
//
// Files: OneDrive for everything (`/me/drive`), found by search or by folder, written by simple upload (under 4 MB) or an upload session.
// Spreadsheets: the Excel workbook API on the file (`/workbook/worksheets/.../range`, tables and `rows/add`). It is documented for
// OneDrive for Business and SharePoint; for personal OneDrive it is NOT confirmed, so the matrix marks `readSheet` and `appendRows` as
// unsupported for personal accounts until an experiment shows otherwise (capability-matrix.ts). Values are written as values: a string
// that Excel would read as a formula (it starts with `=`, `+`, `-` or `@`) is stored with a leading apostrophe, which Excel keeps as
// text. (That relies on Excel's text-prefix behaviour through the API: listed among the experiments in the decision record.)
// Word: Graph cannot edit a `.docx` in place. `createDocument` uploads a generated file, `readDocument` extracts the text here, and
// `appendToDocument` downloads the file, adds paragraphs, and uploads a new version with the file's eTag as a precondition (a change
// made in the meantime fails with CONFLICT instead of being overwritten).
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
import { GraphClient, decodePageToken, encodePageToken } from './graph-client';
import { DOCX_MIME, SIMPLE_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES, XLSX_MIME } from './microsoft.constants';
import { a1, assertSupported, driveName, instantOf, odataString, parseA1, seg, sheetRef } from './microsoft.support';
import { appendToDocx, buildDocx, buildXlsx, docxToText } from './ooxml';

type G = Record<string, unknown>;

const DRIVE_FIELDS = 'id,name,size,webUrl,lastModifiedDateTime,file,folder,parentReference,eTag';
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const TEXT_EXT = /\.(txt|md|csv|tsv|json|xml|log)$/i;
const SEARCH_OR_CHILDREN = /^\/me\/drive\/(?:root|items\/[^/?]+)\/(?:children|search\(q='[^']*'\))\?/;

function kindOf(item: G): FileInfo['kind'] {
  if (item.folder) return 'folder';
  const name = str(item.name).toLowerCase();
  const mime = str((item.file as G | undefined)?.mimeType).toLowerCase();
  if (name.endsWith('.pdf') || mime === 'application/pdf') return 'pdf';
  if (/\.(docx?|odt|rtf)$/.test(name) || mime === DOCX_MIME || mime === 'application/msword') return 'document';
  if (/\.(xlsx?|ods|csv)$/.test(name) || mime === XLSX_MIME || mime === 'application/vnd.ms-excel') return 'spreadsheet';
  return 'other';
}

export function mapDriveItem(item: G): FileInfo {
  const isFolder = Boolean(item.folder);
  return {
    id: str(item.id),
    name: str(item.name),
    kind: kindOf(item),
    mimeType: str((item.file as G | undefined)?.mimeType) || (isFolder ? 'application/vnd.microsoft.onedrive.folder' : 'application/octet-stream'),
    size: !isFolder && typeof item.size === 'number' && item.size >= 0 ? Math.floor(item.size) : null,
    modifiedAt: instantOf(item.lastModifiedDateTime),
    webUrl: str(item.webUrl) || null,
    parentId: str((item.parentReference as G | undefined)?.id) || null,
  };
}

/** Excel reads a string that begins like a formula as one: the apostrophe makes it text. Numbers, booleans and ordinary strings are untouched. */
export const protectCell = (c: Cell): string | number | boolean => (c === null ? '' : typeof c === 'string' && /^[=+\-@\t\r]/.test(c) ? `'${c}` : c);

const cellOut = (v: unknown): Cell => (v === '' || v === undefined || v === null ? null : typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' ? v : String(v));

export class MicrosoftDocuments implements DocumentsCapability {
  constructor(
    private readonly g: GraphClient,
    private readonly ctx: CapabilityContext,
  ) {}

  private item(id: string): string {
    return `/me/drive/items/${seg(id)}`;
  }

  private async fetchItem(id: string): Promise<G> {
    return (await this.g.json<G>(this.ctx, { op: 'files.get', method: 'GET', path: this.item(id), query: { $select: DRIVE_FIELDS }, capability: 'docs_read' })) as G;
  }

  async searchFiles(q: FileQuery): Promise<Page<FileInfo>> {
    const size = pageSizeOf(q);
    const text = q.text?.trim();
    const parent = q.folderId ? this.item(q.folderId) : '/me/drive/root';
    let path = text ? `${parent}/search(q='${seg(odataString(text))}')` : `${parent}/children`;
    let query: Record<string, string> | undefined = { $top: String(size), $select: DRIVE_FIELDS };
    if (q.pageToken) {
      path = decodePageToken(q.pageToken, '/me/drive/');
      if (!SEARCH_OR_CHILDREN.test(path)) throw new CapabilityError('INVALID_INPUT', { issues: ['pageToken'] });
      query = undefined;
    }
    const res = (await this.g.json<G>(this.ctx, { op: 'files.search', method: 'GET', path, query, capability: 'docs_read' })) ?? {};
    const want = q.type && q.type !== 'any' ? q.type : null;
    const items = ((Array.isArray(res.value) ? res.value : []) as G[]).map(mapDriveItem).filter((f) => !want || f.kind === want);
    return { items: items.slice(0, size), nextPageToken: encodePageToken(res['@odata.nextLink'], this.g.baseUrl) };
  }

  async getFile(id: string): Promise<FileInfo> {
    return mapDriveItem(await this.fetchItem(id));
  }

  /** Nothing to pick: `Files.Read` reaches the whole drive. This confirms the file can be reached. */
  registerPickedFile(id: string): Promise<FileInfo> {
    return this.getFile(id);
  }

  // ---- content ----

  private async download(item: G): Promise<Buffer> {
    if (kindOf(item) === 'folder') throw new CapabilityError('INVALID_INPUT', { issues: ['id'] });
    if (typeof item.size === 'number' && item.size > this.ctx.limits.attachmentBytes) throw new CapabilityError('TOO_LARGE', { reason: 'FILE_BYTES' });
    let r = await this.g.request(this.ctx, { op: 'files.content', method: 'GET', path: `${this.item(str(item.id))}/content`, accept: 'buffer', okStatuses: [302], capability: 'docs_read' });
    if (r.status === 302) {
      const location = r.headers.get('location') ?? '';
      // The pre-authenticated address is followed without the bearer token and only over https.
      if (!location.startsWith('https://')) throw new CapabilityError('PROVIDER_ERROR', { status: 502, reason: 'BAD_RESPONSE' });
      r = await this.g.request(this.ctx, { op: 'files.download', method: 'GET', path: '', absoluteUrl: location, accept: 'buffer' });
    }
    const bytes = r.buffer ?? Buffer.alloc(0);
    if (bytes.length > this.ctx.limits.attachmentBytes) throw new CapabilityError('TOO_LARGE', { reason: 'FILE_BYTES' });
    return bytes;
  }

  async readDocument(id: string): Promise<DocumentText> {
    const item = await this.fetchItem(id);
    const name = str(item.name);
    const bytes = await this.download(item);
    let text: string;
    if (/\.docx$/i.test(name)) {
      try {
        text = docxToText(bytes);
      } catch {
        throw new CapabilityError('NOT_SUPPORTED', { reason: 'FORMAT' });
      }
    } else if (TEXT_EXT.test(name) || str((item.file as G | undefined)?.mimeType).startsWith('text/')) {
      text = bytes.toString('utf8');
    } else {
      throw new CapabilityError('NOT_SUPPORTED', { reason: 'FORMAT' });
    }
    const limit = this.ctx.limits.bodyChars;
    return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false };
  }

  /** One file written under a folder: a simple upload when small, an upload session above 4 MB. A name clash keeps both (the new one is renamed). */
  private async put(name: string, bytes: Buffer, mime: string, folderId?: string): Promise<FileInfo> {
    const parent = folderId ? this.item(folderId) : '/me/drive/root';
    const target = `${parent}:/${seg(name)}:`;
    if (bytes.length <= SIMPLE_UPLOAD_BYTES) {
      const item = (await this.g.json<G>(this.ctx, { op: 'files.upload', method: 'PUT', path: `${target}/content`, query: { '@microsoft.graph.conflictBehavior': 'rename' }, body: bytes, contentType: mime, repeatable: false, capability: 'docs_write' })) as G;
      return mapDriveItem(item);
    }
    return this.session(`${target}/createUploadSession`, { item: { '@microsoft.graph.conflictBehavior': 'rename' } }, bytes);
  }

  private async session(path: string, json: unknown, bytes: Buffer, headers?: Record<string, string>): Promise<FileInfo> {
    const s = (await this.g.json<G>(this.ctx, { op: 'files.upload_session', method: 'POST', path, json, headers, capability: 'docs_write' })) as G;
    const uploadUrl = str(s.uploadUrl);
    if (!uploadUrl.startsWith('https://')) throw new CapabilityError('PROVIDER_ERROR', { status: 502, reason: 'BAD_RESPONSE' });
    let last: G | null = null;
    for (let at = 0; at < bytes.length; at += UPLOAD_CHUNK_BYTES) {
      const chunk = bytes.subarray(at, Math.min(bytes.length, at + UPLOAD_CHUNK_BYTES));
      const r = await this.g.request(this.ctx, { op: 'files.upload_chunk', method: 'PUT', path: '', absoluteUrl: uploadUrl, body: chunk, headers: { 'content-range': `bytes ${at}-${at + chunk.length - 1}/${bytes.length}` }, accept: 'json', repeatable: true });
      last = r.json as G | null;
    }
    if (!last || !str(last.id)) throw new CapabilityError('PROVIDER_ERROR', { status: 502, reason: 'BAD_RESPONSE' });
    return mapDriveItem(last);
  }

  createDocument(d: NewDocument): Promise<FileInfo> {
    return this.put(driveName(d.title, '.docx'), buildDocx(d.text), DOCX_MIME, d.folderId);
  }

  async appendToDocument(id: string, text: string): Promise<void> {
    const item = await this.fetchItem(id);
    if (!/\.docx$/i.test(str(item.name))) throw new CapabilityError('NOT_SUPPORTED', { reason: 'FORMAT' });
    const etag = str(item.eTag);
    // Without a version to check against, an append could overwrite someone else's edit: refuse rather than risk the document.
    if (!etag) throw new CapabilityError('PROVIDER_ERROR', { status: 502, reason: 'NO_ETAG' });
    const bytes = await this.download(item);
    let next: Buffer;
    try {
      next = appendToDocx(bytes, text);
    } catch {
      throw new CapabilityError('NOT_SUPPORTED', { reason: 'FORMAT' });
    }
    const precondition = { 'If-Match': etag };
    if (next.length <= SIMPLE_UPLOAD_BYTES) {
      await this.g.request(this.ctx, { op: 'files.replace', method: 'PUT', path: `${this.item(id)}/content`, body: next, contentType: DOCX_MIME, headers: precondition, accept: 'json', repeatable: false, capability: 'docs_write' });
      return;
    }
    await this.session(`${this.item(id)}/createUploadSession`, { item: { '@microsoft.graph.conflictBehavior': 'replace' } }, next, precondition);
  }

  // ---- spreadsheets ----

  private async firstSheet(id: string): Promise<string> {
    const r = (await this.g.json<G>(this.ctx, { op: 'sheet.sheets', method: 'GET', path: `${this.item(id)}/workbook/worksheets`, query: { $top: '1', $select: 'name' }, capability: 'docs_read' })) ?? {};
    const name = str(((Array.isArray(r.value) ? r.value : []) as G[])[0]?.name);
    if (!name) throw new CapabilityError('NOT_FOUND');
    return name;
  }

  async readSheet(id: string, range: SheetRange): Promise<SheetValues> {
    assertSupported(this.ctx, 'documents.readSheet');
    const ws = `${this.item(id)}/workbook/worksheets/${seg(range.sheet ?? (await this.firstSheet(id)))}`;
    const meta = (await this.g.json<G>(this.ctx, { op: 'sheet.used', method: 'GET', path: `${ws}/usedRange(valuesOnly=true)`, query: { $select: 'address,rowCount,columnCount' }, capability: 'docs_read' })) as G;
    const used = parseA1(str(meta.address));
    if (!used) return { values: [], truncated: false };
    // The cells to read: the requested range, or the used range; at most the cell limit (the rest is cut and marked).
    let want = { startCol: used.startCol, startRow: used.startRow, endCol: used.endCol, endRow: used.endRow };
    if (range.range) {
      const given = /^[A-Za-z]{1,3}\d/.test(range.range) ? parseA1(range.range) : null;
      if (given) want = { startCol: given.startCol, startRow: given.startRow, endCol: given.endCol, endRow: given.endRow };
      else {
        // A column span such as `A:C`: those columns over the used rows.
        const m = /^([A-Za-z]{1,3}):([A-Za-z]{1,3})$/.exec(range.range);
        const cols = m ? parseA1(`${m[1]}1:${m[2]}1`) : null;
        if (!cols) throw new CapabilityError('INVALID_INPUT', { issues: ['range'] });
        want = { startCol: cols.startCol, startRow: used.startRow, endCol: cols.endCol, endRow: used.endRow };
      }
    }
    const width = want.endCol - want.startCol + 1;
    const room = Math.max(1, Math.floor(this.ctx.limits.sheetCells / width));
    const rows = want.endRow - want.startRow + 1;
    const truncated = rows > room;
    const endRow = truncated ? want.startRow + room - 1 : want.endRow;
    const r = (await this.g.json<G>(this.ctx, { op: 'sheet.read', method: 'GET', path: `${ws}/range(address='${odataString(a1(want.startCol, want.startRow, want.endCol, endRow))}')`, query: { $select: 'values' }, capability: 'docs_read' })) as G;
    const values = (Array.isArray(r.values) ? (r.values as unknown[][]) : []).map((row) => (Array.isArray(row) ? row.map(cellOut) : []));
    const onlyEmpty = values.length === 1 && values[0]!.length === 1 && values[0]![0] === null;
    return { values: onlyEmpty ? [] : values, truncated };
  }

  async appendRows(id: string, sheet: string | undefined, rows: Cell[][]): Promise<AppendResult> {
    assertSupported(this.ctx, 'documents.appendRows');
    const sheetName = sheet ?? (await this.firstSheet(id));
    const ws = `${this.item(id)}/workbook/worksheets/${seg(sheetName)}`;
    const tables = (await this.g.json<G>(this.ctx, { op: 'sheet.tables', method: 'GET', path: `${ws}/tables`, query: { $select: 'id,name', $top: '50' }, capability: 'docs_write' })) ?? {};
    const table = ((Array.isArray(tables.value) ? tables.value : []) as G[])[0];
    const ambiguous = (e: unknown): boolean => e instanceof CapabilityError && e.code === 'PROVIDER_ERROR' && (e.details.outcomeUnknown === true || e.details.status === 0 || (e.details.status ?? 0) >= 500);

    if (table) {
      const tableId = str(table.id);
      const cols = (await this.g.json<G>(this.ctx, { op: 'sheet.columns', method: 'GET', path: `${ws}/tables/${seg(tableId)}/columns`, query: { $select: 'id' }, capability: 'docs_write' })) ?? {};
      const n = Array.isArray(cols.value) ? cols.value.length : 0;
      if (rows.some((r) => r.length > n)) throw new CapabilityError('INVALID_INPUT', { issues: ['rows'] });
      const values = rows.map((r) => [...r.map(protectCell), ...Array.from({ length: n - r.length }, () => '')]);
      try {
        await this.g.request(this.ctx, { op: 'sheet.table_add', method: 'POST', path: `${ws}/tables/${seg(tableId)}/rows/add`, json: { index: null, values }, accept: 'json', repeatable: false, capability: 'docs_write' });
      } catch (e) {
        if (ambiguous(e)) return { updatedRange: null, ambiguous: true };
        throw e;
      }
      // Where the rows landed: the last rows of the table body.
      const body = await this.g.request(this.ctx, { op: 'sheet.table_body', method: 'GET', path: `${ws}/tables/${seg(tableId)}/dataBodyRange`, query: { $select: 'address' }, accept: 'json', capability: 'docs_write' }).catch(() => null);
      const at = body ? parseA1(str((body.json as G | null)?.address)) : null;
      return { updatedRange: at ? `${sheetRef(sheetName)}!${a1(at.startCol, Math.max(at.startRow, at.endRow - values.length + 1), at.endCol, at.endRow)}` : null, ambiguous: false };
    }

    const meta = (await this.g.json<G>(this.ctx, { op: 'sheet.used', method: 'GET', path: `${ws}/usedRange(valuesOnly=true)`, query: { $select: 'address' }, capability: 'docs_write' })) as G;
    const used = parseA1(str(meta.address));
    let empty = !used;
    if (used && used.startCol === used.endCol && used.startRow === used.endRow) {
      const cell = (await this.g.json<G>(this.ctx, { op: 'sheet.cell', method: 'GET', path: `${ws}/range(address='${a1(used.startCol, used.startRow, used.startCol, used.startRow)}')`, query: { $select: 'values' }, capability: 'docs_write' })) as G;
      empty = cellOut(((cell.values as unknown[][] | undefined) ?? [[]])[0]?.[0]) === null;
    }
    const width = Math.max(...rows.map((r) => r.length));
    const startCol = empty || !used ? 1 : used.startCol;
    const startRow = empty || !used ? 1 : used.endRow + 1;
    const address = a1(startCol, startRow, startCol + width - 1, startRow + rows.length - 1);
    const values = rows.map((r) => [...r.map(protectCell), ...Array.from({ length: width - r.length }, () => '')]);
    try {
      // The same cells written twice end the same: this one may be repeated.
      await this.g.request(this.ctx, { op: 'sheet.write', method: 'PATCH', path: `${ws}/range(address='${address}')`, json: { values }, accept: 'json', repeatable: true, capability: 'docs_write' });
    } catch (e) {
      if (ambiguous(e)) return { updatedRange: null, ambiguous: true };
      throw e;
    }
    return { updatedRange: `${sheetRef(sheetName)}!${address}`, ambiguous: false };
  }

  createSpreadsheet(s: NewSpreadsheet): Promise<FileInfo> {
    return this.put(driveName(s.title, '.xlsx'), buildXlsx(s.headers && s.headers.length > 0 ? [s.headers] : []), XLSX_MIME, s.folderId);
  }

  uploadFile(f: UploadInput): Promise<FileInfo> {
    return this.put(driveName(f.name), f.bytes, f.contentType, f.folderId);
  }

  async createFolder(f: NewFolder): Promise<FileInfo> {
    const parent = f.parentId ? this.item(f.parentId) : '/me/drive/root';
    const item = (await this.g.json<G>(this.ctx, { op: 'files.mkdir', method: 'POST', path: `${parent}/children`, json: { name: driveName(f.name), folder: {}, '@microsoft.graph.conflictBehavior': 'rename' }, repeatable: false, capability: 'docs_write' })) as G;
    return mapDriveItem(item);
  }
}
