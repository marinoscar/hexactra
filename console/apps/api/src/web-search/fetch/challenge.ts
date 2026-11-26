// The pages that are a bot check, not the page asked for (E50.6, #976). A server-side read cannot pass one (no scripts, no sign-in,
// a datacenter address), so the answer is `BLOCKED`: the tool tells the agent to open the page in the browser on the node.
//
// A short list of markers of the common bot-protection services, matched in the first part of an HTML answer, lower-cased. Each
// marker is specific to the service's challenge page, not to a widget an ordinary page may carry (a contact form's reCAPTCHA is not
// a challenge). Every marker is a case in `test/web-fetch.spec.ts`.

/** How much of the answer is searched: the challenge services put their markers near the top. */
export const CHALLENGE_SCAN_CHARS = 64 * 1024;

export const CHALLENGE_MARKERS: readonly { service: string; marker: string }[] = [
  { service: 'cloudflare', marker: '/cdn-cgi/challenge-platform/' },
  { service: 'cloudflare', marker: 'window._cf_chl_opt' },
  { service: 'cloudflare', marker: 'cf-browser-verification' },
  { service: 'cloudflare', marker: '<title>just a moment...</title>' },
  { service: 'cloudflare', marker: '<title>attention required! | cloudflare</title>' },
  { service: 'datadome', marker: 'captcha-delivery.com' },
  { service: 'human', marker: 'px-captcha' },
  { service: 'aws_waf', marker: 'awswaf.com' },
  { service: 'sucuri', marker: 'sucuri website firewall' },
];

/** The service whose challenge page `html` is, or null. */
export function challengeOf(html: string): string | null {
  const head = html.slice(0, CHALLENGE_SCAN_CHARS).toLowerCase();
  return CHALLENGE_MARKERS.find((m) => head.includes(m.marker))?.service ?? null;
}
