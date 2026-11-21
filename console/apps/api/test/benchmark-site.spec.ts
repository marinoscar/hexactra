// The benchmark challenge site and the ten starter challenges (E44.2, #740), without a database: every challenge is completed by its
// solver through the site's dispatcher (an in-memory trial stands in for the table) and graded by its own grader; a state nobody
// touched, a wrong reported value and a wrong stored value fail; two seeds give different data and different answers; and no page,
// template or script carries inline script. The same solvers run over real HTTP in test/benchmark-site.db.spec.ts.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { redactedBenchmarkSiteUrl } from '../src/benchmark/site/site.paths';
import { NOT_FOUND_HTML, SITE_ASSET_DIR, SITE_CSP, renderPage, siteAsset } from '../src/benchmark/site/site.render';
import { BenchmarkSiteService, SITE_RATE_LIMIT } from '../src/benchmark/site/site.service';
import type { TrialSite, TrialStateService, TrialWriteResult } from '../src/benchmark/site/trial-state.service';
import { hashTrialToken, isTrialToken, trialBaseUrl } from '../src/benchmark/site/trial-state.service';
import { dynDelayedPlan } from '../src/benchmark/suite/challenges/dyn-delayed';
import { dynModalPlan } from '../src/benchmark/suite/challenges/dyn-modal';
import { extractInfiniteScrollPlan } from '../src/benchmark/suite/challenges/extract-infinite-scroll';
import { extractTablePlan } from '../src/benchmark/suite/challenges/extract-table';
import { navLookupPlan } from '../src/benchmark/suite/challenges/nav-lookup';
import { navNewTabPlan } from '../src/benchmark/suite/challenges/nav-new-tab';
import { navPaginationPlan } from '../src/benchmark/suite/challenges/nav-pagination';
import { navSpaPlan } from '../src/benchmark/suite/challenges/nav-spa';
import { amountsIn, mentions, normalise, reportedAmount, reportedValue, storedField } from '../src/benchmark/suite/compare';
import { html, page } from '../src/benchmark/suite/pages';
import { SUITE, challengeById, seedFrom, suiteProblems } from '../src/benchmark/suite/registry';
import { formatPrice } from '../src/benchmark/suite/seeded';
import type { Challenge, Check, GradeInput, Seed, SiteState } from '../src/benchmark/suite/types';
import { InMemoryMcpRateLimiter } from '../src/mcp/mcp.rate-limit';
import { SOLVERS, SiteBrowser, inlineProblems, type SiteTransport } from './support/benchmark-solvers';

const BENCHMARK = '00000000-0000-4000-8000-0000000000b1';
const TOKEN = 'A'.repeat(43);
const BASE = 'https://console.example.test/benchmark/t/' + TOKEN;
const IDS = ['nav-lookup', 'nav-spa', 'nav-pagination', 'nav-new-tab', 'form-multistep', 'form-select-date', 'extract-table', 'extract-infinite-scroll', 'dyn-delayed', 'dyn-modal'];
const seedOf = (id: string, trial: number): Seed => seedFrom(BENCHMARK, id, 'builtin:balanced', trial);

/** One trial held in memory, with the optimistic version of the real table. */
class MemoryTrial {
  open = true;
  version = 0;
  state: SiteState;
  writes = 0;
  /** Makes the next write lose once, as if another request had written first. */
  loseNext = false;

  constructor(
    readonly challenge: Challenge,
    readonly seed: Seed,
  ) {
    this.state = challenge.setup(seed);
  }

  readonly service = {
    resolve: async (token: string): Promise<TrialSite | null> => (this.open && token === TOKEN ? { trialId: 'trial-1', challengeId: this.challenge.id, seed: this.seed, state: this.state, version: this.version } : null),
    write: async (_id: string, version: number, state: SiteState): Promise<TrialWriteResult> => {
      if (!this.open) return 'closed';
      if (this.loseNext) {
        this.loseNext = false;
        this.version++;
        return 'conflict';
      }
      if (version !== this.version) return 'conflict';
      this.state = JSON.parse(JSON.stringify(state)) as SiteState;
      this.version++;
      this.writes++;
      return 'written';
    },
  } as unknown as TrialStateService;
}

function transportOf(site: BenchmarkSiteService, token = TOKEN): SiteTransport {
  return async (method, path, body) => {
    const [rest, query = ''] = path.split('?') as [string, string?];
    const answer = await site.handle({ token, method, rest, query: Object.fromEntries(new URLSearchParams(query)), body: body ? ('form' in body ? body.form : body.json) : undefined });
    return { status: answer.status, type: answer.type, body: answer.body, location: answer.headers?.location };
  };
}

let clock = 0;
beforeAll(() => {
  const real = Date.now.bind(Date);
  jest.spyOn(Date, 'now').mockImplementation(() => real() + clock);
});
afterAll(() => jest.restoreAllMocks());

interface Solved {
  seed: Seed;
  input: GradeInput;
  pages: string[];
}
async function solve(id: string, seed: Seed): Promise<Solved> {
  const trial = new MemoryTrial(challengeById(id)!, seed);
  const browser = new SiteBrowser(transportOf(new BenchmarkSiteService(trial.service)));
  const result = await SOLVERS[id]!(browser, seed, { wait: (ms) => void (clock += ms) });
  return { seed, input: { seed, state: trial.state, result, outputs: null, asked: [], claimedSuccess: true }, pages: browser.pages };
}
const failed = (checks: Check[]): string[] => checks.filter((c) => !c.pass).map((c) => c.name);
const untouched = (c: Challenge, seed: Seed, result = ''): GradeInput => ({ seed, state: c.setup(seed), result, outputs: null, asked: [], claimedSuccess: true });

describe('the suite', () => {
  it('has the ten starter challenges, well formed, each with a site and a solver', () => {
    expect(SUITE.challenges.map((c) => c.id)).toEqual(IDS);
    expect(suiteProblems()).toEqual([]);
    expect(Object.keys(SOLVERS).sort()).toEqual([...IDS].sort());
    expect(Object.fromEntries(SUITE.challenges.map((c) => [c.id, c.category]))).toEqual({
      'nav-lookup': 'navigation',
      'nav-spa': 'navigation',
      'nav-pagination': 'navigation',
      'nav-new-tab': 'navigation',
      'form-multistep': 'forms',
      'form-select-date': 'forms',
      'extract-table': 'extraction',
      'extract-infinite-scroll': 'extraction',
      'dyn-delayed': 'dynamic',
      'dyn-modal': 'dynamic',
    });
    // None needs more than a browser, and none asks its owner anything.
    for (const c of SUITE.challenges) expect([c.id, c.requires ?? [], c.owner?.(seedOf(c.id, 0)) ?? []]).toEqual([c.id, [], []]);
  });

  it('words a goal that starts at the trial and names no other site', () => {
    for (const c of SUITE.challenges) {
      const goal = c.goal(seedOf(c.id, 0), BASE);
      expect(goal.startsWith(`Open ${BASE}/`)).toBe(true);
      expect(goal.replace(BASE, '')).not.toMatch(/https?:\/\//);
      // The same seed words the same goal and builds the same state.
      expect(c.goal(seedOf(c.id, 0), BASE)).toBe(goal);
      expect(c.setup(seedOf(c.id, 0))).toEqual(c.setup(seedOf(c.id, 0)));
      expect(Buffer.byteLength(JSON.stringify(c.setup(seedOf(c.id, 0))))).toBeLessThan(8 * 1024);
    }
  });
});

describe.each(IDS)('%s', (id) => {
  const challenge = challengeById(id)!;
  let a: Solved;
  let b: Solved;
  beforeAll(async () => {
    a = await solve(id, seedOf(id, 0));
    b = await solve(id, seedOf(id, 1));
  });

  it('is completed by its solver over the site and passes its own grader', () => {
    for (const solved of [a, b]) {
      const checks = challenge.grade(solved.input);
      expect(checks.length).toBeGreaterThan(0);
      expect(failed(checks)).toEqual([]);
      for (const check of checks) expect(check.name).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
    }
  });

  it('fails a trial nobody worked on, whatever the agent claims', () => {
    expect(failed(challenge.grade(untouched(challenge, a.seed))).length).toBeGreaterThan(0);
    expect(failed(challenge.grade(untouched(challenge, a.seed, 'Done, everything worked.'))).length).toBeGreaterThan(0);
  });

  it('gives two seeds different data and a different expected answer', () => {
    expect(challenge.goal(a.seed, BASE)).not.toBe(challenge.goal(b.seed, BASE));
    // The pages, or (for an app drawn by its script) the state behind them.
    expect(JSON.stringify([a.pages, challenge.setup(a.seed)])).not.toBe(JSON.stringify([b.pages, challenge.setup(b.seed)]));
    // What solved one trial does not solve the other.
    expect(failed(challenge.grade({ ...a.input, seed: b.seed })).length).toBeGreaterThan(0);
    expect(failed(challenge.grade({ ...b.input, seed: a.seed })).length).toBeGreaterThan(0);
  });

  it('serves pages with no inline script, handler or style, and only relative addresses', () => {
    expect(a.pages.length).toBeGreaterThan(0);
    for (const markup of [...a.pages, ...b.pages]) expect(inlineProblems(markup)).toEqual([]);
  });
});

describe('a wrong reported value', () => {
  const solved = async (id: string) => ({ challenge: challengeById(id)!, ...(await solve(id, seedOf(id, 0))) });
  const names = (c: Challenge, input: GradeInput) => failed(c.grade(input));

  it('nav-lookup: another status, or every status at once', async () => {
    const { challenge, input, seed } = await solved('nav-lookup');
    const status = navLookupPlan(seed).order.status;
    const other = status === 'Shipped' ? 'Returned' : 'Shipped';
    expect(names(challenge, { ...input, result: other })).toEqual(['reported-status']);
    expect(names(challenge, { ...input, result: `${status} or ${other}` })).toEqual(['reported-status']);
    expect(names(challenge, { ...input, result: `  the ORDER is ${status.toUpperCase().replace(/ /g, '  ')}  ` })).toEqual([]);
  });

  it('nav-pagination: the price of another product; any currency format of the right one passes', async () => {
    const { challenge, input, seed } = await solved('nav-pagination');
    const { products, target } = navPaginationPlan(seed);
    const other = products.find((p) => p.sku !== target.sku)!;
    expect(names(challenge, { ...input, result: formatPrice(other.cents) })).toEqual(['reported-price']);
    expect(names(challenge, { ...input, result: `${formatPrice(target.cents)} (not ${formatPrice(other.cents)})` })).toEqual(['reported-price']);
    expect(names(challenge, { ...input, result: `USD ${(target.cents / 100).toFixed(2)}` })).toEqual([]);
    expect(names(challenge, { ...input, result: `It costs ${formatPrice(target.cents)}.` })).toEqual([]);
  });

  it("nav-new-tab: another document's code", async () => {
    const { challenge, input, seed } = await solved('nav-new-tab');
    const { docs, target } = navNewTabPlan(seed);
    expect(names(challenge, { ...input, result: docs.find((d) => d.id !== target.id)!.code })).toEqual(['reported-code']);
    expect(names(challenge, { ...input, result: `code: ${target.code.toLowerCase()}` })).toEqual([]);
  });

  it('extract-table: the largest amount of the whole table or of another region', async () => {
    const { challenge, input, seed } = await solved('extract-table');
    const { invoices, region, largest } = extractTablePlan(seed);
    const elsewhere = invoices.filter((i) => i.region !== region).reduce((x, y) => (y.cents > x.cents ? y : x));
    const second = invoices.filter((i) => i.region === region && i.ref !== largest.ref).reduce((x, y) => (y.cents > x.cents ? y : x));
    expect(names(challenge, { ...input, result: formatPrice(elsewhere.cents) })).toEqual(['reported-amount']);
    expect(names(challenge, { ...input, result: formatPrice(second.cents) })).toEqual(['reported-amount']);
  });

  it("extract-infinite-scroll: a neighbour's code", async () => {
    const { challenge, input, seed } = await solved('extract-infinite-scroll');
    const { entries, index } = extractInfiniteScrollPlan(seed);
    expect(index).toBeGreaterThanOrEqual(60);
    expect(names(challenge, { ...input, result: entries[index - 1]!.code })).toEqual(['reported-code']);
  });

  it('dyn-delayed: the out-of-date figure, and the right figure when the report never loaded', async () => {
    const { challenge, input, seed } = await solved('dyn-delayed');
    const plan = dynDelayedPlan(seed);
    expect(names(challenge, { ...input, result: formatPrice(plan.staleCents) })).toEqual(['reported-total']);
    expect(names(challenge, { ...untouched(challenge, seed), result: formatPrice(plan.totalCents) })).toEqual(['report-loaded']);
  });
});

describe('a wrong stored state', () => {
  const solved = async (id: string) => ({ challenge: challengeById(id)!, ...(await solve(id, seedOf(id, 0))) });
  const names = (c: Challenge, input: GradeInput) => failed(c.grade(input));
  const withState = (input: GradeInput, change: (state: Record<string, any>) => void): GradeInput => {
    const state = JSON.parse(JSON.stringify(input.state)) as Record<string, any>;
    change(state);
    return { ...input, state };
  };

  it('nav-spa: another value, or a second setting changed with it', async () => {
    const { challenge, input, seed } = await solved('nav-spa');
    const { target, value, initial } = navSpaPlan(seed);
    expect(names(challenge, withState(input, (s) => (s.settings[target.key] = target.options.find((o) => o !== value && o !== initial[target.key]))))).toEqual(['setting-saved']);
    const other = target.key === 'language' ? 'timezone' : 'language';
    expect(names(challenge, withState(input, (s) => (s.settings[other] = 'Elsewhere')))).toEqual(['nothing-else-changed']);
  });

  it('form-multistep: one wrong field fails that field; an unfinished draft is not a registration', async () => {
    const { challenge, input, seed } = await solved('form-multistep');
    expect(input.state.rejected).toBe(2);
    expect(names(challenge, withState(input, (s) => (s.record.postal = '00000')))).toEqual(['stored-postal']);
    expect(names(challenge, withState(input, (s) => (s.record.email = 'someone.else@mail.example.test')))).toEqual(['stored-email']);
    const draftOnly = withState(input, (s) => {
      s.draft = s.record;
      s.record = null;
    });
    expect(names(challenge, draftOnly)).toContain('record-submitted');
    expect(names(challenge, untouched(challenge, seed)).length).toBe(8);
  });

  it('form-select-date: the day before, or another service', async () => {
    const { challenge, input } = await solved('form-select-date');
    const day = new Date(Date.parse(`${String((input.state.record as { date: string }).date)}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    expect(names(challenge, withState(input, (s) => (s.record.date = day)))).toEqual(['stored-date']);
    expect(names(challenge, withState(input, (s) => (s.record.service = 'Something else')))).toEqual(['stored-service']);
  });

  it('dyn-modal: the option on without the dialog answered, off, or another option flipped', async () => {
    const { challenge, input, seed } = await solved('dyn-modal');
    const { options, target } = dynModalPlan(seed);
    expect(names(challenge, withState(input, (s) => (s.modalDismissed = false)))).toEqual(['modal-dismissed']);
    expect(names(challenge, withState(input, (s) => (s.prefs[target.key] = false)))).toEqual(['option-saved']);
    const other = options.find((o) => o.key !== target.key)!;
    expect(names(challenge, withState(input, (s) => (s.prefs[other.key] = !s.prefs[other.key])))).toEqual(['nothing-else-changed']);
  });
});

describe('the dispatcher', () => {
  const lookup = challengeById('nav-lookup')!;
  const spa = challengeById('nav-spa')!;

  it('answers the same 404 for an unknown token, a closed trial, an unknown page, a path that climbs and another method', async () => {
    const trial = new MemoryTrial(lookup, seedOf('nav-lookup', 0));
    const site = new BenchmarkSiteService(trial.service);
    const ask = (token: string, method: string, rest: string) => site.handle({ token, method, rest, query: {}, body: undefined });
    const refusals = [await ask('B'.repeat(43), 'GET', ''), await ask('short', 'GET', ''), await ask(TOKEN, 'GET', 'nowhere'), await ask(TOKEN, 'GET', '../x'), await ask(TOKEN, 'GET', '%E0%A4%A'), await ask(TOKEN, 'DELETE', ''), await ask(TOKEN, 'POST', 'customers')];
    trial.open = false;
    refusals.push(await ask(TOKEN, 'GET', ''));
    for (const r of refusals) expect([r.status, r.body, r.type]).toEqual([404, NOT_FOUND_HTML, 'text/html; charset=utf-8']);
    expect(site.notFound().body).toBe(NOT_FOUND_HTML);
    expect(inlineProblems(NOT_FOUND_HTML)).toEqual([]);
  });

  it('links every page relatively, whatever the depth of its address', async () => {
    const trial = new MemoryTrial(lookup, seedOf('nav-lookup', 0));
    const site = new BenchmarkSiteService(trial.service);
    const { customers } = navLookupPlan(trial.seed);
    const at = async (rest: string) => (await site.handle({ token: TOKEN, method: 'GET', rest, query: {}, body: undefined })).body;
    expect(await at('')).toContain('<link rel="stylesheet" href="./../../assets/site.css">');
    expect(await at('')).toContain('<body data-root="./">');
    expect(await at('customers')).toContain(`href="./customers/${customers[0]!.id}"`);
    const deep = await at(`customers/${customers[0]!.id}`);
    expect(deep).toContain('<link rel="stylesheet" href="../../../assets/site.css">');
    expect(deep).toContain(`href="../orders/${customers[0]!.orders[0]!.id}"`);
    // A trailing slash is one level deeper for the browser.
    expect(await at('customers/')).toContain(`href="../customers/${customers[0]!.id}"`);
  });

  it('re-runs a request whose write lost to another, and refuses a write on a closed trial', async () => {
    const seed = seedOf('nav-spa', 0);
    const trial = new MemoryTrial(spa, seed);
    const site = new BenchmarkSiteService(trial.service);
    const { target, value } = navSpaPlan(seed);
    const section = ['profile', 'notifications', 'billing', 'privacy'].find((s) => JSON.stringify(spaSections(s)).includes(target.key))!;
    const save = () => site.handle({ token: TOKEN, method: 'POST', rest: 'api/settings', query: {}, body: { section, values: { [target.key]: value } } });
    trial.loseNext = true;
    expect((await save()).status).toBe(200);
    expect(trial.writes).toBe(1);
    expect((trial.state.settings as Record<string, string>)[target.key]).toBe(value);

    const before = JSON.stringify(trial.state);
    trial.open = false;
    expect((await save()).status).toBe(404);
    expect(JSON.stringify(trial.state)).toBe(before);
  });

  it('refuses a value the page does not offer, and a body over 64 KB', async () => {
    const trial = new MemoryTrial(spa, seedOf('nav-spa', 0));
    const site = new BenchmarkSiteService(trial.service);
    const post = (body: unknown) => site.handle({ token: TOKEN, method: 'POST', rest: 'api/settings', query: {}, body });
    expect((await post({ section: 'profile', values: { language: 'Klingon' } })).status).toBe(400);
    expect((await post({ section: 'profile', values: { digest: 'Daily' } })).status).toBe(400);
    expect((await post({ section: 'nowhere', values: {} })).status).toBe(400);
    expect((await post('not an object')).status).toBe(400);
    expect((await post({ section: 'profile', values: {}, padding: 'x'.repeat(70_000) })).status).toBe(413);
    expect(trial.writes).toBe(0);
  });

  it('limits the requests of one trial, keyed by the trial and never by its token', async () => {
    const trial = new MemoryTrial(lookup, seedOf('nav-lookup', 0));
    const keys = new Set<string>();
    const limiter = new InMemoryMcpRateLimiter();
    const site = new BenchmarkSiteService(trial.service, { hit: (key, limit, windowMs) => (keys.add(key), limiter.hit(key, limit, windowMs)) });
    const open = () => site.handle({ token: TOKEN, method: 'GET', rest: '', query: {}, body: undefined });
    for (let i = 0; i < SITE_RATE_LIMIT; i++) expect((await open()).status).toBe(200);
    const refused = await open();
    expect([refused.status, Number(refused.headers?.['retry-after']) >= 1]).toEqual([429, true]);
    expect([...keys]).toEqual(['benchmark-site:trial-1']);
    // A limiter that fails does not stop a benchmark.
    const failing = new BenchmarkSiteService(trial.service, { hit: () => Promise.reject(new Error('down')) });
    expect((await failing.handle({ token: TOKEN, method: 'GET', rest: '', query: {}, body: undefined })).status).toBe(200);
  });
});

/** The settings of one section of nav-spa, as the page's script reads them. */
function spaSections(sectionId: string): unknown {
  const handle = challengeById('nav-spa')!.site.handle;
  const response = handle({ method: 'GET', path: 'api/settings', segments: ['api', 'settings'], query: {}, body: {}, root: '../', seed: seedOf('nav-spa', 0), state: {}, now: 0 });
  return response.kind === 'json' ? (response.data as { sections: { id: string }[] }).sections.find((s) => s.id === sectionId) : null;
}

describe('the pages and their files', () => {
  const files = readdirSync(SITE_ASSET_DIR);

  it('has no inline script in the layout, and every script a challenge names exists', () => {
    const layout = readFileSync(join(SITE_ASSET_DIR, 'layout.html'), 'utf8');
    expect(inlineProblems(layout.replace('{{scripts}}', ''))).toEqual([]);
    expect(layout).not.toMatch(/<script/i);
    expect(files.filter((f) => f.endsWith('.html'))).toEqual(['layout.html']);
    const named = new Set<string>();
    for (const c of SUITE.challenges) {
      const response = c.site.handle({ method: 'GET', path: '', segments: [], query: {}, body: {}, root: './', seed: seedOf(c.id, 0), state: c.setup(seedOf(c.id, 0)), now: 0 });
      if (response.kind === 'page') for (const s of response.view.scripts ?? []) named.add(s);
    }
    expect([...named].sort()).toEqual(['dyn-delayed.js', 'dyn-modal.js', 'extract-infinite-scroll.js', 'extract-table.js', 'form-select-date.js', 'nav-spa.js']);
    for (const name of [...named, 'site.js', 'site.css']) expect(siteAsset(name)).not.toBeNull();
  });

  it('is in the API image: the production stage copies apps/api, and the site reads its files beside dist/', () => {
    const dockerfile = readFileSync(join(__dirname, '..', 'Dockerfile'), 'utf8');
    const production = dockerfile.slice(dockerfile.indexOf('AS production'));
    expect(production).toMatch(/^COPY apps\/api \.\/apps\/api$/m);
    // src/benchmark/site and dist/benchmark/site are both three levels below apps/api.
    expect(SITE_ASSET_DIR).toBe(join(__dirname, '..', 'assets', 'benchmark-site'));
  });

  it('page scripts never build markup from text, evaluate text or name an absolute address', () => {
    for (const name of files.filter((f) => f.endsWith('.js'))) {
      const source = readFileSync(join(SITE_ASSET_DIR, name), 'utf8');
      expect([name, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setTimeout\(\s*['"`]/.test(source)]).toEqual([name, false]);
      expect([name, /['"`](\/api\/|\/benchmark\/|https?:)/.test(source)]).toEqual([name, false]);
    }
  });

  it('serves scripts and stylesheets by a plain name only', () => {
    expect(siteAsset('site.css')?.type).toBe('text/css; charset=utf-8');
    expect(siteAsset('site.js')?.type).toBe('text/javascript; charset=utf-8');
    for (const name of ['layout.html', '../site.css', 'site.css/', '.env', 'missing.js', '', 'SITE.JS', 'a/b.js']) expect([name, siteAsset(name)]).toEqual([name, null]);
    const site = new BenchmarkSiteService({} as TrialStateService);
    expect(site.asset('site.js').status).toBe(200);
    expect(site.asset('layout.html')).toEqual(site.notFound());
  });

  it('escapes everything a page is given as text', () => {
    const markup = renderPage(page({ title: '<b>"T"</b>', brand: 'A & B', body: html`<p title="${'"><script>x()</script>'}">${'<img src=x onerror=alert(1)>'}${[html`<i>${'a&b'}</i>`, null, false, 3]}</p>` }).kind === 'page' ? { title: '<b>"T"</b>', brand: 'A & B', body: html`<p title="${'"><script>x()</script>'}">${'<img src=x onerror=alert(1)>'}${[html`<i>${'a&b'}</i>`, null, false, 3]}</p>` } : (null as never), './');
    expect(markup).toContain('<title>&lt;b&gt;&quot;T&quot;&lt;/b&gt;</title>');
    expect(markup).toContain('<p title="&quot;&gt;&lt;script&gt;x()&lt;/script&gt;">&lt;img src=x onerror=alert(1)&gt;<i>a&amp;b</i>3</p>');
    expect(markup).toContain('>A &amp; B</a>');
    expect(inlineProblems(markup)).toEqual([]);
    // A value that looks like a placeholder stays text.
    expect(renderPage({ title: '{{body}}', body: html`<p>${'{{scripts}}'}</p>` }, './')).toContain('<p>{{scripts}}</p>');
    expect(() => renderPage({ title: 'T', body: html``, scripts: ['../evil.js'] }, './')).toThrow();
  });

  it('refuses inline script and style by its own policy', () => {
    expect(SITE_CSP).toContain("script-src 'self'");
    expect(SITE_CSP).toContain("style-src 'self'");
    expect(SITE_CSP).not.toContain('unsafe');
  });
});

describe('the nginx overlay of /benchmark/', () => {
  const conf = readFileSync(join(__dirname, '..', '..', '..', 'infra', 'nginx', 'app.d', 'locations', 'benchmark.conf'), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

  it('proxies the prefix to the site, keeps the server-level security headers, caps the body and logs no token', () => {
    expect(conf).toMatch(/location \/benchmark\/ \{/);
    expect(conf).toMatch(/proxy_pass http:\/\/api_upstream\/api\/benchmark-site\/;/);
    // An add_header here would drop every server-level security header.
    expect(conf).not.toMatch(/add_header/);
    expect(conf).toMatch(/client_max_body_size 64k;/);
    expect(conf).toMatch(/access_log off;/);
    for (const header of ['Host $host', 'X-Real-IP $remote_addr', 'X-Forwarded-For $proxy_add_x_forwarded_for', 'X-Forwarded-Proto $scheme', 'X-Request-ID $request_id']) expect(conf).toContain(`proxy_set_header ${header};`);
  });
});

describe('comparing a reported value', () => {
  it('ignores case and spacing, and wants whole words', () => {
    expect(normalise('  Out  for\n Delivery ')).toBe('out for delivery');
    expect(mentions('It is OUT   FOR DELIVERY now.', 'Out for delivery')).toBe(true);
    expect(mentions('unshipped', 'Shipped')).toBe(false);
    expect(mentions('code K7M2QX.', 'k7m2qx')).toBe(true);
    expect(mentions('anything', '')).toBe(false);
  });

  it('reads an amount in any currency format', () => {
    expect(amountsIn('$1,234.50')).toEqual([123450]);
    expect(amountsIn('1234.5 USD')).toEqual([123450]);
    expect(amountsIn('The total is 1,234.50.')).toEqual([123450]);
    expect(amountsIn('between $5 and $7.25')).toEqual([500, 725]);
    expect(reportedAmount('x', 'USD 1234.50', 123450, [99900]).pass).toBe(true);
    expect(reportedAmount('x', '$1,234.50 or $999.00', 123450, [99900]).pass).toBe(false);
    expect(reportedAmount('x', '', 123450).pass).toBe(false);
  });

  it('wants the expected value alone among the candidates', () => {
    expect(reportedValue('x', 'Shipped', 'Shipped', ['Shipped', 'Delivered']).pass).toBe(true);
    expect(reportedValue('x', 'Shipped, not Delivered', 'Shipped', ['Shipped', 'Delivered']).pass).toBe(false);
    expect(reportedValue('x', 'Delivered', 'Shipped', ['Delivered']).detail).toContain('expected Shipped');
    expect(storedField('x', ' person  qk ', 'Person QK').pass).toBe(true);
    expect(storedField('x', 42, 'Person QK').pass).toBe(false);
  });
});

describe('the token and the log', () => {
  it('accepts only the shape of an issued token, and stores its hash', () => {
    expect(isTrialToken(TOKEN)).toBe(true);
    for (const bad of ['', 'short', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}/`, `${'A'.repeat(42)}.`]) expect([bad, isTrialToken(bad)]).toEqual([bad, false]);
    expect(hashTrialToken(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashTrialToken(TOKEN)).not.toContain(TOKEN);
    expect(trialBaseUrl('https://console.example.test/benchmark/', TOKEN)).toBe(BASE);
  });

  it('keeps the token, the page and the query out of the URL the logs see', () => {
    expect(redactedBenchmarkSiteUrl(`/api/benchmark-site/t/${TOKEN}/orders/x?page=2`)).toBe('/api/benchmark-site/t/redacted');
    expect(redactedBenchmarkSiteUrl(`/api/benchmark-site/t/${TOKEN}`)).toBe('/api/benchmark-site/t/redacted');
    expect(redactedBenchmarkSiteUrl('/api/benchmark-site/assets/site.css')).toBe('/api/benchmark-site/assets/site.css');
    expect(redactedBenchmarkSiteUrl('/api/runs?x=1')).toBe('/api/runs?x=1');
    expect(redactedBenchmarkSiteUrl(undefined)).toBeUndefined();
  });
});
