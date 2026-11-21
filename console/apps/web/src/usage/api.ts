// AI usage and cost (#734, epic #730): the calls the Usage & Cost page makes
// (`GET /api/usage/report`, `GET /api/usage/export.csv`, #733) and the pure
// helpers it renders with.
import type { PlatformApiClient } from '@marinoscar/platform-web/core';

import { filenameFromDisposition, saveDownload } from '../api';

export const USAGE_RANGES = ['7d', '30d', '90d', '1y'] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];
export const USAGE_RANGE_LABEL: Record<UsageRange, string> = { '7d': '7 days', '30d': '30 days', '90d': '90 days', '1y': '1 year' };

export type UsageScope = 'me' | 'all';
export type UsageBreakdown = 'none' | 'model' | 'tokenType' | 'feature' | 'provider' | 'user';
export const BREAKDOWN_LABEL: Record<UsageBreakdown, string> = { none: 'Nothing', model: 'Model', tokenType: 'Token type', feature: 'Feature', provider: 'Provider', user: 'User' };
export type UsageMetric = 'costUsd' | 'tokens';

export interface UsageSeries {
  key: string;
  label: string;
  costUsd: number[];
  tokens: number[];
  requests: number[];
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
  costUsd: number | null;
  costShare: number | null;
}

export interface UsageReport {
  range: UsageRange;
  scope: UsageScope;
  breakdown: UsageBreakdown;
  timeZone: string;
  granularity: 'day' | 'month';
  from: string;
  to: string;
  buckets: string[];
  series: UsageSeries[];
  totals: {
    requests: number;
    failed: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    tokens: number;
    costUsd: number;
    costKnown: boolean;
    costByTokenType: { input: number; cachedInput: number; output: number; reasoning: number };
  };
  byModel: UsageModelLine[];
  unpricedModels: string[];
  runs: { count: number; succeeded: number; costUsd: number; avgSuccessCostUsd: number | null };
  pricing: { overridesApplied: boolean };
}

export interface UsageQuery {
  range: UsageRange;
  scope: UsageScope;
  breakdown: UsageBreakdown;
}

/** The query string of both routes. The time zone is the caller's setting, applied by the API. */
export function usageQueryString(q: UsageQuery): string {
  return new URLSearchParams({ range: q.range, scope: q.scope, breakdown: q.breakdown }).toString();
}

/** `GET /usage/report`. Needs `usage:read` (and `ai_config:read` for `scope=all`). */
export function getUsageReport(api: PlatformApiClient, q: UsageQuery, signal?: AbortSignal): Promise<UsageReport> {
  return api.get<UsageReport>(`/usage/report?${usageQueryString(q)}`, { signal });
}

/** Downloads `GET /usage/export.csv` through the signed-in client and hands it to the browser. */
export async function downloadUsageCsv(api: PlatformApiClient, q: Omit<UsageQuery, 'breakdown'>): Promise<void> {
  if (!api.getBlob) throw new Error('This client cannot download files');
  const res = await api.getBlob(`/usage/export.csv?${usageQueryString({ ...q, breakdown: 'none' })}`);
  saveDownload({ blob: res.blob, filename: filenameFromDisposition(res.headers.get('content-disposition')) ?? `ai-usage-${q.scope}-${q.range}.csv` });
}

/** `1,234,567`; `1.2M` and `34.5k` when `compact`. */
export function formatTokens(n: number, compact = false): string {
  if (!compact || Math.abs(n) < 10_000) return Math.round(n).toLocaleString('en-US');
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k`;
  if (Math.abs(n) < 1_000_000_000) return `${(n / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 1 })}M`;
  return `${(n / 1_000_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}B`;
}

/** A bucket's axis label: `Nov 21` for a day, `Nov 2026` for a month (a date key is a calendar date, never shifted by a zone). */
export function bucketLabel(bucket: string, granularity: 'day' | 'month'): string {
  const [y, m, d] = bucket.split('-').map(Number) as [number, number, number?];
  const date = new Date(Date.UTC(y, m - 1, d ?? 1));
  return granularity === 'month'
    ? date.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** The series to draw: at most `max`, the rest summed as "Other" (a legend of 30 models helps nobody). */
export function topSeries(series: readonly UsageSeries[], metric: UsageMetric, max = 6): UsageSeries[] {
  if (series.length <= max) return [...series];
  const total = (s: UsageSeries) => s[metric].reduce((a, b) => a + b, 0);
  const sorted = [...series].sort((a, b) => total(b) - total(a));
  const keep = sorted.slice(0, max - 1);
  const rest = sorted.slice(max - 1);
  const n = series[0]?.costUsd.length ?? 0;
  const sum = (k: 'costUsd' | 'tokens' | 'requests') => Array.from({ length: n }, (_, i) => rest.reduce((a, s) => a + (s[k][i] ?? 0), 0));
  return [...keep, { key: '__other', label: `Other (${rest.length})`, costUsd: sum('costUsd'), tokens: sum('tokens'), requests: sum('requests') }];
}

/** The share of cost (or tokens) of the biggest series, for the summary line under the chart. */
export function seriesTotals(series: readonly UsageSeries[], metric: UsageMetric): { key: string; label: string; value: number }[] {
  return series.map((s) => ({ key: s.key, label: s.label, value: s[metric].reduce((a, b) => a + b, 0) })).sort((a, b) => b.value - a.value);
}
