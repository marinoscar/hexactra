// The run dataset summariser (E53.6, #1074): `node --test scripts/runs/analyze-dataset.test.mjs`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const round = (n) => Math.round(n * 1000) / 1000;
import { fileURLToPath } from 'node:url';

import { analyze, reportLines, spread, summaryKey, tablesOf } from './analyze-dataset.mjs';

const SCRIPT = fileURLToPath(new URL('./analyze-dataset.mjs', import.meta.url));
const run = (id, over = {}) => ({ run_id: id, status: 'succeeded', stop_reason: 'finished', task_id: 't1', task_name: 'Check fares', steps: 10, total_tokens: 1000, cost_usd: 0.01, cost_known: true, working_ms: 60_000, ...over });

/** 6 runs: 4 of "Check fares" (one a costly loop), 2 of "Pay invoice" that stall on a missing button. */
function fixture() {
  return {
    datasets: {
      runs: {
        rows: [
          run('r1'),
          run('r2'),
          run('r3', { steps: 90, cost_usd: 0.4, total_tokens: 40_000, status: 'failed', stop_reason: 'budget_cost' }),
          run('r4', { status: 'running', stop_reason: null }),
          run('r5', { task_id: 't2', task_name: 'Pay invoice', status: 'failed', stop_reason: 'stalled', steps: 30, cost_usd: 0.1 }),
          run('r6', { task_id: 't2', task_name: 'Pay invoice', status: 'failed', stop_reason: 'stalled', steps: 34, cost_usd: 0.12 }),
        ],
      },
      findings: {
        rows: [
          { run_id: 'r3', code: 'loop', severity: 'warn', steps_spent: 70 },
          { run_id: 'r5', code: 'selector_miss', severity: 'warn', steps_spent: 12 },
          { run_id: 'r6', code: 'selector_miss', severity: 'warn', steps_spent: 15 },
          { run_id: 'r6', code: 'slow_start', severity: 'info', steps_spent: 0 },
        ],
      },
      steps: {
        rows: [
          ...Array.from({ length: 5 }, (_, i) => ({ run_id: 'r5', seq: i + 1, kind: 'action', action: 'click', ok: false, summary: `No element matches "#pay-${i}"`, duration_ms: 100 })),
          ...Array.from({ length: 3 }, (_, i) => ({ run_id: 'r6', seq: i + 1, kind: 'action', action: 'click', ok: false, summary: 'No element matches "#pay"', duration_ms: 100 })),
          { run_id: 'r1', seq: 1, kind: 'action', action: 'navigate', ok: true, summary: 'Opened the page', duration_ms: 900 },
        ],
      },
    },
  };
}

test('spread uses the console method: the median of an even list, p90 by the nearest rank', () => {
  assert.deepEqual(spread([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), { n: 10, sum: 55, p50: 5.5, p90: 9, max: 10 });
  assert.equal(spread([]), null);
});

test('refuses a file that is not a run dataset', () => {
  assert.throws(() => tablesOf({ runs: [] }), /Not a run dataset/);
  assert.deepEqual(tablesOf({ datasets: { runs: { rows: [] } } }), { runs: [], findings: [], steps: null });
});

test('overall numbers are over the finished runs', () => {
  const a = analyze(fixture());
  assert.equal(a.overall.runs, 6);
  assert.equal(a.overall.finished, 5);
  assert.equal(a.overall.succeeded, 2);
  assert.equal(a.overall.successRate, 0.4);
  assert.equal(a.overall.costUsd, 0.64);
  assert.equal(a.overall.costPerSuccessUsd, 0.32);
});

test('ranks findings by the cost of the runs they appear in', () => {
  const a = analyze(fixture());
  assert.deepEqual(
    a.findings.map((f) => [f.code, f.runsAffected, f.stepsSpent, f.costOfAffectedRunsUsd, f.failedRuns]),
    [
      ['loop', 1, 70, 0.4, 1],
      ['selector_miss', 2, 27, 0.22, 2],
      ['slow_start', 1, 0, 0.12, 1],
    ],
  );
});

test('ranks tasks by cost, with their share and main stop reason', () => {
  const a = analyze(fixture());
  assert.deepEqual(a.tasks.map((t) => [t.task, t.runs, t.costUsd, t.costShare, t.mainStopReason.reason]), [
    ['Check fares', 3, 0.42, 0.656, 'finished'],
    ['Pay invoice', 2, 0.22, 0.344, 'stalled'],
  ]);
});

test('folds repeated failing summaries and counts failures per tool', () => {
  const a = analyze(fixture());
  assert.deepEqual(a.tools.byTool[0], { tool: 'click', calls: 8, failed: 8, durationMs: 800, failureRate: 1, meanMs: 100 });
  assert.deepEqual(a.tools.failingSummaries[0], { tool: 'click', summary: 'No element matches "…"', count: 8, runs: 2 });
  assert.equal(summaryKey('Waited 12 s for "Pay" 3 times'), 'Waited N s for "…" N times');
});

test('splits the time into model and tools, measured or inferred, and does not count owner answers as tool failures', () => {
  const f = fixture();
  for (const r of f.datasets.runs.rows) Object.assign(r, { working_ms: 10_000, wall_ms: 30_000 });
  f.datasets.runs.rows[0].model_ms = 9_000;
  f.datasets.runs.rows[0].model_calls = 3;
  f.datasets.steps.rows.push({ run_id: 'r5', seq: 9, kind: 'handoff', action: 'answered', ok: false, summary: 'The owner declined to answer', duration_ms: 0 });
  const a = analyze(f);
  // 5 finished runs × 10 s; tools: r5 500 ms, r6 300 ms, r1 900 ms; r1 measured at 9 s, the rest inferred.
  assert.equal(a.time.runs, 5);
  assert.equal(a.time.modelMeasuredRuns, 1);
  assert.equal(a.time.toolShare, round(1_700 / 50_000));
  assert.equal(a.time.modelShare, round((9_000 + 10_000 + 10_000 + 9_500 + 9_700) / 50_000));
  assert.equal(a.time.wallToWorking, 3);
  assert.equal(a.tools.byTool.find((t) => t.tool === 'answered'), undefined);
});

test('lists the worst runs with their findings', () => {
  const a = analyze(fixture(), { top: 2 });
  assert.deepEqual(a.worstRuns.byCost.map((r) => [r.runId, r.findings]), [
    ['r3', ['loop']],
    ['r6', ['selector_miss', 'slow_start']],
  ]);
});

test('prints the expected ranked report, and JSON, from the command line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hx-analyze-'));
  const file = join(dir, 'runs.json');
  writeFileSync(file, JSON.stringify(fixture()));
  const text = execFileSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
  const lines = text.split('\n');
  assert.equal(lines[0], 'Runs: 6 (5 finished, 2 succeeded, 40%). Cost $0.6400, $0.3200 per success.');
  const ranked = lines.slice(lines.indexOf('Findings, ranked by the cost of the runs they appear in:') + 1, lines.indexOf('Findings, ranked by the cost of the runs they appear in:') + 4).map((l) => l.trim().split(/\s+/)[0]);
  assert.deepEqual(ranked, ['loop', 'selector_miss', 'slow_start']);
  assert.ok(text.includes('8x in 2 runs  click: No element matches "…"'));
  const json = JSON.parse(execFileSync(process.execPath, [SCRIPT, file, '--json', '--top', '1'], { encoding: 'utf8' }));
  assert.equal(json.worstRuns.byCost.length, 1);
  assert.deepEqual(reportLines(analyze(fixture())).slice(0, 1), [lines[0]]);
});

test('a missing file name prints the usage and exits 2', () => {
  assert.throws(() => execFileSync(process.execPath, [SCRIPT], { stdio: 'pipe' }), (e) => e.status === 2);
});
