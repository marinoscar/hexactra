// MailQuery to Gmail's search language (E39.3, #601). The structured query is the only way in: a caller's value is a TERM, never
// part of the query's grammar. Every value is wrapped in double quotes after the characters that could end the quote are removed,
// so `OR`, `-`, `label:`, `in:anywhere`, parentheses and braces inside a value are matched as text and cannot change what is searched.
import type { MailQuery } from '../capabilities';

const MAX_WORDS = 20;
const MAX_TERM = 200;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/g;

/** `"value"` with quotes, backslashes and control characters replaced by spaces; null when nothing is left. */
export function quoteTerm(value: string): string | null {
  const t = value.replace(CONTROL, ' ').replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TERM);
  return t ? `"${t}"` : null;
}

/** Each word of free text as its own quoted term (an AND of plain words, in any order). */
export function quoteWords(text: string): string[] {
  return text
    .split(/\s+/)
    .map((w) => quoteTerm(w))
    .filter((w): w is string => w !== null)
    .slice(0, MAX_WORDS);
}

const epoch = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

export interface GmailSearch {
  /** The `q` parameter, or undefined when nothing narrows the search. */
  q: string | undefined;
  /** The `labelIds` parameter: a label is an id, never a term of the query. */
  labelIds: string[];
}

export function buildGmailQuery(q: MailQuery): GmailSearch {
  const parts: string[] = [];
  const field = (name: string, value: string | undefined) => {
    const quoted = value ? quoteTerm(value) : null;
    if (quoted) parts.push(`${name}:${quoted}`);
  };
  field('from', q.from);
  field('to', q.to);
  field('subject', q.subject);
  if (q.text) parts.push(...quoteWords(q.text));
  if (q.after) parts.push(`after:${epoch(q.after)}`);
  if (q.before) parts.push(`before:${epoch(q.before)}`);
  if (q.unread === true) parts.push('is:unread');
  if (q.unread === false) parts.push('is:read');
  if (q.hasAttachment === true) parts.push('has:attachment');
  if (q.hasAttachment === false) parts.push('-has:attachment');
  return { q: parts.length > 0 ? parts.join(' ') : undefined, labelIds: q.label ? [q.label] : [] };
}
