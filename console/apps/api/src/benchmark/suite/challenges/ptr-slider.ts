// ptr-slider (E44.7, #745): a custom slider (a track and a thumb, not an `<input type="range">`) set by dragging its thumb or
// clicking its track (assets/benchmark-site/ptr-slider.js). The value is stored only when the person presses "Apply".
import { html, json, notFound, page, type SiteRequest, type SiteResponse } from '../pages';
import { seeded } from '../seeded';
import type { Challenge, Check, Seed, SiteState } from '../types';
import { counter, intField } from './shared';

const SETTINGS = ['Volume limit', 'Screen brightness', 'Battery saver threshold', 'Fan speed', 'Night light strength', 'Microphone level', 'Bass boost', 'Keyboard backlight'] as const;
const BRAND = 'Device settings';
/** How far from the asked value a stored value may be: one step either way. */
export const SLIDER_TOLERANCE = 1;

export function ptrSliderPlan(seed: Seed): { setting: string; target: number; initial: number } {
  const g = seeded(seed, 'ptr-slider');
  const target = g.int(8, 92);
  // Far from the target, so the thumb has to travel.
  let initial = g.int(0, 100);
  for (let guard = 0; guard < 50 && Math.abs(initial - target) < 25; guard++) initial = g.int(0, 100);
  if (Math.abs(initial - target) < 25) initial = target > 50 ? 0 : 100;
  return { setting: g.pick(SETTINGS), target, initial };
}

function handle(req: SiteRequest): SiteResponse {
  const { setting } = ptrSliderPlan(req.seed);
  const value = counter(req.state, 'value');
  if (req.path === '' && req.method === 'GET') {
    return page({
      title: setting,
      brand: BRAND,
      scripts: ['ptr-slider.js'],
      body: html`<p>Drag the slider, then apply the new value.</p>
        <div class="row">
          <div class="slider" role="slider" tabindex="0" aria-label="${setting}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}" data-slider><div class="slider-fill"></div><div class="slider-thumb"></div></div>
          <output id="slider-value" class="slider-output">${value}%</output>
        </div>
        <div class="row"><button type="button" data-apply>Apply</button><span id="applied" role="status" class="muted" hidden>Applied.</span></div>`,
    });
  }
  if (req.path !== 'api/value' || req.method !== 'POST') return notFound();
  const posted = intField(req.body, 'value', 0, 100);
  if (posted === null) return json({ ok: false, error: 'The value must be a whole number from 0 to 100.' }, { status: 400 });
  return json({ ok: true, value: posted }, { state: { ...req.state, value: posted, applied: counter(req.state, 'applied') + 1 } });
}

function grade(seed: Seed, state: SiteState): Check[] {
  const { setting, target } = ptrSliderPlan(seed);
  const applied = counter(state, 'applied') > 0;
  const value = counter(state, 'value');
  const pass = applied && Math.abs(value - target) <= SLIDER_TOLERANCE;
  return [{ name: 'value-applied', pass, detail: `expected ${setting} at ${target}% (±${SLIDER_TOLERANCE}); ${applied ? `applied ${value}%` : 'nothing was applied'}` }];
}

export const ptrSlider: Challenge = {
  id: 'ptr-slider',
  title: 'Set a custom slider to a value',
  category: 'pointer',
  difficulty: 2,
  requires: ['pointer'],
  setup: (seed) => ({ value: ptrSliderPlan(seed).initial, applied: 0 }),
  goal: (seed, baseUrl) => {
    const { setting, target } = ptrSliderPlan(seed);
    return `Open ${baseUrl}/ and set "${setting}" to ${target}%, then apply it.`;
  },
  grade: ({ seed, state }) => grade(seed, state),
  site: { handle },
};
