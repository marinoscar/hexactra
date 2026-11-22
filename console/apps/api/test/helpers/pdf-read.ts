// A PDF as a reader sees it (#543): pages, text per page, page sizes, the
// document info and the outline, read by pdf.js (unpdf) in a child process.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export interface ReadPdf {
  pages: number;
  /** The text of each page. */
  text: string[];
  /** [width, height] of each page, in points. */
  sizes: [number, number][];
  info: Record<string, unknown>;
  outline: string[];
}

export function readPdf(pdf: Buffer): ReadPdf {
  const out = execFileSync(process.execPath, [join(__dirname, 'pdf-read.mjs')], { input: pdf, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out.toString('utf8')) as ReadPdf;
}

/** How many image XObjects the file holds (pdfkit writes object dictionaries uncompressed). */
export function imageObjects(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Subtype \/Image/g) ?? []).length;
}

/** The URIs of the file's link annotations, in order (pdfkit writes annotation dictionaries uncompressed). */
export function linkUris(pdf: Buffer): string[] {
  return [...pdf.toString('latin1').matchAll(/\/URI \(((?:\\.|[^\\)])*)\)/g)].map((m) => m[1]!.replace(/\\(.)/g, '$1'));
}
