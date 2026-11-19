// Nothing of the console's or another connection's credentials goes to an MCP server, and nothing of the kind comes back to a model
// (E39.9, #606). Applied to OUTGOING arguments (the model, or a page it read, may have put a token in one) and to incoming results.
//   * the console's own token shapes: `redactTokens` of the MCP server (personal access tokens, OAuth tokens, node and fabric tokens);
//   * the shapes of the providers' tokens: Google access (`ya29.`) and refresh (`1//`) tokens, and the three-part JWTs Microsoft issues;
//   * exact values: the owner's other connections' tokens and every MCP secret, read from the credential store at the moment of the call.
import { redactTokens, REDACTED_TOKEN } from '../../mcp/mcp.redact';

const PROVIDER_TOKEN_SHAPES: RegExp[] = [/(?<![A-Za-z0-9])ya29\.[A-Za-z0-9_\-]{20,}/g, /(?<![A-Za-z0-9])1\/\/[A-Za-z0-9_\-]{20,}/g, /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g];

/** `text` with every token-shaped string and every exact secret replaced by `[redacted token]`. */
export function redactSecrets(text: string, exact: readonly string[] = []): string {
  let out = redactTokens(text, exact);
  for (const re of PROVIDER_TOKEN_SHAPES) out = out.replace(re, REDACTED_TOKEN);
  return out;
}

/** The same, deep: every string value of the arguments (keys are the tool's own and are kept). */
export function redactArgs<T>(value: T, exact: readonly string[] = []): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactSecrets(v, exact);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** Whether redaction changed anything (the step says "a secret was removed from the arguments" without saying what). */
export const wasRedacted = (before: unknown, after: unknown): boolean => JSON.stringify(before) !== JSON.stringify(after);
