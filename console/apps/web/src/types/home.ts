// `GET /api/home/summary`, as the API returns it (`homeSummaryResponseSchema`
// in apps/api/src/openapi/home.responses.ts). A block the viewer may not see is null.
import type { QuestionInput } from '../components/questions';
import type { RunClient, RunOrigin } from '../aiApps/types';
import type { RunStatus, RunStopReason } from './runs';

export interface HomeQuestion {
  questionId: string;
  runId: string | null;
  kind: string;
  input: QuestionInput;
  /** At most 300 characters. */
  prompt: string;
  risk: 'low' | 'high' | null;
  expiresAt: string;
  createdAt: string;
  goal: string | null;
}

/** What a running run is doing; the API leaves the action's arguments out. */
export interface HomeActivity {
  phase: string;
  action: string | null;
  reason: string | null;
  startedAt: string | null;
  note: string | null;
}

export interface HomeLiveRun {
  id: string;
  taskId: string | null;
  taskName: string | null;
  goal: string;
  status: RunStatus;
  activity: HomeActivity | null;
  stepCount: number;
  startedAt: string | null;
  hostId: string | null;
  hostName: string | null;
  policyName: string | null;
  currentTier: string | null;
  startTier: string | null;
  /** The highest percent among the run's limited budgets; null when unlimited. */
  budgetPercent: number | null;
  budgetWarnPercent: number | null;
}

export interface HomeRecentRun {
  id: string;
  taskId: string | null;
  taskName: string | null;
  goal: string;
  status: RunStatus;
  trigger: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  stepCount: number;
  stopReason: RunStopReason | null;
  costUsd: number | null;
  costKnown: boolean;
  error: string | null;
  /** Where it was started from, and the AI app that started it (#464). */
  origin?: RunOrigin;
  client?: RunClient | null;
}

export interface HomeUpcoming {
  scheduleId: string;
  taskId: string;
  taskName: string;
  nextRunAt: string;
  description: string;
  timezone: string;
}

export interface HomeWeekDay {
  date: string;
  succeeded: number;
  failed: number;
  cancelled: number;
  costUsd: number | null;
}

export interface HomeWeek {
  totals: { succeeded: number; failed: number; cancelled: number; successRate: number | null; costUsd: number | null; costKnown: boolean; budgetStops: number; stalled: number };
  series: HomeWeekDay[];
}

export interface HomeHost {
  id: string;
  name: string;
  online: boolean;
  draining: boolean;
  mode: 'unattended' | 'attended' | 'container' | null;
}

export interface HomeFleet {
  total: number;
  online: number;
  disabled: number;
  /** The fabric did not answer in time: the hosts are the last ones read. */
  stale: boolean;
  hosts: HomeHost[];
}

export interface HomeSummary {
  generatedAt: string;
  timezone: string;
  needsYou: { count: number; items: HomeQuestion[] } | null;
  liveRuns: { count: number; running: number; items: HomeLiveRun[] } | null;
  upcoming: { items: HomeUpcoming[]; pausedCount: number; failingCount: number } | null;
  recentRuns: { items: HomeRecentRun[] } | null;
  week: HomeWeek | null;
  fleet: HomeFleet | null;
  counts: { tasks: number | null; runs: number | null };
}
