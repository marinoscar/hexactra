#!/usr/bin/env node
// =============================================================================
// ui-screens: the route-by-width audit of the console web app (#431)
// =============================================================================
//
// Opens every route of the table below at 360, 390, 768, 1024 and 1440 px, in
// light and dark, saves a full-page PNG of each under `.ui-screens/` (ignored
// by git) and checks that the page does not scroll sideways:
//
//     document.documentElement.scrollWidth <= window.innerWidth
//
// It exits non-zero when any page overflows, printing the route and the width,
// and also when it could not check a single page.
//
// THIS IS A LOCAL, MANUAL CHECK. IT IS NOT A CI STEP: CI has no running stack
// with data to look at. Do not wire it into a workflow as a passing step.
//
// Two ways to run it:
//
//   1. Against the dev stack (README, "Run it"), signed in:
//        npm run ui:screens -- --login      # once: sign in by hand in the window that opens;
//                                           # the session is saved to .ui-screens/state.json
//        npm run ui:screens                 # http://localhost:3535 by default (--base to change)
//      The saved state holds your refresh cookie: it stays in the ignored
//      folder, is never committed, and `--login` replaces it when it expires.
//      Routes with an id (a run, a task, a host, a question, a policy) take the
//      first one your account has; a route with nothing to open is reported as
//      SKIPPED, never as passed. Dark needs your theme set to "System".
//
//   2. Without a stack, against a build of the web app with a mocked API:
//        npm run build --workspace=web
//        npm run preview --workspace=web -- --port 4173 &
//        npm run ui:screens -- --mock --base http://localhost:4173
//      The answers come from scripts/ui-screens.fixtures.mjs. Packaged pages
//      whose endpoints are not mocked render their error or empty state; the
//      run lists those endpoints.
//
// Options: --base <url>  --state <file>  --out <dir>  --widths 360,390
//          --schemes light,dark  --only <name,name>  --strict (a skipped or
//          redirected route fails the run)  --list (print the routes and exit)
//
// TO ADD A PAGE: append one line to ROUTES. `{task}`, `{liveRun}`,
// `{finishedRun}`, `{chatRun}`, `{host}`, `{question}`, `{policy}`, `{group}`, `{chat}` and `{app}` are filled
// in from the account (or the fixtures). The enabled slices' routes are read
// from apps/web/src/slices/<id>.tsx, so a new slice page needs nothing here.
//
// Playwright is the one already on the machine (`require('playwright')`); this
// script never installs a browser.
// =============================================================================

import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSOLE = resolve(HERE, '..');

/** Every route the audit opens: `[name, path, options?]`. Append to add a page. */
export const ROUTES = [
  ['home', '/'],
  ['chat', '/chat'],
  ['chat-new', '/chat/new'],
  ['chat-thread', '/chat/{chat}'],
  ['inbox', '/inbox'],
  ['question', '/inbox/q/{question}'],
  ['tasks', '/tasks'],
  ['task-new', '/tasks/new'],
  ['task-detail', '/tasks/{task}'],
  ['task-edit', '/tasks/{task}/edit'],
  ['runs', '/runs'],
  ['run-live', '/runs/{liveRun}'],
  ['run-finished', '/runs/{finishedRun}'],
  // A chat run that went over its (soft) usual limit and finished (#537).
  ['run-chat-over-limit', '/runs/{chatRun}'],
  ['fleet', '/fleet'],
  ['desktop', '/fleet/hosts/{host}/desktop'],
  ['notes', '/notes'],
  // Settings (the user's hub and its pages).
  ['settings', '/settings'],
  ['settings-run-history', '/settings/run-history'],
  ['settings-tokens', '/settings/tokens'],
  ['settings-agent-policies', '/settings/agent-policies'],
  ['settings-agent-policy-new', '/settings/agent-policies/new'],
  ['settings-agent-policy-edit', '/settings/agent-policies/{policy}'],
  ['settings-agent-model-tiers', '/settings/agent-model-tiers'],
  ['settings-webhooks', '/settings/webhooks'],
  ['settings-connected-apps', '/settings/connected-apps'],
  // Connected AI apps (#464).
  ['settings-ai-apps', '/settings/ai-apps'],
  ['settings-ai-app', '/settings/ai-apps/{app}'],
  ['settings-ai-apps-connect', '/settings/ai-apps/connect'],
  ['settings-danger-zone', '/settings/danger-zone'],
  // Administration (the admin hub and its pages).
  ['admin', '/admin/settings'],
  ['admin-fabric', '/admin/settings/fabric'],
  ['admin-users', '/admin/settings/users'],
  ['admin-organization', '/admin/settings/organization'],
  ['admin-organizations', '/admin/settings/organizations'],
  ['admin-jobs', '/admin/settings/jobs'],
  ['admin-job-insights', '/admin/settings/jobs/insights'],
  ['admin-doctor', '/admin/settings/doctor'],
  ['admin-about', '/admin/settings/about'],
  ['admin-webhooks', '/admin/settings/webhooks'],
  ['admin-alerts', '/admin/settings/alerts'],
  ['admin-agent-model-tiers', '/admin/settings/agent-model-tiers'],
  ['admin-agent-ceilings', '/admin/settings/agent-ceilings'],
  ['admin-agent-pricing', '/admin/settings/agent-pricing'],
  ['admin-factory-reset', '/admin/settings/factory-reset'],
  ['admin-run-history', '/admin/settings/run-history'],
  ['admin-oauth-clients', '/admin/settings/oauth-clients'],
  ['admin-ai-app-limits', '/admin/settings/ai-app-limits'],
  // Outside the shell.
  ['activate', '/activate'],
  ['oauth-error', '/oauth/error?code=client_not_allowed&host=client.example.test', { signedOut: true }],
  ['login', '/login', { signedOut: true }],
];

const DEFAULT_WIDTHS = [360, 390, 768, 1024, 1440];
const DEFAULT_SCHEMES = ['light', 'dark'];

function parseArgs(argv) {
  const args = { mock: false, login: false, strict: false, list: false, base: 'http://localhost:3535', out: join(CONSOLE, '.ui-screens'), state: null, widths: DEFAULT_WIDTHS, schemes: DEFAULT_SCHEMES, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--mock') args.mock = true;
    else if (a === '--login') args.login = true;
    else if (a === '--strict') args.strict = true;
    else if (a === '--list') args.list = true;
    else if (a === '--base') args.base = value().replace(/\/$/, '');
    else if (a === '--out') args.out = resolve(value());
    else if (a === '--state') args.state = resolve(value());
    else if (a === '--widths') args.widths = value().split(',').map(Number).filter((n) => n > 0);
    else if (a === '--schemes') args.schemes = value().split(',');
    else if (a === '--only') args.only = value().split(',');
    else throw new Error(`unknown option ${a}`);
  }
  args.state ??= join(args.out, 'state.json');
  return args;
}

/** The enabled slices' routes, read from their source (`{ path: 'settings/…' }` entries of `routes` and `publicRoutes`). */
export function sliceRoutes() {
  const enabled = JSON.parse(readFileSync(join(CONSOLE, 'packages', 'shared', 'slices.json'), 'utf8')).enabled;
  const routes = [];
  for (const id of enabled) {
    const file = join(CONSOLE, 'apps', 'web', 'src', 'slices', `${id}.tsx`);
    if (!existsSync(file)) continue;
    const source = readFileSync(file, 'utf8');
    const publicBlock = /publicRoutes:\s*\[([\s\S]*?)\]/.exec(source)?.[1] ?? '';
    // A route path has no leading slash; a card's path has one and is the same page.
    for (const match of source.matchAll(/\bpath:\s*'([A-Za-z][^']*)'/g)) {
      const path = match[1];
      const name = `slice-${id}-${path.replace(/[^A-Za-z0-9]+/g, '-')}`;
      if (routes.some((r) => r[0] === name)) continue;
      routes.push([name, `/${path.replace(/:id\b/, '{group}')}`, publicBlock.includes(`'${path}'`) ? { signedOut: true } : {}]);
    }
  }
  return routes;
}

const fill = (path, ids) => path.replace(/\{(\w+)\}/g, (_, key) => ids[key] ?? `{${key}}`);

/** The ids of the signed-in account's first live run, finished run, task, host, question, policy and group. */
async function discoverIds(page) {
  return page.evaluate(async () => {
    const refresh = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
    if (!refresh.ok) return { error: `POST /api/auth/refresh answered ${refresh.status}: sign in again with --login` };
    const token = (await refresh.json()).data?.accessToken;
    const get = async (path) => {
      const res = await fetch(`/api${path}`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
      if (!res?.ok) return [];
      const body = await res.json();
      const data = body.data ?? body;
      return Array.isArray(data) ? data : (data.items ?? []);
    };
    const [runs, tasks, hosts, inbox, policies, groups, chats, apps] = await Promise.all([get('/runs'), get('/tasks'), get('/fleet/hosts'), get('/inbox'), get('/agent-policies'), get('/groups'), get('/chats'), get('/connected-apps')]);
    const live = new Set(['queued', 'running', 'waiting_human']);
    return {
      liveRun: runs.find((r) => live.has(r.status))?.id,
      finishedRun: runs.find((r) => !live.has(r.status))?.id,
      chatRun: (runs.find((r) => r.trigger === 'chat' && r.budget?.over?.length) ?? runs.find((r) => r.trigger === 'chat'))?.id,
      task: tasks[0]?.id,
      host: (hosts.find((h) => h.desktop && h.online) ?? hosts[0])?.id,
      question: inbox[0]?.questionId,
      policy: (policies.find((p) => !p.builtin) ?? policies[0])?.id,
      group: groups[0]?.id,
      chat: chats[0]?.id,
      app: apps[0]?.clientId,
    };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const routes = [...ROUTES, ...sliceRoutes()].filter(([name]) => !args.only || args.only.includes(name));
  if (args.list) {
    for (const [name, path] of routes) console.log(`${name.padEnd(44)} ${path}`);
    return 0;
  }
  // The pre-installed Playwright: resolved from here, then from the machine's global modules.
  const require = createRequire(import.meta.url);
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.error('ui-screens: Playwright is not installed here (require("playwright") failed). This check needs it; it never installs a browser itself.');
    return 2;
  }
  mkdirSync(args.out, { recursive: true });

  if (args.login) {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${args.base}/login`);
    console.log(`Sign in in the window that opened (${args.base}). Waiting up to 5 minutes…`);
    await page.waitForURL((url) => !/\/(login|auth\/callback)/.test(url.pathname), { timeout: 300_000 });
    await context.storageState({ path: args.state });
    await browser.close();
    console.log(`Saved the session to ${args.state} (ignored by git; never commit it).`);
    return 0;
  }

  if (!args.mock && !existsSync(args.state)) {
    console.error(`ui-screens: no saved session at ${args.state}. Run "npm run ui:screens -- --login" first, or use --mock.`);
    return 2;
  }

  const browser = await chromium.launch();
  const fixtures = args.mock ? await import('./ui-screens.fixtures.mjs') : null;
  const unmocked = new Set();
  let frame = null;
  if (fixtures) {
    // A 1280 x 720 frame for the live run's screenshot, drawn by the browser (no binary in the repository).
    const page = await browser.newPage();
    const dataUrl = await page.evaluate(() => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 1280, height: 720 });
      const g = canvas.getContext('2d');
      g.fillStyle = '#e8eaf6';
      g.fillRect(0, 0, 1280, 720);
      g.fillStyle = '#3949ab';
      g.fillRect(0, 0, 1280, 64);
      g.fillStyle = '#9fa8da';
      for (let i = 0; i < 5; i++) g.fillRect(80, 120 + i * 110, 1120, 80);
      g.fillStyle = '#1a237e';
      g.font = '28px sans-serif';
      g.fillText('flights.example.test: a placeholder page', 24, 42);
      return canvas.toDataURL('image/png');
    });
    frame = Buffer.from(dataUrl.split(',')[1], 'base64');
    await page.close();
  }

  const mockApi = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '');
    const key = `${request.method()} ${path}`;
    if (/^GET \/runs\/[^/]+\/screenshot$/.test(key)) return route.fulfill({ contentType: 'image/png', body: frame });
    if (/\/stream$/.test(path) || request.headers().accept?.includes('text/event-stream')) return route.abort();
    if (key in fixtures.RESPONSES) {
      // A function answers by the request (its query, its JSON body): a list that is an array or a page, a preview of what was sent.
      const answer = fixtures.RESPONSES[key];
      return route.fulfill({ json: { data: typeof answer === 'function' ? answer(url, request.postDataJSON?.() ?? null) : answer } });
    }
    unmocked.add(key);
    return route.fulfill({ status: 404, json: { message: 'Not mocked (ui-screens)' } });
  };

  const newContext = async (width, scheme, signedIn) => {
    const context = await browser.newContext({
      viewport: { width, height: width < 600 ? 800 : 900 },
      colorScheme: scheme,
      hasTouch: width < 600,
      ...(signedIn && !args.mock ? { storageState: args.state } : {}),
    });
    if (args.mock) {
      await context.route('**/api/**', (route) => {
        // Signed out: the refresh fails, so the app shows its sign-in page.
        if (!signedIn && /\/api\/auth\/(refresh|me)$/.test(new URL(route.request().url()).pathname)) return route.fulfill({ status: 401, json: { message: 'Unauthorized' } });
        return mockApi(route);
      });
    }
    return context;
  };

  let ids = fixtures ? fixtures.MOCK_IDS : {};
  if (!args.mock) {
    const context = await newContext(1024, 'light', true);
    const page = await context.newPage();
    await page.goto(`${args.base}/`, { waitUntil: 'domcontentloaded' });
    ids = await discoverIds(page);
    await context.close();
    if (ids.error) {
      console.error(`ui-screens: ${ids.error}`);
      await browser.close();
      return 2;
    }
  }

  /** results[name][width] = 'ok' | 'overflow' | 'skipped' | 'redirected' (the worst of the schemes). */
  const results = new Map(routes.map(([name]) => [name, new Map()]));
  const rank = { ok: 0, skipped: 1, redirected: 2, overflow: 3 };
  const note = (name, width, status) => {
    const row = results.get(name);
    if (rank[status] >= rank[row.get(width) ?? 'ok']) row.set(width, status);
  };
  const failures = [];
  let checked = 0;

  for (const scheme of args.schemes) {
    for (const width of args.widths) {
      const contexts = { true: null, false: null };
      for (const [name, template, options = {}] of routes) {
        const path = fill(template, ids);
        if (path.includes('{')) {
          note(name, width, 'skipped');
          continue;
        }
        const signedIn = !options.signedOut;
        contexts[signedIn] ??= await newContext(width, scheme, signedIn);
        const page = await contexts[signedIn].newPage();
        try {
          await page.goto(`${args.base}${path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          // A live page keeps a stream open, so "network idle" may never come: wait for it briefly, then let the page settle.
          await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => undefined);
          await page.waitForTimeout(500);
          const at = new URL(page.url()).pathname;
          if (at !== path.split('?')[0]) {
            // The app has no such route (yet), or the account may not open it: it was sent elsewhere.
            note(name, width, 'redirected');
            continue;
          }
          const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
          await page.screenshot({ path: join(args.out, `${name}-${width}-${scheme}.png`), fullPage: true });
          checked++;
          if (size.scroll > size.inner) {
            note(name, width, 'overflow');
            failures.push(`OVERFLOW ${path} at ${width}px (${scheme}): scrollWidth ${size.scroll} > innerWidth ${size.inner}`);
          } else note(name, width, 'ok');
        } catch (error) {
          note(name, width, 'overflow');
          failures.push(`ERROR ${path} at ${width}px (${scheme}): ${error.message.split('\n')[0]}`);
        } finally {
          await page.close();
        }
      }
      for (const context of Object.values(contexts)) await context?.close();
    }
  }
  await browser.close();

  const mark = { ok: 'ok', overflow: 'OVERFLOW', skipped: 'skipped', redirected: 'redirected' };
  console.log(`\nui-screens: ${args.mock ? 'mocked API' : 'dev stack'} at ${args.base}; schemes ${args.schemes.join(', ')}\n`);
  console.log(`${'route'.padEnd(44)}${args.widths.map((w) => String(w).padEnd(11)).join('')}`);
  const unchecked = [];
  for (const [name, template] of routes) {
    const row = results.get(name);
    console.log(`${name.padEnd(44)}${args.widths.map((w) => mark[row.get(w) ?? 'skipped'].padEnd(11)).join('')}`);
    const status = row.get(args.widths[0]);
    if (status === 'skipped') unchecked.push(`${template} (nothing to open: no ${/\{(\w+)\}/.exec(fill(template, ids))?.[1] ?? 'data'})`);
    if (status === 'redirected') unchecked.push(`${template} (redirected: no such route, or no permission)`);
  }
  if (unmocked.size) console.log(`\nNot mocked (those pages rendered their error or empty state):\n  ${[...unmocked].sort().join('\n  ')}`);
  if (unchecked.length) console.log(`\nNOT CHECKED (${unchecked.length}):\n  ${unchecked.join('\n  ')}`);
  for (const failure of failures) console.error(failure);
  console.log(`\n${checked} page loads checked, ${failures.length} failed, ${unchecked.length} routes not checked. Screenshots: ${args.out}`);
  if (checked === 0) {
    console.error('ui-screens: nothing was checked.');
    return 1;
  }
  if (failures.length) return 1;
  if (args.strict && unchecked.length) return 1;
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`ui-screens: ${error.message}`);
      process.exit(2);
    },
  );
}
