// Reading what Gmail returns (E39.3, #601): RFC 2047 words in headers, address lists, part bodies in their charset, and HTML
// reduced to text on the server. Output is always plain data that satisfies the neutral schemas: an address that is not valid is
// dropped rather than failing the whole message.
import { isHeaderSafe, mailAddress, type MailAddress } from '../capabilities';

const WORD = /=\?([A-Za-z0-9_-]{1,40})(?:\*[A-Za-z-]+)?\?([BbQq])\?([^?\s]{0,600})\?=/g;

function decodeBytes(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset.trim().toLowerCase() || 'utf-8', { fatal: false }).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

/** RFC 2047 `=?UTF-8?B?...?=` and `=?ISO-8859-1?Q?...?=` words to text; whitespace between two words is dropped. */
export function decodeMimeWords(value: string): string {
  const collapsed = value.replace(/(\?=)\s+(?==\?)/g, '$1');
  return collapsed.replace(WORD, (_m, charset: string, enc: string, text: string) => {
    if (enc.toUpperCase() === 'B') return decodeBytes(Buffer.from(text, 'base64'), charset);
    const bytes: number[] = [];
    const q = text.replace(/_/g, ' ');
    for (let i = 0; i < q.length; i++) {
      if (q[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(q.slice(i + 1, i + 3))) {
        bytes.push(parseInt(q.slice(i + 1, i + 3), 16));
        i += 2;
      } else bytes.push(q.charCodeAt(i) & 0xff);
    }
    return decodeBytes(Buffer.from(bytes), charset);
  });
}

/** Splits at commas outside quotes, angle brackets and comments. */
function splitList(header: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = false;
  let angle = 0;
  let comment = 0;
  for (let i = 0; i < header.length; i++) {
    const c = header[i]!;
    if (quote) {
      cur += c;
      if (c === '\\') cur += header[++i] ?? '';
      else if (c === '"') quote = false;
      continue;
    }
    if (c === '"') quote = true;
    else if (c === '(') comment++;
    else if (c === ')' && comment > 0) comment--;
    else if (comment === 0 && c === '<') angle++;
    else if (comment === 0 && c === '>' && angle > 0) angle--;
    else if (c === ',' && angle === 0 && comment === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const cleanName = (s: string): string | null => {
  const t = decodeMimeWords(s.trim().replace(/^"(.*)"$/s, '$1').replace(/\\(.)/g, '$1'))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000a-\u001f\u007f\u0085\u2028\u2029]/g, ' ')
    .trim()
    .slice(0, 200);
  return t.length > 0 ? t : null;
};

/** `Person A <person-a@example.test>, person-c@example.test` to addresses; entries that are not valid are dropped. */
export function parseAddressList(header: string | null | undefined): MailAddress[] {
  if (!header) return [];
  const out: MailAddress[] = [];
  for (const raw of splitList(header)) {
    const entry = raw.trim();
    const angled = /<([^<>]*)>\s*$/.exec(entry);
    const address = (angled ? angled[1]! : entry.replace(/\([^)]*\)/g, '')).trim();
    const name = angled ? cleanName(entry.slice(0, angled.index)) : null;
    const parsed = mailAddress.safeParse({ address, name });
    if (parsed.success) out.push({ address: parsed.data.address, name: parsed.data.name ?? null });
  }
  return out;
}

/** The decoded text of a header that may carry encoded words, without control characters. */
export function headerValue(value: string | null | undefined): string {
  const v = decodeMimeWords(value ?? '');
  return isHeaderSafe(v) ? v : v.replace(/[\u0000-\u0008\u000a-\u001f\u007f\u0085\u2028\u2029]/g, ' ');
}

export function charsetOf(contentType: string | undefined): string {
  const m = /charset\s*=\s*"?([A-Za-z0-9_.:-]+)"?/i.exec(contentType ?? '');
  return m?.[1] ?? 'utf-8';
}

/** A Gmail part's `body.data` (base64url) as text in the part's charset. */
export const decodeBody = (data: string, contentType: string | undefined): string => decodeBytes(Buffer.from(data, 'base64url'), charsetOf(contentType));

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', copy: '(c)', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', euro: 'EUR' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]{2,8});/g, (m, e: string) => {
    if (e.startsWith('#x') || e.startsWith('#X')) return safeCodePoint(parseInt(e.slice(2), 16)) ?? m;
    if (e.startsWith('#')) return safeCodePoint(parseInt(e.slice(1), 10)) ?? m;
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const safeCodePoint = (n: number): string | null => (Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : null);

/** HTML to readable text: no tags, no scripts or styles, block elements as line breaks, entities decoded. Never returns markup. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|table|ul|ol|blockquote|section|article)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(td|th)\s*>/gi, '\t')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(text)
    .replace(/\r/g, '')
    .replace(/[  ]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
