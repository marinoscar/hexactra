// ptr-hover-menu (E44.7, #745): a menu bar whose menus open only while the mouse rests on them (assets/benchmark-site/
// ptr-hover-menu.js): no click, focus or key opens one. An item is a button of an ordinary form; choosing it is the stored state.
import { field, html, notFound, page, redirect, type SiteRequest, type SiteResponse } from '../pages';
import { seeded } from '../seeded';
import type { Challenge, Check, Json, Seed, SiteState } from '../types';
import { appended, list } from './shared';

const MENUS = [
  { label: 'Account', items: ['Edit profile', 'Change password', 'Export my data', 'Linked devices'] },
  { label: 'Orders', items: ['Open orders', 'Returns', 'Invoices', 'Saved baskets'] },
  { label: 'Help', items: ['Contact support', 'Shipping guide', 'Report a problem', 'Accessibility'] },
  { label: 'Settings', items: ['Language', 'Notifications', 'Privacy', 'Display'] },
] as const;
const BRAND = 'Member area';

export interface HoverMenuPlan {
  menus: { label: string; items: { key: string; label: string }[] }[];
  target: { menu: string; key: string; label: string };
}

const keyOf = (label: string): string => label.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export function ptrHoverMenuPlan(seed: Seed): HoverMenuPlan {
  const g = seeded(seed, 'ptr-hover-menu');
  const menus = g.sample(MENUS, 3).map((m) => ({ label: m.label, items: g.shuffle(m.items).map((label) => ({ key: keyOf(label), label })) }));
  const menu = g.pick(menus);
  const item = g.pick(menu.items);
  return { menus, target: { menu: menu.label, key: item.key, label: item.label } };
}

function handle(req: SiteRequest): SiteResponse {
  const { menus } = ptrHoverMenuPlan(req.seed);
  const items = menus.flatMap((m) => m.items);
  if (req.path === '' && req.method === 'GET') {
    return page({
      title: 'Your member area',
      brand: BRAND,
      scripts: ['ptr-hover-menu.js'],
      body: html`<nav class="menubar" aria-label="Member menu">
          ${menus.map(
            (m) => html`<div class="menubar-menu" data-hover-menu>
              <span class="menubar-title" aria-haspopup="true" aria-expanded="false">${m.label}</span>
              <form method="post" action="${req.root}choose" class="menubar-panel" hidden>
                ${m.items.map((i) => html`<button type="submit" name="item" value="${i.key}">${i.label}</button>`)}
              </form>
            </div>`,
          )}
        </nav>
        <p class="muted">Rest the mouse on a menu to open it.</p>`,
    });
  }
  if (req.segments[0] === 'done' && req.segments.length === 2 && req.method === 'GET') {
    const item = items.find((i) => i.key === req.segments[1]);
    if (!item) return notFound();
    return page({ title: item.label, brand: BRAND, body: html`<p id="opened">You opened ${item.label}.</p><p><a href="${req.root}">Back to the member area</a></p>` });
  }
  if (req.path !== 'choose' || req.method !== 'POST') return notFound();
  const item = items.find((i) => i.key === field(req.body, 'item'));
  if (!item) return redirect('');
  return redirect(`done/${item.key}`, { state: { ...req.state, chosen: appended(list(req.state, 'chosen'), item.key) } });
}

function grade(seed: Seed, state: SiteState): Check[] {
  const { menus, target } = ptrHoverMenuPlan(seed);
  const chosen = list(state, 'chosen').map(String);
  const wrong = chosen.filter((k) => k !== target.key);
  const label = (key: string) => menus.flatMap((m) => m.items).find((i) => i.key === key)?.label ?? key;
  return [
    { name: 'item-chosen', pass: chosen.includes(target.key), detail: chosen.includes(target.key) ? `${target.label} was opened` : `${target.label} was never opened` },
    { name: 'no-other-item', pass: wrong.length === 0, detail: wrong.length ? `also opened ${label(wrong[0]!)}` : 'no other item was opened' },
  ];
}

export const ptrHoverMenu: Challenge = {
  id: 'ptr-hover-menu',
  title: 'Choose an item of a menu that opens on hover',
  category: 'pointer',
  difficulty: 2,
  requires: ['pointer'],
  setup: () => ({ chosen: [] as Json[] }),
  goal: (seed, baseUrl) => {
    const { target } = ptrHoverMenuPlan(seed);
    return `Open ${baseUrl}/ and choose "${target.label}" in the "${target.menu}" menu.`;
  },
  grade: ({ seed, state }) => grade(seed, state),
  site: { handle },
};
