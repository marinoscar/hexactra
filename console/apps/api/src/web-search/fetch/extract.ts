// What `web_fetch` reads out of an answer (E50.6, #976): the readable text of a public page, never its code.
//
//   text/html, application/xhtml+xml  the main content (`<main>`, else the one `<article>`, else `<body>`): headings and list items
//                                     as plain lines, a link as `text (url)`, scripts, styles, navigation, forms and hidden elements
//                                     dropped. Parsed by htmlparser2 into a tree that is only read: the page's HTML is never executed
//                                     and no sub-resource (an image, a stylesheet, a frame) is fetched.
//   text/plain, application/json      as is.
//   application/pdf                   the text of the first 50 pages (pdf.js through unpdf, already in the API image for the report
//                                     tests), in a worker thread with a memory limit, ended by Stop or the deadline;
//                                     `isEvalSupported: false`, so a font program is never compiled to code.
//   anything else                     `UNSUPPORTED_TYPE`.
//
// The text is cleaned (control and invisible characters) and cut at the caller's limit; the title is capped at 200 characters.
// Decision record docs/decisions/web-search.md, "Implementation notes (E50.6)".
import { WebToolError } from '@marinoscar/hexactra-web-agent';
import { parseDocument } from 'htmlparser2';
import { Worker } from 'node:worker_threads';

/** The title's cap, in characters. */
export const TITLE_MAX = 200;
/** The pages of a PDF read. */
export const PDF_MAX_PAGES = 50;
/** A link's address longer than this is left out (the link's text stays). */
const LINK_URL_MAX = 500;

export type ContentClass = 'html' | 'text' | 'json' | 'pdf' | 'other';

export interface Extracted {
  title: string | null;
  text: string;
}

/** The bare media type of a `Content-Type` header, lower-cased; '' when absent. */
export function mediaTypeOf(header: string | undefined): string {
  return (header ?? '').split(';')[0]!.trim().toLowerCase();
}

/** The class of an answer: by its media type, else by its first bytes (a server that sends none). */
export function classify(mediaType: string, bytes: Buffer): ContentClass {
  if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') return 'html';
  if (mediaType === 'text/plain') return 'text';
  if (mediaType === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(mediaType)) return 'json';
  if (mediaType === 'application/pdf') return 'pdf';
  if (mediaType === '') {
    const head = bytes.subarray(0, 512).toString('latin1').trimStart().toLowerCase();
    if (head.startsWith('%pdf-')) return 'pdf';
    if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'html';
  }
  return 'other';
}

/** The text of `bytes` in the charset the header names, else (HTML) the one a `<meta>` names, else UTF-8. */
export function decode(bytes: Buffer, contentType: string | undefined, html: boolean): string {
  let charset = /charset\s*=\s*"?([A-Za-z0-9_.:-]+)/i.exec(contentType ?? '')?.[1];
  if (!charset && html) charset = /<meta[^>]+charset\s*=\s*["']?([A-Za-z0-9_.:-]+)/i.exec(bytes.subarray(0, 2048).toString('latin1'))?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// Control characters, zero-width and bidirectional controls, the line separators, the BOM. Built from code points so the source holds
// no invisible character.
const cp = (a: number, b: number) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`;
const TITLE_INVISIBLE = new RegExp(`[${cp(0x00, 0x1f)}${cp(0x7f, 0x9f)}${cp(0x200b, 0x200f)}${cp(0x2028, 0x202e)}${cp(0x2060, 0x2069)}${String.fromCharCode(0xfeff)}]`, 'g');

/** A title as the step and the model read it: one line, at most {@link TITLE_MAX} characters; null when empty. */
export function cleanTitle(raw: string | null | undefined): string | null {
  const t = (raw ?? '')
    .replace(TITLE_INVISIBLE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t ? t.slice(0, TITLE_MAX) : null;
}

// ---- HTML ----

interface HNode {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: HNode[];
}

/** Elements never read: code, styling, embedded objects, navigation and the page's chrome, forms. */
const DROPPED = new Set([
  'script', 'style', 'noscript', 'template', 'head', 'title', 'svg', 'math', 'canvas', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'video', 'audio', 'picture', 'source', 'track', 'map', 'nav', 'header', 'footer', 'aside', 'form', 'button', 'input', 'select', 'textarea',
  'option', 'label', 'dialog', 'menu',
]);
const DROPPED_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'menu', 'menubar', 'toolbar', 'dialog', 'alert', 'tablist']);
const BLOCK = new Set([
  'address', 'article', 'blockquote', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'hr', 'main', 'ol', 'p', 'pre', 'section',
  'table', 'tbody', 'thead', 'tfoot', 'tr', 'ul', 'details', 'summary', 'caption',
]);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

function hidden(el: HNode): boolean {
  const a = el.attribs ?? {};
  if ('hidden' in a) return true;
  if ((a['aria-hidden'] ?? '').toLowerCase() === 'true') return true;
  if (a.type?.toLowerCase() === 'hidden') return true;
  const style = (a.style ?? '').toLowerCase().replace(/\s+/g, '');
  if (style.includes('display:none') || style.includes('visibility:hidden')) return true;
  return DROPPED_ROLES.has((a.role ?? '').toLowerCase());
}

const isElement = (n: HNode): boolean => n.type === 'tag' || n.type === 'script' || n.type === 'style';

function findAll(root: HNode, pred: (n: HNode) => boolean, out: HNode[] = []): HNode[] {
  for (const c of root.children ?? []) {
    if (!isElement(c)) continue;
    if (pred(c)) out.push(c);
    else if (!DROPPED.has(c.name!) || c.name === 'head') findAll(c, pred, out);
  }
  return out;
}

/** The text of an element, whitespace collapsed (for a title or a link's text). */
function flatText(n: HNode): string {
  if (n.type === 'text') return n.data ?? '';
  if (!isElement(n) || DROPPED.has(n.name!) || hidden(n)) return '';
  return (n.children ?? []).map(flatText).join('');
}

/** An absolute http(s) address of a link, or null (a fragment, `javascript:`, `mailto:`, too long, not a URL). */
function linkUrl(href: string | undefined, base: string): string | null {
  if (!href || href.trim().startsWith('#')) return null;
  try {
    const u = new URL(href.trim(), base);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    u.username = '';
    u.password = '';
    return u.href.length <= LINK_URL_MAX ? u.href : null;
  } catch {
    return null;
  }
}

class Lines {
  private readonly out: string[] = [];
  private cur = '';
  private pre = 0;

  text(s: string): void {
    if (this.pre > 0) {
      const parts = s.split('\n');
      this.cur += parts[0];
      for (const p of parts.slice(1)) {
        this.out.push(this.cur);
        this.cur = p;
      }
      return;
    }
    const collapsed = s.replace(/\s+/g, ' ');
    if (this.cur === '' || this.cur.endsWith(' ')) this.cur += collapsed.trimStart();
    else this.cur += collapsed;
  }
  break(): void {
    const line = this.pre > 0 ? this.cur.replace(/\s+$/, '') : this.cur.trim();
    if (line !== '') this.out.push(line);
    this.cur = '';
  }
  blank(): void {
    this.break();
    if (this.out.length && this.out[this.out.length - 1] !== '') this.out.push('');
  }
  enterPre(): void {
    this.pre += 1;
  }
  leavePre(): void {
    this.pre -= 1;
  }
  result(): string {
    this.break();
    while (this.out.length && this.out[this.out.length - 1] === '') this.out.pop();
    return this.out.join('\n');
  }
}

function walk(n: HNode, lines: Lines, base: string): void {
  if (n.type === 'text') {
    lines.text(n.data ?? '');
    return;
  }
  if (!isElement(n)) return;
  const name = n.name!;
  if (DROPPED.has(name) || hidden(n)) return;
  const kids = () => {
    for (const c of n.children ?? []) walk(c, lines, base);
  };
  if (name === 'br') return lines.break();
  if (name === 'img') {
    const alt = (n.attribs?.alt ?? '').trim();
    if (alt) lines.text(` ${alt} `);
    return;
  }
  if (HEADINGS.has(name)) {
    lines.blank();
    kids();
    return lines.blank();
  }
  if (name === 'li') {
    lines.break();
    lines.text('- ');
    kids();
    return lines.break();
  }
  if (name === 'td' || name === 'th') {
    kids();
    return lines.text(' | ');
  }
  if (name === 'a') {
    const url = linkUrl(n.attribs?.href, base);
    const label = flatText(n).replace(/\s+/g, ' ').trim();
    if (!url || !label) return kids();
    lines.text(label === url ? ` ${url} ` : `${label} (${url})`);
    return;
  }
  if (name === 'pre') {
    lines.blank();
    lines.enterPre();
    kids();
    lines.break();
    lines.leavePre();
    return lines.blank();
  }
  if (name === 'p' || name === 'blockquote' || name === 'table' || name === 'hr') {
    lines.blank();
    kids();
    return lines.blank();
  }
  if (BLOCK.has(name)) {
    lines.break();
    kids();
    return lines.break();
  }
  kids();
}

/** The readable text and the title of an HTML page. `baseUrl` (the page's final address) makes a link absolute. */
export function extractHtml(html: string, baseUrl: string): Extracted {
  const doc = parseDocument(html, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true }) as unknown as HNode;
  const titleEl = findAll(doc, (n) => n.name === 'title')[0];
  let base = baseUrl;
  const baseHref = findAll(doc, (n) => n.name === 'base')[0]?.attribs?.href;
  if (baseHref) base = linkUrl(baseHref, baseUrl) ?? baseUrl;
  const main =
    findAll(doc, (n) => n.name === 'main' || (n.attribs?.role ?? '').toLowerCase() === 'main')[0] ??
    (() => {
      const articles = findAll(doc, (n) => n.name === 'article');
      return articles.length === 1 ? articles[0] : undefined;
    })() ??
    findAll(doc, (n) => n.name === 'body')[0] ??
    doc;
  const lines = new Lines();
  if (main === doc) for (const c of doc.children ?? []) walk(c, lines, base);
  else for (const c of main.children ?? []) walk(c, lines, base);
  let title = cleanTitle(titleEl ? (titleEl.children ?? []).map((c) => c.data ?? '').join('') : null);
  if (!title) {
    const h1 = findAll(doc, (n) => n.name === 'h1')[0];
    title = cleanTitle(h1 ? flatText(h1) : null);
  }
  return { title, text: lines.result() };
}

// ---- PDF ----

// pdf.js parses an untrusted file: it runs in a worker thread with a memory limit, terminated on the run's Stop or the deadline (so a
// file that keeps the parser busy never holds the API's event loop). unpdf is ESM-only and the API is CommonJS: the worker loads it
// with Node's own `require` (require of an ES module, Node 22.12+; the image runs Node 24).
const PDF_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { createRequire } = require('node:module');
(async () => {
  let doc = null;
  try {
    const { getDocumentProxy } = createRequire(workerData.base)('unpdf');
    doc = await getDocumentProxy(workerData.bytes, { isEvalSupported: false, useSystemFonts: false, disableFontFace: true, stopAtErrors: false });
    const last = Math.min(doc.numPages, workerData.maxPages);
    const pages = [];
    for (let i = 1; i <= last; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it) => (it.str || '') + (it.hasEOL ? '\\n' : '')).join(''));
      page.cleanup();
    }
    let title = null;
    try {
      const t = (await doc.getMetadata()).info?.Title;
      title = typeof t === 'string' ? t : null;
    } catch {}
    parentPort.postMessage({ ok: true, title, pages, total: doc.numPages });
  } catch (e) {
    parentPort.postMessage({ ok: false });
  } finally {
    try {
      if (doc && typeof doc.destroy === 'function') await doc.destroy();
    } catch {}
  }
})();
`;

/** The memory a PDF worker may use, in MB. */
const PDF_WORKER_HEAP_MB = 256;

interface PdfWorkerAnswer {
  ok: boolean;
  title?: string | null;
  pages?: string[];
  total?: number;
}

/** The text of the first {@link PDF_MAX_PAGES} pages, and the document's title. A PDF that cannot be read is `UNSUPPORTED_TYPE`. */
export async function extractPdf(bytes: Buffer, signal: AbortSignal): Promise<Extracted & { pages: number }> {
  if (signal.aborted) throw new WebToolError('ABORTED');
  const data = new Uint8Array(bytes);
  const worker = new Worker(PDF_WORKER, {
    eval: true,
    workerData: { base: __filename, bytes: data, maxPages: PDF_MAX_PAGES },
    transferList: [data.buffer],
    resourceLimits: { maxOldGenerationSizeMb: PDF_WORKER_HEAP_MB },
    stdout: true,
    stderr: true,
  });
  const answer = await new Promise<PdfWorkerAnswer | 'aborted'>((resolve) => {
    let settled = false;
    const done = (a: PdfWorkerAnswer | 'aborted') => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(a);
    };
    const onAbort = () => done('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (m: PdfWorkerAnswer) => done(m));
    // An answer already posted wins over an error or an exit that is delivered first.
    worker.once('error', () => setTimeout(() => done({ ok: false }), 50));
    worker.once('exit', () => setTimeout(() => done({ ok: false }), 50));
  });
  void worker.terminate();
  if (answer === 'aborted') throw new WebToolError('ABORTED');
  if (!answer.ok || !answer.pages) throw new WebToolError('UNSUPPORTED_TYPE');
  const total = answer.total ?? answer.pages.length;
  const cut = total > answer.pages.length ? `\n\n(Only the first ${answer.pages.length} of ${total} pages were read.)` : '';
  return { title: cleanTitle(answer.title ?? null), text: answer.pages.join('\n\n').trim() + cut, pages: total };
}
