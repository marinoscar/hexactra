import { balancedSpec } from '../src/policies/builtin-policies';
import {
  BUDGET_KEYS,
  BudgetTracker,
  clampLimit,
  computeEffectiveBudget,
  isUnlimited,
  readEffectiveBudget,
  runBudgetView,
  warningLine,
  wrapUpInstruction,
  type BudgetKey,
  type EffectiveBudget,
} from '../src/runner/budget';

const NONE: EffectiveBudget['limits'] = { actions: null, modelCalls: null, activeMinutes: null, inputTokens: null, outputTokens: null, cost: null };
const eff = (limits: Partial<EffectiveBudget['limits']>, warnAtPercent = 80): EffectiveBudget => ({
  limits: { ...NONE, ...limits },
  source: Object.fromEntries(BUDGET_KEYS.map((k) => [k, limits[k] === undefined || limits[k] === null ? null : 'policy'])) as EffectiveBudget['source'],
  warnAtPercent,
});

describe('BudgetTracker', () => {
  const cases: { key: BudgetKey; limit: number; delta: Parameters<BudgetTracker['add']>[0] }[] = [
    { key: 'actions', limit: 3, delta: { actions: 3 } },
    { key: 'modelCalls', limit: 5, delta: { modelCalls: 5 } },
    { key: 'activeMinutes', limit: 2, delta: { activeMs: 120_000 } },
    { key: 'inputTokens', limit: 1000, delta: { inputTokens: 1000 } },
    { key: 'outputTokens', limit: 400, delta: { outputTokens: 400 } },
    { key: 'cost', limit: 0.5, delta: { costUsd: 0.5 } },
  ];

  it.each(cases)('$key exhausts on its own, and only it', ({ key, limit, delta }) => {
    const t = new BudgetTracker(eff({ [key]: limit }));
    t.add(delta);
    expect(t.state().exhausted).toBe(key);
    // The same usage under every other budget set (but this one unlimited) exhausts nothing.
    const others = Object.fromEntries(BUDGET_KEYS.filter((k) => k !== key).map((k) => [k, 1_000_000]));
    const u = new BudgetTracker(eff(others));
    u.add(delta);
    expect(u.state().exhausted).toBeNull();
  });

  it('null means unlimited: huge usage never exhausts, and its percent is null', () => {
    const t = new BudgetTracker(eff({}));
    t.add({ actions: 1e6, modelCalls: 1e6, inputTokens: 1e12, outputTokens: 1e12, costUsd: 1e6, activeMs: 1e12 });
    const s = t.state();
    expect(s.exhausted).toBeNull();
    expect(s.warn).toEqual([]);
    expect(Object.values(s.percent).every((p) => p === null)).toBe(true);
    expect(isUnlimited(eff({}))).toBe(true);
    expect(isUnlimited(eff({ cost: 1 }))).toBe(false);
  });

  it('starts from the totals a run already used, so a continued run has no fresh budget', () => {
    const t = new BudgetTracker(eff({ actions: 10, cost: 2 }), { actions: 9, costUsd: 1.99 });
    expect(t.state().exhausted).toBeNull();
    t.add({ actions: 1 });
    expect(t.state().exhausted).toBe('actions');
    const resumed = new BudgetTracker(eff({ cost: 2 }), { costUsd: 2 });
    expect(resumed.state().exhausted).toBe('cost');
  });

  it('reports the first exhausted budget in order, and percent for the set ones', () => {
    const t = new BudgetTracker(eff({ actions: 4, cost: 1 }));
    t.add({ actions: 4, costUsd: 0.25 });
    const s = t.state();
    expect(s.exhausted).toBe('actions');
    expect(s.percent).toMatchObject({ actions: 100, cost: 25, modelCalls: null });
  });

  it('warns once per budget at warnAtPercent, never for an exhausted or an unlimited one', () => {
    const t = new BudgetTracker(eff({ actions: 10, modelCalls: 100 }, 80));
    t.add({ actions: 7, modelCalls: 79 });
    expect(t.takeWarnings()).toEqual([]);
    t.add({ actions: 1, modelCalls: 1 });
    expect(t.state().warn).toEqual(['actions', 'modelCalls']);
    expect(t.takeWarnings()).toEqual(['actions', 'modelCalls']);
    // Once only.
    expect(t.takeWarnings()).toEqual([]);
    t.add({ actions: 1 });
    expect(t.takeWarnings()).toEqual([]);
    expect(t.warnedKeys()).toEqual(['actions', 'modelCalls']);
    // A budget that jumps straight past the limit is exhausted, not warned.
    const j = new BudgetTracker(eff({ actions: 10 }));
    j.add({ actions: 12 });
    expect(j.state()).toMatchObject({ exhausted: 'actions', warn: [] });
    // Warned keys survive a new job.
    const next = new BudgetTracker(eff({ actions: 10 }), { actions: 9, warned: ['actions'] });
    expect(next.takeWarnings()).toEqual([]);
  });

  it('counts the known part of an unknown cost toward the limit and flags the run', () => {
    const t = new BudgetTracker(eff({ cost: 1 }));
    expect(t.costKnown).toBe(true);
    t.add({ modelCalls: 1, costUsd: 0.6 });
    t.add({ modelCalls: 1, costUsd: 0, costKnown: false });
    expect(t.costKnown).toBe(false);
    expect(t.used().cost).toBe(0.6);
    t.add({ costUsd: 0.4 });
    expect(t.state().exhausted).toBe('cost');
    // Already flagged from earlier jobs.
    expect(new BudgetTracker(eff({}), { costKnown: false }).costKnown).toBe(false);
  });

  it('adds cost without floating point drift', () => {
    const t = new BudgetTracker(eff({ cost: 0.3 }));
    t.add({ costUsd: 0.1 });
    t.add({ costUsd: 0.1 });
    expect(t.state().exhausted).toBeNull();
    t.add({ costUsd: 0.1 });
    expect(t.state().exhausted).toBe('cost');
  });

  it('active time is set from the clock and never goes down', () => {
    const t = new BudgetTracker(eff({ activeMinutes: 1 }));
    t.setActiveMs(30_000);
    t.setActiveMs(10_000);
    expect(t.used().activeMinutes).toBe(0.5);
    t.setActiveMs(60_000);
    expect(t.state().exhausted).toBe('activeMinutes');
  });
});

describe('effective budget', () => {
  it.each([
    { policy: null, ceiling: 5, limit: 5, source: 'ceiling' },
    { policy: 10, ceiling: 5, limit: 5, source: 'ceiling' },
    { policy: 3, ceiling: 5, limit: 3, source: 'policy' },
    { policy: 5, ceiling: 5, limit: 5, source: 'policy' },
    { policy: 7, ceiling: null, limit: 7, source: 'policy' },
    { policy: null, ceiling: null, limit: null, source: null },
    { policy: 4, ceiling: undefined, limit: 4, source: 'policy' },
  ])('policy $policy under ceiling $ceiling gives $limit ($source)', ({ policy, ceiling, limit, source }) => {
    expect(clampLimit(policy, ceiling)).toEqual({ limit, source });
  });

  it('clamps every budget of a policy and records where each limit came from', () => {
    const spec = balancedSpec();
    spec.budget = { ...spec.budget, maxActions: 60, maxModelCalls: null, maxActiveMinutes: 20, maxInputTokens: null, maxOutputTokens: null, maxCostUsd: 2, warnAtPercent: 70 };
    const e = computeEffectiveBudget(spec.budget, { maxActions: 40, maxModelCalls: 300, maxCostUsd: null });
    expect(e.limits).toEqual({ actions: 40, modelCalls: 300, activeMinutes: 20, inputTokens: null, outputTokens: null, cost: 2 });
    expect(e.source).toEqual({ actions: 'ceiling', modelCalls: 'ceiling', activeMinutes: 'policy', inputTokens: null, outputTokens: null, cost: 'policy' });
    expect(e.warnAtPercent).toBe(70);
    expect(readEffectiveBudget(JSON.parse(JSON.stringify(e)))).toEqual(e);
    expect(readEffectiveBudget({ limits: { actions: 'x' }, warnAtPercent: 80 })).toBeNull();
    expect(readEffectiveBudget(null)).toBeNull();
  });

  it('is unlimited only when the policy and every ceiling are null', () => {
    const spec = balancedSpec();
    spec.budget = { ...spec.budget, maxActions: null, maxModelCalls: null, maxActiveMinutes: null, maxInputTokens: null, maxOutputTokens: null, maxCostUsd: null };
    expect(isUnlimited(computeEffectiveBudget(spec.budget, null))).toBe(true);
    expect(isUnlimited(computeEffectiveBudget(spec.budget, { maxCostUsd: 3 }))).toBe(false);
  });
});

describe('budget text and view', () => {
  it('words the warning and the wrap-up without any run data', () => {
    expect(warningLine('actions', 80.4, 48, 60)).toBe('Budget: actions is at 80% (48 of 60). Finish the goal now if you can; otherwise call finish with what you achieved and what remains.');
    expect(warningLine('cost', 90, 1.8, 2)).toContain('cost is at 90% ($1.80 of $2.00)');
    expect(warningLine('activeMinutes', 85, 17, 20)).toContain('active time is at 85% (17 min of 20 min)');
    expect(wrapUpInstruction('modelCalls')).toBe('The model calls budget is used up. Call finish now: success only if the goal is fully done; otherwise summarise exactly what was done and what remains.');
  });

  it('builds the view of a run: used, percent, source and the open active stretch', () => {
    const e = computeEffectiveBudget({ ...balancedSpec().budget, maxActions: 10, maxActiveMinutes: 2 }, { maxActions: 8 });
    const view = runBudgetView(e, { stepCount: 4, modelCalls: 6, inputTokens: 100, outputTokens: 50, costUsd: '0.5', costKnown: false, activeMs: 30_000, activeSince: new Date(1_000) }, 31_000);
    expect(view.used).toMatchObject({ actions: 4, modelCalls: 6, activeMinutes: 1, cost: 0.5 });
    expect(view.percent.actions).toBe(50);
    expect(view.percent.activeMinutes).toBe(50);
    expect(view.percent.inputTokens).toBeNull();
    expect(view.source.actions).toBe('ceiling');
    expect(view.effective).toMatchObject({ actions: 8, activeMinutes: 2, warnAtPercent: 80 });
    expect(view.costKnown).toBe(false);
  });
});
