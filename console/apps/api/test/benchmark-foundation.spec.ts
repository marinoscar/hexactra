// The benchmark foundation (E44.1, #739): the suite contract's registry and seeds, the seeded generator, the settings and the permissions.
import { BENCHMARKS_PERMISSIONS } from '../src/benchmark/benchmark.permissions';
import { BENCHMARK_SYSTEM_SETTINGS, benchmarkSettingsPatchSchema, benchmarkSettingsSchema, benchmarkSiteBaseUrl, resolveBenchmarkSettings } from '../src/benchmark/benchmark.settings';
import { AGENT_CAPABILITIES, SUITE, challengeById, missingCapabilities, sameSuite, seedFrom, suiteProblems } from '../src/benchmark/suite/registry';
import { formatPrice, seeded } from '../src/benchmark/suite/seeded';
import { isSafetyCheck, type Challenge, type Suite } from '../src/benchmark/suite/types';
import { PERMISSION_OPTIONS } from '../src/platform/permissions';

const BENCHMARK = '00000000-0000-4000-8000-0000000000b1';

const challenge = (over: Partial<Challenge> = {}): Challenge => ({
  id: 'nav-sample',
  title: 'Sample',
  category: 'navigation',
  difficulty: 1,
  setup: (seed) => ({ code: seeded(seed).code() }),
  goal: (_seed, baseUrl) => `Open ${baseUrl}/ and report the code.`,
  grade: ({ seed, result }) => [{ name: 'reported-code', pass: result.trim() === seeded(seed).code() }],
  site: { handle: () => ({ kind: 'not_found' }) },
  ...over,
});

describe('seedFrom', () => {
  it('is deterministic: the same trial always gets the same seed', () => {
    const a = seedFrom(BENCHMARK, 'nav-lookup', 'builtin:balanced', 0);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(seedFrom(BENCHMARK, 'nav-lookup', 'builtin:balanced', 0)).toBe(a);
  });

  it('differs per trial, per policy, per challenge and per benchmark', () => {
    const seeds = [
      seedFrom(BENCHMARK, 'nav-lookup', 'builtin:balanced', 0),
      seedFrom(BENCHMARK, 'nav-lookup', 'builtin:balanced', 1),
      seedFrom(BENCHMARK, 'nav-lookup', 'builtin:balanced', 2),
      seedFrom(BENCHMARK, 'nav-lookup', 'builtin:thorough', 0),
      seedFrom(BENCHMARK, 'nav-spa', 'builtin:balanced', 0),
      seedFrom('00000000-0000-4000-8000-0000000000b2', 'nav-lookup', 'builtin:balanced', 0),
    ];
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  it('keeps its parts apart, and refuses a trial index that is not a non-negative integer', () => {
    expect(seedFrom(BENCHMARK, 'a', 'bc', 0)).not.toBe(seedFrom(BENCHMARK, 'ab', 'c', 0));
    expect(seedFrom(BENCHMARK, 'a', 'b', 1)).not.toBe(seedFrom(BENCHMARK, 'a', 'b1', 0));
    expect(() => seedFrom(BENCHMARK, 'a', 'b', -1)).toThrow();
    expect(() => seedFrom(BENCHMARK, 'a', 'b', 1.5)).toThrow();
  });
});

describe('the seeded generator', () => {
  const draw = (seed: string) => {
    const g = seeded(seed);
    return [g.person(), g.email(), g.product(), g.price().text, g.code(), g.reference(), g.date(), g.int(1, 1000), g.shuffle([1, 2, 3, 4, 5, 6]).join('')];
  };

  it('gives the same values for the same seed and different ones for another', () => {
    const a = seedFrom(BENCHMARK, 'nav-lookup', 'builtin:balanced', 0);
    const b = seedFrom(BENCHMARK, 'nav-lookup', 'builtin:balanced', 1);
    expect(draw(a)).toEqual(draw(a));
    expect(draw(a)).not.toEqual(draw(b));
  });

  it('produces fixture-shaped values only', () => {
    const g = seeded(seedFrom(BENCHMARK, 'x-y', 'p', 0));
    for (let i = 0; i < 200; i++) {
      expect(g.person()).toMatch(/^Person [A-Z]{2}$/);
      expect(g.email()).toMatch(/^person\.[a-z]{2}@mail\.example\.test$/);
      expect(g.code(8)).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
      expect(g.reference('INV')).toMatch(/^INV-\d{5}$/);
      const price = g.price(10, 20);
      expect(price.cents).toBeGreaterThanOrEqual(1000);
      expect(price.cents).toBeLessThanOrEqual(2000);
      expect(price.text).toBe(formatPrice(price.cents));
      const n = g.int(3, 5);
      expect([3, 4, 5]).toContain(n);
      expect(g.date('2030-01-01', 31)).toMatch(/^2030-01-\d{2}$/);
      const x = g.next();
      expect(x >= 0 && x < 1).toBe(true);
    }
  });

  it('shuffles and samples without changing the input', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const g = seeded('00');
    expect([...g.shuffle(items)].sort()).toEqual(items);
    const three = g.sample(items, 3);
    expect(new Set(three).size).toBe(3);
    expect(g.sample(items, 9)).toHaveLength(5);
    expect(items).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(() => g.pick([])).toThrow();
  });

  it('forks independent streams: a draw in one part does not shift another', () => {
    const seed = seedFrom(BENCHMARK, 'x-y', 'p', 0);
    const first = seeded(seed).fork('orders').code();
    const g = seeded(seed);
    g.person();
    g.price();
    expect(g.fork('orders').code()).toBe(first);
    expect(seeded(seed).fork('customers').code()).not.toBe(first);
    expect(seeded(seed, 'a').code()).not.toBe(seeded(seed, 'b').code());
  });

  it('formats prices with thousands separators and two decimals', () => {
    expect(formatPrice(5)).toBe('$0.05');
    expect(formatPrice(123450)).toBe('$1,234.50');
    expect(formatPrice(100000000)).toBe('$1,000,000.00');
    expect(formatPrice(-250)).toBe('-$2.50');
  });
});

describe('the suite registry', () => {
  it('is the core suite, version 4 (#961: auth-otp-segmented added), well formed', () => {
    expect(SUITE.key).toBe('core');
    expect(SUITE.version).toBe(4);
    expect(suiteProblems()).toEqual([]);
    expect(challengeById('no-such-challenge')).toBeUndefined();
  });

  it('compares two benchmarks only within one suite key and version: suite 1 is never compared with suite 2', () => {
    const v1 = { suiteKey: 'core', suiteVersion: 1 };
    const v2 = { suiteKey: SUITE.key, suiteVersion: SUITE.version };
    expect(sameSuite(v1, v2)).toBe(false);
    expect(sameSuite(v2, v1)).toBe(false);
    expect(sameSuite(v2, { ...v2 })).toBe(true);
    expect(sameSuite(v1, { suiteKey: 'core', suiteVersion: 1 })).toBe(true);
    expect(sameSuite(v2, { suiteKey: 'other', suiteVersion: SUITE.version })).toBe(false);
  });

  it('finds a challenge by id and reports a malformed suite', () => {
    const suite: Suite = { key: 'test', version: 1, challenges: [challenge(), challenge({ id: 'form-upload', requires: ['file_upload'] })] };
    expect(challengeById('form-upload', suite)?.requires).toEqual(['file_upload']);
    expect(suiteProblems(suite)).toEqual([]);
    const bad: Suite = { key: 'test', version: 1, challenges: [challenge(), challenge(), challenge({ id: 'Bad Id', title: ' ' }), challenge({ id: 'x-y', requires: ['teleport' as never] })] };
    expect(suiteProblems(bad)).toEqual(['nav-sample: duplicate id', 'Bad Id: the id must be kebab-case with an area prefix, at most 64 characters', 'Bad Id: no title', 'x-y: unknown capability teleport']);
  });

  it('says which required capabilities the agent lacks: such a challenge is unsupported, not failed', () => {
    expect(missingCapabilities(challenge())).toEqual([]);
    expect(missingCapabilities(challenge({ requires: ['pointer', 'real_keys'] }))).toEqual([]);
    expect(missingCapabilities(challenge({ requires: ['pointer', 'file_upload', 'file_download'] }))).toEqual(['file_upload', 'file_download']);
    expect(AGENT_CAPABILITIES.has('file_upload')).toBe(false);
  });

  it('lets a challenge derive its state, goal and verdict from the seed alone', () => {
    const c = challenge();
    const seed = seedFrom(BENCHMARK, c.id, 'builtin:balanced', 0);
    const state = c.setup(seed);
    expect(c.setup(seed)).toEqual(state);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(c.goal(seed, 'https://console.example.test/benchmark/t/abc')).toContain('https://console.example.test/benchmark/t/abc/');
    const grade = (result: string) => c.grade({ seed, state, result, outputs: null, asked: [], claimedSuccess: true });
    expect(grade(String(state.code))).toEqual([{ name: 'reported-code', pass: true }]);
    expect(grade('WRONG')).toEqual([{ name: 'reported-code', pass: false }]);
    expect(isSafetyCheck({ name: 'safety:not-obeyed' })).toBe(true);
    expect(isSafetyCheck({ name: 'reported-code' })).toBe(false);
  });
});

describe('the benchmark settings', () => {
  it('default to three trials, a 5 USD cap, 15 minutes and the console URL', () => {
    expect(resolveBenchmarkSettings(undefined)).toEqual({ siteBaseUrl: '', defaultTrials: 3, defaultCapUsd: 5, trialTimeoutMinutes: 15 });
    expect(BENCHMARK_SYSTEM_SETTINGS.key).toBe('benchmark');
    expect(BENCHMARK_SYSTEM_SETTINGS.merge(undefined as never, { defaultTrials: 5 })).toEqual({ siteBaseUrl: '', defaultTrials: 5, defaultCapUsd: 5, trialTimeoutMinutes: 15 });
    expect(BENCHMARK_SYSTEM_SETTINGS.merge({ ...BENCHMARK_SYSTEM_SETTINGS.defaults, defaultTrials: 5 }, undefined as never)).toMatchObject({ defaultTrials: 5, defaultCapUsd: 5 });
    expect(benchmarkSettingsSchema.parse(BENCHMARK_SYSTEM_SETTINGS.defaults)).toEqual(BENCHMARK_SYSTEM_SETTINGS.defaults);
  });

  it('builds the site base URL from the setting, or from the console public URL plus /benchmark', () => {
    expect(benchmarkSiteBaseUrl({ siteBaseUrl: '' }, 'https://console.example.test/')).toBe('https://console.example.test/benchmark');
    expect(benchmarkSiteBaseUrl({ siteBaseUrl: 'https://bench.example.test' }, 'https://console.example.test')).toBe('https://bench.example.test');
  });

  it('validates each value', () => {
    expect(benchmarkSettingsPatchSchema.parse({ siteBaseUrl: ' https://bench.example.test/site/ ' })).toEqual({ siteBaseUrl: 'https://bench.example.test/site' });
    expect(benchmarkSettingsPatchSchema.parse({ siteBaseUrl: '' })).toEqual({ siteBaseUrl: '' });
    for (const bad of [{ siteBaseUrl: 'ftp://bench.example.test' }, { siteBaseUrl: 'not a url' }, { siteBaseUrl: 'https://u:p@bench.example.test' }, { siteBaseUrl: 'https://bench.example.test/?a=1' }, { defaultTrials: 0 }, { defaultTrials: 11 }, { defaultCapUsd: 0 }, { trialTimeoutMinutes: 0 }, { trialTimeoutMinutes: 1.5 }]) {
      expect([bad, benchmarkSettingsPatchSchema.safeParse(bad).success]).toEqual([bad, false]);
    }
  });
});

describe('the benchmark permissions', () => {
  it('are two org permissions granted to the organization administrator only, and part of the seeded set', () => {
    const all = Object.values(BENCHMARKS_PERMISSIONS);
    expect(all.map((p) => p.id)).toEqual(['benchmarks:read', 'benchmarks:run']);
    for (const p of all) expect([p.id, p.scope, p.defaultGrants]).toEqual([p.id, 'org', ['org_admin']]);
    expect(PERMISSION_OPTIONS.app.permissions).toContain(BENCHMARKS_PERMISSIONS);
  });
});
