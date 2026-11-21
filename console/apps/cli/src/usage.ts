// `hexactra usage` (#733): the AI usage and cost report and its CSV export,
// over `GET /api/usage/report` and `GET /api/usage/export.csv`. The pieces are
// pure or take their fetch, so each is tested without a console.
import type { FetchLike } from '@marinoscar/platform-cli/api-client';

export const USAGE_RANGES = ['7d', '30d', '90d', '1y'] as const;
export const USAGE_BREAKDOWNS = ['none', 'model', 'tokenType', 'feature', 'provider', 'user'] as const;

/** What `GET /api/usage/report` answers (the fields the CLI prints). */
export interface UsageReportView {
  range: string;
  scope: 'me' | 'all';
  timeZone: string;
  granularity: 'day' | 'month';
  from: string;
  to: string;
  buckets: string[];
  series: { key: string; label: string; costUsd: number[]; tokens: number[]; requests: number[] }[];
  totals: { requests: number; failed: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number; tokens: number; costUsd: number; costKnown: boolean };
  byModel: { key: string; provider: string; model: string; requests: number; tokens: number; costUsd: number | null; costShare: number | null }[];
  unpricedModels: string[];
  runs: { count: number; succeeded: number; costUsd: number; avgSuccessCostUsd: number | null };
  pricing: { overridesApplied: boolean };
}

/** `1,234,567`. */
export const int = (n: number): string => Math.round(n).toLocaleString('en-US');

/** `$1.23`, `$0.0042`, or `≥ $1.23` when a model has no price. */
export function usd(n: number, known = true): string {
  const s = n !== 0 && Math.abs(n) < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
  return known ? s : `≥ ${s}`;
}

/** The report as text: totals, the per-model table and one line per period with usage. */
export function usageReportText(r: UsageReportView): string[] {
  const t = r.totals;
  const lines = [
    `AI usage ${r.scope === 'all' ? '(everyone) ' : ''}${r.from} to ${r.to} (${r.timeZone})`,
    `  Cost        ${usd(t.costUsd, t.costKnown)}${r.pricing.overridesApplied ? '  (your own prices)' : ''}`,
    `  Requests    ${int(t.requests)}${t.failed ? ` (${int(t.failed)} failed)` : ''}`,
    `  Tokens      ${int(t.tokens)}  input ${int(t.inputTokens - t.cachedInputTokens)}, cached ${int(t.cachedInputTokens)}, output ${int(t.outputTokens - t.reasoningTokens)}, reasoning ${int(t.reasoningTokens)}`,
    `  Runs        ${int(r.runs.count)} (${int(r.runs.succeeded)} succeeded)${r.runs.avgSuccessCostUsd !== null ? `, ${usd(r.runs.avgSuccessCostUsd)} per successful run` : ''}`,
  ];
  if (r.unpricedModels.length) lines.push(`  No price for ${r.unpricedModels.join(', ')}: set it in Administration → Model prices.`);
  if (r.byModel.length) {
    lines.push('', 'By model');
    for (const m of r.byModel) lines.push(`  ${m.model.padEnd(28)} ${int(m.requests).padStart(8)} req ${int(m.tokens).padStart(14)} tok ${(m.costUsd === null ? 'no price' : usd(m.costUsd)).padStart(12)}`);
  }
  lines.push('', r.granularity === 'month' ? 'By month' : 'By day');
  for (let i = 0; i < r.buckets.length; i++) {
    const tokens = r.series.reduce((a, s) => a + (s.tokens[i] ?? 0), 0);
    const cost = r.series.reduce((a, s) => a + (s.costUsd[i] ?? 0), 0);
    if (tokens === 0 && cost === 0) continue;
    lines.push(`  ${r.buckets[i]!.padEnd(10)} ${int(tokens).padStart(14)} tok ${usd(cost).padStart(12)}`);
  }
  return lines;
}

/** Where and as whom the CSV is fetched (tests pass a fake fetch). */
export interface UsageCsvTarget {
  apiBaseUrl: string;
  token: string;
  fetch?: FetchLike;
}

/** Fetches `GET /api/usage/export.csv` with the same bearer token; the JSON API client cannot read a CSV body. */
export async function fetchUsageCsv(target: UsageCsvTarget, query: Record<string, string>): Promise<string> {
  const url = `${target.apiBaseUrl.replace(/\/+$/, '')}/usage/export.csv?${new URLSearchParams(query).toString()}`;
  const fetchImpl = target.fetch ?? globalThis.fetch;
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${target.token}`, accept: 'text/csv, application/json' }, signal: AbortSignal.timeout(120_000) });
  const body = await res.text();
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(body) as { message?: string; error?: { message?: string } };
      message = j.error?.message ?? j.message ?? message;
    } catch {
      // Not JSON: keep the status.
    }
    throw new Error(`Could not export the usage: ${message}`);
  }
  return body;
}
