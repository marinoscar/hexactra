/** Cuts a string to `n` characters, with an ellipsis when it was cut. */
export function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// C0 and C1 controls, DEL, zero-width and bidirectional-control characters, the BOM and the line and paragraph separators.
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/**
 * A short, plain-text version of third-party text (an MCP server's description, a web search hit's title or excerpt): no control or
 * invisible characters, no markup, one line of single spaces, capped at `max` characters. Moved unchanged from the console's MCP text
 * (E50.4). Cleaning is not a guarantee: the real defence is that what a third party says never authorises anything.
 */
export function sanitizeText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  let t = raw.normalize('NFKC');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<\/?[A-Za-z!][^>]*>/g, ' ');
  t = t.replace(/```[\s\S]*?```/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/[*`~|]+/g, ' ');
  t = t.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}
