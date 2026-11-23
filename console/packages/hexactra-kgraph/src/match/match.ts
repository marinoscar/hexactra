// Deterministic procedure matching (E46.27, #849): given a goal and the owner's library, the procedures that may do part of it. No I/O, no
// model, no embeddings. A site matches only on the exact registrable domain, so a lookalike (`paypa1.com`, `paypal.com.evil.io`) never
// matches. A match is only an offer: it grants nothing, and a matched procedure runs only when the agent chooses it, through the same gates
// as any tool.
import { registrableDomain } from '../compile/compile';
import type { Evidence, Procedure, ProcedureVersion } from '../schema';

/** Why a procedure matched. `site`: it touches a candidate site. `words`: its words overlap the goal's. `account`: it uses a named account. */
export type MatchReason = 'site' | 'words' | 'account';

export interface MatchInput {
  /** The goal: the owner's own words. Data, never an instruction. */
  goal: string;
  /** Candidate sites besides those named in the goal (the run's allowed sites, the sites of the accounts the goal names). Hosts or URLs. */
  sites?: readonly string[];
  /** Connection ids of the accounts the goal names. */
  accounts?: readonly string[];
}

/** One procedure of the owner's library with the version that would run, and an optional description. */
export interface LibraryEntry {
  procedure: Procedure;
  version: ProcedureVersion;
  description?: string;
}

export interface MatchOptions {
  /** At most this many matches (default 5). */
  limit?: number;
  /** The shared words a match needs when no site or account matches (default 2). */
  minWords?: number;
}

export interface ProcedureMatch {
  procedureId: string;
  /** 0..1, for display. The order is by the ranking keys, not by this number alone. */
  score: number;
  /** In the order site, words, account. */
  reasons: MatchReason[];
}

export const MATCH_DEFAULTS = Object.freeze({ limit: 5, minWords: 2 });

/** The states a matched procedure's version may be in: only the one the owner's procedure runs. Never `candidate` or `suspended`. */
export const MATCHABLE_STATES: readonly ProcedureVersion['state'][] = Object.freeze(['active']);

const STOP_WORDS = new Set(
  (
    'a an and are as at be but by can could do does for from get go has have how i if in into is it its me my of on or our please so ' +
    'that the their them then there these this those to up us was we what when where which who will with would you your all any each ' +
    'every some new also just now than via per using use'
  ).split(' '),
);

// A host name or URL in free text: labels of letters, digits and hyphens, a TLD of letters. An e-mail address's domain is not a site.
const HOST_IN_TEXT = /(?<![@\w.-])(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?![\w-]|\.[a-z0-9])/gi;
const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The registrable domain of a host or URL, or null when it is not one. */
export function siteOf(value: string): string | null {
  let host = value.trim().toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  }
  host = host.replace(/\.$/, '');
  if (!DOMAIN.test(host)) return null;
  const d = registrableDomain(host);
  return DOMAIN.test(d) ? d : null;
}

/** The registrable domains named in a text, in order of first mention, without repeats. */
export function sitesInText(text: string): string[] {
  const out: string[] = [];
  for (const m of text.normalize('NFKC').matchAll(HOST_IN_TEXT)) {
    const d = siteOf(m[1]!);
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

/** One word in its matching form: plural folded (`invoices` → `invoice`, `entries` → `entry`, `boxes` → `box`). */
function fold(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(?:ss|sh|ch|x|z)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** The words of a text, normalised: camelCase and snake_case split, lower case, accents stripped, stop words dropped, plurals folded. */
export function wordsOf(text: string): Set<string> {
  const plain = text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
  const out = new Set<string>();
  for (const raw of plain.split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOP_WORDS.has(raw) || /^\d+$/.test(raw)) continue;
    out.add(fold(raw));
  }
  return out;
}

/** The share of a version's own runs that finished with no repair and no failure; 0 with no runs. */
export function cleanReplayRate(e: Evidence): number {
  const total = e.successes + e.failures + e.repairs;
  return total === 0 ? 0 : Math.max(0, e.successes - e.repairs) / total;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The procedures of `library` that may do part of `goal`, best first, at most `opts.limit`.
 *
 * Candidate sites are the registrable domains named in the goal plus `input.sites`. A procedure matches on `site` when its version declares
 * one of them exactly, on `account` when it uses one of `input.accounts`, and on `words` when it shares words with the goal (its name, its
 * description and its parameter names). With no site or account match it needs `opts.minWords` shared words. Ranking: a site (or account)
 * match first, then the shared words, then the clean-replay rate, then the procedure id. Only `active` versions are offered.
 */
export function matchProcedures(input: MatchInput, library: readonly LibraryEntry[], opts: MatchOptions = {}): ProcedureMatch[] {
  const limit = Math.max(0, Math.floor(opts.limit ?? MATCH_DEFAULTS.limit));
  const minWords = Math.max(1, Math.floor(opts.minWords ?? MATCH_DEFAULTS.minWords));
  const sites = new Set(sitesInText(input.goal));
  for (const s of input.sites ?? []) {
    const d = siteOf(s);
    if (d) sites.add(d);
  }
  const accounts = new Set(input.accounts ?? []);
  // The goal's words without the host names in it: `bank.com` is a site, not the words "bank" and "com".
  const goalWords = wordsOf(input.goal.normalize('NFKC').replace(HOST_IN_TEXT, ' '));

  const ranked: { m: ProcedureMatch; tier: number; shared: number; clean: number }[] = [];
  const seen = new Set<string>();
  for (const { procedure, version, description } of library) {
    if (seen.has(procedure.id) || version.procedure !== procedure.id || !MATCHABLE_STATES.includes(version.state)) continue;
    seen.add(procedure.id);
    const site = version.sites.some((s) => sites.has(s.domain));
    const account = version.accounts.some((a) => accounts.has(a.connectionId));
    const own = wordsOf([procedure.name, description ?? '', ...version.parameters.map((p) => p.name)].join(' '));
    let shared = 0;
    for (const w of own) if (goalWords.has(w)) shared++;
    const words = shared >= (site || account ? 1 : minWords);
    if (!site && !account && !words) continue;
    const reasons: MatchReason[] = [];
    if (site) reasons.push('site');
    if (words) reasons.push('words');
    if (account) reasons.push('account');
    const clean = cleanReplayRate(version.evidence);
    const tier = site || account ? 1 : 0;
    const overlap = own.size === 0 ? 0 : (words ? shared : 0) / own.size;
    ranked.push({ m: { procedureId: procedure.id, score: round(0.5 * tier + 0.4 * overlap + 0.1 * clean), reasons }, tier, shared: words ? shared : 0, clean });
  }
  ranked.sort((a, b) => b.tier - a.tier || b.shared - a.shared || b.clean - a.clean || (a.m.procedureId < b.m.procedureId ? -1 : a.m.procedureId > b.m.procedureId ? 1 : 0));
  return ranked.slice(0, limit).map((r) => r.m);
}
