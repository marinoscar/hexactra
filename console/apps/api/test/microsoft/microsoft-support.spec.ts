// The small parts under the Microsoft provider (E39.4, #602): the ZIP reader and writer, the Word and Excel files, A1 ranges, time
// zones and file names. No network.
import { deflateRawSync } from 'node:zlib';

import { appendToDocx, buildDocx, buildXlsx, columnName, columnNumber, docxToText, escapeXml, unescapeXml } from '../../src/connections/microsoft/ooxml';
import { a1, driveName, instantOf, isoZ, odataString, parseA1, seg, sheetRef, wallTime } from '../../src/connections/microsoft/microsoft.support';
import { crc32, readZip, writeZip, ZipError } from '../../src/connections/microsoft/zip';
import { decodePageToken, encodePageToken, retryAfterMs } from '../../src/connections/microsoft/graph-client';

describe('zip', () => {
  it('writes and reads entries back, with a valid checksum, UTF-8 names and both stored and deflated data', () => {
    const entries = [
      { name: 'a.txt', data: Buffer.from('hello '.repeat(500)) },
      { name: 'dir/é.bin', data: Buffer.from([0, 1, 2, 3, 255]) },
      { name: 'empty', data: Buffer.alloc(0) },
    ];
    const zip = writeZip(entries);
    expect(readZip(zip)).toEqual(entries);
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(zip.length).toBeLessThan(500 * 6 + 200);
  });

  it('refuses what is not a zip, a truncated one and one with too many or too large entries', () => {
    expect(() => readZip(Buffer.from('plain text, not a zip file at all'))).toThrow(ZipError);
    const zip = writeZip([{ name: 'a', data: Buffer.from('x'.repeat(100)) }]);
    expect(() => readZip(zip.subarray(0, zip.length - 10))).toThrow();
    const many = writeZip(Array.from({ length: 2_001 }, (_v, i) => ({ name: `f${i}`, data: Buffer.from('x') })));
    expect(() => readZip(many)).toThrow(/too many/);
  });

  it('does not inflate an entry past the size it declares (a zip bomb)', () => {
    const zip = Buffer.from(writeZip([{ name: 'bomb.txt', data: Buffer.alloc(1000, 'a') }]));
    // Declare a size of 10 bytes in both headers while the data inflates to 1000.
    zip.writeUInt32LE(10, 22);
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(10, central + 24);
    expect(() => readZip(zip)).toThrow();
    const big = writeZip([{ name: 'x', data: Buffer.from(deflateRawSync(Buffer.alloc(10))) }]);
    expect(readZip(big)).toHaveLength(1);
  });
});

describe('Word files', () => {
  it('round-trips paragraphs, including empty lines, markup characters and non-ASCII text', () => {
    const text = 'Première ligne\nA & B <c> "d"\n\n\tindented\nlast ✓';
    expect(docxToText(buildDocx(text))).toBe(text);
    expect(docxToText(buildDocx('crlf\r\nline'))).toBe('crlf\nline');
  });

  it('drops characters XML cannot carry instead of corrupting the file', () => {
    expect(docxToText(buildDocx('a\u0000b\u0008c\ud800d'))).toBe('abcd');
    expect(escapeXml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    expect(unescapeXml('&lt;&amp;&gt;&quot;&apos;&#65;&#x42;&#0;')).toBe('<&>"\'AB');
  });

  it('extracts tabs and breaks from a document written by Word', () => {
    const xml = '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>a</w:t><w:tab/><w:t xml:space="preserve"> b</w:t><w:br/><w:t>c</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>d &amp; e</w:t></w:r></w:p></w:body></w:document>';
    expect(docxToText(writeZip([{ name: 'word/document.xml', data: Buffer.from(xml) }]))).toBe('a\t b\nc\n\nd & e');
  });

  it('appends at the end of the body and leaves every other part byte for byte', () => {
    const base = readZip(buildDocx('one'));
    const extra = { name: 'customXml/item1.xml', data: Buffer.from('<x/>') };
    const out = readZip(appendToDocx(writeZip([...base, extra]), 'two'));
    expect(out.find((e) => e.name === extra.name)!.data).toEqual(extra.data);
    expect(out.find((e) => e.name === '[Content_Types].xml')!.data).toEqual(base.find((e) => e.name === '[Content_Types].xml')!.data);
    expect(docxToText(appendToDocx(buildDocx('one'), 'two\nthree'))).toBe('one\ntwo\nthree');
  });

  it('is not fooled by a file that is not a Word document', () => {
    expect(() => docxToText(writeZip([{ name: 'x', data: Buffer.from('y') }]))).toThrow();
    expect(() => appendToDocx(writeZip([{ name: 'word/document.xml', data: Buffer.from('<no-body/>') }]), 'x')).toThrow();
  });
});

describe('Excel files', () => {
  it('writes a workbook with one sheet of text cells, escaped, that is a valid package', () => {
    const entries = readZip(buildXlsx([['Date', 'A & <B>', '=SUM(A1)']], 'Sheet1'));
    expect(entries.map((e) => e.name).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
    const sheet = entries.find((e) => e.name === 'xl/worksheets/sheet1.xml')!.data.toString();
    expect(sheet).toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve">Date</t></is></c>');
    expect(sheet).toContain('A &amp; &lt;B&gt;');
    // Written as text: never as a formula element.
    expect(sheet).not.toContain('<f>');
    expect(entries.find((e) => e.name === 'xl/workbook.xml')!.data.toString()).toContain('name="Sheet1"');
  });

  it('names columns and reads their numbers back', () => {
    expect([1, 26, 27, 52, 53, 702, 703].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA']);
    expect(['A', 'z', 'AA', 'AAA'].map(columnNumber)).toEqual([1, 26, 27, 703]);
  });
});

describe('ranges, zones, names and numbers', () => {
  it('parses A1 addresses with and without a sheet, and quotes sheet names that need it', () => {
    expect(parseA1('Sheet1!A2:C9')).toEqual({ sheet: 'Sheet1', startCol: 1, startRow: 2, endCol: 3, endRow: 9 });
    expect(parseA1("'My Tab'!B3")).toEqual({ sheet: 'My Tab', startCol: 2, startRow: 3, endCol: 2, endRow: 3 });
    expect(parseA1("'It''s'!A1:B2")!.sheet).toBe("It's");
    expect(parseA1('A1:D20')).toMatchObject({ sheet: null, endCol: 4, endRow: 20 });
    expect(parseA1('A:C')).toBeNull();
    expect(a1(1, 12, 3, 13)).toBe('A12:C13');
    expect(sheetRef('Sheet1')).toBe('Sheet1');
    expect(sheetRef("It's here")).toBe("'It''s here'");
  });

  it('writes a wall time in the zone of the event, across a daylight-saving change', () => {
    expect(wallTime('2026-03-02T14:30:00Z', undefined)).toBe('2026-03-02T14:30:00.0000000');
    expect(wallTime('2026-03-02T14:30:00Z', 'UTC')).toBe('2026-03-02T14:30:00.0000000');
    expect(wallTime('2026-03-02T14:30:00Z', 'America/New_York')).toBe('2026-03-02T09:30:00.0000000');
    expect(wallTime('2026-07-02T14:30:00Z', 'America/New_York')).toBe('2026-07-02T10:30:00.0000000');
    expect(wallTime('2026-03-02T14:30:00Z', 'Asia/Kolkata')).toBe('2026-03-02T20:00:00.0000000');
    expect(() => wallTime('2026-03-02T14:30:00Z', 'Nowhere/Land')).toThrow();
  });

  it('reads Graph date times back as instants, with or without an offset', () => {
    expect(instantOf('2026-03-02T14:30:00.0000000')).toBe('2026-03-02T14:30:00Z');
    expect(instantOf('2026-03-02T14:30:00Z')).toBe('2026-03-02T14:30:00Z');
    expect(instantOf('2026-03-02T09:30:00-05:00')).toBe('2026-03-02T14:30:00Z');
    expect(instantOf('garbage')).toBeNull();
    expect(instantOf(undefined)).toBeNull();
    expect(isoZ('2026-03-02T09:30:00.123-05:00')).toBe('2026-03-02T14:30:00Z');
  });

  it('makes a name OneDrive accepts, and encodes what goes in a path or a literal', () => {
    expect(driveName('a/b:c*d?e<f>g|h"i\\j')).toBe('a-b-c-d-e-f-g-h-i-j');
    expect(driveName('  report. ')).toBe('report');
    expect(driveName('///')).toBe('---');
    expect(driveName('', '.docx')).toBe('untitled.docx');
    expect(driveName('Plan', '.docx')).toBe('Plan.docx');
    expect(driveName('x'.repeat(400)).length).toBe(200);
    expect(seg("a b/c'd")).toBe('a%20b%2Fc%27d');
    expect(odataString("o'neil")).toBe("o''neil");
  });

  it('reads Retry-After as seconds or a date', () => {
    expect(retryAfterMs('7')).toBe(7000);
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs('Tue, 02 Mar 2026 10:00:10 GMT', Date.parse('2026-03-02T10:00:00Z'))).toBe(10_000);
    expect(retryAfterMs('Tue, 02 Mar 2026 09:00:00 GMT', Date.parse('2026-03-02T10:00:00Z'))).toBe(0);
    expect(retryAfterMs('soon')).toBeUndefined();
  });
});

describe('page tokens', () => {
  const base = 'https://graph.microsoft.com/v1.0';
  const token = (link: string) => encodePageToken(`${base}${link}`, base)!;

  it('keeps the next link as a path under the Graph base, and nothing else', () => {
    expect(encodePageToken(`${base}/me/messages?$skip=10`, base)).toEqual(expect.any(String));
    expect(encodePageToken('https://evil.example.test/me/messages?$skip=10', base)).toBeNull();
    expect(encodePageToken(undefined, base)).toBeNull();
    expect(decodePageToken(token('/me/messages?$skip=10'), '/me/messages?')).toBe('/me/messages?$skip=10');
  });

  it('reads the forms Graph may write a next link in as the user\'s own path, so a token never addresses someone else', () => {
    expect(decodePageToken(token("/users('abc-123')/messages?$skip=10"), '/me/messages?')).toBe('/me/messages?$skip=10');
    expect(decodePageToken(token('/users/abc-123/messages?$skip=10'), '/me/messages?')).toBe('/me/messages?$skip=10');
    expect(decodePageToken(token("/me/mailFolders('AAMk-1=')/messages?$skip=10"), '/me/mailFolders/AAMk-1=/messages?')).toBe('/me/mailFolders/AAMk-1=/messages?$skip=10');
    expect(decodePageToken(token("/users('x')/calendars('CAL-1')/calendarView?startDateTime=a"), '/me/calendars/CAL-1/calendarView?')).toBe('/me/calendars/CAL-1/calendarView?startDateTime=a');
    expect(decodePageToken(token("/drives/b!xyz/items/01ABC/children?$skiptoken=t"), '/me/drive/')).toBe('/me/drive/items/01ABC/children?$skiptoken=t');
    expect(decodePageToken(token("/drives/b!xyz/root/children?$skiptoken=t"), '/me/drive/')).toBe('/me/drive/root/children?$skiptoken=t');
  });

  it('refuses a token for another operation, a doubled slash, a line break or a backslash', () => {
    for (const bad of ['/me/drive/root/children?x=1', '//evil.example.test/me/messages?', '/me/messages?x=1\r\nHost: evil', '/me/messages?x=\\evil']) expect(() => decodePageToken(Buffer.from(bad).toString('base64url'), '/me/messages?')).toThrow();
    expect(() => decodePageToken('%%%', '/me/messages?')).toThrow();
  });
});
