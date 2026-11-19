// The RFC 5322 / MIME composer of outgoing mail (E39.3, #601), small and tested because a mail library would be the largest
// dependency of this adapter and the composer is the one place a header-injection bug would matter.
//
//   * UTF-8 subjects and display names become RFC 2047 encoded-words; file names RFC 2231 (with an ASCII fallback);
//   * plain and HTML parts become multipart/alternative; attachments make it multipart/mixed;
//   * `In-Reply-To` and `References` for replies;
//   * `From` is always the connection's own address. There is no way to send as an alias or as someone else;
//   * header injection is impossible: a CR, an LF, a NUL or another control character in a subject, a name, an address, a
//     file name or a content type is REJECTED (CapabilityError INVALID_INPUT), never stripped, because silently changing what
//     the owner asked to send is worse than refusing. Bodies are base64, so they cannot form a header or a boundary.
import { randomBytes } from 'node:crypto';

import { CapabilityError, isHeaderSafe, type MailAddress, type OutgoingMail } from '../capabilities';

const CRLF = '\r\n';
const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const MESSAGE_ID = /^<[^<>\s\u0000-\u001f\u007f]{1,500}>$/;
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

const invalid = (field: string): never => {
  throw new CapabilityError('INVALID_INPUT', { issues: [field] });
};

function safe(value: string, field: string): string {
  if (!isHeaderSafe(value)) invalid(field);
  return value;
}

/** Folds a base64 string into 76-character lines. */
const base64Lines = (data: Buffer): string => (data.toString('base64').match(/.{1,76}/g) ?? []).join(CRLF);

/** RFC 2047 encoded-words of `text` (UTF-8, B encoding), each at most 75 characters, separated by a folding space. */
export function encodeWords(text: string): string {
  const words: string[] = [];
  let chunk: string[] = [];
  let bytes = 0;
  const flush = () => {
    if (chunk.length) words.push(`=?UTF-8?B?${Buffer.from(chunk.join(''), 'utf8').toString('base64')}?=`);
    chunk = [];
    bytes = 0;
  };
  for (const ch of text) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > 42) flush(); // 42 bytes encode to 56 base64 characters, a word of 68 characters
    chunk.push(ch);
    bytes += n;
  }
  flush();
  return words.join(`${CRLF} `);
}

/** A header's text: as is when it is plain printable ASCII and short, encoded-words otherwise. */
export function encodeHeaderText(text: string, field: string): string {
  safe(text, field);
  return ASCII_PRINTABLE.test(text) && text.length <= 900 ? text : encodeWords(text);
}

/** `Name <address>` or just the address, with the name quoted or encoded as its characters require. */
export function formatAddress(a: MailAddress, field: string): string {
  const address = safe(a.address, field);
  if (!ADDRESS.test(address)) invalid(field);
  const name = a.name?.trim();
  if (!name) return address;
  safe(name, field);
  if (!ASCII_PRINTABLE.test(name)) return `${encodeWords(name)} <${address}>`;
  if (/^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]+$/.test(name)) return `${name} <${address}>`;
  return `"${name.replace(/[\\"]/g, '\\$&')}" <${address}>`;
}

const addressList = (list: readonly MailAddress[], field: string): string => list.map((a) => formatAddress(a, field)).join(`,${CRLF} `);

/** `filename="fallback.ext"; filename*=UTF-8''%..` for a name that needs it. */
function dispositionName(name: string): string {
  safe(name, 'attachments.filename');
  const fallback = name.replace(/[^\x20-\x7e]|["\;]/g, '_');
  if (ASCII_PRINTABLE.test(name) && !/["\\]/.test(name)) return `filename="${name}"`;
  const star = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `filename="${fallback}"; filename*=UTF-8''${star}`;
}

const boundary = (): string => `=_hx_${randomBytes(12).toString('hex')}`;

const textPart = (type: 'text/plain' | 'text/html', body: string): string => `Content-Type: ${type}; charset=UTF-8${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}${base64Lines(Buffer.from(body, 'utf8'))}`;

export interface ComposeOptions {
  /** The connection's own address: the `From`. */
  from: string;
  date?: Date;
  /** For a reply: the original's `Message-ID` and `References` as read from the provider (anything malformed is dropped). */
  reply?: { messageId: string; references?: string | null };
}

/** The whole RFC 5322 message as a string with CRLF line ends. */
export function composeMessage(m: OutgoingMail, opts: ComposeOptions): string {
  if (m.text === undefined && m.html === undefined) invalid('text');
  const headers: string[] = [];
  headers.push(`From: ${formatAddress({ address: opts.from }, 'from')}`);
  headers.push(`To: ${addressList(m.to, 'to')}`);
  if (m.cc?.length) headers.push(`Cc: ${addressList(m.cc, 'cc')}`);
  if (m.bcc?.length) headers.push(`Bcc: ${addressList(m.bcc, 'bcc')}`);
  headers.push(`Subject: ${encodeHeaderText(m.subject, 'subject')}`);
  headers.push(`Date: ${(opts.date ?? new Date()).toUTCString().replace('GMT', '+0000')}`);
  headers.push('MIME-Version: 1.0');
  if (opts.reply && MESSAGE_ID.test(opts.reply.messageId)) {
    headers.push(`In-Reply-To: ${opts.reply.messageId}`);
    const refs = (opts.reply.references ?? '')
      .split(/\s+/)
      .filter((r) => MESSAGE_ID.test(r))
      .slice(-20);
    headers.push(`References: ${[...refs, opts.reply.messageId].join(' ')}`);
  }

  // The body: one part, or plain and HTML as alternatives.
  let bodyHeaders: string;
  let body: string;
  if (m.text !== undefined && m.html !== undefined) {
    const b = boundary();
    bodyHeaders = `Content-Type: multipart/alternative; boundary="${b}"`;
    body = [`--${b}`, textPart('text/plain', m.text), `--${b}`, textPart('text/html', m.html), `--${b}--`, ''].join(CRLF);
  } else {
    const part = textPart(m.html !== undefined ? 'text/html' : 'text/plain', (m.html ?? m.text)!);
    const [h, ...rest] = part.split(CRLF + CRLF);
    bodyHeaders = h!;
    body = rest.join(CRLF + CRLF);
  }

  const attachments = m.attachments ?? [];
  if (attachments.length === 0) return [...headers, bodyHeaders, '', body].join(CRLF);

  const outer = boundary();
  const parts = [`--${outer}`, bodyHeaders, '', body.endsWith(CRLF) ? body.slice(0, -2) : body];
  for (const a of attachments) {
    if (!MEDIA_TYPE.test(a.contentType) || !isHeaderSafe(a.contentType)) invalid('attachments.contentType');
    parts.push(`--${outer}`, `Content-Type: ${a.contentType}`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; ${dispositionName(a.filename)}`, '', base64Lines(a.bytes));
  }
  parts.push(`--${outer}--`, '');
  return [...headers, `Content-Type: multipart/mixed; boundary="${outer}"`, '', parts.join(CRLF)].join(CRLF);
}

/** Gmail's `raw`: the message as base64url. */
export const toRaw = (mime: string): string => Buffer.from(mime, 'utf8').toString('base64url');
