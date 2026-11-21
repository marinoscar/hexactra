// `/api/benchmarks` (E44.3, #741): start a benchmark, watch it, read its trials, cancel and delete it. An organization administrator's
// feature: reading needs `benchmarks:read`, anything that starts, stops or deletes needs `benchmarks:run`. Not offered over MCP.
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

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

/** The fields of the signed-in user these routes read. */
interface Principal {
  id: string;
  activeOrgId?: string | null;
}

const NOT_FOUND = "`BENCHMARK_NOT_FOUND`: no such benchmark, or it is another administrator's.";

@ApiTags('Benchmarks')
@Controller('benchmarks')
export class BenchmarksController {
  constructor(private readonly benchmarks: BenchmarksService) {}

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
      'Runs every chosen challenge under every chosen agent policy, `trials` times each, one trial at a time, as ordinary runs on a node (`trigger: benchmark`). The answer comes back at once with the benchmark `queued`; follow it with `GET /api/benchmarks/{id}`. Each trial run is limited to the challenge site and uses no connection, saved login, identity detail or card. It spends on model calls: no new trial starts once `capUsd` is spent.',
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
    description: "Every trial in the order it runs: its verdict, why it did not pass, the grader's checks, whether the agent claimed success, the metrics copied from its run and the run's id. Never the seed, the site's state or an expected answer.",
  })
  trials(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Query() q: ListTrialsQueryDto) {
    return this.benchmarks.trials(userId, id, q);
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
