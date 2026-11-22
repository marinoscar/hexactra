import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { createCli } from '@marinoscar/platform-cli';
import { ApiClient, ApiError } from '@marinoscar/platform-cli/api-client';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';
import { benchmarkRequest, benchmarksCommand, setBenchmarkExportTarget, setBenchmarkPollMs } from './benchmarks.command.js';
import { comparisonText, deltaLine, exportFilename, parsePolicyFlag, rate, recordingLength, recordingSummary, scorecardText, trialLines, usd, withCode, type BenchmarkTrialView, type BenchmarkView, type ComparisonView, type ScoreMetricsView, type ScorecardView, type SuiteView } from './benchmarks.js';
import { setConsoleApiFactory } from './console-api.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

const ID = '11111111-1111-4111-8111-111111111111';
const BASE = '22222222-2222-4222-8222-222222222222';
const HOST = '33333333-3333-4333-8333-333333333333';

function benchmark(over: Partial<BenchmarkView> = {}): BenchmarkView {
  return {
    id: ID,
    name: 'Economy against Thorough',
    status: 'completed',
    suiteKey: 'core',
    suiteVersion: 2,
    config: { challengeIds: ['nav-lookup', 'form-multistep'], policies: [{ ref: 'builtin:economy', label: 'Economy' }, { ref: 'builtin:thorough', label: 'Thorough' }], trials: 3, hostId: null, profile: 'default', capUsd: 10, trialTimeoutMinutes: 15 },
    appVersion: '1.120.0',
    commit: 'abcdef0123456789',
    spentUsd: 1.5,
    progress: { total: 12, pending: 0, running: 0, graded: 12, skipped: 0, pass: 9, fail: 3, error: 0, unsupported: 0 },
    totals: { inputTokens: 120_000, outputTokens: 8_000, cachedInputTokens: 40_000, modelCalls: 60, costUsd: 1.5, costKnown: true },
    createdAt: '2026-11-21T10:00:00.000Z',
    startedAt: '2026-11-21T10:00:01.000Z',
    finishedAt: '2026-11-21T11:00:00.000Z',
    ...over,
  };
}

const RUN = '55555555-5555-4555-8555-555555555555';

function trial(over: Partial<BenchmarkTrialView> = {}): BenchmarkTrialView {
  return { id: 't1', challengeId: 'nav-lookup', policyLabel: 'Economy', trialIndex: 0, status: 'graded', verdict: 'pass', failureReason: null, claimedSuccess: true, runId: RUN, activeMs: 30_000, steps: 8, inputTokens: 5_000, outputTokens: 400, cachedInputTokens: 2_000, model: 'openai:model-a', costUsd: 0.05, costKnown: true, ...over };
}

const r = (k: number, n: number) => ({ k, n, value: n ? k / n : null, low: n ? 0.2 : null, high: n ? 0.9 : null });

function metrics(over: { pass: number; judged: number; input: number; output: number; cached: number; cost: number; known?: boolean }): ScoreMetricsView {
  const total = over.input + over.output;
  return {
    counts: { total: over.judged, judged: over.judged, pass: over.pass, fail: over.judged - over.pass, error: 0, skipped: 0, unsupported: 0, unfinished: 0 },
    successRate: r(over.pass, over.judged),
    passAllK: { k: 3, challenges: 2, allPassed: 1, rate: r(1, 2) },
    falseSuccess: r(1, over.judged),
    speed: { medianActiveMs: 42_000, p90ActiveMs: 90_000, medianSteps: 9, medianModelCalls: 5 },
    cost: { totalUsd: over.cost, known: over.known ?? true, medianPerTrialUsd: over.cost / over.judged, perSuccessUsd: over.pass ? over.cost / over.pass : null },
    tokens: { input: over.input, output: over.output, cached: over.cached, total, medianInput: over.input / over.judged, medianOutput: over.output / over.judged, medianCached: over.cached / over.judged, perSuccess: over.pass ? total / over.pass : null },
    failureReasons: over.pass < over.judged ? [{ key: 'wrong_result', count: over.judged - over.pass }] : [],
    safety: { flaggedTrials: 0, checks: [] },
    models: ['openai:model-a'],
  };
}

function scorecard(over: Partial<ScorecardView> = {}): ScorecardView {
  const eco = metrics({ pass: 3, judged: 6, input: 30_000, output: 3_000, cached: 10_000, cost: 0.25, known: false });
  const tho = metrics({ pass: 6, judged: 6, input: 90_000, output: 5_000, cached: 30_000, cost: 1.25 });
  return {
    benchmarkId: ID,
    name: 'Economy against Thorough',
    status: 'completed',
    live: false,
    suiteKey: 'core',
    suiteVersion: 2,
    k: 3,
    totals: { costUsd: 1.5, costKnown: false, inputTokens: 120_000, outputTokens: 8_000, cachedInputTokens: 40_000, totalTokens: 128_000, modelCalls: 60, counts: { total: 12, judged: 12, pass: 9, fail: 3, error: 0, skipped: 0, unsupported: 0, unfinished: 0 } },
    ranking: [
      { rank: 1, ref: 'builtin:thorough', label: 'Thorough' },
      { rank: 2, ref: 'builtin:economy', label: 'Economy' },
    ],
    policies: [
      { ref: 'builtin:economy', label: 'Economy', rank: 2, metrics: eco, categories: [{ category: 'navigation', label: 'Navigation', metrics: eco }] },
      { ref: 'builtin:thorough', label: 'Thorough', rank: 1, metrics: tho, categories: [] },
    ],
    ...over,
  };
}

const SUITE: SuiteView = {
  key: 'core',
  version: 2,
  categories: [
    { id: 'navigation', label: 'Navigation' },
    { id: 'forms', label: 'Forms' },
  ],
  challenges: [
    { id: 'nav-lookup', title: "Find an order's status", category: 'navigation', difficulty: 1, requires: [], supported: true, missing: [], confirmRiskyActions: false },
    { id: 'form-upload', title: 'Upload a file', category: 'forms', difficulty: 2, requires: ['file_upload'], supported: false, missing: ['file_upload'], confirmRiskyActions: false },
  ],
  defaults: { trials: 3, capUsd: 5, trialTimeoutMinutes: 15 },
  limits: { maxPolicies: 8, maxTrials: 10, maxCapUsd: 500, maxTrialTimeoutMinutes: 120 },
  site: { baseUrl: 'https://console.example.test/benchmark', reachable: true, problem: null },
};

const COMPARISON: ComparisonView = {
  current: { id: ID, name: 'After', suiteKey: 'core', suiteVersion: 2, appVersion: '1.120.0', commit: 'abcdef0' },
  baseline: { id: BASE, name: 'Before', suiteKey: 'core', suiteVersion: 2, appVersion: '1.119.0', commit: null },
  totals: [
    { metric: 'totalCostUsd', current: 1.5, baseline: 2, delta: -0.5, better: 'lower', improved: true, withinNoise: null, atLeast: false },
    { metric: 'totalTokens', current: 128_000, baseline: 100_000, delta: 28_000, better: 'lower', improved: false, withinNoise: null, atLeast: false },
    { metric: 'inputTokens', current: 120_000, baseline: 90_000, delta: 30_000, better: 'lower', improved: false, withinNoise: null, atLeast: false },
    { metric: 'outputTokens', current: 8_000, baseline: 10_000, delta: -2_000, better: 'lower', improved: true, withinNoise: null, atLeast: false },
    { metric: 'cachedInputTokens', current: 40_000, baseline: 0, delta: 40_000, better: 'lower', improved: false, withinNoise: null, atLeast: false },
  ],
  policies: [
    {
      ref: 'builtin:economy',
      label: 'Economy',
      baselineRef: 'builtin:economy',
      baselineLabel: 'Economy',
      matchedBy: 'ref',
      deltas: [
        { metric: 'successRate', current: 0.5, baseline: 0.33, delta: 0.17, better: 'higher', improved: null, withinNoise: true, atLeast: false },
        { metric: 'totalCostUsd', current: 0.2, baseline: 0.25, delta: -0.05, better: 'lower', improved: true, withinNoise: null, atLeast: true },
        { metric: 'inputTokens', current: 25_000, baseline: 30_000, delta: -5_000, better: 'lower', improved: true, withinNoise: null, atLeast: false },
        { metric: 'outputTokens', current: 2_500, baseline: 3_000, delta: -500, better: 'lower', improved: true, withinNoise: null, atLeast: false },
        { metric: 'cachedInputTokens', current: 12_000, baseline: 10_000, delta: 2_000, better: 'lower', improved: false, withinNoise: null, atLeast: false },
      ],
    },
  ],
  unmatched: { current: [{ ref: 'builtin:thorough', label: 'Thorough' }], baseline: [] },
  flipped: [{ challengeId: 'nav-lookup', policyLabel: 'Economy', baseline: { outcome: 'fail', passes: 0, judged: 3 }, current: { outcome: 'pass', passes: 3, judged: 3 }, direction: 'better' }],
};

type Route = (url: URL, init: RequestInit | undefined) => { status?: number; body: unknown } | undefined;

/** A console: each request is offered to `route`; the JSON answer is wrapped in the `{ data }` envelope. */
function fakeConsole(route: Route): { seen: { method: string; url: URL; body: unknown }[] } {
  const seen: { method: string; url: URL; body: unknown }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const answer = route(url, init);
    if (!answer) return new Response(JSON.stringify({ statusCode: 404, code: 'NOT_FOUND', message: `no fake for ${url.pathname}` }), { status: 404 });
    const status = answer.status ?? 200;
    return new Response(JSON.stringify(status < 300 ? { data: answer.body } : answer.body), { status, headers: { 'content-type': 'application/json' } });
  });
  setConsoleApiFactory(() => new ApiClient({ baseUrl: 'http://console.example.test/api', token: 'pat_test', fetch }));
  return { seen };
}

async function run(...args: string[]): Promise<{ out: string; err: string }> {
  const program = new Command().exitOverride();
  benchmarksCommand(program);
  let out = '';
  let err = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  const spyErr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
  try {
    await program.parseAsync(['node', 'hexactra', ...args]);
  } finally {
    spy.mockRestore();
    spyErr.mockRestore();
  }
  return { out, err };
}

afterEach(() => {
  setConsoleApiFactory(null);
  setBenchmarkExportTarget(null);
  setBenchmarkPollMs(5_000);
  process.exitCode = undefined;
});

describe('benchmark helpers', () => {
  it('formats money, rates and deltas', () => {
    expect(usd(1.234)).toBe('$1.23');
    expect(usd(0.0042)).toBe('$0.0042');
    expect(usd(2, false)).toBe('≥ $2.00');
    expect(usd(null)).toBe('-');
    expect(rate({ k: 2, n: 3, value: 2 / 3, low: 0.208, high: 0.939 })).toBe('67% (2/3, 21-94%)');
    expect(rate({ k: 0, n: 0, value: null, low: null, high: null })).toBe('- (0/0)');
    expect(deltaLine(COMPARISON.totals[0]!)).toMatch(/total cost\s+\$2\.00 -> \$1\.50\s+-\$0\.50\s+better/);
    expect(deltaLine(COMPARISON.policies[0]!.deltas[0]!)).toMatch(/success rate\s+33% -> 50%\s+\+17%\s+within noise/);
  });

  it('parses --policy with an optional label', () => {
    expect(parsePolicyFlag('builtin:economy')).toEqual({ ref: 'builtin:economy' });
    expect(parsePolicyFlag('builtin:thorough=Frontier only')).toEqual({ ref: 'builtin:thorough', label: 'Frontier only' });
    expect(() => parsePolicyFlag('=x')).toThrow(/--policy/);
  });

  it('takes the file name from content-disposition, never a path', () => {
    expect(exportFilename(ID, 'attachment; filename="hexactra-benchmark-11111111-20261121.pdf"', 'pdf')).toBe('hexactra-benchmark-11111111-20261121.pdf');
    expect(exportFilename(ID, 'attachment; filename="../../etc/passwd"', 'csv')).toBe('hexactra-benchmark-11111111.csv');
    expect(exportFilename(ID, 'attachment; filename="a/b.csv"', 'csv')).toBe('a_b.csv');
    expect(exportFilename(ID, null, 'csv')).toBe('hexactra-benchmark-11111111.csv');
  });

  it('adds the API code to a refusal and keeps it an ApiError (non-zero exit)', () => {
    const e = ApiError.fromBody({ status: 400, statusText: 'Bad Request', rawBody: JSON.stringify({ statusCode: 400, code: 'CHALLENGE_UNKNOWN', message: 'The suite has no challenge "nope".' }), method: 'POST', url: 'http://x/api/benchmarks' });
    const coded = withCode(e) as ApiError;
    expect(coded).toBeInstanceOf(ApiError);
    expect(coded.message).toBe('400 CHALLENGE_UNKNOWN: The suite has no challenge "nope".');
    expect(coded.exitCode).toBe(3);
    const plain = new Error('x');
    expect(withCode(plain)).toBe(plain);
  });

  it('prints tokens (input, output, cached) and cost for the benchmark, each policy and each category', () => {
    const text = scorecardText(benchmark(), scorecard()).join('\n');
    expect(text).toContain('Tokens     128,000 (in 120,000 / out 8,000 / cached 40,000), 60 model calls');
    expect(text).toContain('Cost       ≥ $1.50 of a $10.00 cap');
    // Ranked: Thorough first.
    expect(text.indexOf('#1 Thorough')).toBeLessThan(text.indexOf('#2 Economy'));
    expect(text).toMatch(/#2 Economy[\s\S]*success\s+50% \(3\/6, 20-90%\)/);
    expect(text).toMatch(/#2 Economy[\s\S]*tokens\s+33,000 \(in 30,000 \/ out 3,000 \/ cached 10,000\)/);
    expect(text).toMatch(/#2 Economy[\s\S]*cost\s+≥ \$0\.25\s+median per trial ≥ \$0\.04\s+per success ≥ \$0\.08/);
    expect(text).toMatch(/#1 Thorough[\s\S]*cost\s+\$1\.25 .*per success \$0\.21/);
    expect(text).toMatch(/Navigation\s+50% \(3\/6\)\s+33,000 tok \(in 30,000 \/ out 3,000 \/ cached 10,000\)\s+≥ \$0\.25/);
    expect(text).toContain('failures    wrong_result 3');
  });

  it("prints each trial's recording state, and the run page URL of a ready one (#863)", () => {
    expect([recordingLength(45_000), recordingLength(72_000), recordingLength(3_725_000), recordingLength(0)]).toEqual(['45s', '1m12s', '1h02m05s', '0s']);
    const lines = trialLines(
      [
        trial({ recording: { status: 'ready', durationMs: 72_000 } }),
        trial({ id: 't2', trialIndex: 1, recording: { status: 'processing', durationMs: null } }),
        trial({ id: 't3', trialIndex: 2, recording: { status: 'recording', durationMs: null } }),
        trial({ id: 't4', trialIndex: 3, recording: { status: 'failed', durationMs: null } }),
        trial({ id: 't5', trialIndex: 4, recording: null }),
      ],
      { webUrl: 'https://console.example.test/' },
    );
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatch(/#1 .*run 55555555 {2}rec ready 1m12s$/);
    expect(lines[1]).toBe(`      https://console.example.test/runs/${RUN}#recording`);
    expect(lines[2]).toMatch(/#2 .*run 55555555 {2}rec processing$/);
    expect(lines[3]).toMatch(/#3 .*rec recording$/);
    expect(lines[4]).toMatch(/#4 .*rec failed$/);
    expect(lines[5]).toMatch(/#5 .*run 55555555$/);
    // No console URL: the path.
    expect(trialLines([trial({ recording: { status: 'ready', durationMs: 72_000 } })])[1]).toBe(`      /runs/${RUN}#recording`);
  });

  it('counts the recordings in the summary, and prints nothing extra for an older console without the field (#863)', () => {
    const recorded = [
      trial({ recording: { status: 'ready', durationMs: 1000 } }),
      trial({ recording: { status: 'ready', durationMs: 2000 } }),
      trial({ recording: { status: 'processing', durationMs: null } }),
      trial({ recording: { status: 'recording', durationMs: null } }),
      trial({ recording: { status: 'failed', durationMs: null } }),
      trial({ recording: null }),
    ];
    expect(recordingSummary(recorded)).toBe('  Recordings 2 ready, 2 processing, 1 failed');
    const text = scorecardText(benchmark(), scorecard(), recorded);
    expect(text[text.findIndex((l) => l.startsWith('  Cost')) + 1]).toBe('  Recordings 2 ready, 2 processing, 1 failed');
    // Older console: no `recording` field at all. Nothing recorded: every one null.
    const older = [trial(), trial({ id: 't2' })];
    expect(trialLines(older, { webUrl: 'https://console.example.test' })).toHaveLength(2);
    expect(trialLines(older).join('\n')).not.toMatch(/rec |#recording/);
    expect(recordingSummary(older)).toBeNull();
    expect(recordingSummary([trial({ recording: null })])).toBeNull();
    expect(recordingSummary(undefined)).toBeNull();
    expect(scorecardText(benchmark(), scorecard(), older)).toEqual(scorecardText(benchmark(), scorecard()));
  });
});

describe('hexactra benchmarks', () => {
  it('suite prints the challenges, the unsupported ones and the site', async () => {
    fakeConsole((u) => (u.pathname === '/api/benchmarks/suite' ? { body: SUITE } : undefined));
    const { out } = await run('benchmarks', 'suite');
    expect(out).toContain('Suite core, version 2: 2 challenges (1 the agent can attempt)');
    expect(out).toContain('https://console.example.test/benchmark (reachable from a node)');
    expect(out).toMatch(/form-upload .*\[unsupported: needs file_upload\]/);
  });

  it('list prints one line per benchmark with passes and spend', async () => {
    const { seen } = fakeConsole((u) => (u.pathname === '/api/benchmarks' ? { body: { items: [benchmark()], total: 3 } } : undefined));
    const { out } = await run('benchmarks', 'list', '--limit', '1');
    expect(seen[0]!.url.searchParams.get('limit')).toBe('1');
    expect(out).toMatch(/^11111111 {2}completed .*core v2 {3}2 policies {2}9\/12 passed, 12\/12 done {2}\$1\.50/m);
    expect(out).toContain('(1 of 3; --limit shows more)');
  });

  it('run sends the flags, resolves a policy name and a node name', async () => {
    const { seen } = fakeConsole((u, init) => {
      if (u.pathname === '/api/agent-policies') return { body: [{ id: '44444444-4444-4444-8444-444444444444', name: 'Pinned A', builtin: false, description: null, version: 1, isDefault: false, hasNoHardStop: false, usage: { tasks: 0, schedules: 0 }, spec: {} }] };
      if (u.pathname === '/api/fleet/hosts') return { body: [{ id: HOST, name: 'home-node', online: true }] };
      if (u.pathname === '/api/benchmarks' && init?.method === 'POST') return { status: 201, body: benchmark({ status: 'queued' }) };
      return undefined;
    });
    const { out } = await run('benchmarks', 'run', '--policy', 'builtin:economy', '--policy', 'Pinned A=Model A', '--challenge', 'nav-lookup', '--trials', '3', '--cap-usd', '10', '--host', 'home-node', '--profile', 'bench', '--name', 'Nightly');
    const post = seen.find((s) => s.method === 'POST')!;
    expect(post.body).toEqual({
      name: 'Nightly',
      policies: [{ ref: 'builtin:economy' }, { ref: '44444444-4444-4444-8444-444444444444', label: 'Model A' }],
      challengeIds: ['nav-lookup'],
      trials: 3,
      capUsd: 10,
      hostId: HOST,
      profile: 'bench',
    });
    expect(out).toContain(`started ${ID} (12 trials, cap $10)`);
  });

  it('run refuses bad flags before any request', async () => {
    await expect(benchmarkRequest({})).rejects.toThrow(/at least one policy/);
    await expect(benchmarkRequest({ policy: ['builtin:economy'], trials: '1.5' })).rejects.toThrow(/--trials takes a whole number/);
    // `0` (#844) or `none` (#840): no budget, with either spelling of the flag; a negative amount is refused.
    expect((await benchmarkRequest({ policy: ['builtin:economy'], capUsd: '0' })).capUsd).toBeNull();
    expect((await benchmarkRequest({ policy: ['builtin:economy'], cap: '0' })).capUsd).toBeNull();
    expect((await benchmarkRequest({ policy: ['builtin:economy'], cap: '12.5' })).capUsd).toBe(12.5);
    await expect(benchmarkRequest({ policy: ['builtin:economy'], cap: '-1' })).rejects.toThrow(/--cap takes an amount/);
    await expect(benchmarkRequest({ policy: ['builtin:economy'], capUsd: 'lots' })).rejects.toThrow(/--cap-usd/);
    await expect(benchmarkRequest({ policy: ['builtin:economy'], cap: '1', capUsd: '2' })).rejects.toThrow(/once/);
    // `--cap-usd none`: no spend cap (#840).
    expect((await benchmarkRequest({ policy: ['builtin:economy'], capUsd: 'none' })).capUsd).toBeNull();
    // `--record` (#841).
    expect((await benchmarkRequest({ policy: ['builtin:economy'], record: true })).recordVideo).toBe(true);
    expect(await benchmarkRequest({ policy: ['builtin:economy'] })).not.toHaveProperty('recordVideo');
  });

  it('run --wait follows the benchmark, prints the scorecard and exits 0 when it completes', async () => {
    setBenchmarkPollMs(1);
    let polls = 0;
    fakeConsole((u, init) => {
      if (u.pathname === '/api/benchmarks' && init?.method === 'POST') return { status: 201, body: benchmark({ status: 'queued' }) };
      if (u.pathname === `/api/benchmarks/${ID}`) {
        polls += 1;
        return { body: polls < 2 ? benchmark({ status: 'running', progress: { ...benchmark().progress, graded: 4, pass: 3, fail: 1, pending: 8 } }) : benchmark() };
      }
      if (u.pathname === `/api/benchmarks/${ID}/scorecard`) return { body: scorecard() };
      return undefined;
    });
    const { out } = await run('benchmarks', 'run', '--policy', 'builtin:economy', '--wait');
    expect(out).toContain('[running] 4/12 trials: 3 pass, 1 fail');
    expect(out).toContain('[completed] 12/12 trials');
    expect(out).toContain('#1 Thorough');
    expect(process.exitCode).toBeUndefined();
  });

  it.each(['failed', 'cancelled'])('run --wait exits non-zero when the benchmark is %s', async (status) => {
    setBenchmarkPollMs(1);
    fakeConsole((u, init) => {
      if (u.pathname === '/api/benchmarks' && init?.method === 'POST') return { status: 201, body: benchmark({ status: 'queued' }) };
      if (u.pathname === `/api/benchmarks/${ID}`) return { body: benchmark({ status }) };
      if (u.pathname === `/api/benchmarks/${ID}/scorecard`) return { body: scorecard({ status }) };
      return undefined;
    });
    const { err } = await run('benchmarks', 'run', '--policy', 'builtin:economy', '--wait');
    expect(err).toContain(`benchmark ${status}`);
    expect(process.exitCode).toBe(1);
  });

  it('run prints a refusal with its code and fails', async () => {
    fakeConsole((u) => (u.pathname === '/api/benchmarks' ? { status: 400, body: { statusCode: 400, code: 'BENCHMARK_SITE_UNREACHABLE', message: 'A node cannot reach http://localhost/benchmark.' } } : undefined));
    const e = await run('benchmarks', 'run', '--policy', 'builtin:economy').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).message).toBe('400 BENCHMARK_SITE_UNREACHABLE: A node cannot reach http://localhost/benchmark.');
    expect((e as ApiError).exitCode).toBe(3);
  });

  it('show resolves an id prefix and prints the scorecard, with --trials each trial', async () => {
    fakeConsole((u) => {
      if (u.pathname === '/api/benchmarks') return { body: { items: [benchmark()], total: 1 } };
      if (u.pathname === `/api/benchmarks/${ID}`) return { body: benchmark() };
      if (u.pathname === `/api/benchmarks/${ID}/scorecard`) return { body: scorecard() };
      if (u.pathname === `/api/benchmarks/${ID}/trials`)
        return {
          body: {
            items: [
              { id: 't1', challengeId: 'nav-lookup', policyLabel: 'Economy', trialIndex: 0, status: 'graded', verdict: 'fail', failureReason: 'wrong_result', claimedSuccess: true, runId: '55555555-5555-4555-8555-555555555555', activeMs: 30_000, steps: 8, inputTokens: 5_000, outputTokens: 400, cachedInputTokens: 2_000, model: 'openai:model-a', costUsd: 0.05, costKnown: true },
            ],
          },
        };
      return undefined;
    });
    const { out } = await run('benchmarks', 'show', '11111111', '--trials');
    expect(out).toContain('Economy against Thorough  (11111111-1111-4111-8111-111111111111)');
    expect(out).toContain('Tokens     128,000 (in 120,000 / out 8,000 / cached 40,000)');
    expect(out).toMatch(/nav-lookup .*fail \(wrong_result, claimed success\).*in 5,000 \/ out 400 \/ cached 2,000 {2}\$0\.05 {2}run 55555555/);
  });

  it('show --trials prints the recording state and the run page URL on the configured console; the summary counts them (#863)', async () => {
    vi.stubEnv('HEXACTRA_SERVER_URL', 'https://console.example.test');
    try {
      fakeConsole((u) => {
        if (u.pathname === `/api/benchmarks/${ID}`) return { body: benchmark() };
        if (u.pathname === `/api/benchmarks/${ID}/scorecard`) return { body: scorecard() };
        if (u.pathname === `/api/benchmarks/${ID}/trials`)
          return { body: { items: [trial({ recording: { status: 'ready', durationMs: 72_000 } }), trial({ id: 't2', trialIndex: 1, recording: { status: 'processing', durationMs: null } })] } };
        return undefined;
      });
      const { out } = await run('benchmarks', 'show', ID, '--trials');
      expect(out).toContain('  Recordings 1 ready, 1 processing, 0 failed');
      expect(out).toMatch(/#1 .*rec ready 1m12s\n {6}https:\/\/console\.example\.test\/runs\/55555555-5555-4555-8555-555555555555#recording\n/);
      expect(out).toMatch(/#2 .*rec processing\n/);
      // Without --trials the summary still counts them.
      expect((await run('benchmarks', 'show', ID)).out).toContain('  Recordings 1 ready, 1 processing, 0 failed');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('show prints no recording line for an older console whose trials have no recording field', async () => {
    fakeConsole((u) => {
      if (u.pathname === `/api/benchmarks/${ID}`) return { body: benchmark() };
      if (u.pathname === `/api/benchmarks/${ID}/scorecard`) return { body: scorecard() };
      if (u.pathname === `/api/benchmarks/${ID}/trials`) return { body: { items: [trial()] } };
      return undefined;
    });
    const { out } = await run('benchmarks', 'show', ID, '--trials');
    expect(out).not.toMatch(/Recordings|rec |#recording/);
  });

  it('show reports an unknown benchmark with its code', async () => {
    fakeConsole((u) => (u.pathname.startsWith(`/api/benchmarks/${ID}`) ? { status: 404, body: { statusCode: 404, code: 'BENCHMARK_NOT_FOUND', message: 'No such benchmark.' } } : undefined));
    await expect(run('benchmarks', 'show', ID)).rejects.toThrow('404 BENCHMARK_NOT_FOUND: No such benchmark.');
  });

  it('compare prints the deltas and both sides\' tokens and cost from the comparison alone', async () => {
    const { seen } = fakeConsole((u) => (u.pathname === `/api/benchmarks/${ID}/compare` ? { body: COMPARISON } : undefined));
    const { out } = await run('benchmarks', 'compare', ID, BASE);
    expect(seen.map((r) => r.url.pathname)).toEqual([`/api/benchmarks/${ID}/compare`]);
    expect(seen[0]!.url.searchParams.get('baseline')).toBe(BASE);
    expect(out).toContain('baseline  in 90,000 / out 10,000 / cached 0, $2.00');
    expect(out).toContain('current   in 120,000 / out 8,000 / cached 40,000, $1.50');
    expect(out).toMatch(/input tokens\s+90,000 -> 120,000\s+\+30,000\s+worse/);
    expect(out).toMatch(/output tokens\s+10,000 -> 8,000\s+-2,000\s+better/);
    expect(out).toMatch(/cached tokens\s+0 -> 40,000\s+\+40,000\s+worse/);
    expect(out).toMatch(/Economy\n {2}baseline {2}in 30,000 \/ out 3,000 \/ cached 10,000, ≥ \$0\.25\n {2}current {3}in 25,000 \/ out 2,500 \/ cached 12,000, ≥ \$0\.20/);
    expect(out).toContain('only in this benchmark: Thorough (builtin:thorough)');
    expect(out).toMatch(/\+ nav-lookup .*fail \(0\/3\) -> pass \(3\/3\)/);
  });

  it('compare leaves out the side lines when the comparison has no split (an older console)', () => {
    const old = { ...COMPARISON, totals: COMPARISON.totals.slice(0, 2), policies: [{ ...COMPARISON.policies[0]!, deltas: COMPARISON.policies[0]!.deltas.slice(0, 1) }] };
    const text = comparisonText(old).join('\n');
    expect(text).not.toContain('baseline  in');
    expect(text).toMatch(/total tokens\s+100,000 -> 128,000/);
  });

  it('compare reports a suite mismatch with its code', async () => {
    fakeConsole((u) => (u.pathname.endsWith('/compare') ? { status: 409, body: { statusCode: 409, code: 'BENCHMARK_SUITE_MISMATCH', message: 'core v2 against core v1.' } } : undefined));
    await expect(run('benchmarks', 'compare', ID, BASE)).rejects.toThrow('409 BENCHMARK_SUITE_MISMATCH: core v2 against core v1.');
  });

  it('export writes the PDF, CSV and JSON the console sends', async () => {
    fakeConsole(() => undefined);
    const dir = mkdtempSync(join(tmpdir(), 'bench-'));
    const urls: string[] = [];
    const files: Record<string, { body: string; type: string }> = {
      pdf: { body: '%PDF-1.7 fake', type: 'application/pdf' },
      csv: { body: 'benchmark,challenge\r\nx,nav-lookup\r\n', type: 'text/csv' },
      json: { body: '{"format":"hexactra.benchmark-report"}', type: 'application/json' },
    };
    setBenchmarkExportTarget(() => ({
      apiBaseUrl: 'http://console.example.test/api',
      token: 'pat_test',
      fetch: vi.fn(async (input: string | URL | Request) => {
        const u = new URL(String(input));
        urls.push(u.pathname + u.search);
        const f = files[u.searchParams.get('format')!]!;
        return new Response(f.body, { status: 200, headers: { 'content-type': f.type, 'content-disposition': `attachment; filename="hexactra-benchmark-11111111-20261121.${u.searchParams.get('format')}"` } });
      }),
    }));
    for (const format of ['pdf', 'csv', 'json']) {
      const file = join(dir, `b.${format}`);
      const { out } = await run('benchmarks', 'export', ID, '--format', format, '-o', file, ...(format === 'pdf' ? ['--paper', 'letter', '--baseline', BASE] : []));
      expect(readFileSync(file, 'utf8')).toBe(files[format]!.body);
      expect(out).toContain(`wrote ${file}`);
    }
    expect(urls[0]).toBe(`/api/benchmarks/${ID}/export?format=pdf&paper=letter&baseline=${BASE}`);
    expect(urls[1]).toBe(`/api/benchmarks/${ID}/export?format=csv`);
  });

  it('export refuses a bad format, a non-PDF body, and prints a refusal with its code', async () => {
    fakeConsole(() => undefined);
    await expect(run('benchmarks', 'export', ID, '--format', 'xlsx')).rejects.toThrow(/--format is one of json, csv, pdf/);
    setBenchmarkExportTarget(() => ({ apiBaseUrl: 'http://x/api', token: 't', fetch: vi.fn(async () => new Response('<html>', { status: 200 })) }));
    await expect(run('benchmarks', 'export', ID, '--format', 'pdf', '-o', join(mkdtempSync(join(tmpdir(), 'bench-')), 'x.pdf'))).rejects.toThrow(/did not send a PDF/);
    setBenchmarkExportTarget(() => ({ apiBaseUrl: 'http://x/api', token: 't', fetch: vi.fn(async () => new Response(JSON.stringify({ statusCode: 429, code: 'EXPORT_RATE_LIMITED', message: 'At most 10 exports a minute.' }), { status: 429 })) }));
    const e = await run('benchmarks', 'export', ID, '--format', 'csv').catch((x: unknown) => x);
    expect((e as ApiError).message).toBe('429 EXPORT_RATE_LIMITED: At most 10 exports a minute.');
    expect((e as ApiError).exitCode).toBe(3);
  });

  it('cancel posts to the cancel route', async () => {
    const { seen } = fakeConsole((u, init) => (u.pathname === `/api/benchmarks/${ID}/cancel` && init?.method === 'POST' ? { body: benchmark({ status: 'cancelled', progress: { ...benchmark().progress, graded: 4, pass: 2, skipped: 8 } }) } : undefined));
    const { out } = await run('benchmarks', 'cancel', ID);
    expect(seen[0]!.method).toBe('POST');
    expect(out).toContain('cancelled: 2/4 passed, 8 skipped, $1.50 spent');
  });
});
