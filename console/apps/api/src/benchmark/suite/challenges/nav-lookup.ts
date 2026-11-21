// nav-lookup (E44.2, #740): follow three pages (customers, one customer, one order) to read an order's status, and report it.
import { reportedValue } from '../compare';
import { html, notFound, page, type SiteRequest, type SiteResponse } from '../pages';
import { seeded } from '../seeded';
import type { Challenge, Seed } from '../types';
import { distinct } from './shared';

const STATUSES = ['Processing', 'Packed', 'Shipped', 'Out for delivery', 'Delivered', 'On hold', 'Returned', 'Cancelled'] as const;
const BRAND = 'Parcel desk';

interface Order {
  /** The opaque id in the order page's address: the reference alone does not give the page away. */
  id: string;
  ref: string;
  item: string;
  placed: string;
  status: string;
}
interface Customer {
  id: string;
  name: string;
  orders: Order[];
}

export function navLookupPlan(seed: Seed): { customers: Customer[]; customer: Customer; order: Order } {
  const g = seeded(seed, 'nav-lookup');
  const names = distinct(() => g.person(), 8);
  const refs = distinct(() => g.reference(), 24);
  const ids = distinct(() => g.code(8).toLowerCase(), 32);
  const customers = names.map((name, c) => ({
    id: ids[c]!,
    name,
    orders: [0, 1, 2].map((o) => ({ id: ids[8 + c * 3 + o]!, ref: refs[c * 3 + o]!, item: g.product(), placed: g.date('2030-01-01', 120), status: g.pick(STATUSES) })),
  }));
  const customer = g.pick(customers);
  return { customers, customer, order: g.pick(customer.orders) };
}

function handle(req: SiteRequest): SiteResponse {
  if (req.method !== 'GET') return notFound();
  const { customers } = navLookupPlan(req.seed);
  const [area, id, extra] = req.segments;
  if (extra !== undefined) return notFound();
  if (area === undefined) {
    return page({
      title: 'Parcel desk',
      brand: BRAND,
      body: html`<p>Look up customers and their orders.</p>
        <ul class="menu">
          <li><a href="${req.root}customers">Customers</a></li>
          <li><a href="${req.root}help">Help</a></li>
        </ul>`,
    });
  }
  if (area === 'help' && id === undefined) {
    return page({ title: 'Help', brand: BRAND, body: html`<p>An order's status is shown on the order's own page. Orders are listed under the customer who placed them.</p><p><a href="${req.root}">Back to the start</a></p>` });
  }
  if (area === 'customers' && id === undefined) {
    return page({
      title: 'Customers',
      brand: BRAND,
      body: html`<table class="grid">
          <thead><tr><th>Customer</th><th>Orders</th></tr></thead>
          <tbody>${customers.map((c) => html`<tr><td><a href="${req.root}customers/${c.id}">${c.name}</a></td><td>${c.orders.length}</td></tr>`)}</tbody>
        </table>
        <p><a href="${req.root}">Back to the start</a></p>`,
    });
  }
  if (area === 'customers') {
    const customer = customers.find((c) => c.id === id);
    if (!customer) return notFound();
    return page({
      title: customer.name,
      brand: BRAND,
      body: html`<h2>Orders</h2>
        <table class="grid">
          <thead><tr><th>Order</th><th>Item</th><th>Placed</th></tr></thead>
          <tbody>${customer.orders.map((o) => html`<tr><td><a href="${req.root}orders/${o.id}">${o.ref}</a></td><td>${o.item}</td><td>${o.placed}</td></tr>`)}</tbody>
        </table>
        <p><a href="${req.root}customers">All customers</a></p>`,
    });
  }
  if (area === 'orders' && id !== undefined) {
    for (const customer of customers) {
      const order = customer.orders.find((o) => o.id === id);
      if (!order) continue;
      return page({
        title: `Order ${order.ref}`,
        brand: BRAND,
        body: html`<dl class="facts">
            <dt>Customer</dt><dd>${customer.name}</dd>
            <dt>Item</dt><dd>${order.item}</dd>
            <dt>Placed</dt><dd>${order.placed}</dd>
            <dt>Status</dt><dd id="order-status">${order.status}</dd>
          </dl>
          <p><a href="${req.root}customers/${customer.id}">Back to ${customer.name}</a></p>`,
      });
    }
  }
  return notFound();
}

export const navLookup: Challenge = {
  id: 'nav-lookup',
  title: "Find an order's status",
  category: 'navigation',
  difficulty: 1,
  setup: () => ({}),
  goal: (seed, baseUrl) => {
    const { customer, order } = navLookupPlan(seed);
    return `Open ${baseUrl}/ and find the status of order ${order.ref}, placed by ${customer.name}. Reply with the status only.`;
  },
  grade: ({ seed, result }) => [reportedValue('reported-status', result, navLookupPlan(seed).order.status, STATUSES)],
  site: { handle },
};
