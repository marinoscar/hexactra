// extract-table (E44.2, #740): forty invoices in no useful order, in a table that sorts by column and filters by region
// (assets/benchmark-site/extract-table.js). The figure to report is the largest amount of one region.
import { reportedAmount } from '../compare';
import { html, notFound, page, type SiteRequest, type SiteResponse } from '../pages';
import { formatPrice, seeded } from '../seeded';
import type { Challenge, Seed } from '../types';
import { distinct } from './shared';

const REGIONS = ['North', 'South', 'East', 'West', 'Central'] as const;
const STATES = ['Paid', 'Open', 'Overdue'] as const;
const COUNT = 40;

interface Invoice {
  ref: string;
  customer: string;
  region: string;
  cents: number;
  status: string;
}

export function extractTablePlan(seed: Seed): { invoices: Invoice[]; region: string; largest: Invoice } {
  const g = seeded(seed, 'extract-table');
  const refs = distinct(() => g.reference('INV'), COUNT);
  const amounts = distinct(() => g.price(40, 9000).cents, COUNT);
  // Eight invoices a region, then shuffled: the rows of a region are never together.
  const invoices = g.shuffle(refs.map((ref, i) => ({ ref, customer: g.person(), region: REGIONS[i % REGIONS.length]!, cents: amounts[i]!, status: g.pick(STATES) })));
  const region = g.pick(REGIONS);
  const largest = invoices.filter((i) => i.region === region).reduce((a, b) => (b.cents > a.cents ? b : a));
  return { invoices, region, largest };
}

function handle(req: SiteRequest): SiteResponse {
  if (req.method !== 'GET' || req.path !== '') return notFound();
  const { invoices } = extractTablePlan(req.seed);
  const column = (key: string, label: string, numeric = false) => html`<th${numeric ? html` class="num"` : ''} aria-sort="none"><button type="button" data-sort="${key}"${numeric ? html` data-numeric="1"` : ''}>${label}</button></th>`;
  return page({
    title: 'Invoices',
    brand: 'Accounts',
    scripts: ['extract-table.js'],
    body: html`<div class="row">
        <label for="region-filter">Region</label>
        <select id="region-filter">
          <option value="">All regions</option>
          ${REGIONS.map((r) => html`<option value="${r}">${r}</option>`)}
        </select>
        <span class="muted" id="row-count">${invoices.length} invoices</span>
      </div>
      <table class="grid" id="invoices">
        <thead><tr>${column('ref', 'Invoice')}${column('customer', 'Customer')}${column('region', 'Region')}${column('amount', 'Amount', true)}${column('status', 'Status')}</tr></thead>
        <tbody>
          ${invoices.map(
            (i) => html`<tr data-ref="${i.ref}" data-customer="${i.customer}" data-region="${i.region}" data-amount="${i.cents}" data-status="${i.status}">
              <td>${i.ref}</td><td>${i.customer}</td><td>${i.region}</td><td class="num">${formatPrice(i.cents)}</td><td>${i.status}</td>
            </tr>`,
          )}
        </tbody>
      </table>`,
  });
}

export const extractTable: Challenge = {
  id: 'extract-table',
  title: 'Report a figure from a table',
  category: 'extraction',
  difficulty: 2,
  setup: () => ({}),
  goal: (seed, baseUrl) => `Open ${baseUrl}/ and find the largest invoice amount in the ${extractTablePlan(seed).region} region. Reply with the amount only.`,
  grade: ({ seed, result }) => {
    const { invoices, largest } = extractTablePlan(seed);
    return [reportedAmount('reported-amount', result, largest.cents, invoices.map((i) => i.cents), formatPrice)];
  },
  site: { handle },
};
