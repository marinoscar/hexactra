// `/api/benchmarks` (E44.3, #741): start a benchmark, watch it, read its trials, cancel and delete it; its scorecard and the comparison
// with a baseline (E44.4, #742); its report as JSON, CSV or PDF (E44.6, #744). An organization administrator's feature: reading needs
// `benchmarks:read`, anything that starts, stops or deletes needs `benchmarks:run`. Not offered over MCP.
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiExtraModels, ApiOkResponse, ApiOperation, ApiProduces, ApiResponse, ApiTags, getSchemaPath } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { BenchmarkExportQueryDto, BenchmarkReportDto } from './benchmark-report.schemas';
import { BenchmarkReportService } from './benchmark-report.service';
import {
  BenchmarkListResponseDto,
  BenchmarkResponseDto,
  BenchmarkSuiteResponseDto,
  BenchmarkTrialListResponseDto,
  CreateBenchmarkDto,
  ListBenchmarksQueryDto,
  ListTrialsQueryDto,
} from './benchmarks.schemas';
import { BenchmarksService } from './benchmarks.service';
import { BenchmarkComparisonResponseDto, CompareQueryDto, ScorecardResponseDto } from './scorecard.schemas';
import { ScorecardService } from './scorecard.service';

/** The fields of the signed-in user these routes read. */
interface Principal {
  id: string;
  activeOrgId?: string | null;
  permissions?: string[];
}

/** A trial's recording status is shown only to a viewer who may open the run (`runs:read`, the run page's rule; #846). */
export const canSeeRecordings = (user: Pick<Principal, 'permissions'>): boolean => (user.permissions ?? []).includes('runs:read');

const NOT_FOUND = "`BENCHMARK_NOT_FOUND`: no such benchmark, or it is another administrator's.";

@ApiTags('Benchmarks')
@Controller('benchmarks')
export class BenchmarksController {
  constructor(
    private readonly benchmarks: BenchmarksService,
    private readonly scorecards: ScorecardService,
    private readonly reports: BenchmarkReportService,
  ) {}

  // Declared before `:id`.
  @Get('suite')
  @ApiDataResponse(BenchmarkSuiteResponseDto)
  @Auth({ permissions: ['benchmarks:read'] })
  @ApiOperation({
    summary: 'The benchmark suite',
    description:
      'The built-in challenges with their category and difficulty, which of them the agent can attempt (`supported`; the others are reported `unsupported`, never run), the defaults and limits of a new benchmark, and whether a node can reach the challenge site (`site.reachable`).',
  })
  suite() {
    return this.benchmarks.suite();
  }

  @Get()
  @ApiDataResponse(BenchmarkListResponseDto)
  @Auth({ permissions: ['benchmarks:read'] })
  @ApiOperation({ summary: 'List your benchmarks', description: 'Newest first, each with its settings, what it has spent and how many trials are in each state (`progress`).' })
  list(@CurrentUser('id') userId: string, @Query() q: ListBenchmarksQueryDto) {
    return this.benchmarks.list(userId, q);
  }

  @Post()
  @ApiDataResponse(BenchmarkResponseDto, { status: 201 })
  @ApiResponse({ status: 400, description: '`CHALLENGE_UNKNOWN`, `POLICY_REF_INVALID`, `POLICY_DUPLICATE`, `BENCHMARK_HOST_NOT_FOUND`, `BENCHMARK_HOST_UNAVAILABLE` or `BENCHMARK_SITE_UNREACHABLE`: the message names the challenge, the policy, the node or the address. Nothing was started.' })
  @ApiResponse({ status: 409, description: '`BENCHMARK_RUNNING`: a benchmark is already running on that node and profile.' })
  @Auth({ permissions: ['benchmarks:run'] })
  @ApiOperation({
    summary: 'Start a benchmark',
    description:
      'Runs every chosen challenge under every chosen agent policy, `trials` times each, one trial at a time, as ordinary runs on a node (`trigger: benchmark`). The answer comes back at once with the benchmark `queued`; follow it with `GET /api/benchmarks/{id}`. Each trial run is limited to the challenge site and uses no connection, saved login, identity detail or card. It spends on model calls: no new trial starts once `capUsd` is spent (`capUsd: null` or `0`: no budget, stored as `null`; absent: the deployment default).',
  })
  start(@CurrentUser() user: Principal, @Body() body: CreateBenchmarkDto) {
    return this.benchmarks.start(user, body);
  }

  @Get(':id')
  @ApiDataResponse(BenchmarkResponseDto)
  @ApiResponse({ status: 404, description: NOT_FOUND })
  @Auth({ permissions: ['benchmarks:read'] })
  @ApiOperation({ summary: 'Get one benchmark', description: 'Its settings, status, spend and trial counts. Poll it while `status` is `queued` or `running`.' })
  get(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.benchmarks.get(userId, id);
  }

  @Get(':id/trials')
  @ApiDataResponse(BenchmarkTrialListResponseDto)
  @ApiResponse({ status: 404, description: NOT_FOUND })
  @Auth({ permissions: ['benchmarks:read'] })
  @ApiOperation({
    summary: "List a benchmark's trials",
    description:
      "Every trial in the order it runs: its verdict, why it did not pass, the grader's checks, whether the agent claimed success, the metrics copied from its run, the run's id and, for a caller with `runs:read`, the status of the run's recording (`recording`; the video plays only on the run page). Never the seed, the site's state or an expected answer.",
  })
  trials(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string, @Query() q: ListTrialsQueryDto) {
    return this.benchmarks.trials(user.id, id, q, { recordings: canSeeRecordings(user) });
  }

  @Get(':id/scorecard')
  @ApiDataResponse(ScorecardResponseDto)
  @ApiResponse({ status: 404, description: NOT_FOUND })
  @Auth({ permissions: ['benchmarks:read'] })
  @ApiOperation({
    summary: "A benchmark's scorecard",
    description:
      'Compares the policies: success rate with its 95% interval, reliability across the k trials (pass^k), speed, tokens and cost (totals, medians, per success; "at least" when a cost is unknown), false successes and failures, failure reasons, safety flags and the models used, per policy and per category; the challenge x policy matrix; the Benchmark Score of each policy (accuracy, cost, time and tokens sub-scores from 0 to 100, the Overall score with its band, rank and grade under each weighting preset, and badges; #871) and the ranking by it under the default preset; and the totals of the whole benchmark. Computed live while the benchmark runs (`live: true`), cached once it has ended. A benchmark with no judged trial has an empty scorecard.',
  })
  scorecard(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.scorecards.scorecard(userId, id);
  }

  @Get(':id/compare')
  @ApiDataResponse(BenchmarkComparisonResponseDto)
  @ApiResponse({ status: 404, description: NOT_FOUND })
  @ApiResponse({ status: 409, description: '`BENCHMARK_SUITE_MISMATCH`: the baseline is on another suite key or version; `details` names both.' })
  @Auth({ permissions: ['benchmarks:read'] })
  @ApiOperation({
    summary: 'Compare a benchmark with a baseline',
    description:
      "Matches the policies by ref, then by label, and returns each metric's delta (a rate's delta is `withinNoise` when the two 95% intervals overlap), the challenges whose outcome flipped, and both benchmarks' console version and commit. Only within one suite key and version.",
  })
  compare(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Query() q: CompareQueryDto) {
    return this.scorecards.compare(userId, id, q.baseline);
  }

  /** The report as a file (#744), sent as an attachment with `@Res()`: never in the `data` envelope. */
  @Get(':id/export')
  @ApiExtraModels(BenchmarkReportDto)
  @ApiOkResponse({
    description: 'The report file (`format=json`, not wrapped in the `data` envelope), the trials as CSV (`format=csv`) or the PDF report (`format=pdf`), sent as an attachment `hexactra-benchmark-<first 8 of id>-<yyyymmdd>.json`, `.csv` or `.pdf`.',
    content: {
      'application/json': { schema: { $ref: getSchemaPath(BenchmarkReportDto) } },
      'text/csv': { schema: { type: 'string' } },
      'application/pdf': { schema: { type: 'string', format: 'binary' } },
    },
  })
  @ApiProduces('application/json', 'text/csv', 'application/pdf')
  @ApiResponse({ status: 404, description: NOT_FOUND })
  @ApiResponse({ status: 409, description: '`BENCHMARK_SUITE_MISMATCH`: the baseline is on another suite key or version.' })
  @ApiResponse({ status: 429, description: '`EXPORT_RATE_LIMITED`: more than 10 benchmark exports in a minute (every format together); `details.retryAfterS` says when to try again.' })
  @Auth({ permissions: ['benchmarks:read'] })
  @ApiOperation({
    summary: 'Export a benchmark report as JSON, CSV or PDF',
    description:
      'A `hexactra.benchmark-report` file (`formatVersion` 1): the benchmark with its config, suite key and version, console version and commit; the scorecard (ranking, metrics per policy and per category, the challenge x policy matrix, the totals); every trial with its verdict, checks, metrics (input, output and cached tokens, cost, models) and run id, with its run\'s goal and result; and the comparison with `baseline` when asked. `format=csv`: one row per trial (RFC 4180; a cell starting with `=`, `+`, `-` or `@` is prefixed with `\'`). `format=pdf` (`paper=a4` or `letter`, `preset=accuracy|balanced|budget|speed`): the leaderboard first (the Benchmark Score of each policy under the preset, its grade, band, four sub-scores and badges), then summary and ranking, scorecard, tokens and cost, categories, matrix, failure reasons, baseline deltas, the rankings per dimension and under every preset, and the method. Every string is masked (`masking.hits` counts what was) and a trial\'s site token is never included; there is no unmasked export. A benchmark still running exports as in progress (`partial: true`). Audit event `benchmarks.exported`.',
  })
  async export(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string, @Query() q: BenchmarkExportQueryDto, @Res() reply: FastifyReply): Promise<void> {
    const file = await this.reports.export(user.id, id, { format: q.format, paper: q.paper, preset: q.preset, baseline: q.baseline, orgId: user.activeOrgId ?? null, recordings: canSeeRecordings(user) });
    await reply.header('content-disposition', `attachment; filename="${file.filename}"`).header('cache-control', 'no-store').type(file.contentType).send(file.body);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiDataResponse(BenchmarkResponseDto)
  @ApiResponse({ status: 404, description: NOT_FOUND })
  @Auth({ permissions: ['benchmarks:run'] })
  @ApiOperation({ summary: 'Cancel a benchmark', description: 'Nothing more starts, the trials that have not run are `skipped`, and the trial that is running is stopped like any run. A benchmark that already ended is returned unchanged.' })
  cancel(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.benchmarks.cancel(user, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiResponse({ status: 204, description: 'Deleted, with its trials. The runs it started stay in the run history.' })
  @ApiResponse({ status: 404, description: NOT_FOUND })
  @ApiResponse({ status: 409, description: '`BENCHMARK_RUNNING`: cancel it first.' })
  @Auth({ permissions: ['benchmarks:run'] })
  @ApiOperation({ summary: 'Delete a benchmark', description: 'Permanent. Only a benchmark that has ended.' })
  async remove(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.benchmarks.remove(user, id);
  }
}
