// Reads a PDF with a real PDF library (unpdf, the pdf.js engine) for the
// report tests (#543). unpdf is ESM-only and Jest runs this suite as
// CommonJS, so the tests run this file in a child process
// (`test/helpers/pdf-read.ts`): the PDF on stdin, JSON on stdout.
import { extractText, getDocumentProxy, getMeta } from 'unpdf';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const data = new Uint8Array(Buffer.concat(chunks));

const pdf = await getDocumentProxy(data.slice());
const { totalPages, text } = await extractText(pdf, { mergePages: false });
const meta = await getMeta(pdf);
const sizes = [];
for (let i = 1; i <= totalPages; i++) {
  const page = await pdf.getPage(i);
  const [, , width, height] = page.view;
  sizes.push([Math.round(width * 100) / 100, Math.round(height * 100) / 100]);
}
const outline = ((await pdf.getOutline()) ?? []).map((o) => o.title);
process.stdout.write(JSON.stringify({ pages: totalPages, text, sizes, info: meta.info, outline }));
