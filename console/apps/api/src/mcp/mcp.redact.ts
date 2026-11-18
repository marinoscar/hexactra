// No tool result carries the console's own tokens (#465). A tool never puts
// one there itself (the REST routes never return a token, a secret or a
// cookie value), but a web page can hold one, and `browser_evaluate` reads
// anything the signed-in page can (a token pasted in a form, a console tab
// opened by mistake). Every result is scanned before it leaves for a hosted
// model: strings shaped like the console's credentials are replaced, and so
// are exact secret values the server knows (the fabric's service token).
import type { McpToolResult } from './mcp.results';

/**
 * The prefixes of the console's and the fabric's credentials: personal access
 * tokens, OAuth access, refresh and authorization codes, worker-node tokens,
 * the fabric's service, enrollment and host tokens, webhook secrets.
 */
export const CONSOLE_TOKEN_PREFIXES = ['pat_', 'oat_', 'ort_', 'oac_', 'nod_', 'hxs_', 'hxe_', 'hxh_', 'whsec_'] as const;

/** What a redacted token reads as. */
export const REDACTED_TOKEN = '[redacted token]';

// A token body: 16 or more URL-safe characters with at least one digit (random material has digits; a CSS id
// such as `pat_holder_name_field` has none, and stays usable as a selector).
const TOKEN_RE = new RegExp(`(?<![A-Za-z0-9])(?:${CONSOLE_TOKEN_PREFIXES.join('|')})(?=[A-Za-z0-9_\\-]*[0-9])[A-Za-z0-9_\\-]{16,}`, 'g');

/** `text` with every token-shaped string and every exact secret value replaced. */
export function redactTokens(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(TOKEN_RE, REDACTED_TOKEN);
  for (const s of secrets) if (s && s.length >= 8 && out.includes(s)) out = out.split(s).join(REDACTED_TOKEN);
  return out;
}

function redactValue(v: unknown, secrets: readonly string[]): unknown {
  if (typeof v === 'string') return redactTokens(v, secrets);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, secrets));
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactValue(x, secrets)]));
  return v;
}

/** A tool result with its text blocks and structured content redacted (images are passed through). */
export function redactToolResult(r: McpToolResult, secrets: readonly string[] = []): McpToolResult {
  return {
    ...r,
    content: r.content.map((c) => (c.type === 'text' ? { ...c, text: redactTokens(c.text, secrets) } : c)),
    ...(r.structuredContent !== undefined ? { structuredContent: redactValue(r.structuredContent, secrets) as Record<string, unknown> } : {}),
  };
}
