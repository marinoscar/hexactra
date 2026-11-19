/**
 * What a step may store about an action's arguments. Typed text is replaced
 * by its length (it can be a password, a code or personal data), handoff
 * secret values never appear, and long strings are trimmed. URLs keep their
 * origin and path but drop the query and fragment (they can carry tokens).
 */
export function redactActionArgs(action: string, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === 'type') continue;
    if (key === 'text' || key === 'value' || key === 'secret') {
      out[`${key}_length`] = typeof value === 'string' ? value.length : null;
      continue;
    }
    if (key === 'url' && typeof value === 'string') {
      out.url = redactUrl(value);
      continue;
    }
    out[key] = typeof value === 'string' && value.length > 300 ? `${value.slice(0, 300)}…` : value;
  }
  if (action === 'type' && !('text_length' in out)) out.text_length = null;
  return out;
}

export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}${u.search || u.hash ? ' (query removed)' : ''}`;
  } catch {
    return '[invalid url]';
  }
}
