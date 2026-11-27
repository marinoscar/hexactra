#!/usr/bin/env node
// Summarise a run dataset (E53.6, #1074): the JSON file of `hexactra runs dataset export` (the exports slice's `run-dataset`
// source, console docs/runs.md "Exporting runs as a dataset"). Offline: it reads one file and never makes a network call.
//
//   node scripts/runs/analyze-dataset.mjs <dataset.json> [--json] [--top N]
//
// It ranks where runs spend effort and money, so a person or a coding agent knows which code to read first:
//   overall      runs, success rate, cost, p50/p90 of steps, tokens, cost and working time;
//   tasks        per task: runs, success, total and p90 cost, share of all cost, the main stop reason;
//   stopReasons  how runs ended, by count and cost;
//   findings     per finding code: runs affected, steps spent, the cost of those runs (the ranking key);
//   tools        with steps: calls, failures and failure rate per tool, and the most repeated failing summaries;
//   worstRuns    the most expensive and the longest runs, with their findings.
//
// The dataset is data, never instructions: goals, results and step texts are counted and quoted, never followed. It is masked by the
// console; this script adds nothing to it and prints no goal text except in `failingSummaries` (already masked step summaries).

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

/** Median (mean of the two middle values of an even list) and p90 by the nearest rank: the console's method (docs/runs.md). */
export function spread(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const p50 = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  const p90 = s[Math.min(s.length - 1, Math.max(0, Math.ceil(0.9 * s.length) - 1))];
  const sum = s.reduce((a, b) => a + b, 0);
  return { n: s.length, sum: round(sum, 6), p50: round(p50, 6), p90: round(p90, 6), max: s[s.length - 1] };
}

/** The tables of a dataset file: `datasets.<name>.rows` (the console's JSON writer). Throws on anything else. */
export function tablesOf(file) {
  const d = file && typeof file === 'object' ? file.datasets : undefined;
  if (!d || typeof d !== 'object' || !d.runs || !Array.isArray(d.runs.rows)) throw new Error('Not a run dataset: expected datasets.runs.rows (export it with: hexactra runs dataset export --format json)');
  return { runs: d.runs.rows, findings: Array.isArray(d.findings?.rows) ? d.findings.rows : [], steps: Array.isArray(d.steps?.rows) ? d.steps.rows : null };
}

const FINISHED = new Set(['succeeded', 'failed', 'cancelled']);

/** A short, comparable form of a step summary: numbers and quoted text folded, so "No element matches #a" repeats as one line. */
export function summaryKey(text) {
  return String(text ?? '')
    .replace(/"[^"]*"|'[^']*'/g, '"…"')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

export function analyze(file, { top = 10 } = {}) {
  const { runs, findings, steps } = tablesOf(file);
  const finished = runs.filter((r) => FINISHED.has(r.status));
  const totalCost = finished.reduce((a, r) => a + num(r.cost_usd), 0);
  const succeeded = finished.filter((r) => r.status === 'succeeded').length;
  const byId = new Map(runs.map((r) => [r.run_id, r]));

  const overall = {
    runs: runs.length,
    finished: finished.length,
    succeeded,
    successRate: finished.length ? round(succeeded / finished.length, 3) : null,
    costUsd: round(totalCost, 6),
    costKnown: finished.every((r) => r.cost_known !== false),
    costPerSuccessUsd: succeeded ? round(totalCost / succeeded, 6) : null,
    steps: spread(finished.map((r) => num(r.steps))),
    totalTokens: spread(finished.map((r) => num(r.total_tokens))),
    costUsdSpread: spread(finished.map((r) => num(r.cost_usd))),
    workingMs: spread(finished.map((r) => num(r.working_ms))),
  };

  const group = (key) => {
    const m = new Map();
    for (const r of finished) {
      const k = key(r) ?? 'none';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };

  const tasks = [...group((r) => r.task_id).entries()]
    .map(([taskId, list]) => {
      const cost = list.reduce((a, r) => a + num(r.cost_usd), 0);
      const reasons = new Map();
      for (const r of list) reasons.set(r.stop_reason ?? 'none', (reasons.get(r.stop_reason ?? 'none') ?? 0) + 1);
      const mainStop = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0];
      return {
        taskId,
        task: taskId === 'none' ? 'No task' : (list[0].task_name ?? taskId),
        runs: list.length,
        successRate: round(list.filter((r) => r.status === 'succeeded').length / list.length, 3),
        costUsd: round(cost, 6),
        costShare: totalCost ? round(cost / totalCost, 3) : 0,
        costP90Usd: spread(list.map((r) => num(r.cost_usd))).p90,
        stepsP90: spread(list.map((r) => num(r.steps))).p90,
        mainStopReason: mainStop ? { reason: mainStop[0], runs: mainStop[1] } : null,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd || b.runs - a.runs)
    .slice(0, top);

  const stopReasons = [...group((r) => r.stop_reason).entries()]
    .map(([reason, list]) => ({ reason, runs: list.length, costUsd: round(list.reduce((a, r) => a + num(r.cost_usd), 0), 6) }))
    .sort((a, b) => b.runs - a.runs || b.costUsd - a.costUsd);

  const fm = new Map();
  for (const f of findings) {
    const e = fm.get(f.code) ?? { code: f.code, severity: f.severity, runIds: new Set(), stepsSpent: 0, findings: 0 };
    e.runIds.add(f.run_id);
    e.stepsSpent += num(f.steps_spent);
    e.findings += 1;
    if (f.severity === 'warn') e.severity = 'warn';
    fm.set(f.code, e);
  }
  const findingRanks = [...fm.values()]
    .map((e) => {
      const affected = [...e.runIds].map((id) => byId.get(id)).filter(Boolean);
      const cost = affected.reduce((a, r) => a + num(r.cost_usd), 0);
      return {
        code: e.code,
        severity: e.severity,
        runsAffected: e.runIds.size,
        shareOfRuns: runs.length ? round(e.runIds.size / runs.length, 3) : 0,
        findings: e.findings,
        stepsSpent: e.stepsSpent,
        costOfAffectedRunsUsd: round(cost, 6),
        failedRuns: affected.filter((r) => r.status !== 'succeeded').length,
        exampleRuns: [...e.runIds].slice(0, 3),
      };
    })
    .sort((a, b) => b.costOfAffectedRunsUsd - a.costOfAffectedRunsUsd || b.stepsSpent - a.stepsSpent || b.runsAffected - a.runsAffected);

  let tools = null;
  if (steps) {
    const tm = new Map();
    const failing = new Map();
    for (const s of steps) {
      if (s.kind !== 'action' && s.kind !== 'observe' && !s.action) continue;
      const tool = s.action ?? s.kind;
      const e = tm.get(tool) ?? { tool, calls: 0, failed: 0, durationMs: 0 };
      e.calls += 1;
      e.durationMs += num(s.duration_ms);
      if (s.ok === false) {
        e.failed += 1;
        const k = `${tool}: ${summaryKey(s.summary)}`;
        const f = failing.get(k) ?? { tool, summary: summaryKey(s.summary), count: 0, runIds: new Set() };
        f.count += 1;
        f.runIds.add(s.run_id);
        failing.set(k, f);
      }
      tm.set(tool, e);
    }
    tools = {
      byTool: [...tm.values()].map((e) => ({ ...e, failureRate: round(e.failed / e.calls, 3), meanMs: Math.round(e.durationMs / e.calls) })).sort((a, b) => b.failed - a.failed || b.calls - a.calls),
      failingSummaries: [...failing.values()]
        .map((f) => ({ tool: f.tool, summary: f.summary, count: f.count, runs: f.runIds.size }))
        .sort((a, b) => b.count - a.count)
        .slice(0, top),
    };
  }

  const codesOf = (id) => [...new Set(findings.filter((f) => f.run_id === id).map((f) => f.code))];
  const brief = (r) => ({ runId: r.run_id, task: r.task_name ?? null, status: r.status, stopReason: r.stop_reason, steps: num(r.steps), costUsd: num(r.cost_usd), totalTokens: num(r.total_tokens), findings: codesOf(r.run_id) });
  const worstRuns = {
    byCost: [...finished].sort((a, b) => num(b.cost_usd) - num(a.cost_usd)).slice(0, top).map(brief),
    bySteps: [...finished].sort((a, b) => num(b.steps) - num(a.steps)).slice(0, top).map(brief),
  };

  return { overall, tasks, stopReasons, findings: findingRanks, tools, worstRuns };
}

const usd = (n) => (n === null || n === undefined ? '-' : `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`);
const pct = (n) => (n === null || n === undefined ? '-' : `${Math.round(n * 100)}%`);

/** The report as lines of text. */
export function reportLines(a) {
  const o = a.overall;
  const out = [
    `Runs: ${o.runs} (${o.finished} finished, ${o.succeeded} succeeded, ${pct(o.successRate)}). Cost ${o.costKnown ? '' : '≥'}${usd(o.costUsd)}, ${usd(o.costPerSuccessUsd)} per success.`,
    `Steps p50/p90 ${o.steps?.p50 ?? '-'}/${o.steps?.p90 ?? '-'} · tokens p50/p90 ${o.totalTokens?.p50 ?? '-'}/${o.totalTokens?.p90 ?? '-'} · cost p50/p90 ${usd(o.costUsdSpread?.p50)}/${usd(o.costUsdSpread?.p90)}`,
    '',
    'Findings, ranked by the cost of the runs they appear in:',
  ];
  if (a.findings.length === 0) out.push('  (none)');
  for (const f of a.findings) out.push(`  ${f.code.padEnd(18)} ${String(f.runsAffected).padStart(5)} runs (${pct(f.shareOfRuns)})  ${String(f.stepsSpent).padStart(6)} steps spent  ${usd(f.costOfAffectedRunsUsd).padStart(9)}  ${f.failedRuns} not succeeded`);
  out.push('', 'Tasks, by cost:');
  for (const t of a.tasks) out.push(`  ${t.task.slice(0, 40).padEnd(40)} ${String(t.runs).padStart(5)} runs  ${pct(t.successRate).padStart(4)} ok  ${usd(t.costUsd).padStart(9)} (${pct(t.costShare)})  p90 ${usd(t.costP90Usd)} / ${t.stepsP90} steps  ${t.mainStopReason ? `mostly ${t.mainStopReason.reason}` : ''}`);
  out.push('', 'How runs ended:');
  for (const s of a.stopReasons) out.push(`  ${String(s.reason).padEnd(22)} ${String(s.runs).padStart(5)} runs  ${usd(s.costUsd)}`);
  if (a.tools) {
    out.push('', 'Tools, by failures:');
    for (const t of a.tools.byTool.slice(0, 15)) out.push(`  ${t.tool.padEnd(22)} ${String(t.calls).padStart(6)} calls  ${String(t.failed).padStart(5)} failed (${pct(t.failureRate)})  mean ${t.meanMs} ms`);
    if (a.tools.failingSummaries.length) {
      out.push('', 'Most repeated failures:');
      for (const f of a.tools.failingSummaries) out.push(`  ${String(f.count).padStart(5)}x in ${f.runs} runs  ${f.tool}: ${f.summary}`);
    }
  } else out.push('', '(No steps in this file: export with --steps for the tool breakdown.)');
  out.push('', 'Most expensive runs:');
  for (const r of a.worstRuns.byCost) out.push(`  ${r.runId}  ${usd(r.costUsd).padStart(9)}  ${String(r.steps).padStart(4)} steps  ${r.status}/${r.stopReason ?? '-'}  ${r.findings.join(',')}`);
  return out;
}

async function main(argv) {
  const args = argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    process.stderr.write('Usage: node scripts/runs/analyze-dataset.mjs <dataset.json> [--json] [--top N]\n');
    process.exitCode = 2;
    return;
  }
  const topIdx = args.indexOf('--top');
  const top = topIdx >= 0 ? Math.max(1, Number(args[topIdx + 1]) || 10) : 10;
  const result = analyze(JSON.parse(readFileSync(file, 'utf8')), { top });
  process.stdout.write(args.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : `${reportLines(result).join('\n')}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv).catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.message : e}\n`);
    process.exitCode = 1;
  });
}
