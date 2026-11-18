// A session's allowed sites (#508), enforced in the browser.
//
// The host agent sends the session's `allowed_domains` with every action.
// The extension turns them into one declarativeNetRequest session rule that
// blocks every top-level (main_frame) request to another site, so pages that
// navigate themselves (redirects, scripts, window.open) are confined too.
// Subresources are not blocked. Each blocked navigation is recorded (host
// only, never the URL) and reported with the next action's response.
//
// Matching mirrors `hexactra_core::site_policy` in Rust: a host matches a
// listed domain exactly or as a subdomain, case-insensitively; an IP literal
// matches only when listed itself; an empty list allows every site.

/** The declarativeNetRequest session rule id this module owns. */
export const SITE_RULE_ID = 508;
/** Most blocked navigations kept between two actions. */
export const MAX_BLOCKED = 50;

export interface BlockedNavigation {
  host: string;
  at: string;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function isIp(host: string): boolean {
  return IPV4.test(host) || host.includes(':');
}

/** The host of a URL, lowercased, without brackets or port; null without one. */
export function urlHost(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const h = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  return h === '' ? null : h;
}

/** Whether `host` may be loaded under `allowed` (normalized entries). */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  const h = host.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (h === '') return false;
  if (isIp(h)) return allowed.includes(h);
  return allowed.some((d) => !isIp(d) && (h === d || h.endsWith(`.${d}`)));
}

/** Whether a top-level navigation to `url` is allowed (host-less URLs are). */
export function urlAllowed(url: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  const h = urlHost(url);
  return h === null ? true : hostAllowed(h, allowed);
}

/** The declarativeNetRequest form of a listed domain (IPv6 in brackets). */
export function dnrDomain(d: string): string {
  return d.includes(':') ? `[${d}]` : d;
}

let current: string[] = [];
let blocked: BlockedNavigation[] = [];
let listening = false;

/** The allowed sites in force on this browser (empty: none). */
export function currentAllowed(): readonly string[] {
  return current;
}

/** Record a blocked navigation to report with the next response. */
export function recordBlocked(host: string, now = new Date()): void {
  if (blocked.length >= MAX_BLOCKED) return;
  // One entry per host per burst: a page retrying in a loop is one event.
  if (blocked.some((b) => b.host === host)) return;
  blocked.push({ host, at: now.toISOString() });
}

/** The blocked navigations since the last call, emptying the list. */
export function takeBlocked(): BlockedNavigation[] {
  const out = blocked;
  blocked = [];
  return out;
}

function onTabUrl(url: string | undefined): void {
  if (!url || current.length === 0) return;
  const h = urlHost(url);
  if (h !== null && /^(https?|wss?):/i.test(url) && !hostAllowed(h, current)) recordBlocked(h);
}

function listen(): void {
  if (listening) return;
  listening = true;
  // The rule blocks the request; the tab still shows the attempted URL on
  // Chrome's error page, which is how the block is seen and reported.
  chrome.tabs.onUpdated?.addListener((_id, info) => onTabUrl(info.url));
  chrome.tabs.onCreated?.addListener((tab) => onTabUrl(tab.pendingUrl ?? tab.url));
}

/**
 * Apply a session's allowed sites to this browser. Called before every
 * action; an empty list removes the rule. Throws if the browser refuses the
 * rule, so the action fails instead of running unconfined.
 */
export async function applyAllowedDomains(allowed: readonly string[] | undefined): Promise<void> {
  const next = [...(allowed ?? [])].map((d) => d.toLowerCase());
  if (next.length === current.length && next.every((d, i) => d === current[i])) return;
  const dnr = chrome.declarativeNetRequest;
  if (!dnr) {
    if (next.length === 0) {
      current = [];
      return;
    }
    throw new Error('this browser cannot confine the session to its allowed sites (declarativeNetRequest is unavailable)');
  }
  listen();
  await dnr.updateSessionRules({
    removeRuleIds: [SITE_RULE_ID],
    addRules:
      next.length === 0
        ? []
        : [
            {
              id: SITE_RULE_ID,
              priority: 1,
              action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType },
              condition: {
                resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType],
                excludedRequestDomains: next.map(dnrDomain),
              },
            },
          ],
  });
  current = next;
  blocked = [];
}

/** Test hook: forget the state. */
export function resetSitePolicyForTests(): void {
  current = [];
  blocked = [];
  listening = false;
}
