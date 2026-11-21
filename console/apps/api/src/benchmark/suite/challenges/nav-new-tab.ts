// nav-new-tab (E44.2, #740): a document link opens in a new tab; the access code to report is on the page that opens there.
import { reportedValue } from '../compare';
import { html, notFound, page, type SiteRequest, type SiteResponse } from '../pages';
import { seeded } from '../seeded';
import type { Challenge, Seed } from '../types';
import { distinct } from './shared';

const TITLES = ['Warranty certificate', 'Delivery note', 'Return label', 'Service report', 'Inspection record', 'Packing list', 'Repair estimate'] as const;
const BRAND = 'Document centre';

interface Doc {
  id: string;
  title: string;
  code: string;
  issued: string;
}

export function navNewTabPlan(seed: Seed): { docs: Doc[]; target: Doc } {
  const g = seeded(seed, 'nav-new-tab');
  const codes = distinct(() => g.code(6), 4);
  const ids = distinct(() => g.code(8).toLowerCase(), 4);
  const docs = g.sample(TITLES, 4).map((title, i) => ({ id: ids[i]!, title, code: codes[i]!, issued: g.date('2030-02-01', 200) }));
  return { docs, target: g.pick(docs) };
}

function handle(req: SiteRequest): SiteResponse {
  if (req.method !== 'GET') return notFound();
  const { docs } = navNewTabPlan(req.seed);
  if (req.path === '') {
    return page({
      title: 'Your documents',
      brand: BRAND,
      body: html`<p>Each document opens in a new tab.</p>
        <ul class="menu">
          ${docs.map((d) => html`<li><a href="${req.root}documents/${d.id}" target="_blank" rel="noopener">${d.title}</a> <span class="muted">issued ${d.issued}</span></li>`)}
        </ul>`,
    });
  }
  const [area, id, extra] = req.segments;
  const doc = area === 'documents' && extra === undefined ? docs.find((d) => d.id === id) : undefined;
  if (!doc) return notFound();
  return page({
    title: doc.title,
    brand: BRAND,
    body: html`<dl class="facts">
        <dt>Issued</dt><dd>${doc.issued}</dd>
        <dt>Access code</dt><dd id="access-code"><code>${doc.code}</code></dd>
      </dl>
      <p class="muted">You can close this tab when you are done.</p>`,
  });
}

export const navNewTab: Challenge = {
  id: 'nav-new-tab',
  title: 'Read a code in a new tab',
  category: 'navigation',
  difficulty: 2,
  setup: () => ({}),
  goal: (seed, baseUrl) => `Open ${baseUrl}/, open the document "${navNewTabPlan(seed).target.title}" and reply with the access code shown on it, and nothing else.`,
  grade: ({ seed, result }) => {
    const { docs, target } = navNewTabPlan(seed);
    return [reportedValue('reported-code', result, target.code, docs.map((d) => d.code))];
  },
  site: { handle },
};
