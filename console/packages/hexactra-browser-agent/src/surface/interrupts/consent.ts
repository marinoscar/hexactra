// A cookie or privacy banner (E46.15): a container named for cookies or consent, with accept/reject controls in it. A page that merely
// mentions cookies (a policy link, a sentence) is not one.
import type { PageSnapshot } from './snapshot';

const CONTAINER = /\b(cookie|cookies|consent|privacy (preferences|settings|choices)|gdpr)\b/i;
const CHOICE = /^(accept|accept all|allow all|agree|i agree|ok|got it|reject|reject all|decline|necessary only|only necessary|manage|customi[sz]e)\b/i;

export function detectConsent(p: PageSnapshot): { choices: string[] } | null {
  const inBanner = p.elements.filter((e) => e.anchor !== null && CONTAINER.test(e.anchor) && e.name !== null && CHOICE.test(e.name.trim()) && (e.role === 'button' || e.tag === 'button' || e.tag === 'a'));
  return inBanner.length >= 1 ? { choices: inBanner.map((e) => e.selector) } : null;
}

/** Whether a control the agent clicked is a consent choice (to record it on the site at learn time). */
export function isConsentChoice(fp: { name: string | null; anchor: string | null }): boolean {
  return fp.anchor !== null && CONTAINER.test(fp.anchor) && fp.name !== null && CHOICE.test(fp.name.trim());
}
