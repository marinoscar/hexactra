// The pages `web_fetch` read in the last minutes (E50.6, #976): in process, per user, 10 minutes, 50 entries a user, keyed by the
// final address (and the address asked for, when a redirect led there). It only avoids reading the same page twice in one run: nothing
// is written to the database or the object store, and a restart empties it.
//
// An entry keeps the addresses of the hops that led to it, so a hit is checked again against the CURRENT run's allowed sites and the
// blocked hosts, as a fresh read would be: a page another run of the same owner read is never shown past a narrower list.

export const FETCH_CACHE_TTL_MS = 10 * 60_000;
export const FETCH_CACHE_MAX_ENTRIES = 50;
/** Users kept at most; the least recently used goes first. */
const MAX_USERS = 1_000;

export interface CachedPage {
  /** Every address read, the first asked for to the final one. */
  hops: string[];
  finalUrl: string;
  title: string | null;
  /** The cleaned text, cut at the longest a caller may ask for. */
  text: string;
  /** More text existed beyond `text`. */
  cut: boolean;
  contentType: string;
}

interface Entry {
  at: number;
  page: CachedPage;
}

export class FetchCache {
  private readonly users = new Map<string, Map<string, Entry>>();

  constructor(
    private readonly ttlMs = FETCH_CACHE_TTL_MS,
    private readonly maxEntries = FETCH_CACHE_MAX_ENTRIES,
    /** The clock; a test replaces it. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(userId: string, url: string): CachedPage | null {
    const pages = this.users.get(userId);
    const hit = pages?.get(url);
    if (!pages || !hit) return null;
    if (this.now() - hit.at > this.ttlMs) {
      pages.delete(url);
      return null;
    }
    return hit.page;
  }

  /** Keeps `page` under its final address and under the address asked for. */
  put(userId: string, page: CachedPage): void {
    let pages = this.users.get(userId);
    if (pages) this.users.delete(userId);
    else pages = new Map();
    this.users.set(userId, pages);
    const entry: Entry = { at: this.now(), page };
    for (const key of new Set([page.finalUrl, page.hops[0]!])) {
      pages.delete(key);
      pages.set(key, entry);
    }
    const now = this.now();
    for (const [k, v] of pages) if (now - v.at > this.ttlMs) pages.delete(k);
    while (pages.size > this.maxEntries) pages.delete(pages.keys().next().value!);
    while (this.users.size > MAX_USERS) this.users.delete(this.users.keys().next().value!);
  }

  /** How many entries a user has (tests). */
  size(userId: string): number {
    return this.users.get(userId)?.size ?? 0;
  }

  clear(): void {
    this.users.clear();
  }
}
