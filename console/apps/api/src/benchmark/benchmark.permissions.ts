/**
 * The benchmark permissions (E44, epic #738), as data (the app's part of `src/platform/permissions.ts`). A benchmark spends money on
 * model calls and drives a node, so both are an organization administrator's only: no other role is granted them by default.
 */
export const BENCHMARKS_PERMISSIONS = {
  BENCHMARKS_READ: {
    id: 'benchmarks:read',
    description: 'Read benchmarks, their trials and scorecards',
    scope: 'org',
    defaultGrants: ['org_admin'],
  },
  BENCHMARKS_RUN: {
    id: 'benchmarks:run',
    description: 'Start, cancel and delete benchmarks (runs agents on a node and spends on model calls)',
    scope: 'org',
    defaultGrants: ['org_admin'],
  },
} as const;
