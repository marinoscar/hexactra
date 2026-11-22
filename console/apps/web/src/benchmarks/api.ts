// THE client of the benchmark pages (E44.5, #743): every call the four admin pages make to
// `/api/benchmarks` (#741, #742) is a typed function here.
import type { PlatformApiClient } from '@marinoscar/platform-web/core';

import type { Benchmark, BenchmarkComparison, BenchmarkList, BenchmarkSuite, BenchmarkTrial, CreateBenchmarkInput, Scorecard } from '../types/benchmarks';

const enc = encodeURIComponent;

export function getSuite(api: PlatformApiClient): Promise<BenchmarkSuite> {
  return api.get<BenchmarkSuite>('/benchmarks/suite');
}

export function listBenchmarks(api: PlatformApiClient, limit = 100): Promise<BenchmarkList> {
  return api.get<BenchmarkList>(`/benchmarks?limit=${limit}`);
}

export function getBenchmark(api: PlatformApiClient, id: string): Promise<Benchmark> {
  return api.get<Benchmark>(`/benchmarks/${enc(id)}`);
}

export async function listTrials(api: PlatformApiClient, id: string): Promise<BenchmarkTrial[]> {
  return (await api.get<{ items: BenchmarkTrial[] }>(`/benchmarks/${enc(id)}/trials`)).items;
}

export function getScorecard(api: PlatformApiClient, id: string): Promise<Scorecard> {
  return api.get<Scorecard>(`/benchmarks/${enc(id)}/scorecard`);
}

export function compareBenchmarks(api: PlatformApiClient, id: string, baselineId: string): Promise<BenchmarkComparison> {
  return api.get<BenchmarkComparison>(`/benchmarks/${enc(id)}/compare?baseline=${enc(baselineId)}`);
}

export function startBenchmark(api: PlatformApiClient, input: CreateBenchmarkInput): Promise<Benchmark> {
  return api.post<Benchmark>('/benchmarks', input);
}

export function cancelBenchmark(api: PlatformApiClient, id: string): Promise<Benchmark> {
  return api.post<Benchmark>(`/benchmarks/${enc(id)}/cancel`, {});
}

/** Deletes a benchmark that has ended; with `deleteRuns` the runs its trials started go too (#873). */
export function deleteBenchmark(api: PlatformApiClient, id: string, opts: { deleteRuns?: boolean } = {}): Promise<void> {
  return api.delete<void>(`/benchmarks/${enc(id)}${opts.deleteRuns ? '?deleteRuns=true' : ''}`);
}

/** `POST /benchmarks/delete`'s answer (#873). */
export interface BenchmarksDeleted {
  deleted: string[];
  skippedRunning: string[];
  notFound: string[];
  /** Runs deleted with them; -1 when not reported (one benchmark through `DELETE`). */
  runsDeleted: number;
}

/** Deletes several benchmarks; a live one is skipped, one that is not the caller's is listed as not found (#873). */
export function deleteBenchmarks(api: PlatformApiClient, ids: string[], opts: { deleteRuns?: boolean } = {}): Promise<BenchmarksDeleted> {
  return api.post<BenchmarksDeleted>('/benchmarks/delete', { ids, deleteRuns: !!opts.deleteRuns });
}
