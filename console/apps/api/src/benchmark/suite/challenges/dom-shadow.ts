// dom-shadow (E44.7, #745): the delivery choice lives in a custom element's shadow root (assets/benchmark-site/dom-shadow.js), so a
// selector over the page's document does not reach it. The choice is stored when the person presses the element's "Confirm".
import { html, json, notFound, page, type SiteRequest, type SiteResponse } from '../pages';
import { seeded } from '../seeded';
import type { Challenge, Check, Seed, SiteState } from '../types';
import { counter } from './shared';

const OPTIONS = ['Standard', 'Express', 'Next day', 'Evening', 'Weekend', 'Click and collect', 'Locker pickup', 'Same day'] as const;
const BRAND = 'Delivery';

export function domShadowPlan(seed: Seed): { order: string; options: { key: string; label: string }[]; initial: string; target: { key: string; label: string } } {
  const g = seeded(seed, 'dom-shadow');
  const options = g.sample(OPTIONS, 4).map((label) => ({ key: label.toLowerCase().replace(/[^a-z]+/g, '-'), label }));
  const [initial, target] = g.sample(options, 2) as [{ key: string; label: string }, { key: string; label: string }];
  return { order: g.reference('ORD'), options, initial: initial.key, target };
}

function handle(req: SiteRequest): SiteResponse {
  const { order, options } = domShadowPlan(req.seed);
  const selected = typeof req.state.selected === 'string' ? req.state.selected : null;
  if (req.path === '' && req.method === 'GET') {
    return page({
      title: `Delivery for ${order}`,
      brand: BRAND,
      scripts: ['dom-shadow.js'],
      body: html`<p>Choose how order ${order} is delivered.</p><delivery-picker></delivery-picker>`,
    });
  }
  if (req.path === 'api/options' && req.method === 'GET') return json({ options: options.map((o) => ({ key: o.key, label: o.label })), selected });
  if (req.path !== 'api/choice' || req.method !== 'POST') return notFound();
  const option = options.find((o) => o.key === req.body.option);
  if (!option) return json({ ok: false, error: 'Choose one of the options.' }, { status: 400 });
  return json({ ok: true }, { state: { ...req.state, selected: option.key, confirmed: counter(req.state, 'confirmed') + 1 } });
}

function grade(seed: Seed, state: SiteState): Check[] {
  const { options, target } = domShadowPlan(seed);
  const confirmed = counter(state, 'confirmed') > 0;
  const selected = options.find((o) => o.key === state.selected)?.label ?? 'nothing';
  const pass = confirmed && state.selected === target.key;
  return [{ name: 'choice-confirmed', pass, detail: `expected ${target.label}; ${confirmed ? `confirmed ${selected}` : 'nothing was confirmed'}` }];
}

export const domShadow: Challenge = {
  id: 'dom-shadow',
  title: 'Use a control inside a shadow root',
  category: 'pointer',
  difficulty: 2,
  setup: (seed) => ({ selected: domShadowPlan(seed).initial, confirmed: 0 }),
  goal: (seed, baseUrl) => {
    const { order, target } = domShadowPlan(seed);
    return `Open ${baseUrl}/ and choose "${target.label}" delivery for order ${order}, then confirm it.`;
  },
  grade: ({ seed, state }) => grade(seed, state),
  site: { handle },
};
