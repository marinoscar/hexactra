import type { ModelOwnershipDef, UserOwnedModelDef } from '@marinoscar/platform-api/core';

/**
 * A benchmark belongs to the administrator who started it (E44, epic #738); its trials follow it. Read a benchmark through
 * `PrismaService.forUser()`, and a trial through its benchmark (the trial has no owner column of its own, like `RunStep`).
 */
export const BENCHMARKS_USER_OWNED_MODELS: readonly UserOwnedModelDef<'Benchmark'>[] = [
  {
    model: 'Benchmark',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: "The benchmarks the user started, with their settings and scorecard (fixture data only, never a secret): deleted with the user, part of the export.",
  },
];

export const BENCHMARKS_MODEL_OWNERSHIP: readonly ModelOwnershipDef<'Benchmark' | 'BenchmarkTrial'>[] = [
  { model: 'Benchmark', kind: 'user', rationale: 'A benchmark belongs to the administrator who started it.' },
  { model: 'BenchmarkTrial', kind: 'user', rationale: 'A trial belongs to its benchmark, reached only through it (and, by its hashed token, by the challenge site while it runs).' },
];
