// `Benchmark.config` as stored (E44.3, #741): what was asked for with every value resolved, plus the organization the benchmark was
// started in (its jobs and runs carry it). The API returns the config without the organization.
import { z } from 'zod';

import { benchmarkConfigSchema, type BenchmarkConfig } from './benchmarks.schemas';

export const storedBenchmarkConfigSchema = benchmarkConfigSchema.extend({ orgId: z.string().nullable().default(null) });
export type StoredBenchmarkConfig = z.infer<typeof storedBenchmarkConfigSchema>;

const EMPTY: StoredBenchmarkConfig = { challengeIds: [], policies: [], trials: 1, hostId: null, profile: 'default', capUsd: 0, trialTimeoutMinutes: 15, orgId: null };

/** The stored config, read defensively: a row this code cannot read behaves as an empty benchmark with no budget. */
export function readBenchmarkConfig(value: unknown): StoredBenchmarkConfig {
  const parsed = storedBenchmarkConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : EMPTY;
}

export function publicConfig(config: StoredBenchmarkConfig): BenchmarkConfig {
  const { orgId: _orgId, ...rest } = config;
  return rest;
}

/**
 * The order trials run in: attempt by attempt, challenge by challenge, and within a challenge one policy after the other. The policies
 * alternate, so a drift in the node or the provider over an hour is spread over all of them instead of landing on the last one.
 */
export function trialRank(config: Pick<BenchmarkConfig, 'challengeIds' | 'policies'>, t: { challengeId: string; policyRef: string; trialIndex: number }): [number, number, number] {
  const at = (i: number) => (i < 0 ? Number.MAX_SAFE_INTEGER : i);
  return [t.trialIndex, at(config.challengeIds.indexOf(t.challengeId)), at(config.policies.findIndex((p) => p.ref === t.policyRef))];
}

export function inRunOrder<T extends { challengeId: string; policyRef: string; trialIndex: number }>(config: Pick<BenchmarkConfig, 'challengeIds' | 'policies'>, trials: readonly T[]): T[] {
  return [...trials].sort((a, b) => {
    const [x, y] = [trialRank(config, a), trialRank(config, b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
}
