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

const RISKY = /\b(buy|purchase|pay|payment|place[\s_-]*order|checkout|check[\s_-]*out|confirm[\s_-]*(booking|order|purchase|payment)|book[\s_-]*now|subscribe|transfer|send[\s_-]*money|delete[\s_-]*account)\b/i;

/** Whether clicking something with this selector or label looks like it spends money or commits. */
export function looksRisky(...texts: (string | null | undefined)[]): boolean {
  return texts.some((t) => typeof t === 'string' && RISKY.test(t));
}
