// Policy export/import (#402): the pure file format, version upgrade and ceiling check.
import { BUILTIN_POLICIES, balancedSpec } from '../src/policies/builtin-policies';
import type { AgentPolicySpec } from '../src/policies/agent-policy.schema';
import {
  buildPolicyFile,
  exceedsCeilings,
  parsePolicyFile,
  policyFileName,
  renamedName,
  upgradeFile,
  upgradeSpec,
  UnsupportedVersionError,
  MAX_IMPORT_POLICIES,
} from '../src/policies/policy-transfer';

const spec = (change: (s: AgentPolicySpec) => void = () => undefined): AgentPolicySpec => {
  const s = balancedSpec();
  change(s);
  return s;
};
const keysOf = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (out.push(k), keysOf(x, out));
  return out;
};
const NOW = new Date('2026-11-17T12:00:00.000Z');

describe('the policy file', () => {
  it('round-trips every built-in and a pinned policy to an identical spec', () => {
    const pinned = spec((s) => { s.models.pins = { fast: 'prov-a:model-1', frontier: 'model-9' }; });
    const policies = [...BUILTIN_POLICIES.map((b) => ({ name: b.name, description: b.description, spec: b.spec })), { name: 'Pinned', description: null, spec: pinned }];
    const file = buildPolicyFile(policies, { includePins: true, now: NOW });
    const parsed = parsePolicyFile(JSON.parse(JSON.stringify(file)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries.map((e) => e.spec)).toEqual(policies.map((p) => p.spec));
    expect(parsed.entries.map((e) => e.name)).toEqual(policies.map((p) => p.name));
  });

  it('carries no identity: only the documented keys, no ids, user, version or timestamps of a policy', () => {
    const file = buildPolicyFile([{ name: 'A', description: 'd', spec: spec() }], { includePins: true, now: NOW });
    expect(file).toMatchObject({ kind: 'hexactra.agent-policies', formatVersion: 1, exportedAt: '2026-11-17T12:00:00.000Z' });
    expect(Object.keys(file.policies[0]!).sort()).toEqual(['description', 'name', 'spec']);
    const keys = new Set(keysOf(file));
    for (const forbidden of ['id', 'userId', 'user_id', 'version', 'createdAt', 'updatedAt', 'usage', 'isDefault', 'builtin', 'token', 'secret', 'apiKey']) expect(keys.has(forbidden)).toBe(false);
  });

  it('strips every model id with includePins=false, and leaves the source untouched', () => {
    const pinned = spec((s) => { s.models.pins = { fast: 'prov-a:model-1', standard: 'model-2' }; });
    const file = buildPolicyFile([{ name: 'P', description: null, spec: pinned }], { includePins: false, now: NOW });
    expect(JSON.stringify(file)).not.toMatch(/model-1|model-2|prov-a/);
    expect(file.policies[0]!.spec.models).not.toHaveProperty('pins');
    expect(pinned.models.pins).toEqual({ fast: 'prov-a:model-1', standard: 'model-2' });
  });

  it('names the download agent-policies-yyyymmdd.json', () => {
    expect(policyFileName(NOW)).toBe('agent-policies-20261117.json');
  });
});

describe('parsePolicyFile', () => {
  const file = (policies: unknown[], extra: Record<string, unknown> = {}) => ({ kind: 'hexactra.agent-policies', formatVersion: 1, exportedAt: NOW.toISOString(), policies, ...extra });

  it('refuses a file that is not a policy export', () => {
    expect(parsePolicyFile([])).toMatchObject({ ok: false });
    expect(parsePolicyFile({ ...file([]), kind: 'something-else' })).toMatchObject({ ok: false, fileIssues: expect.arrayContaining([expect.objectContaining({ path: 'kind' }), expect.objectContaining({ path: 'policies' })]) });
    expect(parsePolicyFile(file([], { formatVersion: 'one' }))).toMatchObject({ ok: false });
    expect(parsePolicyFile(file(new Array(MAX_IMPORT_POLICIES + 1).fill({})))).toMatchObject({ ok: false, fileIssues: [expect.objectContaining({ path: 'policies' })] });
  });

  it('reports every invalid entry with its index, name and spec issues', () => {
    const bad = spec((s) => { (s.budget as { maxActions: number }).maxActions = -5; });
    const r = parsePolicyFile(file([{ name: 'Good', spec: spec() }, { name: 'Bad', spec: bad }, { name: '', spec: spec() }, 'nope']));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => [e.index, e.name])).toEqual([[1, 'Bad'], [2, null], [3, null]]);
    expect(r.errors[0]!.issues[0]!.path).toBe('spec.budget.maxActions');
    expect(r.errors[1]!.issues[0]!.path).toBe('name');
  });

  it('applies the spec rules of E31.3 (maxTier below startTier) and rejects a name used twice in the file', () => {
    const inverted = spec((s) => { s.models.startTier = 'frontier'; s.models.maxTier = 'fast'; });
    const r = parsePolicyFile(file([{ name: 'X', spec: inverted }, { name: 'Y', spec: spec() }, { name: 'Y', spec: spec() }]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.index)).toEqual([0, 2]);
    expect(r.errors[0]!.issues[0]!.path).toBe('spec.models.maxTier');
  });

  it('trims names and treats a blank description as none', () => {
    const r = parsePolicyFile(file([{ name: '  Spaced  ', description: '  ', spec: spec() }]));
    expect(r).toMatchObject({ ok: true, entries: [{ name: 'Spaced', description: null }] });
  });

  it('throws UnsupportedVersionError for a newer file or spec version, with a clear message', () => {
    expect(() => parsePolicyFile(file([], { formatVersion: 2 }))).toThrow(UnsupportedVersionError);
    expect(() => parsePolicyFile(file([{ name: 'F', spec: { ...spec(), schemaVersion: 2 } }]))).toThrow(/spec schema version 2.*up to version 1/);
    expect(() => parsePolicyFile(file([], { formatVersion: 2 }))).toThrow(/format version 2.*up to version 1/);
  });
});

describe('upgradeFile and upgradeSpec', () => {
  it('are tested no-ops for version 1 and leave malformed input to the schema', () => {
    const f = { formatVersion: 1, policies: [] };
    expect(upgradeFile(f)).toBe(f);
    const s = spec();
    expect(upgradeSpec(s)).toBe(s);
    expect(upgradeSpec(null)).toBeNull();
    expect(upgradeSpec({ schemaVersion: 'x' })).toEqual({ schemaVersion: 'x' });
    expect(upgradeFile('text')).toBe('text');
    expect(() => upgradeSpec({ schemaVersion: 3 })).toThrow(UnsupportedVersionError);
  });
});

describe('renamedName', () => {
  it('appends (2), (3) and so on, skipping taken names', () => {
    expect(renamedName('Careful', new Set(['Careful']))).toBe('Careful (2)');
    expect(renamedName('Careful', new Set(['Careful', 'Careful (2)', 'Careful (3)']))).toBe('Careful (4)');
  });
  it('keeps the result within 100 characters', () => {
    const long = 'x'.repeat(100);
    const n = renamedName(long, new Set([long]));
    expect(n).toHaveLength(100);
    expect(n.endsWith(' (2)')).toBe(true);
  });
});

describe('exceedsCeilings', () => {
  const unlimited = spec((s) => { for (const k of ['maxActions', 'maxModelCalls', 'maxActiveMinutes', 'maxInputTokens', 'maxOutputTokens', 'maxCostUsd'] as const) s.budget[k] = null; });
  it('reports nothing while no ceiling is registered or set', () => {
    expect(exceedsCeilings(unlimited, null)).toEqual([]);
    expect(exceedsCeilings(unlimited, undefined)).toEqual([]);
    expect(exceedsCeilings(unlimited, {})).toEqual([]);
    expect(exceedsCeilings(unlimited, { maxActions: null })).toEqual([]);
  });
  it('reports a larger number and an unlimited value where a ceiling is set', () => {
    const s = spec((x) => { x.budget.maxActions = 500; x.budget.maxCostUsd = null; x.budget.maxActiveMinutes = 10; });
    expect(exceedsCeilings(s, { maxActions: 100, maxCostUsd: 5, maxActiveMinutes: 60 })).toEqual([
      { key: 'maxActions', value: 500, ceiling: 100 },
      { key: 'maxCostUsd', value: null, ceiling: 5 },
    ]);
  });
  it('accepts a value equal to the ceiling', () => {
    expect(exceedsCeilings(spec((x) => { x.budget.maxActions = 100; }), { maxActions: 100 })).toEqual([]);
  });
});
