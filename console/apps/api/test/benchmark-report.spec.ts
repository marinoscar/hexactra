// The benchmark report (E44.6, #744), without a database: the report object (masked, its schema, the trial token hidden), the CSV
// (RFC 4180, parsed back, formula cells neutralised, its sums equal to the scorecard's totals) and the PDF (the definition as a snapshot,
// then the rendered file read back by pdf.js).
import { HIDDEN_TRIAL_TOKEN, CSV_COLUMNS, benchmarkExportFilename, benchmarkReportCsv, buildBenchmarkReport, csvCell, hideTrialTokens } from '../src/benchmark/benchmark-report';
import { BENCHMARK_REPORT_PARTIAL_BANNER, BENCHMARK_REPORT_SECTIONS, buildBenchmarkReportDefinition, count, money, trialRecordingLink } from '../src/benchmark/benchmark-report.pdf';
import { BENCHMARK_REPORT_TYPE, benchmarkReportSchema, type BenchmarkReport } from '../src/benchmark/benchmark-report.schemas';
import { writeFileSync } from 'node:fs';

import { renderPdfBuffer, type ReportDefinition } from '../src/tasks/run-report.pdf';
import { POLICY_A, POLICY_B, SEEDED, reportInput } from './helpers/benchmark-report-fixture';
import { parseCsv } from './helpers/csv-parse';
import { linkUris, readPdf } from './helpers/pdf-read';

function normalized(def: ReportDefinition): unknown {
  const footer = typeof def.footer === 'function' ? def.footer(2, 5, { width: 841.89, height: 595.28, orientation: 'landscape' }) : def.footer;
  return JSON.parse(JSON.stringify({ ...def, footer }, (key, value: unknown) => (typeof value === 'function' ? `[function ${key}]` : value)));
}

const sensitive = [SEEDED.token, SEEDED.card, SEEDED.email, SEEDED.siteToken];
const expectMasked = (text: string) => {
  for (const s of sensitive) expect(text).not.toContain(s);
};

describe('buildBenchmarkReport', () => {
  it('is a hexactra.benchmark-report file that validates, with every trial, the scorecard and the benchmark', () => {
    const report = buildBenchmarkReport(reportInput());
    expect(benchmarkReportSchema.parse(report)).toEqual(report);
    expect(report).toMatchObject({ type: BENCHMARK_REPORT_TYPE, formatVersion: 1, partial: false, masking: { applied: true } });
    expect(report.trials).toHaveLength(12);
    expect(report.benchmark).toMatchObject({ suiteKey: 'core', suiteVersion: 1, appVersion: '1.2.3', commit: '0123456789abcdef0123456789abcdef01234567' });
    expect(report.scorecard.matrix).toHaveLength(2);
    expect(report.baseline).toBeNull();
  });

  it('masks the seeded token, card number and email in goals, results, check notes and the name, and hides the trial site token', () => {
    const report = buildBenchmarkReport(reportInput());
    expectMasked(JSON.stringify(report));
    expect(report.masking.hits).toMatchObject({ token: 1, card: 1 });
    expect(report.masking.hits.email).toBeGreaterThanOrEqual(12);
    expect(report.trials[0]!.goal).toContain(`/benchmark/t/${HIDDEN_TRIAL_TOKEN}/nav`);
    expect(report.trials[0]!.result).toMatch(/^Done\. Paid with .+; token \[redacted token\]; mailed .+\.$/);
    const failed = report.trials.find((t) => t.verdict === 'fail')!;
    expect(failed.checks?.[0]?.detail).toMatch(/^Order placed for /);
    // Ids, dates and the commit are not mistaken for sensitive text.
    expect(report.trials[0]!.runId).toBe('00000000-0000-4000-8000-000000000001');
    expect(report.benchmark.commit).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(report.exportedAt).toBe('2026-11-02T08:00:00.000Z');
  });

  it('carries tokens and cost per trial, per policy and for the whole benchmark, and the models used', () => {
    const report = buildBenchmarkReport(reportInput());
    const t = report.trials[0]!;
    expect([t.inputTokens, t.outputTokens, t.cachedInputTokens, t.costUsd, t.costKnown, t.model]).toEqual([10_100, 510, 4_010, 0.011, true, 'fixture:small']);
    const a = report.scorecard.policies.find((p) => p.ref === POLICY_A.ref)!;
    const trialsA = report.trials.filter((x) => x.policyRef === POLICY_A.ref);
    expect(a.metrics.tokens).toMatchObject({ input: trialsA.reduce((s, x) => s + x.inputTokens!, 0), output: trialsA.reduce((s, x) => s + x.outputTokens!, 0), cached: trialsA.reduce((s, x) => s + x.cachedInputTokens!, 0) });
    expect(a.metrics.cost.totalUsd).toBeCloseTo(trialsA.reduce((s, x) => s + x.costUsd!, 0), 6);
    expect(a.metrics.models).toEqual(['fixture:small']);
    expect(report.scorecard.totals).toMatchObject({ inputTokens: report.benchmark.totals.inputTokens, outputTokens: report.benchmark.totals.outputTokens, cachedInputTokens: report.benchmark.totals.cachedInputTokens, costUsd: report.benchmark.spentUsd });
  });

  it('marks a running benchmark as in progress, and carries the comparison when asked', () => {
    expect(buildBenchmarkReport(reportInput({ status: 'running' })).partial).toBe(true);
    const withBase = buildBenchmarkReport(reportInput({ baseline: true }));
    expect(withBase.baseline?.baseline.name).toBe('Last week');
    expect(withBase.baseline?.flipped.length).toBeGreaterThan(0);
    // The comparison carries the token split, for the whole benchmark and per policy (#829).
    const split = ['inputTokens', 'outputTokens', 'cachedInputTokens'];
    const t = withBase.scorecard.totals;
    expect(withBase.baseline!.totals.filter((d) => split.includes(d.metric)).map((d) => [d.metric, d.current])).toEqual([['inputTokens', t.inputTokens], ['outputTokens', t.outputTokens], ['cachedInputTokens', t.cachedInputTokens]]);
    for (const p of withBase.baseline!.policies) expect(p.deltas.filter((d) => split.includes(d.metric)).map((d) => d.metric)).toEqual(split);
  });

  it('hides every trial site token in a text, and leaves other paths alone', () => {
    expect(hideTrialTokens(`a https://x.example.test/benchmark/t/${SEEDED.siteToken}/b and /t/${SEEDED.siteToken}`)).toBe(`a https://x.example.test/benchmark/t/${HIDDEN_TRIAL_TOKEN}/b and /t/${HIDDEN_TRIAL_TOKEN}`);
    expect(hideTrialTokens('/t/short and /tasks/123')).toBe('/t/short and /tasks/123');
  });

  it('names the file hexactra-benchmark-<8>-<yyyymmdd>.<ext>', () => {
    expect(benchmarkExportFilename('0123abcd-0000-4000-8000-000000000000', new Date('2026-11-02T23:59:00Z'), 'csv')).toBe('hexactra-benchmark-0123abcd-20261102.csv');
  });
});

describe('the CSV', () => {
  it('quotes by RFC 4180 and neutralises a cell a spreadsheet would read as a formula', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell(-1.5)).toBe('-1.5');
    expect(csvCell(null)).toBe('');
    expect(csvCell(true)).toBe('true');
  });

  it('parses back to one row per trial with the header, every value as written', () => {
    const report = buildBenchmarkReport(reportInput());
    const csv = benchmarkReportCsv(report);
    expect(csv.endsWith('\r\n')).toBe(true);
    const [header, ...rows] = parseCsv(csv);
    expect(header).toEqual([...CSV_COLUMNS]);
    expect(rows).toHaveLength(report.trials.length);
    const col = (name: (typeof CSV_COLUMNS)[number]) => CSV_COLUMNS.indexOf(name);
    const first = rows[0]!;
    expect(first[col('challenge')]).toBe('nav-lookup');
    expect(first[col('category')]).toBe('navigation');
    expect(first[col('policy_label')]).toBe('Economy');
    expect(first[col('trial')]).toBe('1');
    expect(first[col('verdict')]).toBe('pass');
    expect(first[col('models')]).toBe('fixture:small');
    expect([first[col('input_tokens')], first[col('output_tokens')], first[col('cached_tokens')], first[col('cost_usd')], first[col('cost_known')]]).toEqual(['10100', '510', '4010', '0.011', 'true']);
    expect(first[col('run_id')]).toBe('00000000-0000-4000-8000-000000000001');
    expect(first[col('benchmark_status')]).toBe('completed');
    // The recording's status only (#846): ready, processing, then none. Never the video or a link to it.
    expect(rows.map((r) => r[col('recording')]).slice(0, 3)).toEqual(['ready', 'processing', '']);
    expect(csv).not.toMatch(/recording\.webm|run-recordings\//);
    // The formula-like label reads back with its leading quote.
    expect(rows.find((r) => r[col('policy_ref')] === POLICY_B.ref)![col('policy_label')]).toBe(`'${POLICY_B.label}`);
    const failed = rows.find((r) => r[col('verdict')] === 'fail')!;
    expect(failed[col('failure_reason')]).toBe('wrong_result');
  });

  it('adds up, per policy and in all, to the scorecard tokens and cost', () => {
    const report = buildBenchmarkReport(reportInput());
    const [, ...rows] = parseCsv(benchmarkReportCsv(report));
    const col = (name: (typeof CSV_COLUMNS)[number]) => CSV_COLUMNS.indexOf(name);
    const sum = (rs: string[][], name: (typeof CSV_COLUMNS)[number]) => rs.reduce((s, r) => s + Number(r[col(name)] || 0), 0);
    for (const p of report.scorecard.policies) {
      const mine = rows.filter((r) => r[col('policy_ref')] === p.ref);
      expect([sum(mine, 'input_tokens'), sum(mine, 'output_tokens'), sum(mine, 'cached_tokens')]).toEqual([p.metrics.tokens.input, p.metrics.tokens.output, p.metrics.tokens.cached]);
      expect(sum(mine, 'cost_usd')).toBeCloseTo(p.metrics.cost.totalUsd, 6);
    }
    const t = report.scorecard.totals;
    expect([sum(rows, 'input_tokens'), sum(rows, 'output_tokens'), sum(rows, 'cached_tokens')]).toEqual([t.inputTokens, t.outputTokens, t.cachedInputTokens]);
    expect(sum(rows, 'cost_usd')).toBeCloseTo(t.costUsd, 6);
  });

  it('holds none of the seeded sensitive values, and says "in progress" on every row of a running benchmark', () => {
    expectMasked(benchmarkReportCsv(buildBenchmarkReport(reportInput())));
    const [, ...rows] = parseCsv(benchmarkReportCsv(buildBenchmarkReport(reportInput({ status: 'running' }))));
    expect(rows.every((r) => r[CSV_COLUMNS.indexOf('benchmark_status')] === 'in progress')).toBe(true);
  });
});

describe('buildBenchmarkReportDefinition', () => {
  const report: BenchmarkReport = buildBenchmarkReport(reportInput({ baseline: true }));

  it('matches the snapshot', () => {
    expect(normalized(buildBenchmarkReportDefinition(report))).toMatchSnapshot();
  });

  it('matches the snapshot of the Trial recordings section with the console origin in its links (#863)', () => {
    const { content } = normalized(buildBenchmarkReportDefinition(report, { consoleUrl: 'https://console.example.test' })) as { content: { id?: string }[] };
    const start = content.findIndex((c) => c.id === 'recordings');
    expect(start).toBeGreaterThan(0);
    expect(content.slice(start, start + 3)).toMatchSnapshot();
  });

  it("links a trial's recording to its run page's player, or prints the path without an origin", () => {
    expect(trialRecordingLink('r-1', 'https://console.example.test/')).toBe('https://console.example.test/runs/r-1#recording');
    expect(trialRecordingLink('r-1', null)).toBe('/runs/r-1#recording');
    expect(trialRecordingLink('r-1')).toBe('/runs/r-1#recording');
  });

  it('is pure: the same report gives the same definition, and the report is not changed', () => {
    const before = JSON.stringify(report);
    expect(normalized(buildBenchmarkReportDefinition(report))).toEqual(normalized(buildBenchmarkReportDefinition(report)));
    expect(JSON.stringify(report)).toBe(before);
    expect(buildBenchmarkReportDefinition(report, { paper: 'letter' }).pageSize).toBe('LETTER');
  });

  it('writes counts and money the same everywhere', () => {
    expect([count(1234567), count(0), count(null), count(-1200)]).toEqual(['1,234,567', '0', '—', '-1,200']);
    expect([money(2.4), money(0.0042), money(2.4, false), money(null)]).toEqual(['$2.40', '$0.0042', 'at least $2.40', '—']);
  });
});

describe('the rendered PDF', () => {
  const text = (pages: string[]) => pages.join('\n').replace(/\s+/g, ' ');

  it('reads back with the ranking, the scorecard, tokens and cost, the baseline and the method, and no sensitive value', async () => {
    const report = buildBenchmarkReport(reportInput({ baseline: true }));
    const read = readPdf(await renderPdfBuffer(buildBenchmarkReportDefinition(report)));
    const all = text(read.text);
    for (const h of Object.values(BENCHMARK_REPORT_SECTIONS)) expect(all).toContain(h);
    expect(read.outline).toEqual(expect.arrayContaining(['Benchmark report', 'Ranking', 'Method']));
    expect(read.info).toMatchObject({ Title: expect.stringMatching(/^Benchmark report: /), Author: 'Hexactra' });
    expect(all).toContain('Economy');
    expect(all).toContain('How a trial is graded');
    expect(all).toContain('core version 1');
    const t = report.scorecard.totals;
    expect(all).toContain(`Total cost ${money(t.costUsd)}`);
    expect(all).toContain(`${count(t.totalTokens)} (${count(t.inputTokens)} input, ${count(t.outputTokens)} output, ${count(t.cachedInputTokens)} cached input)`);
    const a = report.scorecard.policies.find((p) => p.ref === POLICY_A.ref)!;
    expect(all).toContain(`Economy ${count(a.metrics.tokens.input)} ${count(a.metrics.tokens.output)} ${count(a.metrics.tokens.cached)}`);
    expect(all).toContain(`Whole benchmark ${count(t.inputTokens)} ${count(t.outputTokens)} ${count(t.cachedInputTokens)}`);
    expect(all).toContain('Economy: fixture:small');
    expect(all).toContain('Last week');
    const delta = (metric: string) => report.baseline!.totals.find((d) => d.metric === metric)!;
    for (const [label, metric] of [['Input tokens', 'inputTokens'], ['Output tokens', 'outputTokens'], ['Cached input tokens', 'cachedInputTokens']] as const) {
      expect(all).toContain(`${label} ${count(delta(metric).baseline!)} ${count(delta(metric).current!)}`);
    }
    expect(all).not.toContain(BENCHMARK_REPORT_PARTIAL_BANNER);
    expectMasked(all);
  });

  it('opens with the leaderboard on page 1, ahead of the summary, and ends with the rankings before the method (#872)', async () => {
    const report = buildBenchmarkReport(reportInput({ baseline: true }));
    const pdf = await renderPdfBuffer(buildBenchmarkReportDefinition(report));
    if (process.env.BENCHMARK_PDF_OUT) writeFileSync(process.env.BENCHMARK_PDF_OUT, pdf);
    const read = readPdf(pdf);
    const first = text([read.text[0]!]);
    const leader = report.scorecard.policies.find((p) => p.score.overall.accuracy.rank === 1)!;
    expect(first.indexOf('Leaderboard')).toBeGreaterThanOrEqual(0);
    expect(first.indexOf('Leaderboard')).toBeLessThan(first.indexOf('Summary'));
    expect(first).toContain('BEST OVERALL · ACCURACY FIRST');
    expect(first).toContain(leader.label);
    expect(first).toContain(leader.score.overall.accuracy.value!.toFixed(1));
    expect(first).toContain('weighting "Accuracy first" (Accuracy 50 · Cost 20 · Time 15 · Tokens 15)');
    expect(read.outline.indexOf('Leaderboard')).toBeLessThan(read.outline.indexOf('Ranking'));
    const all = text(read.text);
    expect(all.lastIndexOf('Rankings')).toBeLessThan(all.lastIndexOf('How a trial is graded'));
    expect(read.outline.indexOf('Rankings')).toBe(read.outline.indexOf('Method') - 1);
    expect(all).toContain('The overall order under every weighting');
    expect(all).toContain('How the Benchmark Score is computed');
    expectMasked(all);
  });

  it('leads with the preset asked for, and names it in the Method (#872)', async () => {
    const report = buildBenchmarkReport(reportInput());
    const read = readPdf(await renderPdfBuffer(buildBenchmarkReportDefinition(report, { preset: 'budget' })));
    const first = text([read.text[0]!]);
    const leader = report.scorecard.policies.find((p) => p.score.overall.budget.rank === 1)!;
    expect(first).toContain('BEST OVERALL · BUDGET');
    expect(first).toContain('weighting "Budget" (Accuracy 35 · Cost 40 · Time 10 · Tokens 15)');
    expect(first).toContain(leader.score.overall.budget.value!.toFixed(1));
    expect(text(read.text)).toContain('this report\'s leaderboard uses "Budget"');
  });

  it('lists every recorded trial with its status, length and run-page link, and counts them in the Method row (#863)', async () => {
    const report = buildBenchmarkReport(reportInput());
    const pdf = await renderPdfBuffer(buildBenchmarkReportDefinition(report, { consoleUrl: 'https://console.example.test' }));
    const all = text(readPdf(pdf).text);
    expect(all).toContain(BENCHMARK_REPORT_SECTIONS.recordings);
    // Trial 1 (ready, 61 s) and trial 2 (still processing), in the fixture's run order.
    expect(all).toMatch(/Look up a record Economy 1 ready 1(\.0)? ?min .*https:\/\/console\.example\.test\/runs\/00000000-0000-4000-8000-000000000001#recording/);
    expect(all).toContain('still processing');
    expect(all).toContain(`2 of 12 trials recorded a video of the browser tab: listed under "${BENCHMARK_REPORT_SECTIONS.recordings}"`);
    // A link the layout wraps is one annotation per line: the same URI each time.
    expect([...new Set(linkUris(pdf))]).toEqual(['https://console.example.test/runs/00000000-0000-4000-8000-000000000001#recording', 'https://console.example.test/runs/00000000-0000-4000-8000-000000000002#recording']);
    // Never the video or its storage key.
    expect(pdf.toString('latin1')).not.toMatch(/run-recordings\/|recording\.webm/);
  });

  it('prints the run-page path when the origin is not known, as text and not as a link', async () => {
    const pdf = await renderPdfBuffer(buildBenchmarkReportDefinition(buildBenchmarkReport(reportInput())));
    expect(text(readPdf(pdf).text)).toContain('/runs/00000000-0000-4000-8000-000000000002#recording');
    expect(linkUris(pdf)).toEqual([]);
  });

  it('has no Trial recordings section when nothing was recorded or the viewer may not read runs (every recording null)', async () => {
    const input = reportInput();
    const report = buildBenchmarkReport({ ...input, trials: input.trials.map((t) => ({ ...t, recording: null })) });
    const pdf = await renderPdfBuffer(buildBenchmarkReportDefinition(report, { consoleUrl: 'https://console.example.test' }));
    const all = text(readPdf(pdf).text);
    expect(all).not.toContain(BENCHMARK_REPORT_SECTIONS.recordings);
    expect(all).not.toContain('#recording');
    expect(all).toMatch(/Recordings Off\./);
    expect(linkUris(pdf)).toEqual([]);
    const on = buildBenchmarkReport({ ...input, benchmark: { ...input.benchmark, config: { ...input.benchmark.config, recordVideo: true } }, trials: input.trials.map((t) => ({ ...t, recording: null })) });
    expect(text(readPdf(await renderPdfBuffer(buildBenchmarkReportDefinition(on))).text)).toContain('No recording is listed here.');
  });

  it('prints the in-progress banner for a running benchmark', async () => {
    const read = readPdf(await renderPdfBuffer(buildBenchmarkReportDefinition(buildBenchmarkReport(reportInput({ status: 'running' })))));
    expect(text(read.text)).toContain(BENCHMARK_REPORT_PARTIAL_BANNER);
    expect(text(read.text)).not.toContain(BENCHMARK_REPORT_SECTIONS.baseline);
  });
});
