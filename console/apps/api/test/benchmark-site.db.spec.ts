// The benchmark challenge site (E44.2, #740) over real HTTP and a real, migrated database: every challenge is completed by its solver
// with `app.inject` (form posts, JSON calls, redirects) and passes its own grader from the state the site stored; a token opens its
// trial only while the trial is running; a closed, unknown or malformed token is the same 404 on every route; and the state cannot
// change after the site is closed. The pages carry the site's own headers, and no token reaches the request log.
import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { NOT_FOUND_HTML, SITE_CSP } from '../src/benchmark/site/site.render';
import { TrialStateService, hashTrialToken } from '../src/benchmark/site/trial-state.service';
import { navSpaPlan } from '../src/benchmark/suite/challenges/nav-spa';
import { SUITE, challengeById, seedFrom } from '../src/benchmark/suite/registry';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { SOLVERS, SiteBrowser, inlineProblems, type SiteResult, type SiteTransport } from './support/benchmark-solvers';

let app: NestFastifyApplication;
let prisma: PrismaService;
let trials: TrialStateService;
let benchmarkId = '';
const stamp = `${Date.now()}`;
const logged: string[] = [];
let clock = 0;

const SITE = '/api/benchmark-site';

async function newTrial(challengeId: string, trialIndex = 0, status: 'pending' | 'running' = 'running') {
  const seed = seedFrom(benchmarkId, challengeId, 'builtin:balanced', trialIndex);
  const trial = await prisma.benchmarkTrial.create({ data: { benchmarkId, challengeId, policyRef: 'builtin:balanced', policyLabel: 'Balanced', trialIndex, seed, status } });
  return { id: trial.id, seed, token: await trials.issueToken(trial.id) };
}
const row = (id: string) => prisma.benchmarkTrial.findUniqueOrThrow({ where: { id } });

async function send(token: string, method: 'GET' | 'POST', path: string, body?: { form: Record<string, string> } | { json: unknown }): Promise<SiteResult & { headers: Record<string, unknown> }> {
  const res = await app.inject({
    method,
    url: `${SITE}/t/${token}/${path}`,
    ...(body && 'form' in body ? { headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(body.form).toString() } : {}),
    ...(body && 'json' in body ? { headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body.json) } : {}),
  });
  return { status: res.statusCode, type: String(res.headers['content-type'] ?? ''), body: res.body, location: res.headers.location as string | undefined, headers: res.headers };
}
const transportOf = (token: string): SiteTransport => (method, path, body) => send(token, method, path, body);

beforeAll(async () => {
  const real = Date.now.bind(Date);
  jest.spyOn(Date, 'now').mockImplementation(() => real() + clock);
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
    jest.spyOn(Logger, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
  }
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  trials = app.get(TrialStateService);
  const login = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `bench-site-${stamp}@example.test`, role: 'org_admin' } });
  const session = new URL(String(login.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${session}` } });
  const userId = me.json<{ data: { id: string } }>().data.id;
  benchmarkId = (await prisma.benchmark.create({ data: { userId, name: 'Site', suiteKey: SUITE.key, suiteVersion: SUITE.version, status: 'running', config: {}, appVersion: '0.0.0-test' } })).id;
});
afterAll(async () => {
  if (benchmarkId) await prisma.benchmark.delete({ where: { id: benchmarkId } }).catch(() => undefined);
  await app?.close();
  jest.restoreAllMocks();
});

describe('every challenge, solved over HTTP', () => {
  it.each(SUITE.challenges.map((c) => c.id))('%s is completed with app.inject and passes its own grader', async (id) => {
    const challenge = challengeById(id)!;
    const trial = await newTrial(id);
    const browser = new SiteBrowser(transportOf(trial.token));
    const result = await SOLVERS[id]!(browser, trial.seed, { wait: (ms) => void (clock += ms) });

    // The grader reads what the site stored, after the site is closed.
    await trials.closeToken(trial.id);
    const stored = await trials.read(trial.id);
    const checks = challenge.grade({ seed: trial.seed, state: stored!.state, result, outputs: null, asked: [], claimedSuccess: true });
    expect(checks.filter((c) => !c.pass)).toEqual([]);
    expect(browser.pages.length).toBeGreaterThan(0);
    for (const markup of browser.pages) expect(inlineProblems(markup)).toEqual([]);
    // The same answer against a trial nobody worked on does not pass on the claim alone, unless the task is only to report.
    const fresh = challenge.grade({ seed: trial.seed, state: challenge.setup(trial.seed), result: '', outputs: null, asked: [], claimedSuccess: true });
    expect(fresh.some((c) => !c.pass)).toBe(true);
  });
});

describe("a trial's site", () => {
  it('serves its pages and files with its own headers, no cookie, and a relative redirect to the start page', async () => {
    const trial = await newTrial('nav-lookup', 1);
    const start = await send(trial.token, 'GET', '');
    expect(start.status).toBe(200);
    expect(start.type).toBe('text/html; charset=utf-8');
    expect(start.headers['content-security-policy']).toBe(SITE_CSP);
    expect(start.headers['cache-control']).toBe('no-store');
    expect(start.headers['referrer-policy']).toBe('no-referrer');
    expect(start.headers['x-content-type-options']).toBe('nosniff');
    expect(start.headers['set-cookie']).toBeUndefined();
    expect(start.body).toContain('href="./../../assets/site.css"');

    const css = await app.inject({ method: 'GET', url: `${SITE}/assets/site.css` });
    expect([css.statusCode, css.headers['content-type'], css.headers['x-content-type-options']]).toEqual([200, 'text/css; charset=utf-8', 'nosniff']);
    const js = await app.inject({ method: 'GET', url: `${SITE}/assets/site.js` });
    expect([js.statusCode, js.headers['content-type']]).toEqual([200, 'text/javascript; charset=utf-8']);
    for (const name of ['layout.html', 'missing.js', '..%2Fsite.css']) {
      const res = await app.inject({ method: 'GET', url: `${SITE}/assets/${name}` });
      expect([name, res.statusCode, res.body]).toEqual([name, 404, NOT_FOUND_HTML]);
    }

    const bare = await app.inject({ method: 'GET', url: `${SITE}/t/${trial.token}` });
    expect([bare.statusCode, bare.headers.location]).toEqual([308, `./${trial.token}/`]);
  });

  it('stores only the hash of a token, opens the pages only while the trial is running, and a new token replaces the old', async () => {
    const seed = seedFrom(benchmarkId, 'nav-spa', 'builtin:balanced', 7);
    const created = await prisma.benchmarkTrial.create({ data: { benchmarkId, challengeId: 'nav-spa', policyRef: 'builtin:balanced', policyLabel: 'Balanced', trialIndex: 7, seed, status: 'pending' } });
    const first = await trials.issueToken(created.id);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await row(created.id);
    expect(stored.tokenHash).toBe(hashTrialToken(first));
    expect(JSON.stringify(stored)).not.toContain(first);
    expect(stored.siteState).toEqual(challengeById('nav-spa')!.setup(seed));
    // Not running yet: the token opens nothing.
    expect((await send(first, 'GET', '')).status).toBe(404);
    await prisma.benchmarkTrial.update({ where: { id: created.id }, data: { status: 'running' } });
    expect((await send(first, 'GET', '')).status).toBe(200);

    const second = await trials.issueToken(created.id);
    expect(second).not.toBe(first);
    expect((await send(first, 'GET', '')).status).toBe(404);
    expect((await send(second, 'GET', '')).status).toBe(200);

    // Graded: the token no longer opens it, and its site cannot be opened again.
    await prisma.benchmarkTrial.update({ where: { id: created.id }, data: { status: 'graded' } });
    expect((await send(second, 'GET', '')).status).toBe(404);
    await expect(trials.issueToken(created.id)).rejects.toThrow(/graded/);
    await expect(trials.issueToken('00000000-0000-4000-8000-000000000000')).rejects.toThrow(/does not exist/);
    expect((await row(created.id)).tokenHash).toBe(hashTrialToken(second));
  });

  it('answers the same 404 for an unknown, malformed or closed token on every route', async () => {
    const trial = await newTrial('nav-spa', 2);
    const { target, value } = navSpaPlan(trial.seed);
    expect((await send(trial.token, 'GET', 'api/settings')).status).toBe(200);
    await trials.closeToken(trial.id);
    await trials.closeToken(trial.id);

    const unknown = 'Z'.repeat(43);
    const refusals: (SiteResult & { headers: Record<string, unknown> })[] = [];
    for (const token of [trial.token, unknown, 'short', 'a.b', `${unknown}x`]) {
      refusals.push(await send(token, 'GET', ''));
      refusals.push(await send(token, 'GET', 'api/settings'));
      refusals.push(await send(token, 'GET', 'no/such/page'));
      refusals.push(await send(token, 'POST', 'api/settings', { json: { section: 'profile', values: { [target.key]: value } } }));
      refusals.push(await send(token, 'POST', 'save', { form: { a: 'b' } }));
    }
    for (const r of refusals) expect([r.status, r.body, r.type, r.headers['content-security-policy']]).toEqual([404, NOT_FOUND_HTML, 'text/html; charset=utf-8', SITE_CSP]);
    // A page a running trial does not have is that 404 too.
    const open = await newTrial('nav-lookup', 2);
    const missing = await send(open.token, 'GET', 'no/such/page');
    expect([missing.status, missing.body]).toEqual([404, NOT_FOUND_HTML]);
  });

  it('cannot change its state after it is closed, or once the trial is no longer running', async () => {
    const trial = await newTrial('nav-spa', 3);
    const { target, value, initial } = navSpaPlan(trial.seed);
    const section = (await send(trial.token, 'GET', 'api/settings').then((r) => JSON.parse(r.body) as { sections: { id: string; settings: { key: string }[] }[] })).sections.find((s) => s.settings.some((x) => x.key === target.key))!.id;
    const save = (to: string) => send(trial.token, 'POST', 'api/settings', { json: { section, values: { [target.key]: to } } });
    const other = target.options.find((o) => o !== value && o !== initial[target.key])!;

    expect((await save(other)).status).toBe(200);
    const before = await row(trial.id);
    expect((before.siteState as { settings: Record<string, string> }).settings[target.key]).toBe(other);
    expect(before.siteStateVersion).toBe(2);

    // A request that read the state while the site was open and writes after it closed is refused by the write itself.
    const read = await trials.resolve(trial.token);
    await trials.closeToken(trial.id);
    logged.length = 0;
    expect(await trials.write(trial.id, read!.version, { ...read!.state, settings: { [target.key]: value } })).toBe('closed');
    expect(logged.filter((l) => l.includes('state write refused'))).toEqual([`state write refused: trial ${trial.id} is closed`]);
    expect((await save(value)).status).toBe(404);
    const after = await row(trial.id);
    expect(after.siteState).toEqual(before.siteState);
    expect(after.siteStateVersion).toBe(2);
    expect(after.tokenHash).toBeNull();
    // The grader still reads it.
    expect((await trials.read(trial.id))!.state).toEqual(before.siteState);

    // The same for a trial that left `running` with its token still set.
    const graded = await newTrial('nav-spa', 4);
    const open = await trials.resolve(graded.token);
    await prisma.benchmarkTrial.update({ where: { id: graded.id }, data: { status: 'graded' } });
    expect(await trials.write(graded.id, open!.version, { settings: {} })).toBe('closed');
    expect((await row(graded.id)).siteState).toEqual(challengeById('nav-spa')!.setup(graded.seed));
  });

  it('gives a write that read an older state a conflict, and never overwrites the newer one', async () => {
    const trial = await newTrial('nav-spa', 5);
    const read = await trials.resolve(trial.token);
    expect(await trials.write(trial.id, read!.version, { ...read!.state, saves: 1 })).toBe('written');
    expect(await trials.write(trial.id, read!.version, { ...read!.state, saves: 99 })).toBe('conflict');
    expect((await row(trial.id)).siteState).toMatchObject({ saves: 1 });
    await expect(trials.write(trial.id, read!.version + 1, { blob: 'x'.repeat(70_000) })).rejects.toThrow(/over 65536 bytes/);
  });

  it('refuses a body over 64 KB', async () => {
    const trial = await newTrial('nav-spa', 6);
    const res = await send(trial.token, 'POST', 'api/settings', { json: { section: 'profile', values: {}, padding: 'x'.repeat(70_000) } });
    expect(res.status).toBe(413);
    expect((await row(trial.id)).siteStateVersion).toBe(1);
  });

  it('writes no token, seed or answer to a log', async () => {
    logged.length = 0;
    const trial = await newTrial('nav-lookup', 8);
    const browser = new SiteBrowser(transportOf(trial.token));
    const result = await SOLVERS['nav-lookup']!(browser, trial.seed, { wait: () => undefined });
    await send(trial.token, 'GET', 'no/such/page');
    await send('Z'.repeat(43), 'GET', '');
    const closed = await newTrial('nav-spa', 9);
    await trials.closeToken(closed.id);
    await send(closed.token, 'POST', 'api/settings', { json: { section: 'profile', values: {} } });
    const all = logged.join('\n');
    // The request log is on, and sees every page of a trial as the same address.
    const requests = logged.filter((l) => l.includes('/api/benchmark-site/'));
    expect(requests.length).toBeGreaterThan(5);
    for (const line of requests) expect(line).toMatch(/^(GET|POST) \/api\/benchmark-site\/t\/redacted - \d+ms$/);
    for (const secret of [trial.token, closed.token, trial.seed, closed.seed, 'Z'.repeat(43), result.replace('The status is ', '').replace('.', '')]) expect(all).not.toContain(secret);
  });
});
