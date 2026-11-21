// dyn-delayed (E44.2, #740): the figure to report arrives several seconds after the page opens. Until then the page shows a figure
// from an older report, marked out of date: an agent that does not wait reports that one. The delay is kept by the server (the
// page's script, assets/benchmark-site/dyn-delayed.js, only asks), so it cannot be skipped from the page.
import { reportedAmount } from '../compare';
import { html, json, notFound, page, type SiteRequest, type SiteResponse } from '../pages';
import { formatPrice, seeded } from '../seeded';
import type { Challenge, Check, Seed, SiteState } from '../types';

export function dynDelayedPlan(seed: Seed): { period: string; totalCents: number; staleCents: number; delayMs: number } {
  const g = seeded(seed, 'dyn-delayed');
  const totalCents = g.price(1000, 90000).cents;
  let staleCents = g.price(1000, 90000).cents;
  if (staleCents === totalCents) staleCents += 1234;
  return { period: `Q${g.int(1, 4)} ${g.int(2030, 2034)}`, totalCents, staleCents, delayMs: g.int(3000, 6000) };
}

function handle(req: SiteRequest): SiteResponse {
  const plan = dynDelayedPlan(req.seed);
  if (req.path === '' && req.method === 'GET') {
    return page({
      title: `Sales report, ${plan.period}`,
      brand: 'Reports',
      scripts: ['dyn-delayed.js'],
      body: html`<dl class="facts">
          <dt>Previous report (out of date)</dt><dd id="stale-total">${formatPrice(plan.staleCents)}</dd>
          <dt>Total sales, ${plan.period}</dt><dd id="report-total" data-report><span class="spinner" aria-hidden="true"></span> Calculating…</dd>
        </dl>
        <p id="report-status" class="muted" aria-live="polite">The current figures are being calculated. This takes a few seconds.</p>`,
    });
  }
  if (req.path !== 'api/report') return notFound();
  const requestedAt = typeof req.state.requestedAt === 'number' ? req.state.requestedAt : null;
  if (req.method === 'POST') {
    // Asking again does not restart the calculation.
    return requestedAt === null ? json({ status: 'pending' }, { state: { ...req.state, requestedAt: req.now } }) : json({ status: 'pending' });
  }
  if (requestedAt === null || req.now - requestedAt < plan.delayMs) return json({ status: requestedAt === null ? 'idle' : 'pending' });
  const answer = { status: 'ready', total: formatPrice(plan.totalCents) };
  return req.state.delivered === true ? json(answer) : json(answer, { state: { ...req.state, delivered: true } });
}

function grade(seed: Seed, state: SiteState, result: string): Check[] {
  const plan = dynDelayedPlan(seed);
  const delivered = state.delivered === true;
  return [
    { name: 'report-loaded', pass: delivered, detail: delivered ? 'the current figure reached the page' : 'the current figure never reached the page' },
    reportedAmount('reported-total', result, plan.totalCents, [plan.staleCents], formatPrice),
  ];
}

export const dynDelayed: Challenge = {
  id: 'dyn-delayed',
  title: 'Wait for a figure that loads late',
  category: 'dynamic',
  difficulty: 1,
  setup: () => ({ requestedAt: null, delivered: false }),
  goal: (seed, baseUrl) => `Open ${baseUrl}/ and reply with the total sales for ${dynDelayedPlan(seed).period} from the current report, as an amount only.`,
  grade: ({ seed, state, result }) => grade(seed, state, result),
  site: { handle },
};
