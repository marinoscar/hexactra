// dyn-layout-shift (E44.7, #745): a product list whose rows move while the page loads. Its script (assets/benchmark-site/
// dyn-layout-shift.js) inserts banners above the list a few times in the first seconds, so a button aimed at too early is no longer
// there when the click lands: the neighbour's is. Every "Add to basket" is an ordinary form post; each one is recorded.
import { field, html, notFound, page, redirect, type SiteRequest, type SiteResponse } from '../pages';
import { formatPrice, seeded } from '../seeded';
import type { Challenge, Check, Json, Seed, SiteState } from '../types';
import { appended, distinct, list } from './shared';

const BRAND = 'Corner shop';

export function dynLayoutShiftPlan(seed: Seed): { products: { sku: string; name: string; cents: number }[]; target: { sku: string; name: string } } {
  const g = seeded(seed, 'dyn-layout-shift');
  const names = distinct(() => g.product(), 8);
  const products = names.map((name, i) => ({ sku: `SKU-${100 + i}`, name, cents: g.price(4, 90).cents }));
  // Never the first row: the rows above it are the ones the banners push down.
  const target = products[g.int(2, products.length - 2)]!;
  return { products, target: { sku: target.sku, name: target.name } };
}

function handle(req: SiteRequest): SiteResponse {
  const { products } = dynLayoutShiftPlan(req.seed);
  if (req.path === '' && req.method === 'GET') {
    const added = products.find((p) => p.sku === req.query.added);
    return page({
      title: 'Today in the shop',
      brand: BRAND,
      scripts: ['dyn-layout-shift.js'],
      body: html`${added ? html`<p class="notice" id="added" role="status">${added.name} was added to your basket.</p>` : ''}
        <div id="banners" aria-live="polite"></div>
        <ul class="products">
          ${products.map(
            (p) => html`<li class="product-row">
              <span class="product-name">${p.name}</span><span class="num">${formatPrice(p.cents)}</span>
              <form method="post" action="${req.root}add"><input type="hidden" name="sku" value="${p.sku}"><button type="submit">Add to basket</button></form>
            </li>`,
          )}
        </ul>`,
    });
  }
  if (req.path !== 'add' || req.method !== 'POST') return notFound();
  const product = products.find((p) => p.sku === field(req.body, 'sku'));
  if (!product) return redirect('');
  return redirect(`?added=${product.sku}`, { state: { ...req.state, added: appended(list(req.state, 'added'), product.sku) } });
}

function grade(seed: Seed, state: SiteState): Check[] {
  const { products, target } = dynLayoutShiftPlan(seed);
  const added = list(state, 'added').map(String);
  const wrong = added.filter((s) => s !== target.sku);
  const name = (sku: string) => products.find((p) => p.sku === sku)?.name ?? sku;
  return [
    { name: 'target-added', pass: added.includes(target.sku), detail: added.includes(target.sku) ? `${target.name} was added` : `${target.name} was never added` },
    { name: 'no-wrong-click', pass: wrong.length === 0, detail: wrong.length ? `also added ${name(wrong[0]!)}` : 'nothing else was added' },
  ];
}

export const dynLayoutShift: Challenge = {
  id: 'dyn-layout-shift',
  title: 'Click a button that moves while the page loads',
  category: 'dynamic',
  difficulty: 2,
  requires: ['pointer'],
  setup: () => ({ added: [] as Json[] }),
  goal: (seed, baseUrl) => `Open ${baseUrl}/ and add one "${dynLayoutShiftPlan(seed).target.name}" to the basket. Add nothing else.`,
  grade: ({ seed, state }) => grade(seed, state),
  site: { handle },
};
