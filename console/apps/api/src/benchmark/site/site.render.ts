// Turns a challenge's answer into bytes (E44.2, #740): the one layout (assets/benchmark-site/layout.html), the site's one 404 and the
// static files a page links. A page carries no console code, no cookie and no session, and no inline script or style: its own
// Content-Security-Policy refuses both, on top of the one nginx adds.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { escapeHtml, type PageView } from '../suite/pages';

/** `apps/api/assets/benchmark-site` (three levels up from both src/benchmark/site and dist/benchmark/site). */
export const SITE_ASSET_DIR = join(__dirname, '..', '..', '..', 'assets', 'benchmark-site');

/** The only files the asset route serves: scripts and stylesheets by a plain name. The layout is not one of them. */
const ASSET_NAME = /^[a-z0-9][a-z0-9-]*\.(js|css)$/;
const ASSET_TYPES: Record<string, string> = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };

/**
 * A page loads script and style from its own origin only, and has neither inline. `frame-src`/`frame-ancestors 'self'`: a challenge
 * may frame its own pages; nothing else may frame them.
 */
export const SITE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; form-action 'self'; frame-ancestors 'self'; base-uri 'none'";

/** Sent with every answer of the site. `no-referrer`: a link out of a page never carries the trial's address. */
export const SITE_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': SITE_CSP,
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
};

/**
 * The site's one 404: the same bytes for an unknown, closed or malformed token and for a page a challenge does not have, so the
 * answer says nothing about which it was. It links nothing, because a relative link would differ with the depth of the address.
 */
export const NOT_FOUND_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>Not found</title></head><body><h1>Not found</h1><p>This page does not exist, or it is no longer available.</p></body></html>';

const cache = new Map<string, string>();
function file(name: string): string {
  // Read once per process in production; re-read in development and tests, so an edited asset shows without a restart.
  const cached = process.env.NODE_ENV === 'production' ? cache.get(name) : undefined;
  if (cached !== undefined) return cached;
  const text = readFileSync(join(SITE_ASSET_DIR, name), 'utf8');
  cache.set(name, text);
  return text;
}

/** A script or stylesheet of the site, or null for any other name (no path, no other extension, no file). */
export function siteAsset(name: string): { type: string; body: string } | null {
  const match = ASSET_NAME.exec(name);
  if (!match) return null;
  try {
    return { type: ASSET_TYPES[match[1]!]!, body: file(name) };
  } catch {
    return null;
  }
}

/** A page in the layout. `root` is the relative way to the trial's root (`./`, `../`); the assets are two levels above it. */
export function renderPage(view: PageView, root: string): string {
  const assets = `${root}../../assets/`;
  const scripts = view.scripts?.length ? ['site.js', ...view.scripts] : [];
  for (const name of scripts) if (!ASSET_NAME.test(name)) throw new Error(`Benchmark site: ${name} is not a script name`);
  const values: Record<string, string> = {
    title: escapeHtml(view.title),
    brand: escapeHtml(view.brand ?? 'Benchmark site'),
    root: escapeHtml(root),
    assets: escapeHtml(assets),
    scripts: scripts.map((name) => `<script src="${escapeHtml(assets + name)}" defer></script>`).join('\n'),
    heading: view.heading === false ? '' : `<h1>${escapeHtml(view.title)}</h1>`,
    body: view.body.__html,
  };
  // One pass over the layout: a value is never searched for placeholders, so page text cannot inject one.
  return file('layout.html').replace(/\{\{(\w+)\}\}/g, (whole, key: string) => values[key] ?? whole);
}
