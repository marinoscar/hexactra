// Solvers for the benchmark challenges (E44.2, #740): each completes one challenge the way a browser would, over the site's own
// requests, knowing only what the goal says (the values of the challenge's plan that the goal words) and what the pages show.
// `SiteBrowser` follows the links, forms and redirects of the pages it is given; the transport under it is the real HTTP stack
// (`app.inject`, test/benchmark-site.db.spec.ts) or the dispatcher with an in-memory trial (test/benchmark-site.spec.ts).
import { dynDelayedPlan } from '../../src/benchmark/suite/challenges/dyn-delayed';
import { dynModalPlan } from '../../src/benchmark/suite/challenges/dyn-modal';
import { extractInfiniteScrollPlan } from '../../src/benchmark/suite/challenges/extract-infinite-scroll';
import { extractTablePlan } from '../../src/benchmark/suite/challenges/extract-table';
import { formMultistepPlan } from '../../src/benchmark/suite/challenges/form-multistep';
import { formSelectDatePlan } from '../../src/benchmark/suite/challenges/form-select-date';
import { navLookupPlan } from '../../src/benchmark/suite/challenges/nav-lookup';
import { navNewTabPlan } from '../../src/benchmark/suite/challenges/nav-new-tab';
import { navPaginationPlan } from '../../src/benchmark/suite/challenges/nav-pagination';
import { navSpaPlan } from '../../src/benchmark/suite/challenges/nav-spa';
import { formatPrice } from '../../src/benchmark/suite/seeded';
import type { Seed } from '../../src/benchmark/suite/types';

export interface SiteResult {
  status: number;
  type: string;
  body: string;
  location?: string;
}
/** One request below the trial's root: `path` is `orders/x?page=2`, never absolute. */
export type SiteTransport = (method: 'GET' | 'POST', path: string, body?: { form: Record<string, string> } | { json: unknown }) => Promise<SiteResult>;

const ORIGIN = 'http://site.test/t/token/';
const unescape = (s: string): string => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const text = (markup: string): string => unescape(markup.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

/** Why a page is not allowed by the site's own policy: an inline script, an inline handler, an inline style. Empty when it is fine. */
export function inlineProblems(markup: string): string[] {
  const problems: string[] = [];
  for (const m of markup.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\ssrc="[^"]+"/.test(m[1]!)) problems.push('a script without src');
    if (m[2]!.trim()) problems.push('a script with inline code');
  }
  if (/<script\b/i.test(markup.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''))) problems.push('an unclosed script');
  if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(markup)) problems.push('an inline event handler');
  if (/<[a-z][^>]*\sstyle\s*=/i.test(markup)) problems.push('an inline style attribute');
  if (/<style\b/i.test(markup)) problems.push('a style element');
  if (/(href|src|action)\s*=\s*["']?\s*javascript:/i.test(markup)) problems.push('a javascript: address');
  if (/(href|src|action)="(\/|[a-z]+:)/i.test(markup)) problems.push('an absolute address');
  return problems;
}

/** A browser reduced to what the solvers need: a current address, the page there, its links and its form. */
export class SiteBrowser {
  /** The address below the trial's root, with its query. */
  url = '';
  html = '';
  status = 0;
  /** Every HTML page it was served, for the scan of inline script. */
  readonly pages: string[] = [];

  constructor(private readonly transport: SiteTransport) {}

  private resolve(href: string, from = this.url): string {
    const target = new URL(href, new URL(from, ORIGIN));
    if (!target.href.startsWith(ORIGIN)) throw new Error(`${href} leaves the trial's site`);
    return target.href.slice(ORIGIN.length).split('#')[0]!;
  }

  private async land(method: 'GET' | 'POST', path: string, body?: { form: Record<string, string> }): Promise<this> {
    let result = await this.transport(method, path, body);
    let at = path;
    for (let hops = 0; (result.status === 303 || result.status === 308) && hops < 5; hops++) {
      at = this.resolve(result.location!, at);
      result = await this.transport('GET', at);
    }
    this.url = at;
    this.status = result.status;
    this.html = result.body;
    if (result.type.includes('text/html')) this.pages.push(result.body);
    return this;
  }

  open(href: string): Promise<this> {
    return this.land('GET', this.resolve(href));
  }

  /** The address of the first link whose text contains `label`. */
  href(label: string): string {
    for (const m of this.html.matchAll(/<a\b[^>]*\shref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) if (text(m[2]!).includes(label)) return unescape(m[1]!);
    throw new Error(`no link "${label}" on ${this.url || 'the start page'}`);
  }

  follow(label: string): Promise<this> {
    return this.open(this.href(label));
  }

  /** Posts the page's form with these fields, as the browser would. */
  submit(fields: Record<string, string>): Promise<this> {
    const form = /<form\b[^>]*\smethod="post"[^>]*\saction="([^"]*)"/.exec(this.html);
    if (!form) throw new Error(`no form on ${this.url}`);
    return this.land('POST', this.resolve(unescape(form[1]!)), { form: fields });
  }

  /** A call the page's script makes: the path is below the trial's root, like `BenchmarkSite.get`. */
  async call<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body: unknown = {}): Promise<{ status: number; data: T }> {
    const root = /<body data-root="([^"]*)"/.exec(this.html)?.[1] ?? './';
    const result = await this.transport(method, this.resolve(root + path), method === 'POST' ? { json: body } : undefined);
    return { status: result.status, data: JSON.parse(result.body) as T };
  }

  /** The text of the element with this id. */
  byId(id: string): string {
    const m = new RegExp(`<(\\w+)[^>]*\\sid="${id}"[^>]*>([\\s\\S]*?)</\\1>`).exec(this.html);
    if (!m) throw new Error(`no #${id} on ${this.url}`);
    return text(m[2]!);
  }

  get text(): string {
    return text(this.html);
  }
}

export interface SolveTools {
  /** Lets `ms` pass for the site (the tests move the clock; nothing sleeps). */
  wait(ms: number): void | Promise<void>;
}

/** Completes the challenge and returns the agent's answer. */
export type Solver = (browser: SiteBrowser, seed: Seed, tools: SolveTools) => Promise<string>;

export const SOLVERS: Record<string, Solver> = {
  'nav-lookup': async (b, seed) => {
    const { customer, order } = navLookupPlan(seed);
    await b.open('');
    await b.follow('Customers');
    await b.follow(customer.name);
    await b.follow(order.ref);
    return `The status is ${b.byId('order-status')}.`;
  },

  'nav-spa': async (b, seed) => {
    const { target, value } = navSpaPlan(seed);
    await b.open('');
    type Sections = { sections: { id: string; settings: { key: string; label: string; value: string }[] }[] };
    const { data } = await b.call<Sections>('GET', 'api/settings');
    const section = data.sections.find((s) => s.settings.some((x) => x.label === target.label))!;
    // The page posts every value of the section it shows.
    const values = Object.fromEntries(section.settings.map((s) => [s.key, s.label === target.label ? value : s.value]));
    const saved = await b.call('POST', 'api/settings', { section: section.id, values });
    if (saved.status !== 200) throw new Error(`save answered ${saved.status}`);
    return 'The setting is saved.';
  },

  'nav-pagination': async (b, seed) => {
    const { target } = navPaginationPlan(seed);
    await b.open('');
    for (let guard = 0; guard < 20; guard++) {
      const row = new RegExp(`<td>${target.name}</td><td class="num">([^<]+)</td>`).exec(b.html);
      if (row) return row[1]!;
      await b.follow('Next');
    }
    throw new Error('the product is on no page');
  },

  'nav-new-tab': async (b, seed) => {
    const { target } = navNewTabPlan(seed);
    await b.open('');
    if (!/target="_blank"/.test(b.html)) throw new Error('the documents do not open in a new tab');
    await b.follow(target.title);
    return b.byId('access-code');
  },

  'form-multistep': async (b, seed) => {
    const p = formMultistepPlan(seed);
    await b.open('');
    await b.follow('Start registration');
    // The phone number as the goal writes it is refused; the page says why.
    await b.submit({ name: p.name, email: p.email, phone: p.phoneAsGiven });
    if (!b.text.includes('Use digits only')) throw new Error('the phone number with a dash was accepted');
    await b.submit({ name: p.name, email: p.email, phone: p.phone });
    await b.submit({ street: p.street, city: p.city, postal: p.postal });
    await b.submit({ plan: p.plan });
    if (!b.text.includes('Accept the terms')) throw new Error('the terms were not asked for');
    await b.submit({ plan: p.plan, terms: 'yes' });
    if (!b.byId('confirmation').includes(p.name)) throw new Error('no confirmation');
    return 'The member is registered.';
  },

  'form-select-date': async (b, seed) => {
    const p = formSelectDatePlan(seed);
    await b.open('');
    await b.submit({ name: p.name, service: '', date: '' });
    if (!b.text.includes('Choose a service')) throw new Error('an empty booking was accepted');
    await b.submit({ name: p.name, service: p.service, date: p.date });
    if (!b.byId('confirmation').includes(p.service)) throw new Error('no confirmation');
    return 'The visit is booked.';
  },

  'extract-table': async (b, seed) => {
    const { region } = extractTablePlan(seed);
    await b.open('');
    const amounts = [...b.html.matchAll(/data-region="([^"]+)" data-amount="(\d+)"/g)].filter((m) => m[1] === region).map((m) => Number(m[2]));
    return formatPrice(Math.max(...amounts));
  },

  'extract-infinite-scroll': async (b, seed) => {
    const { target } = extractInfiniteScrollPlan(seed);
    await b.open('');
    const first = new RegExp(`<strong>${target.ref}</strong>[\\s\\S]*?<code>([^<]+)</code>`).exec(b.html);
    if (first) return first[1]!;
    let next: number | null = Number(/data-next="(\d+)"/.exec(b.html)![1]);
    while (next !== null) {
      const { data }: { data: { items: { ref: string; code: string }[]; next: number | null } } = await b.call('GET', `api/feed?offset=${next}`);
      const found = data.items.find((i) => i.ref === target.ref);
      if (found) return `Pickup code ${found.code}`;
      next = data.next;
    }
    throw new Error('the shipment is not in the feed');
  },

  'dyn-delayed': async (b, seed, tools) => {
    const { delayMs } = dynDelayedPlan(seed);
    await b.open('');
    await b.call('POST', 'api/report');
    const early = await b.call<{ status: string }>('GET', 'api/report');
    if (early.data.status !== 'pending') throw new Error(`the report was ${early.data.status} at once`);
    await tools.wait(delayMs + 50);
    const ready = await b.call<{ status: string; total: string }>('GET', 'api/report');
    if (ready.data.status !== 'ready') throw new Error('the report never became ready');
    return `Total sales: ${ready.data.total}`;
  },

  'dyn-modal': async (b, seed) => {
    const { options, initial, target } = dynModalPlan(seed);
    const fields = Object.fromEntries(options.filter((o) => initial[o.key] || o.key === target.key).map((o) => [`opt_${o.key}`, 'on']));
    await b.open('');
    // A save behind the open dialog is refused.
    await b.submit(fields);
    if (!b.text.includes('Answer the dialog first')) throw new Error('a save behind the dialog was accepted');
    const dismissed = await b.call('POST', 'api/modal', { action: 'dismiss' });
    if (dismissed.status !== 200) throw new Error('the dialog could not be dismissed');
    await b.submit(fields);
    if (!b.text.includes('Your preferences are saved')) throw new Error('the preferences were not saved');
    return 'The preference is on.';
  },
};
