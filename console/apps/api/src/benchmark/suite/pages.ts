// What a challenge's pages are made of (E44.2, #740): the request a challenge's site handler receives, the answers it can give and a
// small HTML builder that escapes everything it is not told is markup. Pure code, like the rest of the suite: no Nest, no Prisma.
//
// A handler is a pure function of the request, the trial's seed and its state. It never writes anywhere itself: it RETURNS the new
// state, and the site (src/benchmark/site/) stores it with the optimistic version, re-running the handler when another request won.
// So a handler may run more than once for one request, and must not depend on anything but its input.
import type { Json, Seed, SiteState } from './types';

/** Markup that is already safe to send. Only `html` and `raw` make one. */
export interface Html {
  readonly __html: string;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

type HtmlValue = Html | string | number | null | undefined | false | readonly HtmlValue[];

function render(value: HtmlValue): string {
  if (value === null || value === undefined || value === false) return '';
  if (typeof value === 'string') return escapeHtml(value);
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(render).join('');
  return (value as Html).__html;
}

/**
 * Markup with escaped values: html`<td>${name}</td>`. A string or number is escaped, another `html` value and an array of them are
 * inserted as they are, and null, undefined and false are nothing. Attribute values must be quoted.
 */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): Html {
  let out = strings[0]!;
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1]!;
  return { __html: out };
}

/** One request to a trial's site, as its challenge sees it. */
export interface SiteRequest {
  method: 'GET' | 'POST';
  /** The path below the trial's root, without leading or trailing slash: `` (the start page), `orders/ORD-48213`. */
  path: string;
  segments: readonly string[];
  /** The query string's values (the first of a repeated one). */
  query: Readonly<Record<string, string>>;
  /** The posted form's fields or the posted JSON object; empty for a GET or any other body. */
  body: Readonly<Record<string, Json>>;
  /**
   * The relative way from this page to the trial's root: `./` or `../`. EVERY link, form action and redirect is built from it
   * (`${req.root}orders/${ref}`), never from an absolute path: the same pages are served at `/benchmark/t/<token>/` behind nginx and at
   * `/api/benchmark-site/t/<token>/` in development.
   */
  root: string;
  seed: Seed;
  /** The trial's state as this request read it. Treat it as read-only and return a new object to change it. */
  state: SiteState;
  /** Milliseconds since the Unix epoch, for a page whose content arrives after a delay. */
  now: number;
}

export interface PageView {
  /** The document title and, unless `heading` is false, the page's `h1`. */
  title: string;
  heading?: false;
  /** The name in the bar at the top; an invented one, never a real company. Default `Benchmark site`. */
  brand?: string;
  body: Html;
  /** Page scripts by file name in `apps/api/assets/benchmark-site/` (`nav-spa.js`). They are the only script a page has. */
  scripts?: readonly string[];
}

/** What a handler answers. `state`, when present, is the trial's new state. */
export type SiteResponse =
  | { kind: 'page'; view: PageView; status: number; state?: SiteState }
  | { kind: 'json'; data: Json; status: number; state?: SiteState }
  | { kind: 'redirect'; to: string; state?: SiteState }
  | { kind: 'not_found' };

interface Options {
  status?: number;
  state?: SiteState;
}

/** An HTML page in the site's layout. */
export const page = (view: PageView, options: Options = {}): SiteResponse => ({ kind: 'page', view, status: options.status ?? 200, ...(options.state ? { state: options.state } : {}) });
/** A JSON answer to a call made by the page's own script. */
export const json = (data: Json, options: Options = {}): SiteResponse => ({ kind: 'json', data, status: options.status ?? 200, ...(options.state ? { state: options.state } : {}) });
/** A 303 to another page of the trial; `to` is a path below the trial's root (`step/2`, or `` for the start page). */
export const redirect = (to: string, options: Pick<Options, 'state'> = {}): SiteResponse => ({ kind: 'redirect', to, ...(options.state ? { state: options.state } : {}) });
/** The site's one 404. */
export const notFound = (): SiteResponse => ({ kind: 'not_found' });

/** The same answer, also storing `state` (a page that comes back with its errors and counts the attempt). */
export const withState = (response: SiteResponse, state: SiteState): SiteResponse => (response.kind === 'not_found' ? response : { ...response, state });

/** A challenge's pages and endpoints: everything under the trial's root is routed here. */
export interface ChallengeSite {
  handle(request: SiteRequest): SiteResponse;
}

/** A posted field as trimmed text; anything that is not a string is empty. Capped, so a state stays small. */
export function field(body: Readonly<Record<string, Json>>, name: string, max = 200): string {
  const v = body[name];
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
