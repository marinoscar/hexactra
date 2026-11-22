// Running a benchmark (E44.3, #741), the parts that need no database: how a trial run carries its limits and why no other run can,
// the scripted owner's rules, the verdict of a finished trial, the order trials run in, and the challenge site's address check.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { NO_SITE, domainAllowed, fabricAllowedSites } from '@marinoscar/hexactra-browser-agent/policy';

import { inRunOrder, publicConfig, readBenchmarkConfig } from '../src/benchmark/benchmark-config';
import { siteAddress } from '../src/benchmark/benchmark-site-address';
import { createBenchmarkSchema } from '../src/benchmark/benchmarks.schemas';
import { BENCHMARK_ANSWER_CHANNEL, askedQuestions, brokerAnswer, scriptRules, type ScriptQuestion } from '../src/benchmark/owner-script';
import type { OwnerRule } from '../src/benchmark/suite/types';
import { readTrialModels, trialModels } from '../src/benchmark/trial-models';
import { trialOutcome } from '../src/benchmark/trial-verdict';
import { balancedSpec } from '../src/policies/builtin-policies';
import { mayAnswerOn } from '../src/questions/channels/channel-rules';
import { benchmarkLimits, benchmarkRunContext, runLimits } from '../src/runner/host/run-limits';

const SRC = join(__dirname, '../src');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
const sources = walk(SRC).map((p) => ({ rel: relative(SRC, p).split(sep).join('/'), text: readFileSync(p, 'utf8') }));

describe("a run's limits (runner/host/run-limits.ts)", () => {
  const context = benchmarkRunContext({ benchmarkId: 'b', trialId: 't', allowedDomains: ['Console.Example.Test'], confirmRiskyActions: true });

  it('reads a benchmark trial run from its context: the challenge site only, and the challenge\'s confirmation', () => {
    expect(context).toEqual({ benchmark: { benchmarkId: 'b', trialId: 't', allowedDomains: ['console.example.test'], confirmRiskyActions: true } });
    const limits = runLimits({ trigger: 'benchmark', context });
    expect(limits).toEqual({ allowedDomains: ['console.example.test'], confirmRiskyActions: true });
    expect(domainAllowed('https://console.example.test/benchmark/t/x/', limits.allowedDomains)).toBe(true);
    expect(domainAllowed('https://elsewhere.example.test/', limits.allowedDomains)).toBe(false);
    expect(fabricAllowedSites(limits.allowedDomains, [])).toEqual(['console.example.test']);
  });

  it('refuses to make a context without a site, and a benchmark run with no readable context is allowed no site at all', () => {
    expect(() => benchmarkRunContext({ benchmarkId: 'b', trialId: 't', allowedDomains: [' '], confirmRiskyActions: false })).toThrow(/allowed site/);
    for (const broken of [null, undefined, {}, 'text', { benchmark: null }, { benchmark: { allowedDomains: [] } }, { benchmark: { allowedDomains: 'console.example.test' } }, { benchmark: { allowedDomains: [7, ''] } }]) {
      const limits = runLimits({ trigger: 'benchmark', context: broken });
      expect(limits).toEqual({ allowedDomains: [NO_SITE], confirmRiskyActions: false });
      expect(domainAllowed('https://console.example.test/', limits.allowedDomains)).toBe(false);
      // Never the empty list, which means "any site".
      expect(fabricAllowedSites(limits.allowedDomains, [])).toEqual([NO_SITE]);
    }
  });

  it('ignores the context of every other run: the same entry on a manual, chat, API, scheduled or email run changes nothing', () => {
    for (const trigger of ['manual', 'schedule', 'api', 'mcp', 'external', 'chat', 'email', null, undefined]) {
      expect(benchmarkLimits({ trigger, context })).toBeNull();
      expect(runLimits({ trigger, context })).toEqual({ allowedDomains: [], confirmRiskyActions: false });
      expect(runLimits({ trigger, context, task: { allowedDomains: ['shop.example.test'], confirmRiskyActions: true } })).toEqual({ allowedDomains: ['shop.example.test'], confirmRiskyActions: true });
      expect(runLimits({ trigger, context, conversation: { allowedDomains: ['chat.example.test'], confirmRiskyActions: true } })).toEqual({ allowedDomains: ['chat.example.test'], confirmRiskyActions: true });
      // The task's own list wins over the chat's, as before.
      expect(runLimits({ trigger, task: { allowedDomains: [], confirmRiskyActions: false }, conversation: { allowedDomains: ['chat.example.test'], confirmRiskyActions: true } })).toEqual({ allowedDomains: [], confirmRiskyActions: false });
    }
  });

  it('a context cannot widen a benchmark run: it only ever names sites, and a task on the same row does not replace them', () => {
    const limits = runLimits({ trigger: 'benchmark', context, task: { allowedDomains: [], confirmRiskyActions: false } });
    expect(limits).toEqual({ allowedDomains: ['console.example.test'], confirmRiskyActions: true });
  });

  it('only the benchmark run starter creates a benchmark run or writes its context', () => {
    const writesTrigger = /trigger:\s*(['"]benchmark['"]|BENCHMARK_RUN_TRIGGER)/;
    expect(sources.filter((s) => writesTrigger.test(s.text)).map((s) => s.rel)).toEqual(['benchmark/benchmark-run-starter.ts']);
    expect(sources.filter((s) => /\bbenchmarkRunContext\(/.test(s.text)).map((s) => s.rel).sort()).toEqual(['benchmark/benchmark-run-starter.ts', 'runner/host/run-limits.ts']);
    // The limits are read in the one helper, and used by the two files that read the task's values before.
    expect(sources.filter((s) => /\brunLimits\(/.test(s.text)).map((s) => s.rel).sort()).toEqual(['runner/host/browser-session.ts', 'runner/host/build-context.ts', 'runner/host/run-limits.ts']);
    // `runs.context` has two writers, both the server's own: the mail trigger poller (a message reference) and the starter. The REST
    // routes that start a run are checked against a real body in test/benchmark-run.db.spec.ts.
    const writesContext = sources.filter((s) => /\bcontext:\s*(\{\s*mail\b|benchmarkRunContext\()/.test(s.text)).map((s) => s.rel);
    expect(writesContext.sort()).toEqual(['benchmark/benchmark-run-starter.ts', 'mail-triggers/mail-trigger.poller.ts']);
  });

  it('the body that starts a benchmark has no field for a trigger, a context, allowed sites or a confirmation setting', () => {
    const ok = createBenchmarkSchema.safeParse({ policies: [{ ref: 'builtin:balanced' }] });
    expect(ok.success).toBe(true);
    for (const extra of ['trigger', 'context', 'allowedDomains', 'confirmRiskyActions', 'connections', 'useSavedLogins']) {
      expect(createBenchmarkSchema.safeParse({ policies: [{ ref: 'builtin:balanced' }], [extra]: true }).success).toBe(false);
    }
    expect(createBenchmarkSchema.safeParse({ policies: [] }).success).toBe(false);
    expect(createBenchmarkSchema.safeParse({ policies: Array.from({ length: 9 }, () => ({ ref: 'builtin:balanced' })) }).success).toBe(false);
    expect(createBenchmarkSchema.safeParse({ policies: [{ ref: 'builtin:balanced' }], trials: 11 }).success).toBe(false);
    expect(createBenchmarkSchema.safeParse({ policies: [{ ref: 'not-a-policy' }] }).success).toBe(false);
  });
});

describe('the scripted owner (benchmark/owner-script.ts)', () => {
  let n = 0;
  const q = (over: Partial<ScriptQuestion>): ScriptQuestion => ({ id: `q${++n}`, kind: 'other', input: 'text', prompt: 'What is the code?', status: 'pending', answeredChannel: null, createdAt: new Date(1_700_000_000_000 + n * 1000), ...over });
  const rules: OwnerRule[] = [
    { kind: 'confirmation', input: 'confirm', match: 'place the order', answer: { type: 'approve' } },
    { input: 'credentials', answer: { type: 'credentials', username: 'person.a', password: 'fixture-pass' }, repeat: true },
    { input: 'text', answer: { type: 'text', text: 'K7Q2' } },
  ];

  it('the first rule that fits answers; kind, input and prompt text must all hold; the prompt is compared without case', () => {
    const confirm = q({ kind: 'confirmation', input: 'confirm', prompt: 'Place the ORDER for 1 item?' });
    const other = q({ kind: 'confirmation', input: 'confirm', prompt: 'Delete the account?' });
    const matched = scriptRules(rules, [confirm, other]);
    expect(matched.get(confirm.id)).toBe(rules[0]);
    expect(matched.get(other.id)).toBeNull();
  });

  it('a rule answers once unless it repeats, and what is spent is recomputed from the questions', () => {
    const first = q({ status: 'answered', answeredChannel: BENCHMARK_ANSWER_CHANNEL });
    const second = q({});
    expect(scriptRules(rules, [first, second]).get(second.id)).toBeNull();
    const signIn1 = q({ kind: 'login', input: 'credentials', status: 'answered', answeredChannel: BENCHMARK_ANSWER_CHANNEL });
    const signIn2 = q({ kind: 'login', input: 'credentials' });
    expect(scriptRules(rules, [signIn1, signIn2]).get(signIn2.id)).toBe(rules[1]);
    // The same list in any order gives the same answer.
    expect(scriptRules(rules, [second, first]).get(second.id)).toBeNull();
  });

  it('a question a person or the run itself settled spends no rule, and an owner card is never matched', () => {
    const byPerson = q({ status: 'answered', answeredChannel: 'web' });
    const withdrawn = q({ status: 'cancelled', answeredChannel: null });
    const pending = q({});
    expect(scriptRules(rules, [byPerson, withdrawn, pending]).get(pending.id)).toBe(rules[2]);
    for (const input of ['memory', 'save_login', 'form']) expect(scriptRules([{ answer: { type: 'approve' } }], [q({ input })]).values().next().value).toBeNull();
  });

  it("turns an answer into the broker's words, and never ticks remember", () => {
    expect(brokerAnswer({ type: 'approve' }, { input: 'confirm' })).toEqual({ outcome: 'completed', value: 'approve' });
    expect(brokerAnswer({ type: 'approve' }, { input: 'none' })).toEqual({ outcome: 'completed' });
    expect(brokerAnswer({ type: 'approve' }, { input: 'text' })).toBeNull();
    expect(brokerAnswer({ type: 'deny' }, { input: 'confirm' })).toEqual({ outcome: 'completed', value: 'deny' });
    expect(brokerAnswer({ type: 'deny' }, { input: 'credentials' })).toEqual({ outcome: 'cancelled' });
    expect(brokerAnswer({ type: 'text', text: 'K7Q2' }, { input: 'text' })).toEqual({ outcome: 'completed', value: 'K7Q2' });
    expect(brokerAnswer({ type: 'text', text: '12.5' }, { input: 'number' })).toEqual({ outcome: 'completed', value: 12.5 });
    expect(brokerAnswer({ type: 'text', text: 'twelve' }, { input: 'number' })).toBeNull();
    const options = [{ id: 'std', label: 'Standard' }, { id: 'exp', label: 'Express' }];
    expect(brokerAnswer({ type: 'text', text: 'express' }, { input: 'choice', options })).toEqual({ outcome: 'completed', value: 'exp' });
    expect(brokerAnswer({ type: 'text', text: 'std' }, { input: 'multi_choice', options })).toEqual({ outcome: 'completed', values: ['std'] });
    expect(brokerAnswer({ type: 'text', text: 'overnight' }, { input: 'choice', options })).toBeNull();
    expect(brokerAnswer({ type: 'text', text: 'x' }, { input: 'confirm' })).toBeNull();
    expect(brokerAnswer({ type: 'credentials', username: 'person.a', password: 'p' }, { input: 'credentials' })).toEqual({ outcome: 'completed', value: 'person.a', secret: 'p' });
    expect(brokerAnswer({ type: 'credentials', username: 'person.a', password: 'p' }, { input: 'confirm' })).toBeNull();
    for (const answer of [{ type: 'approve' }, { type: 'deny' }, { type: 'text', text: 'a' }, { type: 'credentials', username: 'u', password: 'p' }] as const) {
      for (const input of ['confirm', 'none', 'text', 'secret', 'credentials', 'choice', 'number']) {
        const sent = brokerAnswer(answer, { input, options }) ?? {};
        expect(Object.keys(sent).filter((k) => ['remember', 'rememberRule', 'memory', 'saveLogin', 'neverForSite', 'fields'].includes(k))).toEqual([]);
      }
    }
  });

  it('the broker itself refuses a memory or a saved login on the benchmark channel, saved or declined', () => {
    for (const input of ['memory', 'save_login']) for (const outcome of ['completed', 'cancelled'] as const) expect(mayAnswerOn(BENCHMARK_ANSWER_CHANNEL, { input, risk: null }, outcome)).toBe(false);
  });

  it('records what was asked for the grader: masked prompts, oldest first, and what the scripted owner answered', () => {
    const a = q({ kind: 'confirmation', input: 'confirm', prompt: 'Place the order for person.a@example.test?', status: 'answered', answeredChannel: BENCHMARK_ANSWER_CHANNEL });
    const b = q({ prompt: 'Which colour?', status: 'cancelled' });
    const card = q({ input: 'memory', prompt: 'The agent suggests remembering something.' });
    const asked = askedQuestions(rules, [card, b, a], (t) => t.replace(/\S+@\S+/g, '[email]'));
    expect(asked).toEqual([
      { kind: 'confirmation', input: 'confirm', prompt: 'Place the order for [email]', at: a.createdAt.getTime(), answered: 'approve' },
      { kind: 'other', input: 'text', prompt: 'Which colour?', at: b.createdAt.getTime(), answered: 'none' },
    ]);
  });
});

describe('the verdict of a finished trial (benchmark/trial-verdict.ts)', () => {
  const pass = { checks: [{ name: 'reported-code', pass: true }] };
  const fail = { checks: [{ name: 'reported-code', pass: false, detail: 'expected the code' }, { name: 'safety:nothing-else-changed', pass: true }] };
  const ended = (status: string, stopReason: string | null = 'finished', error: string | null = null) => ({ status, stopReason, error });

  it('passes only when every check passes, whatever the agent claimed', () => {
    expect(trialOutcome({ preset: null, run: ended('succeeded'), grade: pass })).toMatchObject({ status: 'graded', verdict: 'pass', failureReason: null, claimedSuccess: true });
    // A false failure: the state is right and the agent said it failed.
    expect(trialOutcome({ preset: null, run: ended('failed'), grade: pass })).toMatchObject({ verdict: 'pass', claimedSuccess: false });
  });

  it('a claimed success with a wrong state is a fail with claimedSuccess: true', () => {
    expect(trialOutcome({ preset: null, run: ended('succeeded'), grade: fail })).toEqual({ status: 'graded', verdict: 'fail', failureReason: 'wrong_result', checks: fail.checks, claimedSuccess: true });
    expect(trialOutcome({ preset: null, run: ended('failed'), grade: fail })).toMatchObject({ verdict: 'fail', failureReason: 'gave_up', claimedSuccess: false });
  });

  it('names the budget or the stall that stopped the run', () => {
    expect(trialOutcome({ preset: null, run: ended('failed', 'budget_actions'), grade: fail })).toMatchObject({ verdict: 'fail', failureReason: 'budget' });
    expect(trialOutcome({ preset: null, run: ended('failed', 'budget_cost'), grade: fail })).toMatchObject({ verdict: 'fail', failureReason: 'budget' });
    expect(trialOutcome({ preset: null, run: ended('failed', 'stalled'), grade: fail })).toMatchObject({ verdict: 'fail', failureReason: 'stalled' });
  });

  it('a timeout and an unscripted question fail the trial even when the state is right', () => {
    expect(trialOutcome({ preset: 'timeout', run: ended('cancelled', 'cancelled'), grade: pass })).toMatchObject({ status: 'graded', verdict: 'fail', failureReason: 'timeout', checks: pass.checks });
    expect(trialOutcome({ preset: 'asked_person', run: ended('cancelled', 'cancelled'), grade: fail })).toMatchObject({ status: 'graded', verdict: 'fail', failureReason: 'asked_person' });
  });

  it('a run that could not work is an error, not a failure of the agent', () => {
    expect(trialOutcome({ preset: null, run: ended('failed', 'error', 'No browser available: offline'), grade: null })).toEqual({ status: 'graded', verdict: 'error', failureReason: 'error', checks: [{ name: 'run', pass: false, detail: 'No browser available: offline' }], claimedSuccess: false });
    expect(trialOutcome({ preset: null, run: ended('failed', 'no_model', 'No model selected'), grade: fail })).toMatchObject({ verdict: 'error', failureReason: 'no_model' });
  });

  it('a grader that throws or returns nothing is an error with its message', () => {
    expect(trialOutcome({ preset: null, run: ended('succeeded'), grade: { error: 'boom' } })).toEqual({ status: 'graded', verdict: 'error', failureReason: 'error', checks: [{ name: 'grader', pass: false, detail: 'boom' }], claimedSuccess: true });
    expect(trialOutcome({ preset: null, run: ended('succeeded'), grade: { checks: [] } })).toMatchObject({ verdict: 'error', checks: [{ name: 'grader', pass: false, detail: 'The grader returned no check' }] });
  });

  it('a cancelled benchmark, or a run somebody stopped, is skipped: it says nothing about the agent', () => {
    expect(trialOutcome({ preset: 'cancelled', run: ended('cancelled', 'cancelled'), grade: pass })).toMatchObject({ status: 'skipped', verdict: 'skipped', failureReason: 'cancelled' });
    expect(trialOutcome({ preset: null, run: ended('cancelled', 'cancelled'), grade: fail })).toMatchObject({ status: 'skipped', verdict: 'skipped', failureReason: 'cancelled' });
  });

  it('keeps a stored check small', () => {
    const out = trialOutcome({ preset: null, run: ended('succeeded'), grade: { checks: Array.from({ length: 80 }, (_, i) => ({ name: `c-${i}`, pass: true, detail: 'x'.repeat(900) })) } });
    expect(out.checks).toHaveLength(50);
    expect(out.checks![0]!.detail!.length).toBe(500);
  });
});

describe('the stored config and the order of trials', () => {
  const config = { challengeIds: ['nav-lookup', 'nav-spa'], policies: [{ ref: 'builtin:economy', label: 'Economy' }, { ref: 'builtin:thorough', label: 'Thorough' }], trials: 2, hostId: null, profile: 'default', capUsd: 5, trialTimeoutMinutes: 15 };

  it('alternates the policies: attempt by attempt, challenge by challenge, one policy after the other', () => {
    const trials = [1, 0].flatMap((trialIndex) => ['builtin:thorough', 'builtin:economy'].flatMap((policyRef) => ['nav-spa', 'nav-lookup'].map((challengeId) => ({ challengeId, policyRef, trialIndex }))));
    expect(inRunOrder(config, trials).map((t) => `${t.trialIndex} ${t.challengeId} ${t.policyRef.slice(8)}`)).toEqual([
      '0 nav-lookup economy', '0 nav-lookup thorough', '0 nav-spa economy', '0 nav-spa thorough',
      '1 nav-lookup economy', '1 nav-lookup thorough', '1 nav-spa economy', '1 nav-spa thorough',
    ]);
  });

  it('keeps the organization out of what the API returns, and reads an unreadable row as a benchmark with no budget', () => {
    const stored = readBenchmarkConfig({ ...config, orgId: 'org-1' });
    expect(stored.orgId).toBe('org-1');
    expect(publicConfig(stored)).toEqual(config);
    expect(readBenchmarkConfig({})).toMatchObject({ challengeIds: [], policies: [], capUsd: 0 });
    // No cap (#840) is kept as the owner's choice.
    expect(readBenchmarkConfig({ ...config, capUsd: null, orgId: null }).capUsd).toBeNull();
  });
});

describe("the challenge site's address", () => {
  it('is the console\'s public URL plus /benchmark, and its host is the only site a trial may visit', () => {
    expect(siteAddress({ siteBaseUrl: '' }, 'https://Console.Example.Test/')).toEqual({ baseUrl: 'https://Console.Example.Test/benchmark', host: 'console.example.test', reachable: true, problem: null });
    expect(siteAddress({ siteBaseUrl: 'https://bench.example.test' }, 'http://localhost:3535')).toMatchObject({ baseUrl: 'https://bench.example.test', host: 'bench.example.test', reachable: true });
  });

  it('refuses a loopback default (a node would open its own localhost) and an address that is not a URL, without any network call', () => {
    for (const url of ['http://localhost:3535', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'http://app.localhost']) {
      const a = siteAddress({ siteBaseUrl: '' }, url);
      expect([url, a.reachable]).toEqual([url, false]);
      expect(a.problem).toMatch(/cannot reach/);
    }
    expect(siteAddress({ siteBaseUrl: '' }, '')).toMatchObject({ reachable: false, host: '' });
  });

  it('takes a loopback address an administrator set deliberately (a node on the same machine)', () => {
    expect(siteAddress({ siteBaseUrl: 'http://localhost:3535/benchmark' }, 'http://localhost:3535')).toMatchObject({ reachable: true, host: 'localhost' });
  });
});

describe("the models of a trial's run (benchmark/trial-models.ts)", () => {
  const tier = (model: string | null, fallbackModel: string | null = null) => ({ model, fallbackModel });
  const snapshot = (startTier: string, maxTier: string) => ({
    schemaVersion: 1, ref: 'builtin:balanced', name: 'Balanced', version: 1, builtin: true, source: 'run', takenAt: '2026-11-21T00:00:00.000Z', tiers: null,
    spec: { ...balancedSpec(), models: { ...balancedSpec().models, startTier, maxTier } },
    resolvedTiers: { fast: tier('provider-a:small'), standard: tier('provider-a:medium', 'provider-b:medium'), frontier: tier('provider-a:large') },
  });

  it('lists the tiers from start to max with their models, the start tier\'s model first, and the tier the run ended on', () => {
    expect(trialModels(snapshot('fast', 'frontier'), 'standard')).toEqual({
      startTier: 'fast', maxTier: 'frontier', finalTier: 'standard', model: 'provider-a:small',
      tiers: [{ tier: 'fast', model: 'provider-a:small', fallbackModel: null }, { tier: 'standard', model: 'provider-a:medium', fallbackModel: 'provider-b:medium' }, { tier: 'frontier', model: 'provider-a:large', fallbackModel: null }],
    });
  });

  it('a policy pinned to one tier names one model', () => {
    const pinned = trialModels(snapshot('standard', 'standard'), null)!;
    expect(pinned).toMatchObject({ model: 'provider-a:medium', finalTier: 'standard' });
    expect(pinned.tiers).toHaveLength(1);
    expect(readTrialModels(JSON.parse(JSON.stringify(pinned)))).toEqual(pinned);
  });

  it('is null for a run that never got a snapshot, and for a stored value it cannot read', () => {
    expect(trialModels(null, 'fast')).toBeNull();
    expect(readTrialModels(null)).toBeNull();
    expect(readTrialModels({ startTier: 'x' })).toBeNull();
  });
});
