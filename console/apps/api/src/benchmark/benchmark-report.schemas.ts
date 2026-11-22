// The benchmark report (E44.6, #744): one file with everything a benchmark showed, safe to share. The JSON export is this object; the
// CSV is its trials, one row each; the PDF is drawn from it (`benchmark-report.pdf.ts`). Every string in it is masked at export time
// (`tasks/mask.ts`): there is no unmasked export.
import { SENSITIVE_PATTERN_IDS } from '@app/shared/sensitive-patterns';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { benchmarkSchema, benchmarkTrialSchema } from './benchmarks.schemas';
import { DEFAULT_SCORE_PRESET, SCORE_PRESETS, benchmarkComparisonSchema, scorecardSchema } from './scorecard.schemas';

export const BENCHMARK_REPORT_TYPE = 'hexactra.benchmark-report' as const;
export const BENCHMARK_REPORT_FORMAT_VERSION = 1 as const;

/** How many exports of benchmarks one user may ask for in a minute (every format together). */
export const BENCHMARK_EXPORT_RATE_LIMIT = 10;

export const BENCHMARK_EXPORT_FORMATS = ['json', 'csv', 'pdf'] as const;
export type BenchmarkExportFormat = (typeof BENCHMARK_EXPORT_FORMATS)[number];
export const BENCHMARK_REPORT_PAPERS = ['a4', 'letter'] as const;
export type BenchmarkReportPaper = (typeof BENCHMARK_REPORT_PAPERS)[number];

export const benchmarkExportQuerySchema = z.object({
  format: z.enum(BENCHMARK_EXPORT_FORMATS).default('json').describe('`json` (the default): the `hexactra.benchmark-report` file. `csv`: one row per trial. `pdf`: the report.'),
  paper: z.enum(BENCHMARK_REPORT_PAPERS).default('a4').describe('The PDF\'s paper: `a4` (the default) or `letter`. Ignored for `json` and `csv`.'),
  baseline: z.uuid().optional().describe('An earlier benchmark on the same suite key and version: the report adds the comparison with it (409 `BENCHMARK_SUITE_MISMATCH` otherwise).'),
  preset: z.enum(SCORE_PRESETS).default(DEFAULT_SCORE_PRESET).describe('The PDF\'s Benchmark Score weighting for its leaderboard (#872): `accuracy` (the default), `balanced`, `budget` or `speed`. The scores under every preset are in the scorecard; ignored for `json` and `csv`.'),
});
export class BenchmarkExportQueryDto extends createZodDto(benchmarkExportQuerySchema) {}
export type BenchmarkExportQuery = z.infer<typeof benchmarkExportQuerySchema>;

/** A trial in the report: the API's trial with its run's goal and result, both masked. */
export const benchmarkReportTrialSchema = benchmarkTrialSchema.extend({
  goal: z.string().nullable().describe("The trial run's goal, masked, with the trial's site token hidden; null when the run was deleted or never started."),
  result: z.string().nullable().describe("What the agent answered, masked; null when it said nothing or the run is gone."),
});
export type BenchmarkReportTrial = z.infer<typeof benchmarkReportTrialSchema>;

export const benchmarkReportSchema = z.object({
  type: z.literal(BENCHMARK_REPORT_TYPE),
  formatVersion: z.literal(BENCHMARK_REPORT_FORMAT_VERSION).describe('Version of this file format'),
  exportedAt: z.string(),
  partial: z.boolean().describe('True for a benchmark still in progress (queued or running) when it was exported: the scorecard is live.'),
  console: z.object({ version: z.string().describe('The console version that wrote the file') }),
  masking: z.object({
    applied: z.literal(true).describe('Always true: there is no unmasked export'),
    patternsVersion: z.number().int(),
    hits: z.partialRecord(z.enum(SENSITIVE_PATTERN_IDS as [string, ...string[]]), z.number().int()).describe('How many matches of each pattern were masked; patterns with none are left out'),
  }),
  benchmark: benchmarkSchema.describe('The benchmark: its config, suite key and version, `appVersion`, `commit`, spend and totals.'),
  scorecard: scorecardSchema.describe('The scorecard, with the ranking, the per-policy and per-category metrics (tokens and cost included) and the challenge x policy matrix.'),
  trials: z.array(benchmarkReportTrialSchema).describe('Every trial in run order: verdict, checks, metrics (tokens, cost, models) and run id.'),
  baseline: benchmarkComparisonSchema.nullable().describe('The comparison with `baseline`, when asked.'),
});
export type BenchmarkReport = z.infer<typeof benchmarkReportSchema>;
export class BenchmarkReportDto extends createZodDto(benchmarkReportSchema) {}
