// The one report shape of diagnostics (E50.10, #980; epic E50 Design §4): ordered stages, each with a status, a code from a closed
// list and the key of a remedy the owner can act on. A report stores codes, counts and timings: NEVER content, a provider's message,
// an email address, a URL path or query, or a token. `sanitizeStages` is the one gate every stage passes before it is returned or stored.
import { z } from 'zod';

export const STAGE_STATUSES = ['pass', 'warn', 'fail', 'skipped'] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const DIAGNOSTIC_TARGET_KINDS = ['connection', 'provider_app', 'search_provider'] as const;
export type DiagnosticTargetKind = (typeof DIAGNOSTIC_TARGET_KINDS)[number];

export const DIAGNOSTIC_TRIGGERS = ['owner', 'admin', 'cli', 'health_job'] as const;
export type DiagnosticTrigger = (typeof DIAGNOSTIC_TRIGGERS)[number];

export type StageData = Record<string, string | number | boolean>;

export interface DiagnosticStage {
  /** 'status', 'provider_installed', 'sign_in', 'capability:mail_read', 'server', 'latency', ... */
  id: string;
  status: StageStatus;
  /** Closed vocabulary, /^[A-Z][A-Z_]{0,39}$/, never provider text. */
  code: string | null;
  /** A key of the remedy table (`packages/shared/diagnostics.json`), rendered by the client. */
  remedy: string | null;
  ms: number | null;
  /** Counts, booleans, a host name, an API or permission id: never content, an address or a token. */
  data?: StageData;
}

export interface DiagnosticReport {
  target: { kind: DiagnosticTargetKind; id: string };
  trigger: DiagnosticTrigger;
  overall: StageStatus;
  startedAt: string;
  finishedAt: string;
  stages: DiagnosticStage[];
}

export interface DiagnoseContext {
  signal: AbortSignal;
  trigger: DiagnosticTrigger;
}

export interface Diagnosable<T> {
  /** Every code `diagnose` can return. A code outside this list is reported as `UNKNOWN`; each has an entry in the remedy table (a test checks). */
  readonly codes: readonly string[];
  /** Ordered stages. Never throws for an answer of the outside service: a failure is a stage. Stops at the first `fail` and marks the rest `skipped`, unless a stage is independent. */
  diagnose(target: T, ctx: DiagnoseContext): Promise<DiagnosticStage[]>;
}

export const CODE_PATTERN = /^[A-Z][A-Z_]{0,39}$/;
export const STAGE_ID_PATTERN = /^[a-z][a-z0-9_]{0,39}(:[a-z0-9_]{1,40})?$/;
const DATA_KEY = /^[a-z][a-z0-9_]{0,39}$/;
/** A host name, an id or a permission name: letters, digits and `. _ : -`; no space, `@`, `/`, `?`, `=` or `+`. */
const DATA_STRING = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
/** A run of 24 or more characters without a separator looks like a token, a key or an encoded blob; so does a UUID (a grant or session id). */
const TOKEN_LIKE = /[A-Za-z0-9_]{24,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** A host name or an API id is short. */
const MAX_DATA_STRING = 200;
export const MAX_DATA_KEYS = 20;

/** A string value of `data`: at most 200 characters, a host name or an id; never an address, a path, a query, prose or a token. */
export const stageDataStringSchema = z
  .string()
  .max(MAX_DATA_STRING)
  .regex(DATA_STRING, 'Only a host name or an id')
  .refine((v) => !TOKEN_LIKE.test(v), 'Looks like a token');
export const stageDataValueSchema = z.union([stageDataStringSchema, z.number().finite(), z.boolean()]);
export const stageDataSchema = z
  .record(z.string().regex(DATA_KEY), stageDataValueSchema)
  .refine((d) => Object.keys(d).length <= MAX_DATA_KEYS, `At most ${MAX_DATA_KEYS} values`);

export const diagnosticStageSchema = z
  .object({
    id: z.string().regex(STAGE_ID_PATTERN),
    status: z.enum(STAGE_STATUSES),
    code: z.string().regex(CODE_PATTERN).nullable(),
    remedy: z.string().regex(CODE_PATTERN).nullable(),
    ms: z.number().int().min(0).nullable(),
    data: stageDataSchema.optional(),
  })
  .strict();

/** fail > warn > pass; all skipped (or none) is `skipped`. */
export function overall(stages: readonly DiagnosticStage[]): StageStatus {
  if (stages.some((s) => s.status === 'fail')) return 'fail';
  if (stages.some((s) => s.status === 'warn')) return 'warn';
  if (stages.some((s) => s.status === 'pass')) return 'pass';
  return 'skipped';
}

/** A code from a closed list: anything not matching the pattern, or not in `allowed` when given, is `UNKNOWN`. */
export function closedCode(code: unknown, allowed?: ReadonlySet<string>): string {
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) return 'UNKNOWN';
  if (allowed && !allowed.has(code)) return 'UNKNOWN';
  return code;
}

/** Keeps only the `data` values the schema accepts (each one checked on its own); returns null when none is left. */
function cleanData(data: unknown): { data: StageData | null; dropped: number } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { data: null, dropped: data === undefined || data === null ? 0 : 1 };
  const out: StageData = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_DATA_KEYS || !DATA_KEY.test(k) || !stageDataValueSchema.safeParse(v).success) {
      dropped += 1;
      continue;
    }
    out[k] = v as string | number | boolean;
  }
  return { data: Object.keys(out).length > 0 ? out : null, dropped };
}

/**
 * The gate every stage passes: a stage id that is not a plain id becomes `unknown`, a code outside `allowed` becomes `UNKNOWN`, a remedy
 * key that is not in `remedies` falls back to the code, and every `data` value the schema refuses (an email address, a token, a URL,
 * prose, more than 200 characters) is dropped. `dropped` counts them, for a log line that names no value.
 */
export function sanitizeStages(stages: readonly unknown[], allowed: ReadonlySet<string>, remedies: ReadonlySet<string>): { stages: DiagnosticStage[]; dropped: number } {
  let dropped = 0;
  const out: DiagnosticStage[] = [];
  for (const raw of stages.slice(0, 40)) {
    const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<DiagnosticStage>;
    const status: StageStatus = (STAGE_STATUSES as readonly string[]).includes(s.status as string) ? (s.status as StageStatus) : 'fail';
    const code = s.code === null || s.code === undefined ? (status === 'fail' ? 'UNKNOWN' : null) : closedCode(s.code, allowed);
    const remedyKey = typeof s.remedy === 'string' && CODE_PATTERN.test(s.remedy) && remedies.has(s.remedy) ? s.remedy : code && remedies.has(code) ? code : null;
    const ms = typeof s.ms === 'number' && Number.isFinite(s.ms) && s.ms >= 0 ? Math.round(s.ms) : null;
    const { data, dropped: d } = cleanData(s.data);
    dropped += d;
    out.push({ id: typeof s.id === 'string' && STAGE_ID_PATTERN.test(s.id) ? s.id : 'unknown', status, code, remedy: remedyKey, ms, ...(data ? { data } : {}) });
  }
  return { stages: out, dropped };
}
