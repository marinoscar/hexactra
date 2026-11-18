// Text-only helpers every widget uses (#466, #467). Every string a widget
// shows comes from a tool result (and so, partly, from web pages and the
// agent): these helpers only pick typed values out of it, and the widgets
// render them as React text nodes, never as HTML.

/** The parts of an MCP `CallToolResult` a widget reads. */
export interface ToolResultLike {
  content?: unknown[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function num(v: unknown, d = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/** The structured result: `structuredContent`, else the JSON after a text block's summary line (hosts that drop structured content). */
export function structured(r: ToolResultLike): Record<string, unknown> | undefined {
  if (obj(r.structuredContent)) return r.structuredContent;
  for (const c of r.content ?? []) {
    const b = obj(c);
    const text = b?.type === 'text' ? str(b.text) : undefined;
    if (!text) continue;
    // An object first (the summary line before it may hold a "[" from the page), else a bare list (`{ items }`).
    for (const at of [text.indexOf('{'), text.indexOf('\n[') + 1, text.startsWith('[') ? 0 : -1]) {
      if (at < 0 || (at === 0 && text[0] !== '{' && text[0] !== '[')) continue;
      try {
        const parsed: unknown = JSON.parse(text.slice(at));
        const v = obj(parsed) ?? (Array.isArray(parsed) ? { items: parsed } : undefined);
        if (v) return v;
      } catch {
        // not JSON from here: a plain sentence
      }
    }
  }
  return undefined;
}

/** The first text block of a result (an error's sentence), without a trailing `[CODE]`. */
export function firstText(r: ToolResultLike | undefined | null): string {
  for (const c of r?.content ?? []) {
    const b = obj(c);
    if (b?.type === 'text' && typeof b.text === 'string') return b.text.replace(/\s*\[[A-Z_]+\]\s*$/, '').trim();
  }
  return '';
}

/** An http(s) URL, or `null`: the only links a widget opens. */
export function safeUrl(v: string | undefined | null): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** A console page under the console's URL (`app_url`), or `null` when that URL is not http(s). */
export function consolePage(appUrl: string | undefined | null, path: string): string | null {
  const base = safeUrl(appUrl);
  if (!base) return null;
  return `${new URL(base).origin}${path.startsWith('/') ? path : `/${path}`}`;
}

/** A string cut to `n` characters with an ellipsis, on one line. */
export function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** "6 s", "1 min 40 s", "2 h 5 min". */
export function formatDuration(seconds: number): string {
  const n = Math.max(0, Math.floor(seconds));
  if (n < 60) return `${n} s`;
  if (n < 3600) return `${Math.floor(n / 60)} min ${n % 60} s`;
  return `${Math.floor(n / 3600)} h ${Math.floor((n % 3600) / 60)} min`;
}
