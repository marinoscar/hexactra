// E46.11 (#785): outcome checks and audit runs.
import { checkOutcome, isAuditRun, learnShape, type DeclaredOutput, type OutputShape } from '../src/execute';

const total: DeclaredOutput = { key: 'total', type: 'money', required: true };
const code: DeclaredOutput = { key: 'code', type: 'text', required: true, sensitive: true };
const ref: DeclaredOutput = { key: 'ref', type: 'text', required: false };
const day: DeclaredOutput = { key: 'day', type: 'date', required: true };

describe('checkOutcome', () => {
  it('an empty required output fails; an empty optional one does not', () => {
    expect(checkOutcome([total, ref], { total: '' })).toEqual({ ok: false, problems: ['total is missing'] });
    expect(checkOutcome([total, ref], { total: '4,512.07' }).ok).toBe(true);
  });
  it('checks types and options', () => {
    expect(checkOutcome([total], { total: 'n/a' }).problems).toEqual(['total is not a number']);
    expect(checkOutcome([{ key: 'c', type: 'choice', required: true, options: ['a', 'b'] }], { c: 'z' }).problems).toEqual(['c is not one of its options']);
    expect(checkOutcome([{ key: 'u', type: 'url', required: true }], { u: 'javascript:x' }).problems).toEqual(['u is not a web address']);
  });
  it('checks plausibility against earlier shapes', () => {
    let s: OutputShape | undefined;
    for (const v of ['4,512.07', '3,980.10', '5,001.00']) s = learnShape(total, s, v);
    expect(checkOutcome([total], { total: '4,700.00' }, { total: s! }).ok).toBe(true);
    expect(checkOutcome([total], { total: '45,000,000' }, { total: s! }).problems).toEqual(['total is far from earlier values']);
    const d = learnShape(day, undefined, '2026-11-20')!;
    expect(checkOutcome([day], { day: '1999-01-01' }, { day: d }).problems).toEqual(['day is far in the past']);
  });
  it('a shape holds no value, and a sensitive output has none', () => {
    const s = learnShape(ref, undefined, 'INV-2026-0042');
    expect(JSON.stringify(s)).not.toMatch(/INV|2026|0042/);
    expect(learnShape(code, undefined, '7391')).toBeUndefined();
    expect(learnShape(total, undefined, '4512.07')).toEqual({ kind: 'number', minMagnitude: 3, maxMagnitude: 3, samples: 1 });
  });
  it('reports keys and reasons, never a value', () => {
    expect(JSON.stringify(checkOutcome([total], { total: 'SECRET-TEXT' }))).not.toContain('SECRET');
  });
});

describe('isAuditRun', () => {
  it('with auditEvery 3: runs 3, 6 and 9', () => {
    expect([...Array(10).keys()].map((i) => i + 1).filter((n) => isAuditRun(n, 3))).toEqual([3, 6, 9]);
  });
  it('auditEvery 0 never audits', () => {
    expect([...Array(50).keys()].some((n) => isAuditRun(n, 0))).toBe(false);
  });
});
