// ptr-drag-reorder (E44.7, #745): a list that is put in order by dragging its rows with the mouse (assets/benchmark-site/
// ptr-drag-reorder.js). The order is stored only when the person presses "Save order"; the page has no other way to reorder.
import { html, json, notFound, page, type SiteRequest, type SiteResponse } from '../pages';
import { seeded } from '../seeded';
import type { Challenge, Check, Seed, SiteState } from '../types';
import { counter, list } from './shared';

const TASKS = [
  'Water the plants',
  'Book the plumber',
  'Renew the parking permit',
  'Return the library books',
  'Pay the gas bill',
  'Collect the dry cleaning',
  'Order printer ink',
  'Call the bank',
  'Defrost the freezer',
  'Replace the smoke alarm battery',
  'Sort the recycling',
  'Send the birthday card',
] as const;
const BRAND = 'Chores';

export interface DragReorderPlan {
  items: { id: string; label: string }[];
  /** The ids in the order the goal asks for. */
  target: string[];
  /** The ids in the order the page opens with: never the target, and the first row is never already in place. */
  initial: string[];
}

export function ptrDragReorderPlan(seed: Seed): DragReorderPlan {
  const g = seeded(seed, 'ptr-drag-reorder');
  const items = g.sample(TASKS, 5).map((label) => ({ id: `task-${TASKS.indexOf(label) + 1}`, label }));
  const target = items.map((i) => i.id);
  let initial = g.shuffle(target);
  for (let guard = 0; guard < 50 && initial[0] === target[0]; guard++) initial = g.shuffle(target);
  if (initial[0] === target[0]) initial = [...target.slice(1), target[0]!];
  return { items, target, initial };
}

const sameOrder = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

function handle(req: SiteRequest): SiteResponse {
  const { items } = ptrDragReorderPlan(req.seed);
  const order = list(req.state, 'order').map(String);
  if (req.path === '' && req.method === 'GET') {
    const byId = new Map(items.map((i) => [i.id, i]));
    return page({
      title: 'Plan the week',
      brand: BRAND,
      scripts: ['ptr-drag-reorder.js'],
      body: html`<p>Drag a row by its handle to move it. Save when the list is in the order you want.</p>
        <ol class="sortable" data-sortable aria-label="Chores">
          ${order.map((id) => html`<li class="sortable-item" data-id="${id}"><span class="sortable-handle" aria-hidden="true">⠿</span><span>${byId.get(id)?.label ?? id}</span></li>`)}
        </ol>
        <div class="row"><button type="button" data-save>Save order</button><span id="saved" role="status" class="muted" hidden>The order is saved.</span></div>`,
    });
  }
  if (req.path !== 'api/order' || req.method !== 'POST') return notFound();
  const posted = Array.isArray(req.body.order) ? req.body.order.map(String) : [];
  // A permutation of the list's own rows, or nothing is stored.
  if (posted.length !== items.length || new Set(posted).size !== items.length || !posted.every((id) => items.some((i) => i.id === id))) return json({ ok: false, error: 'That is not an order of this list.' }, { status: 400 });
  return json({ ok: true }, { state: { ...req.state, order: posted, saves: counter(req.state, 'saves') + 1 } });
}

function grade(seed: Seed, state: SiteState): Check[] {
  const { items, target } = ptrDragReorderPlan(seed);
  const order = list(state, 'order').map(String);
  const saved = counter(state, 'saves') > 0;
  const labels = (ids: readonly string[]) => ids.map((id) => items.find((i) => i.id === id)?.label ?? id).join(', ');
  const pass = saved && sameOrder(order, target);
  return [{ name: 'order-saved', pass, detail: pass ? 'the list was saved in the asked order' : `expected ${labels(target)}; ${saved ? `saved ${labels(order)}` : 'nothing was saved'}` }];
}

export const ptrDragReorder: Challenge = {
  id: 'ptr-drag-reorder',
  title: 'Reorder a list by dragging',
  category: 'pointer',
  difficulty: 2,
  requires: ['pointer'],
  setup: (seed) => ({ order: ptrDragReorderPlan(seed).initial, saves: 0 }),
  goal: (seed, baseUrl) => {
    const { items, target } = ptrDragReorderPlan(seed);
    return `Open ${baseUrl}/ and put the chores in this order, top to bottom: ${target.map((id) => `"${items.find((i) => i.id === id)!.label}"`).join(', ')}. Then save the order.`;
  },
  grade: ({ seed, state }) => grade(seed, state),
  site: { handle },
};
