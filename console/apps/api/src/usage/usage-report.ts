// The usage and cost report (#733, epic #730), pure: the range in the viewer's
// time zone, the buckets (days, or months for a year), the cost of each slice
// split by token type, and the series of the chosen breakdown. No I/O: the
// rows come from `UsageRollupService.rows` and the prices from the caller.
import { addDaysToDateKey, zonedDateKey, zonedDayStart, type DateKey } from '@marinoscar/platform-contract/timezone';

import { priceKey, type ModelPrice, type PriceTable } from '../runner/cost';
import type { UsageRow } from './usage-rollup.service';

export const USAGE_RANGES = ['7d', '30d', '90d', '1y'] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];
export const USAGE_BREAKDOWNS = ['none', 'model', 'tokenType', 'feature', 'provider', 'user'] as const;
export type UsageBreakdown = (typeof USAGE_BREAKDOWNS)[number];
export const TOKEN_TYPES = ['input', 'cachedInput', 'output', 'reasoning'] as const;
export type TokenType = (typeof TOKEN_TYPES)[number];
export const TOKEN_TYPE_LABELS: Record<TokenType, string> = { input: 'Input (uncached)', cachedInput: 'Cached input', output: 'Output', reasoning: 'Reasoning' };

const RANGE_DAYS: Record<Exclude<UsageRange, '1y'>, number> = { '7d': 7, '30d': 30, '90d': 90 };

/** The window of a report: its buckets (date keys or `YYYY-MM`) and the instants they cover. */
export interface UsageWindow {
  granularity: 'day' | 'month';
  buckets: string[];
  from: Date;
  to: Date;
  firstDay: DateKey;
  lastDay: DateKey;
}

/** `YYYY-MM` plus `n` months. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${String(Math.floor(idx / 12)).padStart(4, '0')}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

/** The window of `range` ending today in `timeZone`: 7, 30 or 90 whole days, or the 12 calendar months to this one. */
export function usageWindow(range: UsageRange, timeZone: string, now = new Date()): UsageWindow {
  const today = zonedDateKey(now, timeZone);
  if (range === '1y') {
    const thisMonth = today.slice(0, 7);
    const buckets = Array.from({ length: 12 }, (_, i) => addMonths(thisMonth, i - 11));
    const firstDay = `${buckets[0]}-01` as DateKey;
    const nextMonthDay = `${addMonths(thisMonth, 1)}-01` as DateKey;
    return { granularity: 'month', buckets, from: zonedDayStart(firstDay, timeZone), to: zonedDayStart(nextMonthDay, timeZone), firstDay, lastDay: addDaysToDateKey(nextMonthDay, -1) };
  }
  const days = RANGE_DAYS[range];
  const firstDay = addDaysToDateKey(today, -(days - 1));
  const buckets = Array.from({ length: days }, (_, i) => addDaysToDateKey(firstDay, i) as string);
  return { granularity: 'day', buckets, from: zonedDayStart(firstDay, timeZone), to: zonedDayStart(addDaysToDateKey(today, 1), timeZone), firstDay, lastDay: today };
}

/** The bucket an hour falls in. */
export function bucketOf(hour: Date, granularity: 'day' | 'month', timeZone: string): string {
  const day = zonedDateKey(hour, timeZone);
  return granularity === 'month' ? day.slice(0, 7) : day;
}

/** Token counts of a slice, split so the four types add up to input + output. */
export function tokenSplit(r: Pick<UsageRow, 'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'reasoningTokens'>): Record<TokenType, number> {
  const cached = Math.min(r.cachedInputTokens, r.inputTokens);
  const reasoning = Math.min(r.reasoningTokens, r.outputTokens);
  return { input: r.inputTokens - cached, cachedInput: cached, output: r.outputTokens - reasoning, reasoning };
}

/** The cost of each token type at `price` (USD); reasoning is billed as output, cached input at its own price when set. */
export function costSplit(tokens: Record<TokenType, number>, price: ModelPrice): Record<TokenType, number> {
  const m = 1_000_000;
  return {
    input: (tokens.input * price.inputPerMTok) / m,
    cachedInput: (tokens.cachedInput * (price.cachedInputPerMTok ?? price.inputPerMTok)) / m,
    output: (tokens.output * price.outputPerMTok) / m,
    reasoning: (tokens.reasoning * price.outputPerMTok) / m,
  };
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** One series of the chart: one value per bucket, aligned with `buckets`. */
export interface UsageSeries {
  key: string;
  label: string;
  costUsd: number[];
  tokens: number[];
  requests: number[];
}

export interface UsageTotals {
  requests: number;
  failed: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  tokens: number;
  costUsd: number;
  /** False when a call was on a model with no price: `costUsd` is then a lower bound. */
  costKnown: boolean;
  costByTokenType: Record<TokenType, number>;
}

export interface UsageModelLine {
  key: string;
  provider: string;
  model: string;
  requests: number;
  failed: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  tokens: number;
  /** Null when the model has no price. */
  costUsd: number | null;
  /** Share of the report's known cost, 0-1 (null when unpriced or nothing cost anything). */
  costShare: number | null;
}

export interface UsageReportCore {
  granularity: 'day' | 'month';
  buckets: string[];
  series: UsageSeries[];
  totals: UsageTotals;
  byModel: UsageModelLine[];
  unpricedModels: string[];
}

/** The series key and label of a row for a breakdown other than `tokenType`. */
function seriesOf(r: UsageRow, breakdown: UsageBreakdown, userLabel: (id: string | null) => string): { key: string; label: string } {
  switch (breakdown) {
    case 'model':
      return { key: priceKey(r.provider, r.modelId), label: r.modelId };
    case 'feature':
      return { key: r.feature ?? 'none', label: r.feature ?? 'No feature' };
    case 'provider':
      return { key: r.provider, label: r.provider };
    case 'user':
      return { key: r.userId ?? 'none', label: userLabel(r.userId) };
    default:
      return { key: 'total', label: 'Total' };
  }
}

/** Builds the report from hourly rows. `prices` is the effective table (`'<provider>:<model>'` → price). */
export function buildUsageReport(
  rows: readonly UsageRow[],
  opts: { window: UsageWindow; timeZone: string; breakdown: UsageBreakdown; prices: PriceTable; userLabel?: (id: string | null) => string },
): UsageReportCore {
  const { window, timeZone, breakdown, prices } = opts;
  const userLabel = opts.userLabel ?? ((id: string | null) => id ?? 'Deployment');
  const index = new Map(window.buckets.map((b, i) => [b, i]));
  const n = window.buckets.length;
  const series = new Map<string, UsageSeries>();
  const seriesFor = (key: string, label: string) => {
    let s = series.get(key);
    if (!s) {
      s = { key, label, costUsd: new Array(n).fill(0), tokens: new Array(n).fill(0), requests: new Array(n).fill(0) };
      series.set(key, s);
    }
    return s;
  };
  if (breakdown === 'tokenType') for (const t of TOKEN_TYPES) seriesFor(t, TOKEN_TYPE_LABELS[t]);

  const totals: UsageTotals = {
    requests: 0, failed: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, tokens: 0, costUsd: 0, costKnown: true,
    costByTokenType: { input: 0, cachedInput: 0, output: 0, reasoning: 0 },
  };
  const models = new Map<string, UsageModelLine & { known: boolean }>();
  const unpriced = new Set<string>();

  for (const r of rows) {
    const i = index.get(bucketOf(r.hour, window.granularity, timeZone));
    if (i === undefined) continue;
    const split = tokenSplit(r);
    const key = priceKey(r.provider, r.modelId);
    const price = prices[key];
    const cost = price ? costSplit(split, price) : null;
    const rowCost = cost ? cost.input + cost.cachedInput + cost.output + cost.reasoning : 0;
    const rowTokens = r.inputTokens + r.outputTokens;
    if (!cost && rowTokens > 0) {
      unpriced.add(key);
      totals.costKnown = false;
    }

    totals.requests += r.requests;
    totals.failed += r.failed;
    totals.inputTokens += r.inputTokens;
    totals.cachedInputTokens += r.cachedInputTokens;
    totals.outputTokens += r.outputTokens;
    totals.reasoningTokens += r.reasoningTokens;
    totals.tokens += rowTokens;
    totals.costUsd += rowCost;
    if (cost) for (const t of TOKEN_TYPES) totals.costByTokenType[t] += cost[t];

    const m = models.get(key) ?? { key, provider: r.provider, model: r.modelId, requests: 0, failed: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, tokens: 0, costUsd: 0, costShare: null, known: true };
    m.requests += r.requests;
    m.failed += r.failed;
    m.inputTokens += r.inputTokens;
    m.cachedInputTokens += r.cachedInputTokens;
    m.outputTokens += r.outputTokens;
    m.reasoningTokens += r.reasoningTokens;
    m.tokens += rowTokens;
    if (cost) m.costUsd = (m.costUsd ?? 0) + rowCost;
    else if (rowTokens > 0) m.known = false;
    models.set(key, m);

    if (breakdown === 'tokenType') {
      for (const t of TOKEN_TYPES) {
        const s = series.get(t)!;
        s.tokens[i] += split[t];
        s.costUsd[i] += cost ? cost[t] : 0;
      }
      // Requests are not split by token type: they go on the first series only.
      series.get('input')!.requests[i] += r.requests;
    } else {
      const { key: sk, label } = seriesOf(r, breakdown, userLabel);
      const s = seriesFor(sk, label);
      s.tokens[i] += rowTokens;
      s.costUsd[i] += rowCost;
      s.requests[i] += r.requests;
    }
  }

  totals.costUsd = round6(totals.costUsd);
  for (const t of TOKEN_TYPES) totals.costByTokenType[t] = round6(totals.costByTokenType[t]);
  const out = [...series.values()].map((s) => ({ ...s, costUsd: s.costUsd.map(round6) }));
  // Largest first (by cost, then tokens), so the chart's legend and colours follow what matters.
  if (breakdown !== 'tokenType') out.sort((a, b) => sum(b.costUsd) - sum(a.costUsd) || sum(b.tokens) - sum(a.tokens));
  const byModel = [...models.values()]
    .map(({ known, ...m }) => {
      const costUsd = known ? round6(m.costUsd ?? 0) : null;
      return { ...m, costUsd, costShare: costUsd !== null && totals.costUsd > 0 ? round6(costUsd / totals.costUsd) : null };
    })
    .sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.tokens - a.tokens);
  return { granularity: window.granularity, buckets: window.buckets, series: out, totals, byModel, unpricedModels: [...unpriced].sort() };
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

/** A CSV cell: quoted when needed, and a leading `= + - @` neutralised so a spreadsheet never runs it as a formula. */
export function csvCell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const USAGE_CSV_COLUMNS = [
  'period', 'provider', 'model', 'feature', 'user', 'requests', 'failed',
  'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens', 'total_tokens', 'cost_usd', 'cost_known',
] as const;

/** The CSV: one line per period × provider × model × feature (× user when `withUser`), oldest first. */
export function usageCsv(rows: readonly UsageRow[], opts: { window: UsageWindow; timeZone: string; prices: PriceTable; withUser: boolean; userLabel?: (id: string | null) => string }): string {
  const userLabel = opts.userLabel ?? ((id: string | null) => id ?? '');
  const lines = new Map<string, { period: string; provider: string; model: string; feature: string; user: string; requests: number; failed: number; input: number; cached: number; output: number; reasoning: number }>();
  for (const r of rows) {
    const period = bucketOf(r.hour, opts.window.granularity, opts.timeZone);
    if (!opts.window.buckets.includes(period)) continue;
    const user = opts.withUser ? userLabel(r.userId) : '';
    const k = JSON.stringify([period, r.provider, r.modelId, r.feature, user]);
    const l = lines.get(k) ?? { period, provider: r.provider, model: r.modelId, feature: r.feature ?? '', user, requests: 0, failed: 0, input: 0, cached: 0, output: 0, reasoning: 0 };
    l.requests += r.requests;
    l.failed += r.failed;
    l.input += r.inputTokens;
    l.cached += r.cachedInputTokens;
    l.output += r.outputTokens;
    l.reasoning += r.reasoningTokens;
    lines.set(k, l);
  }
  const header = opts.withUser ? USAGE_CSV_COLUMNS : USAGE_CSV_COLUMNS.filter((c) => c !== 'user');
  const body = [...lines.values()]
    .sort((a, b) => a.period.localeCompare(b.period) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model) || a.feature.localeCompare(b.feature) || a.user.localeCompare(b.user))
    .map((l) => {
      const price = opts.prices[priceKey(l.provider, l.model)];
      const split = tokenSplit({ inputTokens: l.input, cachedInputTokens: l.cached, outputTokens: l.output, reasoningTokens: l.reasoning });
      const c = price ? costSplit(split, price) : null;
      const cost = c ? round6(c.input + c.cachedInput + c.output + c.reasoning) : null;
      const cells: (string | number | boolean | null)[] = [l.period, l.provider, l.model, l.feature];
      if (opts.withUser) cells.push(l.user);
      cells.push(l.requests, l.failed, l.input, l.cached, l.output, l.reasoning, l.input + l.output, cost, cost !== null || l.input + l.output === 0);
      return cells.map(csvCell).join(',');
    });
  return [header.join(','), ...body].join('\r\n') + '\r\n';
}

/** The cost of one slice at `prices` (USD), or null when its model has no price and it used tokens. */
export function rowCost(r: Pick<UsageRow, 'provider' | 'modelId' | 'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'reasoningTokens'>, prices: PriceTable): number | null {
  const price = prices[priceKey(r.provider, r.modelId)];
  if (!price) return r.inputTokens + r.outputTokens > 0 ? null : 0;
  const c = costSplit(tokenSplit(r), price);
  return c.input + c.cachedInput + c.output + c.reasoning;
}

/** Spend per user and in total, for alerts (#736): known USD, and whether every slice was priced. */
export interface SpendSummary {
  totalUsd: number;
  totalKnown: boolean;
  users: { userId: string | null; usd: number; known: boolean }[];
}

/** Sums `rows` into a spend summary at `prices`. Pure. */
export function spendSummary(rows: readonly UsageRow[], prices: PriceTable): SpendSummary {
  const users = new Map<string, { userId: string | null; usd: number; known: boolean }>();
  let totalUsd = 0;
  let totalKnown = true;
  for (const r of rows) {
    const cost = rowCost(r, prices);
    const key = r.userId ?? '';
    const u = users.get(key) ?? { userId: r.userId, usd: 0, known: true };
    if (cost === null) {
      u.known = false;
      totalKnown = false;
    } else {
      u.usd += cost;
      totalUsd += cost;
    }
    users.set(key, u);
  }
  return { totalUsd: round6(totalUsd), totalKnown, users: [...users.values()].map((u) => ({ ...u, usd: round6(u.usd) })).sort((a, b) => b.usd - a.usd) };
}
