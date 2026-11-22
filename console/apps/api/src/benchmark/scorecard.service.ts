// The scorecard of a benchmark and its comparison with a baseline (E44.4, #742). The formulas are pure (`scorecard.ts`); this reads the
// rows and keeps the cache: the scorecard of a benchmark that has ended is written to `Benchmark.summary` once its last trial is
// graded, and read from there afterwards. A live benchmark's scorecard is computed on every read. The trial rows carry every metric,
// so a deleted run changes nothing.
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Benchmark, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { readBenchmarkConfig } from './benchmark-config';
import { BENCHMARK_STATUSES, LIVE_BENCHMARK_STATUSES, type BenchmarkStatus } from './benchmark.constants';
import { compareScorecards, computeScorecard, type CompareSide, type ScoreBenchmark } from './scorecard';
import { SCORECARD_FORMAT, SCORECARD_VERSION, scorecardSchema, type BenchmarkComparison, type Scorecard } from './scorecard.schemas';
import { sameSuite } from './suite/registry';
import { TRIAL_VIEW_OMIT, iso, oneOf, trialView } from './trial-view';

const isLive = (status: string): boolean => (LIVE_BENCHMARK_STATUSES as readonly string[]).includes(status);

/** A cached summary this code can use: the current format and version, else null (it is recomputed). */
export function readSummary(value: unknown): Scorecard | null {
  const v = value as { format?: unknown; version?: unknown } | null;
  if (!v || typeof v !== 'object' || v.format !== SCORECARD_FORMAT || v.version !== SCORECARD_VERSION) return null;
  const parsed = scorecardSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

@Injectable()
export class ScorecardService {
  private readonly log = new Logger(ScorecardService.name);

  constructor(private readonly prisma: PrismaService) {}

  private async find(userId: string, id: string): Promise<Benchmark> {
    const b = await this.prisma.forUser({ userId }).benchmark.findFirst({ where: { id } });
    if (!b) throw new NotFoundException({ code: 'BENCHMARK_NOT_FOUND', message: 'Benchmark not found' });
    return b;
  }

  /**
   * The scorecard of one of the user's benchmarks: the cached one when it has ended, else computed now. An ended benchmark with no
   * usable cache (none yet, or an older format) is computed and cached here.
   */
  async scorecard(userId: string, id: string): Promise<Scorecard> {
    return this.of(await this.find(userId, id));
  }

  /** Compares one of the user's benchmarks with an earlier one of theirs. 409 when the suite key or version differ. */
  async compare(userId: string, id: string, baselineId: string): Promise<BenchmarkComparison> {
    const [b, base] = [await this.find(userId, id), await this.find(userId, baselineId)];
    if (!sameSuite(b, base)) {
      throw new ConflictException({
        code: 'BENCHMARK_SUITE_MISMATCH',
        message: `The benchmark is on suite ${b.suiteKey} version ${b.suiteVersion} and the baseline on ${base.suiteKey} version ${base.suiteVersion}: they cannot be compared`,
        details: { benchmark: { suiteKey: b.suiteKey, suiteVersion: b.suiteVersion }, baseline: { suiteKey: base.suiteKey, suiteVersion: base.suiteVersion } },
      });
    }
    const [cur, prev] = await Promise.all([this.of(b), this.of(base)]);
    return compareScorecards(cur, prev, { current: side(b), baseline: side(base) });
  }

  /**
   * Writes the final scorecard of a benchmark that has ended, once no trial of it is running (a cancelled benchmark's last trial is
   * graded after the cancel; the pass that grades it calls this again). Never throws: the scorecard is then computed on the next read.
   */
  async cacheIfEnded(benchmarkId: string): Promise<void> {
    try {
      const b = await this.prisma.benchmark.findUnique({ where: { id: benchmarkId } });
      // Once written it is final: a pass that runs again on an ended benchmark changes nothing.
      if (!b || isLive(b.status) || readSummary(b.summary)) return;
      await this.computeAndCache(b);
    } catch (e) {
      this.log.warn(`benchmark ${benchmarkId}: the scorecard could not be cached: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async of(b: Benchmark): Promise<Scorecard> {
    if (!isLive(b.status)) {
      const cached = readSummary(b.summary);
      if (cached) return cached;
      return this.computeAndCache(b);
    }
    return this.compute(b, true);
  }

  /** Computes an ended benchmark's scorecard and caches it when every trial has ended. */
  private async computeAndCache(b: Benchmark): Promise<Scorecard> {
    const unfinished = await this.prisma.benchmarkTrial.count({ where: { benchmarkId: b.id, status: { in: ['pending', 'running'] } } });
    const card = await this.compute(b, unfinished > 0);
    if (unfinished === 0) {
      // Only over a summary that is not already this one's: two readers write the same value.
      await this.prisma.benchmark.updateMany({ where: { id: b.id, status: b.status }, data: { summary: card as unknown as Prisma.InputJsonValue } });
    }
    return card;
  }

  private async compute(b: Benchmark, live: boolean): Promise<Scorecard> {
    const rows = await this.prisma.benchmarkTrial.findMany({ where: { benchmarkId: b.id }, omit: TRIAL_VIEW_OMIT });
    const config = readBenchmarkConfig(b.config);
    const bench: ScoreBenchmark = {
      id: b.id,
      name: b.name,
      status: statusOf(b.status),
      suiteKey: b.suiteKey,
      suiteVersion: b.suiteVersion,
      appVersion: b.appVersion,
      commit: b.commit,
      spentUsd: Number(b.spentUsd),
      config: { challengeIds: config.challengeIds, policies: config.policies, trials: config.trials },
    };
    return computeScorecard(bench, rows.map(trialView), { live });
  }
}

const statusOf = (s: string): BenchmarkStatus => oneOf(BENCHMARK_STATUSES, s) ?? 'failed';

const side = (b: Benchmark): CompareSide => ({ id: b.id, name: b.name, status: statusOf(b.status), suiteKey: b.suiteKey, suiteVersion: b.suiteVersion, appVersion: b.appVersion, commit: b.commit, finishedAt: iso(b.finishedAt) });
