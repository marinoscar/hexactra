// How a run's and a task's spend leave the API: `cost_usd` is a Decimal in
// the database and a plain number (USD, at most 6 decimal places) on the wire.
import type { Prisma } from '@prisma/client';

/** How far back a task's `spend30d` looks. */
export const SPEND_WINDOW_DAYS = 30;

/** A run with `costUsd` as a number. */
export function withCost<T extends { costUsd: Prisma.Decimal }>(run: T): Omit<T, 'costUsd'> & { costUsd: number } {
  return { ...run, costUsd: Number(run.costUsd) };
}

/** What a task spent over the last 30 days. */
export interface TaskSpend {
  runs: number;
  /** USD; a lower bound while `costKnown` is false. */
  costUsd: number;
  /** False when any of those runs had a call that could not be priced. */
  costKnown: boolean;
  tokens: number;
}

export const NO_SPEND: TaskSpend = { runs: 0, costUsd: 0, costKnown: true, tokens: 0 };
