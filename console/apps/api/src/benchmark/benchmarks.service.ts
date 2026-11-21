// Benchmarks as an administrator sees them (E44.3, #741): start one, list and read them, read the trials, cancel, delete. Nothing long
// happens here: starting writes the rows and queues the first pass (`benchmark.advance`).
import { randomUUID } from 'node:crypto';

import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { readDeployInfo, resolveApiVersion, resolveDeployInfoPath } from '@marinoscar/platform-api/host';
import { JobsService } from '@marinoscar/platform-api/jobs';
import type { Benchmark, BenchmarkTrial, Prisma } from '@prisma/client';

import { FabricClient } from '../fabric/fabric.client';
import { PoliciesService } from '../policies/policies.service';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { inRunOrder, publicConfig, readBenchmarkConfig, type StoredBenchmarkConfig } from './benchmark-config';
import { BENCHMARK_STATUSES, LIVE_BENCHMARK_STATUSES, TRIAL_FAILURE_REASONS, TRIAL_STATUSES, TRIAL_VERDICTS, type BenchmarkStatus } from './benchmark.constants';
import { enqueueBenchmarkAdvance } from './benchmark.jobs.enqueue';
import { BenchmarkMetrics } from './benchmark.metrics';
import { BenchmarkRunner, STOP_GRACE_MS } from './benchmark-runner.service';
import { BenchmarkSiteAddress } from './benchmark-site-address';
import { BENCHMARK_LIMITS } from './benchmark.settings';
import { BENCHMARK_MAX_POLICIES, type BenchmarkProgress, type BenchmarkSuiteView, type BenchmarkTotals, type BenchmarkTrialView, type BenchmarkView, type CreateBenchmarkInput } from './benchmarks.schemas';
import { SUITE, challengeById, missingCapabilities, seedFrom } from './suite/registry';
import { CATEGORIES, CATEGORY_LABELS, type Check } from './suite/types';
import { readTrialModels } from './trial-models';

/** Who is asking. */
export interface BenchmarkActor {
  id: string;
  activeOrgId?: string | null;
}

/** The audit actions of benchmarks; ids and counts only. */
export const BENCHMARK_AUDIT = { started: 'benchmarks.started', cancelled: 'benchmarks.cancelled', deleted: 'benchmarks.deleted' } as const;

const oneOf = <T extends string>(list: readonly T[], value: unknown): T | null => (list.includes(value as T) ? (value as T) : null);
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const EMPTY_TOTALS: BenchmarkTotals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, modelCalls: 0, costUsd: 0, costKnown: true };
const EMPTY_PROGRESS: BenchmarkProgress = { total: 0, pending: 0, running: 0, graded: 0, skipped: 0, pass: 0, fail: 0, error: 0, unsupported: 0 };

/** Two benchmarks would drive the same browser: the same profile on the same node, or on a node the fabric picks. */
const sameSeat = (a: Pick<StoredBenchmarkConfig, 'hostId' | 'profile'>, b: Pick<StoredBenchmarkConfig, 'hostId' | 'profile'>): boolean => a.profile === b.profile && (a.hostId === b.hostId || a.hostId === null || b.hostId === null);

@Injectable()
export class BenchmarksService {
  private readonly log = new Logger(BenchmarksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly policies: PoliciesService,
    private readonly fabric: FabricClient,
    private readonly tasks: TasksService,
    private readonly site: BenchmarkSiteAddress,
    private readonly runner: BenchmarkRunner,
    private readonly metrics: BenchmarkMetrics,
  ) {}

  private db(userId: string) {
    return this.prisma.forUser({ userId });
  }

  // ---- The suite ----

  /** The built-in suite, what the agent can attempt of it, the defaults of a new benchmark and whether the site can be reached. */
  async suite(): Promise<BenchmarkSuiteView> {
    const settings = await this.site.settingsNow();
    const site = await this.site.read();
    return {
      key: SUITE.key,
      version: SUITE.version,
      categories: CATEGORIES.map((id) => ({ id, label: CATEGORY_LABELS[id] })),
      challenges: SUITE.challenges.map((c) => {
        const missing = missingCapabilities(c);
        return { id: c.id, title: c.title, category: c.category, difficulty: c.difficulty, requires: [...(c.requires ?? [])], supported: missing.length === 0, missing, confirmRiskyActions: c.run?.confirmRiskyActions === true };
      }),
      defaults: { trials: settings.defaultTrials, capUsd: settings.defaultCapUsd, trialTimeoutMinutes: settings.trialTimeoutMinutes },
      limits: { maxPolicies: BENCHMARK_MAX_POLICIES, maxTrials: BENCHMARK_LIMITS.maxTrials, maxCapUsd: BENCHMARK_LIMITS.maxCapUsd, maxTrialTimeoutMinutes: BENCHMARK_LIMITS.maxTrialTimeoutMinutes },
      site: { baseUrl: site.baseUrl, reachable: site.reachable, problem: site.problem },
    };
  }

  // ---- Start ----

  /**
   * Starts a benchmark: checks everything, writes the benchmark and one row per challenge, policy and attempt, and queues the first
   * pass. A refusal writes nothing. 400 names the challenge, the policy or the node; 409 names the benchmark already using the browser.
   */
  async start(actor: BenchmarkActor, dto: CreateBenchmarkInput): Promise<BenchmarkView> {
    const userId = actor.id;
    const orgId = actor.activeOrgId ?? null;
    const settings = await this.site.settingsNow();
    const site = await this.site.read();
    if (!site.reachable) throw new BadRequestException({ code: 'BENCHMARK_SITE_UNREACHABLE', message: site.problem });

    const asked = [...new Set(dto.challengeIds ?? SUITE.challenges.map((c) => c.id))];
    const unknown = asked.filter((id) => !challengeById(id));
    if (unknown.length) throw new BadRequestException({ code: 'CHALLENGE_UNKNOWN', message: `The suite has no challenge ${unknown.join(', ')}`, details: { challengeIds: unknown } });
    // The suite's own order, whatever order they were named in.
    const challengeIds = SUITE.challenges.map((c) => c.id).filter((id) => asked.includes(id));

    const policies: { ref: string; label: string }[] = [];
    for (const [i, p] of dto.policies.entries()) {
      await this.policies.assertAssignable(userId, p.ref, `policies[${i}].ref (${p.ref})`);
      const label = p.label ?? (await this.policies.find(userId, p.ref))?.name ?? p.ref;
      if (policies.some((x) => x.ref === p.ref)) throw new BadRequestException({ code: 'POLICY_DUPLICATE', message: `The policy ${p.ref} is listed twice` });
      if (policies.some((x) => x.label === label)) throw new BadRequestException({ code: 'POLICY_DUPLICATE', message: `Two policies have the label "${label}": give one of them another label` });
      policies.push({ ref: p.ref, label: label.slice(0, 200) });
    }

    const hostId = dto.hostId ?? null;
    if (hostId) {
      const hosts = await this.fabric.hosts().catch((e: unknown) => {
        throw new BadRequestException({ code: 'BENCHMARK_HOST_UNAVAILABLE', message: `The node could not be checked: ${e instanceof Error ? e.message : String(e)}` });
      });
      if (!hosts.some((h) => h.id === hostId)) throw new BadRequestException({ code: 'BENCHMARK_HOST_NOT_FOUND', message: `No node ${hostId} is in the fleet` });
    }

    const config: StoredBenchmarkConfig = {
      challengeIds,
      policies,
      trials: dto.trials ?? settings.defaultTrials,
      hostId,
      profile: dto.profile,
      capUsd: dto.capUsd ?? settings.defaultCapUsd,
      trialTimeoutMinutes: dto.trialTimeoutMinutes ?? settings.trialTimeoutMinutes,
      orgId,
    };
    const id = randomUUID();
    const name = dto.name ?? `Benchmark ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    const now = new Date();
    const rows: Prisma.BenchmarkTrialCreateManyInput[] = [];
    for (let trialIndex = 0; trialIndex < config.trials; trialIndex++) {
      for (const challengeId of challengeIds) {
        const unsupported = missingCapabilities(challengeById(challengeId)!).length > 0;
        for (const p of policies) {
          rows.push({
            benchmarkId: id,
            challengeId,
            policyRef: p.ref,
            policyLabel: p.label,
            trialIndex,
            seed: seedFrom(id, challengeId, p.ref, trialIndex),
            // A challenge the agent cannot attempt is reported, never run and never failed.
            ...(unsupported ? { status: 'skipped', verdict: 'unsupported', failureReason: 'unsupported', finishedAt: now } : {}),
          });
        }
      }
    }
    const commit = await readDeployInfo(resolveDeployInfoPath())
      .then((r) => r.document?.app.commitSha ?? null)
      .catch(() => null);

    const created = await this.prisma.$transaction(async (tx) => {
      // One start at a time, so two requests cannot both find the browser free.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('benchmark:start', 0))`;
      const live = await tx.benchmark.findMany({ where: { status: { in: [...LIVE_BENCHMARK_STATUSES] } }, select: { id: true, name: true, userId: true, config: true } });
      const taken = live.find((b) => sameSeat(readBenchmarkConfig(b.config), config));
      if (taken) {
        const mine = taken.userId === userId;
        throw new ConflictException({
          code: 'BENCHMARK_RUNNING',
          message: mine ? `The benchmark "${taken.name}" is already running on that node and profile` : 'Another benchmark is already running on that node and profile',
          details: mine ? { benchmarkId: taken.id, name: taken.name } : {},
        });
      }
      const b = await tx.benchmark.create({
        data: { id, userId, name, suiteKey: SUITE.key, suiteVersion: SUITE.version, status: 'queued', config: config as unknown as Prisma.InputJsonValue, appVersion: resolveApiVersion(__dirname).slice(0, 32), commit: commit ? commit.slice(0, 64) : null },
      });
      await tx.benchmarkTrial.createMany({ data: rows });
      return b;
    });

    this.metrics.started();
    this.metrics.trials('unsupported', rows.filter((r) => r.verdict === 'unsupported').length);
    await this.audit(userId, orgId, BENCHMARK_AUDIT.started, id, { suite: `${SUITE.key}@${SUITE.version}`, challenges: challengeIds.length, policies: policies.length, trials: config.trials, runs: rows.length, capUsd: config.capUsd });
    await enqueueBenchmarkAdvance(this.jobs, id, orgId, 'benchmark_started');
    this.log.log(`benchmark ${id}: started (${rows.length} trials)`);
    return this.view(created, await this.factsOf([id]));
  }

  // ---- Read ----

  async list(userId: string, q: { limit: number; offset: number }): Promise<{ items: BenchmarkView[]; total: number }> {
    const [rows, total] = await Promise.all([
      this.db(userId).benchmark.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: q.limit, skip: q.offset }),
      this.db(userId).benchmark.count(),
    ]);
    const facts = await this.factsOf(rows.map((r) => r.id));
    return { items: rows.map((r) => this.view(r, facts)), total };
  }

  private async find(userId: string, id: string): Promise<Benchmark> {
    const b = await this.db(userId).benchmark.findFirst({ where: { id } });
    if (!b) throw new NotFoundException({ code: 'BENCHMARK_NOT_FOUND', message: 'Benchmark not found' });
    return b;
  }

  async get(userId: string, id: string): Promise<BenchmarkView> {
    const b = await this.find(userId, id);
    return this.view(b, await this.factsOf([id]));
  }

  /** The trials of a benchmark, in the order they run. */
  async trials(userId: string, id: string, filter: { status?: string; verdict?: string; policyRef?: string; challengeId?: string } = {}): Promise<{ items: BenchmarkTrialView[] }> {
    const b = await this.find(userId, id);
    const rows = await this.prisma.benchmarkTrial.findMany({
      where: { benchmarkId: id, ...(filter.status ? { status: filter.status } : {}), ...(filter.verdict ? { verdict: filter.verdict } : {}), ...(filter.policyRef ? { policyRef: filter.policyRef } : {}), ...(filter.challengeId ? { challengeId: filter.challengeId } : {}) },
      omit: { siteState: true, policySnapshot: true, tokenHash: true, seed: true },
    });
    return { items: inRunOrder(readBenchmarkConfig(b.config), rows).map(trialView) };
  }

  // ---- Cancel and delete ----

  /**
   * Cancels a benchmark: nothing more starts, the trials that have not run are skipped, and the live trial's run is stopped through
   * the ordinary cancel path. A benchmark that already ended is returned as it is.
   */
  async cancel(actor: BenchmarkActor, id: string): Promise<BenchmarkView> {
    const b = await this.find(actor.id, id);
    const { count } = await this.prisma.benchmark.updateMany({ where: { id, status: { in: [...LIVE_BENCHMARK_STATUSES] } }, data: { status: 'cancelled', finishedAt: new Date() } });
    if (count === 1) {
      const config = readBenchmarkConfig(b.config);
      const skipped = await this.runner.skipRest(id, 'cancelled');
      const running = await this.prisma.benchmarkTrial.findMany({ where: { benchmarkId: id, status: 'running' }, select: { id: true, runId: true } });
      // The reason goes on the trial first: the grader reads it when the run ends.
      await this.prisma.benchmarkTrial.updateMany({ where: { benchmarkId: id, status: 'running', failureReason: null }, data: { failureReason: 'cancelled' } });
      for (const t of running) {
        if (t.runId) await this.tasks.cancel(actor.id, t.runId).catch((e: unknown) => this.log.warn(`benchmark ${id}: could not stop run ${t.runId}: ${e instanceof Error ? e.message : String(e)}`));
      }
      await this.audit(actor.id, actor.activeOrgId ?? null, BENCHMARK_AUDIT.cancelled, id, { skipped, stopped: running.length });
      // A pass now for a trial that had no run yet, and one later that ends a run nothing stopped.
      await enqueueBenchmarkAdvance(this.jobs, id, config.orgId, 'benchmark_cancelled');
      if (running.length) await enqueueBenchmarkAdvance(this.jobs, id, config.orgId, 'benchmark_cancelled', STOP_GRACE_MS + 1_000);
      this.log.log(`benchmark ${id}: cancelled`);
    }
    return this.get(actor.id, id);
  }

  /** Deletes a benchmark that has ended, with its trials. Its runs stay: they are the owner's runs, under their own retention. */
  async remove(actor: BenchmarkActor, id: string): Promise<void> {
    const b = await this.find(actor.id, id);
    const { count } = await this.prisma.benchmark.deleteMany({ where: { id, userId: actor.id, status: { notIn: [...LIVE_BENCHMARK_STATUSES] } } });
    if (count !== 1) throw new ConflictException({ code: 'BENCHMARK_RUNNING', message: 'Cancel the benchmark before deleting it' });
    await this.audit(actor.id, actor.activeOrgId ?? null, BENCHMARK_AUDIT.deleted, id, { status: b.status });
  }

  // ---- Views ----

  /** Trial counts by benchmark. */
  private async progressOf(ids: string[]): Promise<Map<string, BenchmarkProgress>> {
    const out = new Map<string, BenchmarkProgress>();
    if (ids.length === 0) return out;
    const groups = await this.prisma.benchmarkTrial.groupBy({ by: ['benchmarkId', 'status', 'verdict'], where: { benchmarkId: { in: ids } }, _count: { _all: true } });
    for (const g of groups) {
      const p = out.get(g.benchmarkId) ?? { ...EMPTY_PROGRESS };
      const n = g._count._all;
      p.total += n;
      const status = oneOf(TRIAL_STATUSES, g.status);
      if (status) p[status] += n;
      const verdict = oneOf(['pass', 'fail', 'error', 'unsupported'] as const, g.verdict);
      if (verdict) p[verdict] += n;
      out.set(g.benchmarkId, p);
    }
    return out;
  }

  /** What the trials that ended used, by benchmark: the sums of the metrics copied from their runs. */
  private async totalsOf(ids: string[]): Promise<Map<string, BenchmarkTotals>> {
    const out = new Map<string, BenchmarkTotals>();
    if (ids.length === 0) return out;
    const [sums, unpriced] = await Promise.all([
      this.prisma.benchmarkTrial.groupBy({ by: ['benchmarkId'], where: { benchmarkId: { in: ids } }, _sum: { inputTokens: true, outputTokens: true, cachedInputTokens: true, modelCalls: true, costUsd: true } }),
      this.prisma.benchmarkTrial.groupBy({ by: ['benchmarkId'], where: { benchmarkId: { in: ids }, costKnown: false }, _count: { _all: true } }),
    ]);
    const unknown = new Set(unpriced.map((g) => g.benchmarkId));
    for (const g of sums) {
      out.set(g.benchmarkId, { inputTokens: g._sum.inputTokens ?? 0, outputTokens: g._sum.outputTokens ?? 0, cachedInputTokens: g._sum.cachedInputTokens ?? 0, modelCalls: g._sum.modelCalls ?? 0, costUsd: Number(g._sum.costUsd ?? 0), costKnown: !unknown.has(g.benchmarkId) });
    }
    return out;
  }

  private async factsOf(ids: string[]) {
    const [progress, totals] = await Promise.all([this.progressOf(ids), this.totalsOf(ids)]);
    return { progress, totals };
  }

  private view(b: Benchmark, facts: { progress: Map<string, BenchmarkProgress>; totals: Map<string, BenchmarkTotals> }): BenchmarkView {
    return {
      id: b.id,
      name: b.name,
      status: oneOf(BENCHMARK_STATUSES, b.status) ?? ('failed' satisfies BenchmarkStatus),
      suiteKey: b.suiteKey,
      suiteVersion: b.suiteVersion,
      config: publicConfig(readBenchmarkConfig(b.config)),
      appVersion: b.appVersion,
      commit: b.commit,
      spentUsd: Number(b.spentUsd),
      progress: facts.progress.get(b.id) ?? { ...EMPTY_PROGRESS },
      totals: facts.totals.get(b.id) ?? { ...EMPTY_TOTALS },
      baselineId: b.baselineId,
      createdAt: b.createdAt.toISOString(),
      startedAt: iso(b.startedAt),
      finishedAt: iso(b.finishedAt),
    };
  }

  /** One audit event: ids and counts; never a goal, an answer or a seed. A failure is logged, never thrown. */
  private async audit(userId: string, orgId: string | null, action: string, benchmarkId: string, meta: Record<string, unknown>): Promise<void> {
    try {
      await this.prisma.auditEvent.create({ data: { actorUserId: userId, action, targetType: 'benchmark', targetId: benchmarkId, orgId, meta: { benchmarkId, ...meta } as Prisma.InputJsonValue } });
    } catch (e) {
      this.log.warn(`benchmarks: the audit record ${action} could not be written: ${e instanceof Error ? e.name : 'error'}`);
    }
  }
}

type TrialRow = Omit<BenchmarkTrial, 'siteState' | 'policySnapshot' | 'tokenHash' | 'seed'>;

const readChecks = (value: unknown): Check[] | null =>
  Array.isArray(value)
    ? value.flatMap((c): Check[] => {
        const v = c as Partial<Check> | null;
        return v && typeof v.name === 'string' ? [{ name: v.name, pass: v.pass === true, ...(typeof v.detail === 'string' ? { detail: v.detail } : {}) }] : [];
      })
    : null;

/** A trial as the API returns it: never its seed, its token, its site state or the expected answer. */
export function trialView(t: TrialRow): BenchmarkTrialView {
  const challenge = challengeById(t.challengeId);
  return {
    id: t.id,
    challengeId: t.challengeId,
    challengeTitle: challenge?.title ?? t.challengeId,
    category: challenge?.category ?? null,
    policyRef: t.policyRef,
    policyLabel: t.policyLabel,
    trialIndex: t.trialIndex,
    status: oneOf(TRIAL_STATUSES, t.status) ?? 'skipped',
    verdict: oneOf(TRIAL_VERDICTS, t.verdict),
    failureReason: oneOf(TRIAL_FAILURE_REASONS, t.failureReason),
    checks: readChecks(t.checks),
    claimedSuccess: t.claimedSuccess,
    runId: t.runId,
    durationMs: t.durationMs,
    activeMs: t.activeMs,
    steps: t.steps,
    modelCalls: t.modelCalls,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cachedInputTokens: t.cachedInputTokens,
    model: readTrialModels(t.models)?.model ?? null,
    models: readTrialModels(t.models),
    costUsd: t.costUsd === null ? null : Number(t.costUsd),
    costKnown: t.costKnown,
    stopReason: t.stopReason,
    questions: t.questions,
    escalations: t.escalations,
    startedAt: iso(t.startedAt),
    finishedAt: iso(t.finishedAt),
  };
}
