// Plain words of the web search screens (E50.5, #975; E50.14, #984). No provider price is stated as fact: an estimate, editable by the
// administrator.
import type { ServiceCredential, Tier, WebSearchStatus } from './api';

export const REASON_TEXT: Record<NonNullable<WebSearchStatus['reason']>, string> = {
  disabled_by_admin: 'Your administrator switched web search off.',
  disabled_by_you: 'You switched web search off. The agent searches in the browser instead.',
  no_provider: 'No search provider is switched on for this console.',
  no_key: 'No key is set that your searches may use. Add your own key below, or ask your administrator to share the deployment key.',
};

export const TIER_TEXT: Record<Tier, string> = { user: 'your own key', organization: "your organization's key", system: "your administrator's key" };

/** "about $0.005 a search (estimate)". */
export function estimate(usd: number | null): string {
  if (usd === null) return 'no estimate';
  const digits = usd < 0.01 ? 3 : 2;
  return `about $${usd.toFixed(digits)} a search (estimate)`;
}

/** Where a key is kept, from the credential's binding. */
export function keptWords(binding: ServiceCredential['binding']): string {
  if (binding === 'vault') return 'Kept in your secrets provider, never shown again.';
  if (binding === 'builtin') return "Kept in the console's built-in secrets store, never shown again.";
  return 'Kept in the console, encrypted, never shown again.';
}

/** "Today: 3 searches of 300; at most 30 a run." */
export function todayWords(s: Pick<WebSearchStatus, 'today' | 'perRunLimit'>): string {
  const n = s.today.calls;
  return `Today: ${n} ${n === 1 ? 'search' : 'searches'}${s.today.limit === null ? ' (no daily limit)' : ` of ${s.today.limit}`}${s.perRunLimit === null ? '; no limit per run.' : `; at most ${s.perRunLimit} a run.`}`;
}

export const SEARCH_TEST_NOTE = 'A test makes one real search of a common word. It counts against the daily limit like any search.';
