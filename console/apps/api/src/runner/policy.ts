/**
 * Server-side policy, checked before every action (the model's say-so is
 * never authorization). Allowed domains match a hostname exactly or as a
 * suffix (`example.test` allows `www.example.test`; `*.example.test` allows
 * only subdomains). An empty list allows any http(s) site.
 */
export function domainAllowed(rawUrl: string, allowed: readonly string[]): boolean {
  let host: string;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (allowed.length === 0) return true;
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
