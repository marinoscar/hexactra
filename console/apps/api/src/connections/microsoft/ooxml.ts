// The Word and Excel files of the Microsoft provider (E39.4, #602): a MINIMAL generator for `.docx` and `.xlsx` and a small text
// extractor and appender for `.docx`. Graph cannot edit a Word file in place the way the Google Docs API can, so a generated file is
// uploaded, a read converts the file to text here, and an append downloads the file, adds a paragraph and uploads a new version.
//
// Choice, recorded: a built-in writer of about 150 lines over `zip.ts` rather than a library (`docx`, `exceljs`), so the API image does
// not grow. What is generated is deliberately plain: paragraphs of text (Word) and a header row of text cells (Excel). Anything a
// person added to a file (styles, images, tables) is carried through an append untouched, because only `word/document.xml` changes.
import { readZip, writeZip, type ZipEntry } from './zip';

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// Characters XML 1.0 cannot carry (control characters other than tab, line feed and carriage return, lone surrogates).
// eslint-disable-next-line no-control-regex
const XML_ILLEGAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

export const escapeXml = (s: string): string => s.replace(XML_ILLEGAL, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

const paragraphXml = (line: string): string => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`;
const paragraphsOf = (text: string): string => text.replace(/\r\n?/g, '\n').split('\n').map(paragraphXml).join('');

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

export function buildDocx(text: string): Buffer {
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: Buffer.from(`${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`) },
    { name: '_rels/.rels', data: Buffer.from(`${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`) },
    { name: 'word/document.xml', data: Buffer.from(`${XML_HEAD}<w:document ${W_NS}><w:body>${paragraphsOf(text)}</w:body></w:document>`) },
  ];
  return writeZip(entries);
}

const documentEntry = (entries: ZipEntry[]): ZipEntry => {
  const e = entries.find((x) => x.name === 'word/document.xml');
  if (!e) throw new Error('not a Word document');
  return e;
};

/** The text of a `.docx`: one line per paragraph, tabs and line breaks kept. Tables and text boxes are flattened in reading order. */
export function docxToText(file: Buffer): string {
  const xml = documentEntry(readZip(file)).data.toString('utf8');
  const lines: string[] = [];
  for (const p of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g)) {
    let line = '';
    for (const t of p[0].matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)) line += t[0] === '<w:tab/>' ? '\t' : t[0] === '<w:br/>' ? '\n' : unescapeXml(t[1] ?? '');
    lines.push(line);
  }
  return lines.join('\n');
}

/** The `.docx` with the text added as new paragraphs at the end of the body (before the final section properties); every other part is carried through. */
export function appendToDocx(file: Buffer, text: string): Buffer {
  const entries = readZip(file);
  const doc = documentEntry(entries);
  const xml = doc.data.toString('utf8');
  const add = paragraphsOf(text);
  const sect = xml.lastIndexOf('<w:sectPr');
  const body = xml.lastIndexOf('</w:body>');
  if (body < 0) throw new Error('not a Word document');
  const at = sect >= 0 && sect < body ? sect : body;
  doc.data = Buffer.from(xml.slice(0, at) + add + xml.slice(at));
  return writeZip(entries);
}

// ---- Excel ----

export const columnName = (n: number): string => {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
};

export const columnNumber = (name: string): number => [...name.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

/** A workbook with one sheet; `rows` become text cells (the header row of `createSpreadsheet`). */
export function buildXlsx(rows: readonly (readonly string[])[], sheetName = 'Sheet1'): Buffer {
  const sheetRows = rows
    .map((row, r) => `<row r="${r + 1}">${row.map((v, c) => `<c r="${columnName(c + 1)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(v)}</t></is></c>`).join('')}</row>`)
    .join('');
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: Buffer.from(`${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`) },
    { name: '_rels/.rels', data: Buffer.from(`${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: 'xl/workbook.xml', data: Buffer.from(`${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(`${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`) },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(`${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`) },
  ];
  return writeZip(entries);
}
