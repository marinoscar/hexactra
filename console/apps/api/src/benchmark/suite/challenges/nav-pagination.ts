// nav-pagination (E44.2, #740): find one product across paged results (ten a page, in no useful order) and report its price.
import { reportedAmount } from '../compare';
import { html, notFound, page, type SiteRequest, type SiteResponse } from '../pages';
import { formatPrice, seeded } from '../seeded';
import type { Challenge, Seed } from '../types';
import { distinct } from './shared';

const PAGE_SIZE = 10;
const COUNT = 60;

interface Product {
  sku: string;
  name: string;
  cents: number;
}

export function navPaginationPlan(seed: Seed): { products: Product[]; target: Product; targetPage: number } {
  const g = seeded(seed, 'nav-pagination');
  const names = distinct(() => g.product(), COUNT);
  const prices = distinct(() => g.price(5, 900).cents, COUNT);
  const skus = distinct(() => g.reference('SKU'), COUNT);
  const products = names.map((name, i) => ({ sku: skus[i]!, name, cents: prices[i]! }));
  // Never on the first two pages: the task is to page through.
  const index = g.int(2 * PAGE_SIZE, COUNT - 1);
  return { products, target: products[index]!, targetPage: Math.floor(index / PAGE_SIZE) + 1 };
}

function handle(req: SiteRequest): SiteResponse {
  if (req.method !== 'GET' || req.path !== '') return notFound();
  const { products } = navPaginationPlan(req.seed);
  const pages = Math.ceil(products.length / PAGE_SIZE);
  const asked = Number(req.query.page ?? '1');
  if (!Number.isInteger(asked) || asked < 1 || asked > pages) return notFound();
  const rows = products.slice((asked - 1) * PAGE_SIZE, asked * PAGE_SIZE);
  const link = (n: number, label: string, rel?: string) => html`<a href="${req.root}?page=${n}"${rel ? html` rel="${rel}"` : ''}>${label}</a>`;
  return page({
    title: 'Catalogue',
    brand: 'Homeware catalogue',
    body: html`<p id="page-status">Page ${asked} of ${pages}, ${products.length} products.</p>
      <table class="grid">
        <thead><tr><th>Code</th><th>Product</th><th class="num">Price</th></tr></thead>
        <tbody>${rows.map((p) => html`<tr><td>${p.sku}</td><td>${p.name}</td><td class="num">${formatPrice(p.cents)}</td></tr>`)}</tbody>
      </table>
      <nav class="pager" aria-label="Pages">
        ${asked > 1 ? link(asked - 1, 'Previous', 'prev') : html`<span class="muted">Previous</span>`}
        ${Array.from({ length: pages }, (_, i) => (i + 1 === asked ? html`<strong aria-current="page">${i + 1}</strong>` : link(i + 1, String(i + 1))))}
        ${asked < pages ? link(asked + 1, 'Next', 'next') : html`<span class="muted">Next</span>`}
      </nav>`,
  });
}

export const navPagination: Challenge = {
  id: 'nav-pagination',
  title: 'Find a product across pages',
  category: 'navigation',
  difficulty: 1,
  setup: () => ({}),
  goal: (seed, baseUrl) => `Open ${baseUrl}/ and find the price of the product "${navPaginationPlan(seed).target.name}" in the catalogue. Reply with the price only.`,
  grade: ({ seed, result }) => {
    const { products, target } = navPaginationPlan(seed);
    return [reportedAmount('reported-price', result, target.cents, products.map((p) => p.cents), formatPrice)];
  },
  site: { handle },
};
