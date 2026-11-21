// nav-spa (E44.2, #740): a single-page app with client-side routes (`#/settings/billing`). The agent reaches one setting, changes it
// and saves. The page's script (assets/benchmark-site/nav-spa.js) draws every view from `api/settings` and posts a section's values.
import { html, json, notFound, page, type SiteRequest, type SiteResponse } from '../pages';
import { seeded } from '../seeded';
import type { Challenge, Check, Json, Seed, SiteState } from '../types';
import { pickOther, record } from './shared';

interface Setting {
  key: string;
  label: string;
  options: readonly string[];
}
const SECTIONS: readonly { id: string; label: string; settings: readonly Setting[] }[] = [
  {
    id: 'profile',
    label: 'Profile',
    settings: [
      { key: 'language', label: 'Language', options: ['English', 'Spanish', 'French', 'German'] },
      { key: 'timezone', label: 'Time zone', options: ['UTC', 'UTC+1', 'UTC-5', 'UTC+9'] },
    ],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    settings: [
      { key: 'digest', label: 'Digest frequency', options: ['Never', 'Daily', 'Weekly', 'Monthly'] },
      { key: 'channel', label: 'Alert channel', options: ['Email', 'Text message', 'Push', 'None'] },
    ],
  },
  {
    id: 'billing',
    label: 'Billing',
    settings: [
      { key: 'invoice_format', label: 'Invoice format', options: ['PDF', 'CSV', 'HTML', 'Paper'] },
      { key: 'currency', label: 'Billing currency', options: ['USD', 'EUR', 'GBP', 'JPY'] },
    ],
  },
  {
    id: 'privacy',
    label: 'Privacy',
    settings: [
      { key: 'visibility', label: 'Profile visibility', options: ['Public', 'Team', 'Private', 'Hidden'] },
      { key: 'retention', label: 'Data retention', options: ['30 days', '90 days', '1 year', 'Forever'] },
    ],
  },
];
const ALL = SECTIONS.flatMap((s) => s.settings);

export function navSpaPlan(seed: Seed): { initial: Record<string, string>; target: Setting; value: string } {
  const g = seeded(seed, 'nav-spa');
  const initial: Record<string, string> = {};
  for (const s of ALL) initial[s.key] = g.pick(s.options);
  const target = g.pick(ALL);
  return { initial, target, value: pickOther(g, target.options, initial[target.key]!) };
}

function handle(req: SiteRequest): SiteResponse {
  const settings = record(req.state, 'settings');
  if (req.path === '' && req.method === 'GET') {
    return page({
      title: 'Workspace',
      heading: false,
      brand: 'Workspace',
      scripts: ['nav-spa.js'],
      body: html`<nav class="tabs" aria-label="Sections">
          <a href="#/dashboard">Dashboard</a>
          <a href="#/projects">Projects</a>
          <a href="#/settings">Settings</a>
        </nav>
        <section id="view" aria-live="polite"><p class="muted">Loading…</p></section>`,
    });
  }
  if (req.path !== 'api/settings') return notFound();
  if (req.method === 'GET') {
    return json({ sections: SECTIONS.map((s) => ({ id: s.id, label: s.label, settings: s.settings.map((x) => ({ key: x.key, label: x.label, options: [...x.options], value: settings[x.key] ?? null })) })) });
  }
  const section = SECTIONS.find((s) => s.id === req.body.section);
  const values = req.body.values;
  if (!section || values === null || typeof values !== 'object' || Array.isArray(values)) return json({ ok: false, error: 'Unknown section.' }, { status: 400 });
  const next: { [key: string]: Json } = { ...settings };
  for (const [key, value] of Object.entries(values)) {
    const setting = section.settings.find((s) => s.key === key);
    if (!setting || typeof value !== 'string' || !setting.options.includes(value)) return json({ ok: false, error: 'That value is not offered.' }, { status: 400 });
    next[key] = value;
  }
  const saves = typeof req.state.saves === 'number' ? req.state.saves : 0;
  return json({ ok: true }, { state: { ...req.state, settings: next, saves: saves + 1 } });
}

function grade(seed: Seed, state: SiteState): Check[] {
  const { initial, target, value } = navSpaPlan(seed);
  const settings = record(state, 'settings');
  const changed = ALL.filter((s) => s.key !== target.key && settings[s.key] !== initial[s.key]).map((s) => s.label);
  return [
    { name: 'setting-saved', pass: settings[target.key] === value, detail: `expected ${target.label} to be ${value}; stored ${String(settings[target.key] ?? 'nothing')}` },
    { name: 'nothing-else-changed', pass: changed.length === 0, detail: changed.length ? `also changed: ${changed.join(', ')}` : 'the other settings are as they were' },
  ];
}

export const navSpa: Challenge = {
  id: 'nav-spa',
  title: 'Change a setting in a single-page app',
  category: 'navigation',
  difficulty: 2,
  setup: (seed) => ({ settings: { ...navSpaPlan(seed).initial }, saves: 0 }),
  goal: (seed, baseUrl) => {
    const { target, value } = navSpaPlan(seed);
    return `Open ${baseUrl}/ and change the "${target.label}" setting to "${value}", then save it. Change nothing else.`;
  },
  grade: ({ seed, state }) => grade(seed, state),
  site: { handle },
};
