import { agentPolicySpecSchema, BUDGET_LIMIT_KEYS, type AgentPolicySpec } from './agent-policy.schema';

/**
 * The agent policy JSON file (#402): pure functions, no I/O. The format is
 * versioned and self-describing, and carries no identity: no ids, no user,
 * no version, no timestamps of the policy, no task usage, nothing secret.
 */
export const POLICY_FILE_KIND = 'hexactra.agent-policies';
/** The file format this build writes and the newest it reads. */
export const POLICY_FILE_FORMAT_VERSION = 1;
/** The `spec.schemaVersion` this build writes and the newest it reads. */
export const POLICY_SPEC_SCHEMA_VERSION = 1;
export const MAX_IMPORT_POLICIES = 100;
export const MAX_IMPORT_BYTES = 256 * 1024;
export const MAX_POLICY_NAME = 100;

export interface PolicyFileEntry {
  name: string;
  description: string | null;
  spec: AgentPolicySpec;
}

export interface PolicyFile {
  kind: typeof POLICY_FILE_KIND;
  formatVersion: number;
  exportedAt: string;
  policies: PolicyFileEntry[];
}

/** A file or spec written by a newer build than this one. */
export class UnsupportedVersionError extends Error {
  constructor(
    readonly what: 'formatVersion' | 'schemaVersion',
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      what === 'formatVersion'
        ? `This file uses format version ${found}, but this deployment reads up to version ${supported}. Export it again from a matching deployment, or upgrade this one.`
        : `A policy uses spec schema version ${found}, but this deployment reads up to version ${supported}. Export it again from a matching deployment, or upgrade this one.`,
    );
  }
}

/** Positive integer version of a raw value, or null when it is not one. */
function versionOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : null;
}

/**
 * Upgrades a file's `formatVersion` to the current one. Only version 1 exists,
 * so today this is a no-op; a newer version throws `UnsupportedVersionError`.
 * Returns the raw value untouched when the version is missing or malformed (the
 * envelope schema then reports it).
 */
export function upgradeFile(raw: unknown): unknown {
  const v = versionOf((raw as { formatVersion?: unknown } | null)?.formatVersion);
  if (v === null) return raw;
  if (v > POLICY_FILE_FORMAT_VERSION) throw new UnsupportedVersionError('formatVersion', v, POLICY_FILE_FORMAT_VERSION);
  // Older versions are upgraded here, one step at a time, once they exist.
  return raw;
}

/**
 * Upgrades one policy spec, from its own `schemaVersion` to the current one,
 * one step at a time. Pure. Only version 1 exists, so today this is a no-op for
 * v1 and a refusal for anything newer. A spec without a readable version is
 * returned untouched for the spec schema to reject.
 */
export function upgradeSpec(raw: unknown): unknown {
  const v = versionOf((raw as { schemaVersion?: unknown } | null)?.schemaVersion);
  if (v === null) return raw;
  if (v > POLICY_SPEC_SCHEMA_VERSION) throw new UnsupportedVersionError('schemaVersion', v, POLICY_SPEC_SCHEMA_VERSION);
  return raw;
}

/** A deep copy of a spec, without the model pins when `includePins` is false. */
export function exportSpec(spec: AgentPolicySpec, includePins: boolean): AgentPolicySpec {
  const copy = structuredClone(spec);
  if (!includePins) delete copy.models.pins;
  else if (copy.models.pins && Object.values(copy.models.pins).every((p) => !p)) delete copy.models.pins;
  return copy;
}

/** Builds the file. `now` is injectable for tests. */
export function buildPolicyFile(policies: readonly { name: string; description: string | null; spec: AgentPolicySpec }[], opts: { includePins: boolean; now?: Date }): PolicyFile {
  return {
    kind: POLICY_FILE_KIND,
    formatVersion: POLICY_FILE_FORMAT_VERSION,
    exportedAt: (opts.now ?? new Date()).toISOString(),
    policies: policies.map((p) => ({ name: p.name, description: p.description, spec: exportSpec(p.spec, opts.includePins) })),
  };
}

/** `agent-policies-yyyymmdd.json` (UTC). */
export function policyFileName(now: Date = new Date()): string {
  return `agent-policies-${now.toISOString().slice(0, 10).replace(/-/g, '')}.json`;
}

/** What `parsePolicyFile` reports for one entry that does not validate. */
export interface PolicyEntryError {
  index: number;
  name: string | null;
  issues: { path: string; message: string }[];
}

export type ParsedPolicyFile = { ok: true; entries: PolicyFileEntry[] } | { ok: false; fileIssues: { path: string; message: string }[]; errors: PolicyEntryError[] };

const path = (p: PropertyKey[]): string => p.map(String).join('.');

/**
 * Validates an uploaded file: the envelope, then every entry against
 * `agentPolicySpecSchema` (after `upgradeSpec`). Collects EVERY problem, so the
 * caller can report them all at once; a newer format or spec version throws
 * `UnsupportedVersionError` before anything else is judged.
 */
export function parsePolicyFile(raw: unknown): ParsedPolicyFile {
  const file = upgradeFile(raw);
  const fileIssues: { path: string; message: string }[] = [];
  if (typeof file !== 'object' || file === null || Array.isArray(file)) return { ok: false, fileIssues: [{ path: '', message: 'The file must be a JSON object' }], errors: [] };
  const f = file as Record<string, unknown>;
  if (f.kind !== POLICY_FILE_KIND) fileIssues.push({ path: 'kind', message: `kind must be "${POLICY_FILE_KIND}"` });
  if (versionOf(f.formatVersion) === null) fileIssues.push({ path: 'formatVersion', message: 'formatVersion must be a positive integer' });
  if (!Array.isArray(f.policies)) fileIssues.push({ path: 'policies', message: 'policies must be a list' });
  else if (f.policies.length === 0) fileIssues.push({ path: 'policies', message: 'The file holds no policies' });
  else if (f.policies.length > MAX_IMPORT_POLICIES) fileIssues.push({ path: 'policies', message: `A file holds at most ${MAX_IMPORT_POLICIES} policies (found ${f.policies.length})` });
  if (fileIssues.length > 0) return { ok: false, fileIssues, errors: [] };

  const entries: PolicyFileEntry[] = [];
  const errors: PolicyEntryError[] = [];
  const seen = new Map<string, number>();
  (f.policies as unknown[]).forEach((item, index) => {
    const e = (item ?? {}) as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    const issues: { path: string; message: string }[] = [];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      errors.push({ index, name: null, issues: [{ path: '', message: 'A policy must be an object' }] });
      return;
    }
    if (name.length < 1 || name.length > MAX_POLICY_NAME) issues.push({ path: 'name', message: `name must be 1 to ${MAX_POLICY_NAME} characters` });
    let description: string | null = null;
    if (e.description !== undefined && e.description !== null) {
      if (typeof e.description !== 'string' || e.description.trim().length > 500) issues.push({ path: 'description', message: 'description must be text of at most 500 characters' });
      else description = e.description.trim() || null;
    }
    const spec = agentPolicySpecSchema.safeParse(upgradeSpec(e.spec));
    if (!spec.success) for (const i of spec.error.issues) issues.push({ path: `spec${i.path.length ? '.' : ''}${path(i.path)}`, message: i.message });
    if (name && seen.has(name)) issues.push({ path: 'name', message: `"${name}" is already used by policy ${seen.get(name)! + 1} of this file` });
    else if (name) seen.set(name, index);
    if (issues.length > 0 || !spec.success) errors.push({ index, name: name || null, issues });
    else entries.push({ name, description, spec: spec.data });
  });
  return errors.length > 0 ? { ok: false, fileIssues: [], errors } : { ok: true, entries };
}

/**
 * The first free ` (n)` name: `Name (2)`, `Name (3)`, ... The base is cut so the
 * result still fits the name limit. `taken` is every name that exists or was
 * already used by this import.
 */
export function renamedName(base: string, taken: ReadonlySet<string>): string {
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate = `${base.slice(0, MAX_POLICY_NAME - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The deployment ceilings (#404's `browserAgentCeilings`): per budget limit, a number, or null/absent for no ceiling. */
export type BudgetCeilings = Partial<Record<(typeof BUDGET_LIMIT_KEYS)[number], number | null>>;

export interface CeilingExceeded {
  key: (typeof BUDGET_LIMIT_KEYS)[number];
  /** What the policy sets; null means it is unlimited. */
  value: number | null;
  ceiling: number;
}

/**
 * Which budget limits of a spec go beyond the deployment ceilings: a larger
 * number, or unlimited (`null`) where a ceiling is set. Pure. An empty or
 * missing ceilings object (the namespace is not registered, or no ceiling is
 * set) exceeds nothing. Such a policy is still stored as written; the budget
 * engine clamps it at run time.
 */
export function exceedsCeilings(spec: AgentPolicySpec, ceilings: BudgetCeilings | null | undefined): CeilingExceeded[] {
  if (!ceilings) return [];
  const out: CeilingExceeded[] = [];
  for (const key of BUDGET_LIMIT_KEYS) {
    const ceiling = ceilings[key];
    if (typeof ceiling !== 'number') continue;
    const value = spec.budget[key];
    if (value === null || value > ceiling) out.push({ key, value, ceiling });
  }
  return out;
}

/** A warning line for one exceeded ceiling. */
export function ceilingWarning(c: CeilingExceeded): string {
  return `${c.key} is ${c.value === null ? 'unlimited' : c.value}, above this deployment's ceiling of ${c.ceiling}; runs are held to the ceiling`;
}
