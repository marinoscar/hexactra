// OneDrive, Word and Excel through the fake Graph (E39.4, #602): search and read, uploads, a Word append with an eTag precondition,
// and the Excel workbook calls (table, no table, raw values, the personal-account limit).
import { CapabilityError } from '../../src/connections/capabilities';
import { FakeGraph } from '../../src/connections/microsoft/testing/fake-graph';
import { protectCell } from '../../src/connections/microsoft/microsoft.documents';
import { buildDocx } from '../../src/connections/microsoft/ooxml';
import { readZip, writeZip } from '../../src/connections/microsoft/zip';
import { randomBytes } from 'node:crypto';
import { createHarness } from './harness';

const fail = async (p: Promise<unknown>): Promise<CapabilityError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof CapabilityError) return e;
    throw e;
  }
  throw new Error('expected a failure');
};
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof CapabilityError ? e.code : `other:${(e as Error).name}`;
  }
};

function setup(kind: 'work' | 'personal' = 'work') {
  const h = createHarness();
  const a = h.addAccount({ email: 'person-a@example.test', kind });
  const c = h.connect(a);
  const docs = (signal?: AbortSignal) => h.hub.documents(c.ctx(signal));
  const graph = (f?: (r: { method: string; path: string }) => boolean) => h.fake.calls((r) => r.host === 'graph.microsoft.com' && (!f || f(r)));
  return { h, a, c, docs, graph };
}
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('files', () => {
  it('lists a folder and maps the kinds, sizes, times and parents', async () => {
    const { a, docs } = setup();
    const folder = a.addFile({ name: 'Reports', folder: true });
    a.addFile({ name: 'q1.docx', mimeType: DOCX, bytes: Buffer.alloc(120), parentId: folder.id });
    a.addFile({ name: 'q1.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: Buffer.alloc(5), parentId: folder.id });
    a.addFile({ name: 'q1.pdf', mimeType: 'application/pdf', bytes: Buffer.alloc(7), parentId: folder.id });
    a.addFile({ name: 'q1.png', mimeType: 'image/png', bytes: Buffer.alloc(9), parentId: folder.id });
    const page = await docs().searchFiles({ folderId: folder.id });
    expect(page.items.map((f) => [f.name, f.kind, f.size])).toEqual([['q1.docx', 'document', 120], ['q1.xlsx', 'spreadsheet', 5], ['q1.pdf', 'pdf', 7], ['q1.png', 'other', 9]]);
    expect(page.items[0]).toMatchObject({ parentId: folder.id, webUrl: expect.stringContaining('https://'), modifiedAt: expect.stringMatching(/Z$/), mimeType: DOCX });
    const top = await docs().searchFiles({ type: 'folder' });
    expect(top.items.map((f) => [f.name, f.kind, f.size])).toEqual([['Reports', 'folder', null]]);
  });

  it('searches by words in the name under the root or a folder, with quotes doubled, filters by kind and pages', async () => {
    const { a, docs, graph } = setup();
    const folder = a.addFile({ name: 'Plans', folder: true });
    for (let i = 0; i < 3; i++) a.addFile({ name: `O'Brien budget ${i}.xlsx`, parentId: folder.id });
    a.addFile({ name: "O'Brien budget.pdf", mimeType: 'application/pdf' });
    a.addFile({ name: 'other.docx' });
    const all = await docs().searchFiles({ text: "O'Brien budget" });
    expect(all.items).toHaveLength(4);
    expect(graph((r) => r.path.includes('/search('))[0]!.path).toBe("/me/drive/root/search(q='O''Brien budget')");
    expect((await docs().searchFiles({ text: "O'Brien budget", type: 'pdf' })).items.map((f) => f.name)).toEqual(["O'Brien budget.pdf"]);
    const p1 = await docs().searchFiles({ text: 'budget', folderId: folder.id, pageSize: 2 });
    expect(p1.items).toHaveLength(2);
    const p2 = await docs().searchFiles({ text: 'budget', folderId: folder.id, pageSize: 2, pageToken: p1.nextPageToken! });
    expect(p2.items).toHaveLength(1);
    expect(p2.nextPageToken).toBeNull();
    expect(graph((r) => r.path === `/me/drive/items/${folder.id}/search(q='budget')`).length).toBe(2);
  });

  it('keeps a page token on the drive listing it came from', async () => {
    const { docs } = setup();
    for (const bad of ['/me/messages?x=1', '/me/drive/items/x/content?y=1', '//evil.example.test/me/drive/root/children?x=1']) expect(await code(docs().searchFiles({ pageToken: Buffer.from(bad).toString('base64url') }))).toBe('INVALID_INPUT');
  });

  it('gets one file, reports a missing one as NOT_FOUND, and a picked file is just a file that can be reached (nothing to pick at Microsoft)', async () => {
    const { a, docs } = setup();
    const f = a.addFile({ name: 'a.txt', bytes: Buffer.from('x'), mimeType: 'text/plain' });
    expect(await docs().getFile(f.id)).toMatchObject({ id: f.id, name: 'a.txt', size: 1 });
    expect(await docs().registerPickedFile(f.id)).toMatchObject({ id: f.id });
    expect(await code(docs().getFile('missing'))).toBe('NOT_FOUND');
    expect(await code(docs().registerPickedFile('missing'))).toBe('NOT_FOUND');
  });

  it('creates folders under the root or a parent', async () => {
    const { a, docs } = setup();
    const top = await docs().createFolder({ name: 'Reports' });
    expect(top).toMatchObject({ name: 'Reports', kind: 'folder' });
    const sub = await docs().createFolder({ name: 'Q1: draft?', parentId: top.id });
    expect(sub).toMatchObject({ name: 'Q1- draft-', parentId: top.id });
    expect(a.drive.get(sub.id)!.folder).toBe(true);
  });
});

describe('uploads', () => {
  it('uploads a small file in one request, keeping both when the name is taken', async () => {
    const { a, docs, graph } = setup();
    a.addFile({ name: 'note.txt' });
    const f = await docs().uploadFile({ name: 'note.txt', contentType: 'text/plain', bytes: Buffer.from('hello') });
    expect(f.name).toBe('note 1.txt');
    expect(a.drive.get(f.id)!.bytes.toString()).toBe('hello');
    const req = graph((r) => r.method === 'PUT')[0] as unknown as { headers: Record<string, string>; query: Record<string, string> };
    expect(req.headers['content-type']).toBe('text/plain');
    expect(req.query['@microsoft.graph.conflictBehavior']).toBe('rename');
  });

  it('uploads into a folder, and makes a name OneDrive accepts from one it would not', async () => {
    const { a, docs } = setup();
    const folder = a.addFile({ name: 'Plans', folder: true });
    const f = await docs().uploadFile({ name: 'a/b:c*d?.txt ', contentType: 'text/plain', bytes: Buffer.from('x'), folderId: folder.id });
    expect(f.name).toBe('a-b-c-d-.txt');
    expect(f.parentId).toBe(folder.id);
  });

  it('uses an upload session above 4 MB, in chunks, and ends with the file', async () => {
    const { h, a, docs, graph } = setup();
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 10, 3);
    const f = await docs().uploadFile({ name: 'big.bin', contentType: 'application/octet-stream', bytes });
    expect(a.drive.get(f.id)!.bytes.equals(bytes)).toBe(true);
    expect(graph((r) => r.path.endsWith('createUploadSession'))).toHaveLength(1);
    expect(graph((r) => r.method === 'PUT')).toHaveLength(0);
    const chunks = h.fake.calls((r) => r.host === 'upload.fake.example.test');
    expect(chunks.length).toBe(2);
    expect(chunks.every((c) => c.headers.authorization === undefined)).toBe(true);
  });

  it('refuses a file over the limit before sending anything', async () => {
    const { h, docs } = setup();
    expect(await code(docs().uploadFile({ name: 'huge.bin', contentType: 'application/octet-stream', bytes: Buffer.alloc(10 * 1024 * 1024 + 1) }))).toBe('TOO_LARGE');
    expect(h.fake.requests).toHaveLength(0);
  });

  it('does not repeat an upload after a failure that leaves it unknown', async () => {
    const { h, docs } = setup();
    h.fake.failAfter((r) => r.method === 'PUT', 504);
    const e = await fail(docs().uploadFile({ name: 'a.txt', contentType: 'text/plain', bytes: Buffer.from('x') }));
    expect(e.details.outcomeUnknown).toBe(true);
    expect(h.fake.calls((r) => r.method === 'PUT')).toHaveLength(1);
  });
});

describe('Word documents', () => {
  it('creates a .docx of paragraphs that reads back as the same text', async () => {
    const { a, docs } = setup();
    const f = await docs().createDocument({ title: 'Minutes', text: 'First line\nSecond & <third>\n\nAfter blank' });
    expect(f).toMatchObject({ name: 'Minutes.docx', kind: 'document', mimeType: DOCX });
    expect(FakeGraph.docxText(a.drive.get(f.id)!)).toBe('First line\nSecond & <third>\n\nAfter blank');
    expect(await docs().readDocument(f.id)).toEqual({ text: 'First line\nSecond & <third>\n\nAfter blank', truncated: false });
  });

  it('does not double the extension and files it in a folder', async () => {
    const { a, docs } = setup();
    const folder = a.addFile({ name: 'Plans', folder: true });
    const f = await docs().createDocument({ title: 'Plan.DOCX', text: 'x', folderId: folder.id });
    expect(f).toMatchObject({ name: 'Plan.DOCX', parentId: folder.id });
  });

  it('reads the text of a .docx download, following the redirect without the bearer token, and cuts a long one', async () => {
    const { h, a, docs } = setup();
    const f = a.addFile({ name: 'long.docx', mimeType: DOCX, bytes: buildDocx('y'.repeat(60_000)) });
    const r = await docs().readDocument(f.id);
    expect(r.text).toHaveLength(50_000);
    expect(r.truncated).toBe(true);
    const dl = h.fake.calls((x) => x.host === 'download.fake.example.test');
    expect(dl).toHaveLength(1);
    expect(dl[0]!.headers.authorization).toBeUndefined();
  });

  it('reads plain-text files and says NOT_SUPPORTED for formats it cannot read, without downloading them', async () => {
    const { h, a, docs } = setup();
    const t = a.addFile({ name: 'n.md', mimeType: 'text/markdown', bytes: Buffer.from('# Title') });
    expect(await docs().readDocument(t.id)).toEqual({ text: '# Title', truncated: false });
    const pdf = a.addFile({ name: 'x.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF') });
    const broken = a.addFile({ name: 'broken.docx', mimeType: DOCX, bytes: Buffer.from('not a zip') });
    h.fake.requests.length = 0;
    expect(await code(docs().readDocument(pdf.id))).toBe('NOT_SUPPORTED');
    expect(await code(docs().readDocument(broken.id))).toBe('NOT_SUPPORTED');
    expect(await code(docs().readDocument(a.addFile({ name: 'huge.docx', bytes: Buffer.alloc(11 * 1024 * 1024) }).id))).toBe('TOO_LARGE');
  });

  it('appends paragraphs by downloading, adding and uploading a new version with the eTag as the precondition', async () => {
    const { a, docs, graph } = setup();
    const f = await docs().createDocument({ title: 'Log', text: 'one' });
    const item = a.drive.get(f.id)!;
    const before = item.version;
    await docs().appendToDocument(f.id, 'two\nthree');
    expect(FakeGraph.docxText(item)).toBe('one\ntwo\nthree');
    expect(item.version).toBe(before + 1);
    const put = graph((r) => r.method === 'PUT' && r.path === `/me/drive/items/${f.id}/content`)[0] as unknown as { headers: Record<string, string> };
    expect(put.headers['if-match']).toBe(`"etag-${f.id}-${before}"`);
  });

  it('keeps what the file already holds besides the text: only the document part changes', async () => {
    const { a, docs } = setup();
    const original = readZip(buildDocx('keep'));
    const file = a.addFile({ name: 'rich.docx', mimeType: DOCX, bytes: writeZip([...original, { name: 'word/media/logo.png', data: Buffer.from([1, 2, 3]) }, { name: 'word/styles.xml', data: Buffer.from('<styles/>') }]) });
    await docs().appendToDocument(file.id, 'added');
    const after = readZip(file.bytes);
    expect(after.find((e) => e.name === 'word/media/logo.png')!.data).toEqual(Buffer.from([1, 2, 3]));
    expect(after.find((e) => e.name === 'word/styles.xml')!.data.toString()).toBe('<styles/>');
    expect(FakeGraph.docxText(file)).toBe('keep\nadded');
  });

  it('puts a new paragraph before the final section properties', async () => {
    const { a, docs } = setup();
    const xml = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>a</w:t></w:r></w:p><w:sectPr><w:pgSz/></w:sectPr></w:body></w:document>';
    const file = a.addFile({ name: 's.docx', bytes: writeZip([{ name: 'word/document.xml', data: Buffer.from(xml) }]) });
    await docs().appendToDocument(file.id, 'b');
    const out = readZip(file.bytes)[0]!.data.toString();
    expect(out.indexOf('>b<')).toBeLessThan(out.indexOf('<w:sectPr'));
  });

  it('reports a concurrent edit as CONFLICT and leaves the file as the other person made it', async () => {
    const { a, docs, h } = setup();
    const f = await docs().createDocument({ title: 'Shared', text: 'original' });
    const item = a.drive.get(f.id)!;
    // Someone else saves between our download and our upload.
    const inner = h.fake.fetch;
    let edited = false;
    h.fake.fetch = (async (...args: Parameters<typeof fetch>) => {
      const url = String(args[0]);
      if (!edited && url.includes('download.fake.example.test')) {
        edited = true;
        item.bytes = buildDocx('original\ntheirs');
        item.version++;
      }
      return inner(...args);
    }) as typeof fetch;
    const e = await fail(docs().appendToDocument(f.id, 'mine'));
    expect(e.code).toBe('CONFLICT');
    expect(FakeGraph.docxText(item)).toBe('original\ntheirs');
  });

  it('a file that is not a .docx is not appended to, and a file without a version to check is refused rather than risked', async () => {
    const { a, docs, h } = setup();
    expect(await code(docs().appendToDocument(a.addFile({ name: 'x.pdf' }).id, 'x'))).toBe('NOT_SUPPORTED');
    const f = a.addFile({ name: 'y.docx', bytes: buildDocx('a') });
    h.fake.answer((r) => r.method === 'GET' && r.path === `/me/drive/items/${f.id}`, () => new Response(JSON.stringify({ id: f.id, name: 'y.docx', size: 10 }), { status: 200, headers: { 'content-type': 'application/json' } }));
    expect((await fail(docs().appendToDocument(f.id, 'x'))).details.reason).toBe('NO_ETAG');
    expect(FakeGraph.docxText(f)).toBe('a');
  });

  it('uses an upload session for a new version above 4 MB, with the same precondition', async () => {
    const { a, docs, graph } = setup();
    const f = a.addFile({ name: 'many.docx', mimeType: DOCX, bytes: buildDocx(randomBytes(5_200_000).toString('hex')) });
    expect(f.bytes.length).toBeGreaterThan(4 * 1024 * 1024);
    expect(f.bytes.length).toBeLessThan(10 * 1024 * 1024);
    const before = f.version;
    await docs().appendToDocument(f.id, 'tail '.repeat(200_000));
    const session = graph((r) => r.path === `/me/drive/items/${f.id}/createUploadSession`);
    expect(session).toHaveLength(1);
    expect((session[0] as unknown as { headers: Record<string, string> }).headers['if-match']).toBe(`"etag-${f.id}-${before}"`);
    expect(FakeGraph.docxText(f).endsWith('tail tail tail ')).toBe(true);
    expect(f.version).toBe(before + 1);
  });
});

describe('spreadsheets', () => {
  it('creates an .xlsx with a header row of text and reads it back', async () => {
    const { a, docs } = setup();
    const f = await docs().createSpreadsheet({ title: 'Expenses', headers: ['Date', 'Amount', '=HEADER()'] });
    expect(f).toMatchObject({ name: 'Expenses.xlsx', kind: 'spreadsheet' });
    FakeGraph.registerXlsx(a, a.drive.get(f.id)!);
    expect(await docs().readSheet(f.id, {})).toEqual({ values: [['Date', 'Amount', '=HEADER()']], truncated: false });
    expect(a.sheet(f.id, 'Sheet1').formulas.size).toBe(0);
  });

  it('reads the used range, a given range, a column span and a named tab, as values with empty cells as null', async () => {
    const { a, docs } = setup();
    const f = a.addWorkbook('book.xlsx', { Sheet1: { rows: [['name', 'qty'], ['apple', 3], ['pear', ''], ['fig', 9]] }, Other: { rows: [['x']] } });
    expect(await docs().readSheet(f.id, {})).toEqual({ values: [['name', 'qty'], ['apple', 3], ['pear', null], ['fig', 9]], truncated: false });
    expect(await docs().readSheet(f.id, { range: 'A2:B3' })).toEqual({ values: [['apple', 3], ['pear', null]], truncated: false });
    expect((await docs().readSheet(f.id, { range: 'B:B' })).values).toEqual([['qty'], [3], [null], [9]]);
    expect(await docs().readSheet(f.id, { sheet: 'Other' })).toEqual({ values: [['x']], truncated: false });
    expect(await code(docs().readSheet(f.id, { sheet: 'Missing' }))).toBe('NOT_FOUND');
    const empty = a.addWorkbook('empty.xlsx', { Sheet1: { rows: [] } });
    expect(await docs().readSheet(empty.id, {})).toEqual({ values: [], truncated: false });
  });

  it('stops at the cell limit and says so, asking Graph only for the rows that fit', async () => {
    const { a, docs, graph } = setup();
    const rows = Array.from({ length: 4000 }, (_v, i) => [i, i + 1]);
    const f = a.addWorkbook('big.xlsx', { Sheet1: { rows } });
    const r = await docs().readSheet(f.id, {});
    expect(r.truncated).toBe(true);
    expect(r.values.length * 2).toBeLessThanOrEqual(5000);
    expect(r.values).toHaveLength(2500);
    expect(graph((x) => x.path.includes("range(address='A1:B2500')"))).toHaveLength(1);
  });

  describe('appendRows', () => {
    it('adds to the first table of the sheet and says where the rows landed', async () => {
      const { a, docs } = setup();
      const f = a.addWorkbook('t.xlsx', { Sheet1: { rows: [['name', 'qty'], ['apple', 3]], table: true } });
      const r = await docs().appendRows(f.id, undefined, [['pear', 4], ['fig', 5]]);
      expect(r).toEqual({ updatedRange: 'Sheet1!A3:B4', ambiguous: false });
      expect((await docs().readSheet(f.id, {})).values).toEqual([['name', 'qty'], ['apple', 3], ['pear', 4], ['fig', 5]]);
      expect(a.sheet(f.id, 'Sheet1').tables[0]!.bodyRows).toBe(3);
    });

    it('pads a short row to the table width and refuses a row that is wider', async () => {
      const { a, docs } = setup();
      const f = a.addWorkbook('t.xlsx', { Sheet1: { rows: [['a', 'b', 'c']], table: true } });
      await docs().appendRows(f.id, 'Sheet1', [['x']]);
      expect((await docs().readSheet(f.id, {})).values).toEqual([['a', 'b', 'c'], ['x', null, null]]);
      expect(await code(docs().appendRows(f.id, 'Sheet1', [['1', '2', '3', '4']]))).toBe('INVALID_INPUT');
    });

    it('without a table, writes below the used range starting at its first column', async () => {
      const { a, docs } = setup();
      const f = a.addWorkbook('p.xlsx', { Sheet1: { rows: [['name', 'qty'], ['apple', 3]] } });
      const r = await docs().appendRows(f.id, 'Sheet1', [['pear', 4], ['fig']]);
      expect(r).toEqual({ updatedRange: 'Sheet1!A3:B4', ambiguous: false });
      expect((await docs().readSheet(f.id, {})).values).toEqual([['name', 'qty'], ['apple', 3], ['pear', 4], ['fig', null]]);
    });

    it('writes at A1 on an empty sheet, and quotes the sheet name in the address when it needs it', async () => {
      const { a, docs } = setup();
      const f = a.addWorkbook('e.xlsx', { 'My Tab': { rows: [] } });
      expect(await docs().appendRows(f.id, 'My Tab', [['first', 1]])).toEqual({ updatedRange: "'My Tab'!A1:B1", ambiguous: false });
      expect((await docs().readSheet(f.id, { sheet: 'My Tab' })).values).toEqual([['first', 1]]);
    });

    it('writes values, never formulas: a cell that starts like a formula arrives as text, with a table or without', async () => {
      const { a, docs } = setup();
      const dangerous = ['=HYPERLINK("https://evil.example.test","x")', '+1+1', '-2+3', '@SUM(A1)', '=1+1', '\t=1'];
      const plain = a.addWorkbook('n.xlsx', { Sheet1: { rows: [['v']] } });
      const table = a.addWorkbook('t.xlsx', { Sheet1: { rows: [['v']], table: true } });
      for (const f of [plain, table]) {
        await docs().appendRows(f.id, 'Sheet1', dangerous.map((d) => [d]));
        const sheet = a.sheet(f.id, 'Sheet1');
        expect(sheet.formulas.size).toBe(0);
        expect((await docs().readSheet(f.id, {})).values.slice(1).map((r) => r[0])).toEqual(dangerous);
      }
      // Numbers, booleans and ordinary text are untouched; an empty cell is empty.
      expect([protectCell(5), protectCell(true), protectCell('hello'), protectCell(null), protectCell('a=b'), protectCell('=x')]).toEqual([5, true, 'hello', '', 'a=b', "'=x"]);
    });

    it('is not repeated after a failure that leaves it unknown: the result says so', async () => {
      const { h, a, docs } = setup();
      const f = a.addWorkbook('t.xlsx', { Sheet1: { rows: [['a']], table: true } });
      h.fake.failAfter((r) => r.path.endsWith('/rows/add'), 504);
      expect(await docs().appendRows(f.id, 'Sheet1', [['x']])).toEqual({ updatedRange: null, ambiguous: true });
      expect(h.fake.calls((r) => r.path.endsWith('/rows/add'))).toHaveLength(1);
      expect(a.sheet(f.id, 'Sheet1').tables[0]!.bodyRows).toBe(1);
    });

    it('writing to a range may be repeated (the same cells end the same)', async () => {
      const { h, a, docs } = setup();
      const f = a.addWorkbook('p.xlsx', { Sheet1: { rows: [['a']] } });
      h.fake.failAfter((r) => r.method === 'PATCH', 504);
      expect(await docs().appendRows(f.id, 'Sheet1', [['x']])).toEqual({ updatedRange: 'Sheet1!A2:A2', ambiguous: false });
      expect((await docs().readSheet(f.id, {})).values).toEqual([['a'], ['x']]);
    });

    it('a missing sheet is NOT_FOUND and a failure that is certain is an error', async () => {
      const { h, a, docs } = setup();
      const f = a.addWorkbook('p.xlsx', { Sheet1: { rows: [['a']] } });
      expect(await code(docs().appendRows(f.id, 'Nope', [['x']]))).toBe('NOT_FOUND');
      h.fake.fail((r) => r.method === 'PATCH', 400, 'InvalidArgument');
      expect(await code(docs().appendRows(f.id, 'Sheet1', [['x']]))).toBe('PROVIDER_ERROR');
    });
  });
});

describe('personal accounts: what the matrix says', () => {
  it('reading and appending to a workbook is not supported on a personal account, and no request is made', async () => {
    const { h, a, docs } = setup('personal');
    const f = a.addWorkbook('p.xlsx', { Sheet1: { rows: [['a']] } });
    h.fake.requests.length = 0;
    expect(await code(docs().readSheet(f.id, {}))).toBe('NOT_SUPPORTED');
    expect(await code(docs().appendRows(f.id, 'Sheet1', [['x']]))).toBe('NOT_SUPPORTED');
    expect(h.fake.requests).toHaveLength(0);
  });

  it('files, Word documents and creating a spreadsheet work as on a work account', async () => {
    const { a, docs } = setup('personal');
    const d = await docs().createDocument({ title: 'Note', text: 'one' });
    await docs().appendToDocument(d.id, 'two');
    expect(FakeGraph.docxText(a.drive.get(d.id)!)).toBe('one\ntwo');
    expect(await docs().createSpreadsheet({ title: 'S', headers: ['a'] })).toMatchObject({ kind: 'spreadsheet' });
    expect((await docs().searchFiles({ text: 'Note' })).items).toHaveLength(1);
  });
});
