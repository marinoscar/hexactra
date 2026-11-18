// How a run's and a task's spend leave the API: `cost_usd` is a Decimal in
// the database and a plain number (USD, at most 6 decimal places) on the wire.
import type { Prisma } from '@prisma/client';

/** How far back a task's `spend30d` looks. */
export const SPEND_WINDOW_DAYS = 30;

/** The AI app that started a run, as a run payload carries it (#464). */
export interface RunClientView {
  id: string | null;
  name: string | null;
  /** False: a name an MCP client gave itself (a personal access token caller). */
  verified: boolean;
}

/** The client columns of a run as one object; null for a run no app started. */
export function runClientView(run: { clientId?: string | null; clientName?: string | null }): RunClientView | null {
  const id = run.clientId ?? null;
  const name = run.clientName ?? null;
  return id || name ? { id, name, verified: id !== null } : null;
}

type ClientColumns = 'clientId' | 'clientName' | 'grantId' | 'appLimits';
type WithClient<T> = T extends { clientId: unknown } ? { client: RunClientView | null } : unknown;

/**
 * A run as the API returns it: `costUsd` as a number, and (#464) the app that
 * started it as `client { id, name, verified }` in place of its columns (the
 * grant and the limits that applied stay server-side).
 */
export function withCost<T extends { costUsd: Prisma.Decimal }>(run: T): Omit<T, 'costUsd' | ClientColumns> & { costUsd: number } & WithClient<T> {
  const out: Record<string, unknown> = { ...run, costUsd: Number(run.costUsd) };
  if ('clientId' in run || 'clientName' in run) {
    out.client = runClientView(run as { clientId?: string | null; clientName?: string | null });
    for (const k of ['clientId', 'clientName', 'grantId', 'appLimits']) delete out[k];
  }
  return out as Omit<T, 'costUsd' | ClientColumns> & { costUsd: number } & WithClient<T>;
}

/** What a task spent over the last 30 days. */
export interface TaskSpend {
  runs: number;
  /** USD; a lower bound while `costKnown` is false. */
  costUsd: number;
  /** False when any of those runs had a call that could not be priced. */
  costKnown: boolean;
  tokens: number;
  /** Of those runs, how many succeeded. */
  succeeded: number;
  /** The average cost of one successful run (USD); null with no successful run (#408). */
  avgSuccessCostUsd: number | null;
}

export const NO_SPEND: TaskSpend = { runs: 0, costUsd: 0, costKnown: true, tokens: 0, succeeded: 0, avgSuccessCostUsd: null };

/** The average of `totalUsd` over `count` runs, to 6 decimal places; null for no runs. */
export function averageUsd(totalUsd: number, count: number): number | null {
  if (count <= 0) return null;
  return Math.round((totalUsd / count) * 1_000_000) / 1_000_000;
}
