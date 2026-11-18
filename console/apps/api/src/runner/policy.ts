/**
 * Server-side policy, checked before every action (the model's say-so is
 * never authorization). The agent is a human emulator with the owner's full
 * authority (#366): with no allowed-domain list it may open any URL a person
 * could type (`file:`, `chrome:`, `data:`...), except `javascript:` (it has
 * run_javascript for that). A task that lists allowed domains is scoped to
 * them: a hostname matches exactly or as a suffix (`example.test` allows
 * `www.example.test`; `*.example.test` allows only subdomains), and other
 * schemes are refused.
 */
export function domainAllowed(rawUrl: string, allowed: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return false;
  }
  if (u.protocol === 'javascript:') return false;
  if (allowed.length === 0) return true;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return allowed.some((d) => {
    const domain = d.toLowerCase();
    if (domain.startsWith('*.')) return host.endsWith(domain.slice(1));
    return host === domain || host.endsWith(`.${domain}`);
  });
}

/** A domain no site has: what the fabric gets when two lists leave nothing in common (an empty list means "any site"). */
export const NO_SITE = 'no-site.invalid';

/**
 * The allowed sites for the fabric's session request (#508): the task's (or chat's) list narrowed by the AI app's.
 * The fabric enforces them in the browser, for every top-level navigation, including the ones a page starts itself;
 * the console still checks each action against both lists. The fabric takes plain domains (a domain covers its
 * subdomains), so `*.example.test` is sent as `example.test`: the fabric is the backstop, the console the exact rule.
 * Empty: any site. Two lists with nothing in common give `[NO_SITE]`, never `[]`.
 */
export function fabricAllowedSites(task: readonly string[], app: readonly string[]): string[] {
  const plain = (l: readonly string[]) => [...new Set(l.map((d) => d.trim().toLowerCase().replace(/^\*\./, '')).filter(Boolean))];
  const a = plain(task);
  const b = plain(app);
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const covers = (outer: string, inner: string) => inner === outer || inner.endsWith(`.${outer}`);
  const out = new Set<string>();
  for (const x of a) for (const y of b) {
    if (covers(y, x)) out.add(x);
    else if (covers(x, y)) out.add(y);
  }
  return out.size ? [...out] : [NO_SITE];
}

const RISKY = /\b(buy|purchase|pay|payment|place[\s_-]*order|checkout|check[\s_-]*out|confirm[\s_-]*(booking|order|purchase|payment)|book[\s_-]*now|subscribe|transfer|send[\s_-]*money|delete[\s_-]*account)\b/i;

/** Whether clicking something with this selector or label looks like it spends money or commits. */
export function looksRisky(...texts: (string | null | undefined)[]): boolean {
  return texts.some((t) => typeof t === 'string' && RISKY.test(t));
}
