// dyn-modal (E44.2, #740): shortly after the page opens a dialog covers it. The preferences behind it are saved only once the dialog
// has been answered: the server refuses a save while it is open, so clicking through the cover by selector does not pass either.
import { field, html, json, notFound, page, redirect, type SiteRequest, type SiteResponse } from '../pages';
import { seeded } from '../seeded';
import type { Challenge, Check, Json, Seed, SiteState } from '../types';
import { record } from './shared';

const OPTIONS = [
  { key: 'orders', label: 'Order updates' },
  { key: 'summary', label: 'Weekly summary' },
  { key: 'prices', label: 'Price alerts' },
  { key: 'security', label: 'Security notices' },
  { key: 'news', label: 'Product news' },
  { key: 'partners', label: 'Partner offers' },
  { key: 'delivery', label: 'Delivery reminders' },
  { key: 'invoices', label: 'Invoice receipts' },
  { key: 'reviews', label: 'Review requests' },
  { key: 'restock', label: 'Back-in-stock alerts' },
  { key: 'events', label: 'Event invitations' },
  { key: 'tips', label: 'Tips and guides' },
] as const;
const BRAND = 'Notification preferences';

export function dynModalPlan(seed: Seed): { options: { key: string; label: string }[]; initial: Record<string, boolean>; target: { key: string; label: string } } {
  const g = seeded(seed, 'dyn-modal');
  const options = g.sample(OPTIONS, 6);
  const target = g.pick(options);
  const initial: Record<string, boolean> = {};
  for (const o of options) initial[o.key] = o.key === target.key ? false : g.next() < 0.5;
  return { options, initial, target };
}

function prefsPage(req: SiteRequest, message: { error?: string; saved?: boolean } = {}): SiteResponse {
  const { options } = dynModalPlan(req.seed);
  const prefs = record(req.state, 'prefs');
  const dismissed = req.state.modalDismissed === true;
  return page({
    title: 'Notification preferences',
    brand: BRAND,
    scripts: ['dyn-modal.js'],
    body: html`${message.error ? html`<div class="errors" role="alert"><p>${message.error}</p></div>` : ''}${message.saved ? html`<p class="notice" id="saved" role="status">Your preferences are saved.</p>` : ''}
      <form method="post" action="${req.root}save" class="stack">
        ${options.map((o) => html`<label class="check"><input type="checkbox" name="opt_${o.key}" value="on"${prefs[o.key] === true ? html` checked` : ''}> ${o.label}</label>`)}
        <div class="row"><button type="submit">Save preferences</button></div>
      </form>
      <div class="overlay" id="survey-modal" data-modal data-dismissed="${dismissed ? '1' : '0'}" hidden>
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="survey-title">
          <h2 id="survey-title">Help us improve</h2>
          <p>Would you answer a few questions about your experience? It takes about ten minutes.</p>
          <div class="row"><a class="button" href="${req.root}survey">Start the survey</a><button type="button" class="secondary" data-dismiss>No thanks</button></div>
        </div>
      </div>`,
  });
}

function handle(req: SiteRequest): SiteResponse {
  const { options } = dynModalPlan(req.seed);
  const dismissed = req.state.modalDismissed === true;
  if (req.path === '' && req.method === 'GET') return prefsPage(req, { saved: req.query.saved === '1' });
  if (req.path === 'survey' && req.method === 'GET') {
    return page({ title: 'Survey', brand: BRAND, body: html`<p>Thank you for your interest. The survey is not open at the moment.</p><p><a href="${req.root}">Back to your preferences</a></p>` });
  }
  if (req.path === 'api/modal' && req.method === 'POST') {
    if (req.body.action !== 'dismiss') return json({ ok: false }, { status: 400 });
    return dismissed ? json({ ok: true }) : json({ ok: true }, { state: { ...req.state, modalDismissed: true } });
  }
  if (req.path !== 'save' || req.method !== 'POST') return notFound();
  if (!dismissed) return prefsPage(req, { error: 'Your preferences were not saved. Answer the dialog first.' });
  const prefs: { [key: string]: Json } = {};
  for (const o of options) prefs[o.key] = field(req.body, `opt_${o.key}`) === 'on';
  const saves = typeof req.state.saves === 'number' ? req.state.saves : 0;
  return redirect('?saved=1', { state: { ...req.state, prefs, saves: saves + 1 } });
}

function grade(seed: Seed, state: SiteState): Check[] {
  const { options, initial, target } = dynModalPlan(seed);
  const prefs = record(state, 'prefs');
  const dismissed = state.modalDismissed === true;
  const saved = typeof state.saves === 'number' && state.saves > 0;
  const changed = options.filter((o) => o.key !== target.key && prefs[o.key] !== initial[o.key]).map((o) => o.label);
  return [
    { name: 'modal-dismissed', pass: dismissed, detail: dismissed ? 'the dialog was answered' : 'the dialog was never answered' },
    { name: 'option-saved', pass: saved && prefs[target.key] === true, detail: `expected ${target.label} to be on and saved; ${saved ? `stored ${prefs[target.key] === true ? 'on' : 'off'}` : 'nothing was saved'}` },
    { name: 'nothing-else-changed', pass: changed.length === 0, detail: changed.length ? `also changed: ${changed.join(', ')}` : 'the other preferences are as they were' },
  ];
}

export const dynModal: Challenge = {
  id: 'dyn-modal',
  title: 'Dismiss a dialog, then save a preference',
  category: 'dynamic',
  difficulty: 2,
  setup: (seed) => ({ prefs: { ...dynModalPlan(seed).initial }, modalDismissed: false, saves: 0 }),
  goal: (seed, baseUrl) => `Open ${baseUrl}/ and turn on "${dynModalPlan(seed).target.label}" in the notification preferences, then save. Change nothing else.`,
  grade: ({ seed, state }) => grade(seed, state),
  site: { handle },
};
