// Run retention (#422): the per-user rule, the deployment ceiling, and the
// wire shapes of `GET /runs/retention`, its preview and "apply now".
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** The most days a rule may keep runs for. */
export const RETENTION_MAX_DAYS = 3650;
/** The most runs per task a rule may keep. */
export const RETENTION_MAX_PER_TASK = 10_000;
/** A run is never deleted by retention while it is younger than this (alert windows can raise it). */
export const RETENTION_FLOOR_HOURS = 24;
/** Runs deleted per user per night; the rest goes the next night. */
export const RETENTION_USER_NIGHTLY_CAP = 20_000;
/** Users read per page by the nightly job. */
export const RETENTION_USER_PAGE = 100;

const days = z.number().int().min(1).max(RETENTION_MAX_DAYS);
const perTask = z.number().int().min(1).max(RETENTION_MAX_PER_TASK);

/** The `runs` namespace of a user's settings document. */
export const runRetentionSettingsSchema = z.object({
  keepDays: days.nullable().describe('Finished runs older than this many days are deleted. `null`: no age limit.'),
  keepPerTask: perTask.nullable().describe('Only the newest N finished runs of each task are kept (runs without a task are one group). `null`: no limit.'),
  keepFailedDays: days.nullable().describe('The age limit of failed runs, to keep failures longer. `null`: the same as `keepDays`.'),
  noticeSentAt: z.iso
    .datetime({ offset: true })
    .nullable()
    .optional()
    .describe('Set by the server: when the user chose a rule, or was told that the default rule starts deleting. Until then the nightly job deletes nothing.'),
});
export type RunRetentionSettings = z.infer<typeof runRetentionSettingsSchema>;

export const runRetentionSettingsPatchSchema = runRetentionSettingsSchema.partial();
export type RunRetentionSettingsPatch = z.infer<typeof runRetentionSettingsPatchSchema>;

/** What applies to a user who never saved the namespace. */
export const RUN_RETENTION_DEFAULTS = { keepDays: 90, keepPerTask: null, keepFailedDays: null } as const satisfies Omit<RunRetentionSettings, 'noticeSentAt'>;

/** The `runs` namespace of the system settings document: the deployment's ceiling. */
export const runRetentionCeilingSchema = z.object({
  maxKeepDays: days.nullable().describe("The most days any user's runs are kept. A user's longer limit, or no limit, is cut to it by the nightly job. `null`: no ceiling."),
  maxPausedHours: z
    .number()
    .int()
    .min(1)
    .max(8_760)
    .nullable()
    .optional()
    .describe('The most hours a run may stay paused (E38.2). A run paused longer is cancelled with the reason "Paused too long" and its owner is told. Absent: 72. `null`: no limit (a paused run waits for its owner).'),
});
export type RunRetentionCeiling = z.infer<typeof runRetentionCeilingSchema>;
export const runRetentionCeilingPatchSchema = runRetentionCeilingSchema.partial();
/** The deployment default of `maxPausedHours` (E38.2). */
export const DEFAULT_MAX_PAUSED_HOURS = 72;
export const NO_RETENTION_CEILING: RunRetentionCeiling = { maxKeepDays: null, maxPausedHours: DEFAULT_MAX_PAUSED_HOURS };

/** The three limits of a rule, as the user chose them. */
export type RunRetentionLimits = Pick<RunRetentionSettings, 'keepDays' | 'keepPerTask' | 'keepFailedDays'>;

/** A rule as the job applies it: the ceiling applied, the failed-run limit resolved. */
export interface EffectiveRetentionRule {
  /** Age limit of succeeded and cancelled runs, in days; null: none. */
  keepDays: number | null;
  /** Age limit of failed runs, in days; null: none. */
  keepFailedDays: number | null;
  keepPerTask: number | null;
  /** True when the deployment ceiling shortened (or set) an age limit. */
  capped: boolean;
}

/** The stored namespace, salvaged field by field: an invalid or missing field reads as its default. */
export function salvageRetentionSettings(stored: unknown): RunRetentionSettings & { noticeSentAt: string | null } {
  const raw = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const field = <K extends keyof typeof RUN_RETENTION_DEFAULTS>(key: K): RunRetentionSettings[K] => {
    if (!(key in raw)) return RUN_RETENTION_DEFAULTS[key];
    const parsed = runRetentionSettingsSchema.shape[key].safeParse(raw[key]);
    return (parsed.success ? parsed.data : RUN_RETENTION_DEFAULTS[key]) as RunRetentionSettings[K];
  };
  const notice = runRetentionSettingsSchema.shape.noticeSentAt.safeParse(raw.noticeSentAt);
  return { keepDays: field('keepDays'), keepPerTask: field('keepPerTask'), keepFailedDays: field('keepFailedDays'), noticeSentAt: notice.success ? (notice.data ?? null) : null };
}

/** The rule the job applies: the user's limits under the deployment ceiling. Pure. */
export function effectiveRetentionRule(limits: RunRetentionLimits, maxKeepDays: number | null): EffectiveRetentionRule {
  const cap = (v: number | null): number | null => (maxKeepDays === null ? v : Math.min(v ?? Infinity, maxKeepDays));
  const keepDays = cap(limits.keepDays);
  const keepFailedDays = cap(limits.keepFailedDays ?? limits.keepDays);
  return { keepDays, keepFailedDays, keepPerTask: limits.keepPerTask, capped: keepDays !== limits.keepDays || keepFailedDays !== (limits.keepFailedDays ?? limits.keepDays) };
}

/** True when the rule can never delete a run. */
export function keepsEverything(rule: EffectiveRetentionRule): boolean {
  return rule.keepDays === null && rule.keepFailedDays === null && rule.keepPerTask === null;
}

// A query value: a number, or empty / absent for "no limit". Optional in the schema, so the OpenAPI document does
// not call a parameter required that the route accepts without; what the handler reads is still a number or null.
const queryLimit = (max: number) =>
  z
    .preprocess((v) => (v === '' || v === 'null' ? null : v), z.coerce.number().int().min(1).max(max).nullable())
    .optional()
    .transform((v) => v ?? null);

export const retentionPreviewQuerySchema = z.object({
  keepDays: queryLimit(RETENTION_MAX_DAYS).describe('Days finished runs are kept; empty or absent: no age limit'),
  keepPerTask: queryLimit(RETENTION_MAX_PER_TASK).describe('Newest finished runs kept per task; empty or absent: no limit'),
  keepFailedDays: queryLimit(RETENTION_MAX_DAYS).describe('Days failed runs are kept; empty or absent: the same as `keepDays`'),
});
export class RetentionPreviewQueryDto extends createZodDto(retentionPreviewQuerySchema) {}

export const retentionPreviewResponseSchema = z.object({
  wouldDelete: z.number().int().describe('Finished runs the rule would delete now (the nightly job deletes at most 20,000 per night)'),
  finished: z.number().int().describe("All of the caller's finished runs"),
  oldestKept: z.iso.datetime().nullable().describe('When the oldest run that would be kept finished; null when none would be kept'),
  costUsd: z.number().nullable().describe('The recorded model spend (USD) of the runs that would be deleted; null when none of them made a model call'),
  maxKeepDays: z.number().int().nullable().describe("The deployment's ceiling in days, applied to the limits given; null: none"),
  capped: z.boolean().describe('True when the ceiling shortened a limit given'),
  floorHours: z.number().int().describe('Runs that finished less than this many hours ago are never deleted by retention'),
});
export class RetentionPreviewResponseDto extends createZodDto(retentionPreviewResponseSchema) {}

export const retentionSettingsResponseSchema = z.object({
  keepDays: runRetentionSettingsSchema.shape.keepDays,
  keepPerTask: runRetentionSettingsSchema.shape.keepPerTask,
  keepFailedDays: runRetentionSettingsSchema.shape.keepFailedDays,
  saved: z.boolean().describe('False while the user never saved a rule: the defaults apply'),
  maxKeepDays: z.number().int().nullable().describe("The deployment's ceiling in days; null: none"),
  floorHours: z.number().int().describe('Runs that finished less than this many hours ago are never deleted by retention'),
});
export class RetentionSettingsResponseDto extends createZodDto(retentionSettingsResponseSchema) {}

export const retentionApplyResponseSchema = z.object({
  jobId: z.uuid().describe("The `browser.runs.retention` job that applies the caller's saved rule to the caller's runs"),
});
export class RetentionApplyResponseDto extends createZodDto(retentionApplyResponseSchema) {}
