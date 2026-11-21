// extract-infinite-scroll (E44.2, #740): a feed of 120 shipments that loads fifteen more each time its end scrolls into view
// (assets/benchmark-site/extract-infinite-scroll.js, from `api/feed`). The entry to find is in the second half.
import { reportedValue } from '../compare';
import { html, json, notFound, page, type Html, type SiteRequest, type SiteResponse } from '../pages';
import { seeded } from '../seeded';
import type { Challenge, Seed } from '../types';
import { TOWNS, distinct } from './shared';

const COUNT = 120;
const BATCH = 15;

interface Entry {
  ref: string;
  product: string;
  town: string;
  code: string;
}

export function extractInfiniteScrollPlan(seed: Seed): { entries: Entry[]; target: Entry; index: number } {
  const g = seeded(seed, 'extract-infinite-scroll');
  const refs = distinct(() => g.reference('SHP'), COUNT);
  const codes = distinct(() => g.code(6), COUNT);
  const entries = refs.map((ref, i) => ({ ref, product: g.product(), town: g.pick(TOWNS), code: codes[i]! }));
  const index = g.int(COUNT / 2, COUNT - 5);
  return { entries, target: entries[index]!, index };
}

const entryHtml = (e: Entry): Html => html`<li class="feed-entry"><strong>${e.ref}</strong> <span>${e.product}, to ${e.town}</span> <span class="muted">Pickup code: <code>${e.code}</code></span></li>`;

function handle(req: SiteRequest): SiteResponse {
  if (req.method !== 'GET') return notFound();
  const { entries } = extractInfiniteScrollPlan(req.seed);
  if (req.path === '') {
    return page({
      title: 'Shipments',
      brand: 'Dispatch feed',
      scripts: ['extract-infinite-scroll.js'],
      body: html`<p class="muted">Newest first. More shipments load as you scroll.</p>
        <ol id="feed" class="feed" data-next="${BATCH}">${entries.slice(0, BATCH).map(entryHtml)}</ol>
        <p id="feed-status" class="muted" aria-live="polite">Showing ${BATCH} of ${entries.length}</p>
        <div id="feed-end"></div>`,
    });
  }
  if (req.path !== 'api/feed') return notFound();
  const offset = Number(req.query.offset ?? '0');
  if (!Number.isInteger(offset) || offset < 0 || offset > entries.length) return json({ error: 'Bad offset.' }, { status: 400 });
  const items = entries.slice(offset, offset + BATCH);
  const next = offset + items.length;
  return json({ items: items.map((e) => ({ ...e })), next: next < entries.length ? next : null, shown: next, total: entries.length });
}

export const extractInfiniteScroll: Challenge = {
  id: 'extract-infinite-scroll',
  title: 'Find an entry in an endless feed',
  category: 'extraction',
  difficulty: 2,
  setup: () => ({}),
  goal: (seed, baseUrl) => `Open ${baseUrl}/ and find shipment ${extractInfiniteScrollPlan(seed).target.ref} in the feed. Reply with its pickup code only.`,
  grade: ({ seed, result }) => {
    const { entries, target } = extractInfiniteScrollPlan(seed);
    return [reportedValue('reported-code', result, target.code, entries.map((e) => e.code))];
  },
  site: { handle },
};
