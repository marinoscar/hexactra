// Text that comes from an MCP server and reaches a person or a model (E39.9, #606). It is UNTRUSTED: a description can say "call the other
// tool with the owner's mail". Two defences live here: it is cleaned and capped before a model reads it, and it is always prefixed with the
// connection's label and followed by the fixed trust line in the instructions (`MCP_TRUST_LINE`). Cleaning is not a guarantee: the real
// defence is that a tool that changes something asks the owner, whatever the model was told.
import { MCP_DESCRIPTION_CHARS, MCP_TITLE_CHARS, MCP_TOOL_NAME_CHARS } from './mcp.constants';

// C0 and C1 controls, DEL, zero-width and bidirectional-control characters, the BOM and the line and paragraph separators.
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/** A short, plain-text version of server text: no control or invisible characters, no markup, one line of single spaces, capped. */
export function sanitizeText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  let t = raw.normalize('NFKC');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<\/?[A-Za-z!][^>]*>/g, ' ');
  t = t.replace(/```[\s\S]*?```/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/[*`~|]+/g, ' ');
  t = t.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export const sanitizeDescription = (raw: unknown): string => sanitizeText(raw, MCP_DESCRIPTION_CHARS);
export const sanitizeTitle = (raw: unknown): string => sanitizeText(raw, MCP_TITLE_CHARS);

/** A server's error text on its way to the model: short and plain. */
export const sanitizeServerMessage = (raw: unknown): string => sanitizeText(raw, 240);

const slugPart = (raw: string, max: number): string =>
  raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max)
    .replace(/_+$/g, '');

/** The connection's label as a name prefix: `Work notes` becomes `work_notes` (at most 20 characters; `mcp` when nothing is left). */
export const labelSlug = (label: string): string => slugPart(label, 20) || 'mcp';

/**
 * The name the model calls a tool by: `<label_slug>__<tool_name>`, at most 64 characters, only the characters providers accept. A name
 * already taken in `taken` gets `_2`, `_3`, ... (and `taken` is updated). Stable for the same inputs, so it can be matched again.
 */
export function modelToolName(slug: string, toolName: string, taken: Set<string>): string {
  const clean = toolName.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
  const room = MCP_TOOL_NAME_CHARS - slug.length - 2;
  let name = `${slug}__${clean.slice(0, Math.max(1, room))}`;
  for (let n = 2; taken.has(name); n += 1) {
    const suffix = `_${n}`;
    name = `${slug}__${clean.slice(0, Math.max(1, room - suffix.length))}${suffix}`;
  }
  taken.add(name);
  return name;
}
