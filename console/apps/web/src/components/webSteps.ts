// The web steps of a run (E50.7 records them; E50.14, #984 reads them): `web_search` as "Searched the web for “…”" with the provider and
// the number of results, `web_fetch` as "Read <host>". Built from the step's masked arguments and its summary, as text only.
interface StepLike {
  kind: string;
  action: string | null;
  args: Record<string, unknown> | null;
  summary: string;
  ok: boolean;
}

export const isWebStep = (s: Pick<StepLike, 'kind' | 'action'>) => s.kind === 'action' && (s.action === 'web_search' || s.action === 'web_fetch');

const hostOf = (url: unknown): string | null => {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
};

/** The sentence and the small print of a web step. */
export function webStepLine(s: StepLike): { primary: string; secondary: string | null } {
  const a = s.args ?? {};
  if (s.action === 'web_search') {
    const q = typeof a.query === 'string' && a.query ? ` for “${a.query}”` : '';
    // The summary of a search that worked: `searched the web for "q" (5 results, brave)`.
    const m = /\((\d+) results?, ([a-z0-9_]+)\)$/.exec(s.summary);
    if (s.ok && m) return { primary: `Searched the web${q}`, secondary: `${m[1]} ${m[1] === '1' ? 'result' : 'results'} · ${m[2]}` };
    return { primary: `Searched the web${q}${s.ok ? '' : ' (failed)'}`, secondary: s.ok ? null : s.summary };
  }
  const host = hostOf(a.url);
  return { primary: `Read ${host ?? 'a page'}${s.ok ? '' : ' (failed)'}`, secondary: s.ok ? null : s.summary };
}

/** "2 web searches · 1 page read", or null when the run made none. */
export function webCountWords(steps: readonly Pick<StepLike, 'kind' | 'action'>[]): string | null {
  const searches = steps.filter((s) => s.kind === 'action' && s.action === 'web_search').length;
  const reads = steps.filter((s) => s.kind === 'action' && s.action === 'web_fetch').length;
  const parts = [searches ? `${searches} web ${searches === 1 ? 'search' : 'searches'}` : null, reads ? `${reads} ${reads === 1 ? 'page' : 'pages'} read` : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}
