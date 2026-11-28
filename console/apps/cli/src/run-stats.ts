// `hexactra runs stats` (E53.4, #1072): the flags as `GET /api/runs/stats` query parameters, and the table it prints. Pure: the command
// fetches, this words it, the tests read it. `--json` prints the API's answer unchanged: that shape is the contract scripts and coding
// agents read (docs/runs.md, "GET /api/runs/stats").

export const STATS_GROUP_BY = ['none', 'task', 'policy', 'stopReason', 'status', 'trigger', 'origin', 'tier', 'day', 'week'] as const;
/** `--all` (the admin route) also groups by user. */
export const STATS_ADMIN_GROUP_BY = [...STATS_GROUP_BY, 'user'] as const;

export interface Distribution {
  n: number;
  sum: number;
  mean: number;
  min: number;
  p50: number;
  p90: number;
  max: number;
}

export interface StatsGroup {
  key?: string;
  label?: string;
  runs: number;
  finished: number;
  live: number;
  byStatus: Record<string, number>;
  successRate: number | null;
  costPerSuccessUsd: number | null;
  costKnown: boolean;
  metrics: Record<'workingMs' | 'wallMs' | 'modelMs' | 'steps' | 'modelCalls' | 'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'totalTokens' | 'costUsd', Distribution | null>;
}

export interface RunStats {
  groupBy: string;
  timeZone: string;
  scanned: number;
  truncated: boolean;
  total: StatsGroup;
  groups: (StatsGroup & { key: string; label: string })[];
  groupsTruncated: boolean;
}

export interface StatsFlags {
  by?: string;
  from?: string;
  to?: string;
  status?: string;
  stopReason?: string;
  policy?: string;
  trigger?: string;
  origin?: string;
  q?: string;
  tz?: string;
}

const RELATIVE = /^(\d{1,4})([hdw])$/;

/** `7d`, `24h`, `2w` (before now) or an ISO 8601 date-time; a bare date (`2026-06-01`) is its UTC midnight. */
export function timeArg(value: string, now = Date.now()): string {
  const rel = RELATIVE.exec(value.trim());
  if (rel) {
    const unit = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[rel[2] as 'h' | 'd' | 'w'];
    return new Date(now - Number(rel[1]) * unit).toISOString();
  }
  const v = /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? `${value.trim()}T00:00:00Z` : value.trim();
  const t = Date.parse(v);
  if (Number.isNaN(t) || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(v)) throw new Error(`"${value}" is not a time: use 7d, 24h, 2w, 2026-06-01 or an ISO date-time with a zone`);
  return new Date(t).toISOString();
}

/** The query parameters of a stats request. `taskId` is resolved by the command (a name, an id prefix or `none`). */
export function statsQuery(flags: StatsFlags, taskId?: string, now = Date.now(), all = false): Record<string, string> {
  const by = flags.by ?? 'none';
  const allowed: readonly string[] = all ? STATS_ADMIN_GROUP_BY : STATS_GROUP_BY;
  if (!allowed.includes(by)) throw new Error(`--by must be one of: ${allowed.join(', ')}`);
  const q: Record<string, string> = { groupBy: by };
  if (flags.from) q.from = timeArg(flags.from, now);
  if (flags.to) q.to = timeArg(flags.to, now);
  if (taskId) q.taskId = taskId;
  if (flags.status) q.status = flags.status;
  if (flags.stopReason) q.stopReason = flags.stopReason;
  if (flags.policy) q.policyId = flags.policy;
  if (flags.trigger) q.trigger = flags.trigger;
  if (flags.origin) q.origin = flags.origin;
  if (flags.q) q.q = flags.q;
  if (flags.tz) q.tz = flags.tz;
  return q;
}

const pct = (n: number | null) => (n === null ? '-' : `${Math.round(n * 100)}%`);
const usd = (n: number | null | undefined, known = true) => (n === null || n === undefined ? '-' : `${known ? '' : '≥'}$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`);
const mins = (ms: number | null | undefined) => (ms === null || ms === undefined ? '-' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 60_000).toFixed(1)}m`);
const tokens = (n: number | null | undefined) => (n === null || n === undefined ? '-' : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(Math.round(n)));
const num = (n: number | null | undefined) => (n === null || n === undefined ? '-' : String(Math.round(n)));

const COLUMNS: { head: string; cell: (g: StatsGroup) => string }[] = [
  { head: 'RUNS', cell: (g) => String(g.runs) },
  { head: 'OK', cell: (g) => pct(g.successRate) },
  { head: 'STEPS p50/p90', cell: (g) => `${num(g.metrics.steps?.p50)}/${num(g.metrics.steps?.p90)}` },
  { head: 'TIME p50/p90', cell: (g) => `${mins(g.metrics.workingMs?.p50)}/${mins(g.metrics.workingMs?.p90)}` },
  { head: 'TOKENS p50/p90', cell: (g) => `${tokens(g.metrics.totalTokens?.p50)}/${tokens(g.metrics.totalTokens?.p90)}` },
  { head: 'COST p50/p90', cell: (g) => `${usd(g.metrics.costUsd?.p50, g.costKnown)}/${usd(g.metrics.costUsd?.p90, g.costKnown)}` },
  { head: 'COST TOTAL', cell: (g) => usd(g.metrics.costUsd?.sum, g.costKnown) },
  { head: '$/SUCCESS', cell: (g) => usd(g.costPerSuccessUsd, g.costKnown) },
];

/** A table: one row per group (or the total alone), then the total and notes. Working time excludes waiting for a person. */
export function statsLines(s: RunStats): string[] {
  if (s.total.runs === 0) return ['No runs match.'];
  const name = (g: StatsGroup & { label?: string }) => g.label ?? 'All runs';
  const rows: (StatsGroup & { label?: string })[] = s.groupBy === 'none' ? [s.total] : [...s.groups, { ...s.total, label: 'TOTAL' }];
  const nameWidth = Math.min(40, Math.max(5, ...rows.map((r) => name(r).length)));
  const cells = rows.map((r) => [name(r).length > nameWidth ? `${name(r).slice(0, nameWidth - 1)}…` : name(r), ...COLUMNS.map((c) => c.cell(r))]);
  const head = [s.groupBy === 'none' ? '' : s.groupBy.toUpperCase(), ...COLUMNS.map((c) => c.head)];
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((row) => row[i]!.length)));
  const line = (row: string[]) => row.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ').trimEnd();
  const out = [line(head), ...cells.map(line)];
  const b = s.total.byStatus;
  out.push('', `${s.total.finished} finished (${b.succeeded ?? 0} succeeded, ${b.failed ?? 0} failed, ${b.cancelled ?? 0} cancelled), ${s.total.live} live. Percentiles are over finished runs; time is working time.`);
  if (!s.total.costKnown) out.push('≥: a model had no price, so the cost is a lower bound.');
  if (s.truncated) out.push(`Only the newest ${s.scanned} runs were read: narrow --from/--to for exact numbers.`);
  if (s.groupsTruncated) out.push('More groups than shown: the largest (or the latest periods) are listed.');
  if (s.groupBy === 'day' || s.groupBy === 'week') out.push(`Days are in ${s.timeZone}.`);
  return out;
}
