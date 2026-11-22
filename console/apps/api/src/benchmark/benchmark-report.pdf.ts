// The PDF report of a benchmark (E44.6, #744): the leaderboard first (the Benchmark Score under the chosen preset, #872), the summary and ranking, the scorecard, the categories, the challenge x policy matrix, the
// failure reasons, the trial recordings (#863), the comparison with a baseline when asked, the rankings per dimension and under every preset (#872), and how it was measured. Tokens and cost sit next to every result.
//
// One source: the `BenchmarkReport` of `BenchmarkReportService.build`, already masked. Nothing here reads the database or masks again.
// `buildBenchmarkReportDefinition(report, opts)` is pure (snapshot-tested); the run report's `renderPdf` lays it out with the bundled
// fonts, no network, no file system, no screenshots. Rendering is synchronous like the run report's: #570 (off the event loop) is open
// and would move both; a benchmark report is tables only, a few pages.
import type { Content, ContextPageSize } from 'pdfmake/interfaces';

import { REPORT_FOOTER_NOTE, reportDate, reportDuration, type ReportDefinition } from '../tasks/run-report.pdf';
import type { BenchmarkReport, BenchmarkReportPaper } from './benchmark-report.schemas';
import { SCORE_PRESETS, type MetricDelta, type PolicyScore, type Rate, type ScoreBadge, type ScoreDimension, type ScoreGrade, type ScoreMetrics, type ScorePreset } from './scorecard.schemas';
import { CATEGORY_LABELS } from './suite/types';

export interface BenchmarkReportOptions {
  /** A4 (the default) or US letter. */
  paper?: BenchmarkReportPaper;
  /**
   * The console's public origin (`APP_URL`), for the links to each recorded trial's run page (#863). Without it the report prints the
   * path `/runs/<id>#recording`.
   */
  consoleUrl?: string | null;
  /** The weighting of the leaderboard (#872): `accuracy` (the default), `balanced`, `budget` or `speed`. */
  preset?: ScorePreset;
}

/** The banner of a benchmark that was still running when it was exported. */
export const BENCHMARK_REPORT_PARTIAL_BANNER = 'Benchmark in progress: partial report';

/** The section headings, in order; the read-back test looks for them. */
export const BENCHMARK_REPORT_SECTIONS = {
  leaderboard: 'Leaderboard',
  ranking: 'Ranking',
  scorecard: 'Scorecard',
  cost: 'Tokens and cost',
  categories: 'By category',
  matrix: 'Challenge x policy',
  failures: 'Failure reasons',
  recordings: 'Trial recordings',
  baseline: 'Compared with the baseline',
  rankings: 'Rankings',
  method: 'Method',
} as const;

const MARGIN = (18 / 25.4) * 72;
const PAGE: Record<BenchmarkReportPaper, { size: 'A4' | 'LETTER' }> = { a4: { size: 'A4' }, letter: { size: 'LETTER' } };
const ACCENT = '#4b4be8';
const MARK_ACCENT = '#ff6b4a';
const TEXT = '#12131c';
const MUTED = '#5a5e72';
const RULE = '#d5d6e3';
const SOFT_FILL = '#f2f2fb';
const FAIL = '#b3261e';
const BAR_TRACK = '#e4e4f4';
const GOLD = '#c9971c';
/** A grade's colour: S and A green, B blue, C amber, D red. */
const GRADE_COLOR: Record<ScoreGrade, string> = { S: '#1b7a43', A: '#2e8b57', B: '#2b6cb0', C: '#b7791f', D: FAIL };
const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path d="M60 60V108L18.4 84V36L60 12L101.6 36V84L80 96.5" fill="none" stroke="${ACCENT}" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/><circle cx="60" cy="60" r="13" fill="${MARK_ACCENT}"/></svg>`;

// ---- words ----

const DASH = '—';

/** "1,234,567": grouped by hand, the same on every machine. */
export function count(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  const r = Math.round(n);
  const s = String(Math.abs(r)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return r < 0 ? `-${s}` : s;
}

/** "$2.40", "$0.0042", "at least $2.40". */
export function money(amount: number | null | undefined, known = true): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return DASH;
  const text = amount > 0 && amount < 0.01 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(2)}`;
  return known ? text : `at least ${text}`;
}

const pct = (v: number | null | undefined): string => (v === null || v === undefined ? DASH : `${Math.round(v * 100)}%`);

/** "67% (21–94%), 2 of 3"; a dash when nothing was counted. */
export function rate(r: Rate): string {
  if (r.n === 0 || r.value === null) return DASH;
  return `${pct(r.value)} (${pct(r.low)}–${pct(r.high)}), ${r.k} of ${r.n}`;
}

const ms = (v: number | null | undefined): string => reportDuration(v) ?? DASH;

const tokens = (m: ScoreMetrics): string => `${count(m.tokens.input)} in / ${count(m.tokens.output)} out / ${count(m.tokens.cached)} cached`;

const VERDICT_MARK: Record<string, string> = { pass: 'P', fail: 'F', error: 'E', skipped: 'S', unsupported: 'U' };

const METRIC_LABEL: Record<MetricDelta['metric'], string> = {
  successRate: 'Success rate',
  passAllK: 'Reliability (pass^k)',
  falseSuccessRate: 'False success',
  medianActiveMs: 'Median active time',
  medianCostUsd: 'Median cost per trial',
  totalCostUsd: 'Total cost',
  costPerSuccessUsd: 'Cost per success',
  totalTokens: 'Total tokens',
  inputTokens: 'Input tokens',
  outputTokens: 'Output tokens',
  cachedInputTokens: 'Cached input tokens',
  tokensPerSuccess: 'Tokens per success',
  overallScore: 'Overall score',
  accuracyScore: 'Accuracy score',
  costScore: 'Cost score',
  timeScore: 'Time score',
  tokensScore: 'Tokens score',
};

const isScoreMetric = (m: MetricDelta['metric']): boolean => m.endsWith('Score');
/** A score to one decimal. */
const scoreText = (v: number | null | undefined): string => (v === null || v === undefined ? DASH : v.toFixed(1));

function deltaValue(d: MetricDelta, v: number | null): string {
  if (v === null) return DASH;
  if (d.metric === 'successRate' || d.metric === 'passAllK' || d.metric === 'falseSuccessRate') return pct(v);
  if (d.metric === 'medianActiveMs') return ms(v);
  if (d.metric.endsWith('Usd')) return money(v, !d.atLeast);
  if (isScoreMetric(d.metric)) return scoreText(v);
  return count(v);
}

function deltaText(d: MetricDelta): string {
  if (d.delta === null) return DASH;
  const sign = d.delta > 0 ? '+' : d.delta < 0 ? '-' : '';
  const abs = Math.abs(d.delta);
  const v =
    d.metric === 'successRate' || d.metric === 'passAllK' || d.metric === 'falseSuccessRate'
      ? `${Math.round(abs * 100)} pts`
      : d.metric === 'medianActiveMs'
        ? ms(abs)
        : d.metric.endsWith('Usd')
          ? money(abs, !d.atLeast)
          : isScoreMetric(d.metric)
            ? `${scoreText(abs)} pts`
            : count(abs);
  const verdict = d.withinNoise ? 'within noise' : d.improved === true ? 'better' : d.improved === false ? 'worse' : 'no change';
  return `${sign}${v} (${verdict})`;
}

// ---- blocks ----

function heading(text: string, id: string, pageBreak = false): Content {
  return { text, style: 'h2', outline: true, outlineText: text, id, ...(pageBreak ? { pageBreak: 'before' } : {}) } as Content;
}

function factsTable(rows: [string, string][]): Content {
  return {
    table: { widths: [130, '*'], body: rows.map(([k, v]) => [{ text: k, style: 'factKey' }, { text: v, style: 'factValue' }]) },
    layout: { hLineWidth: (i: number) => (i === 0 ? 0 : 0.5), vLineWidth: () => 0, hLineColor: () => RULE, paddingLeft: () => 0, paddingTop: () => 3, paddingBottom: () => 3 },
    margin: [0, 6, 0, 0],
  } as Content;
}

/** A table with a header row repeated on each page. */
function grid(header: string[], rows: (string | Content)[][], widths: (number | string)[]): Content {
  const head = header.map((h) => ({ text: h, style: 'th' }));
  const body = rows.map((r) => r.map((c) => (typeof c === 'string' ? { text: c, style: 'td' } : c)));
  return {
    table: { headerRows: 1, dontBreakRows: true, widths, body: [head, ...body] },
    layout: { hLineWidth: (i: number) => (i === 1 ? 0.8 : 0.4), vLineWidth: () => 0, hLineColor: () => RULE, paddingLeft: () => 3, paddingRight: () => 3, paddingTop: () => 2.5, paddingBottom: () => 2.5 },
    margin: [0, 4, 0, 8],
  } as Content;
}

function banner(title: string, text: string): Content {
  return {
    table: { widths: ['*'], body: [[{ stack: [{ text: title, style: 'bannerTitle' }, { text, style: 'small' }], fillColor: SOFT_FILL }]] },
    layout: { hLineWidth: () => 0.8, vLineWidth: () => 0.8, hLineColor: () => MUTED, vLineColor: () => MUTED, paddingLeft: () => 8, paddingRight: () => 8, paddingTop: () => 6, paddingBottom: () => 6 },
    margin: [0, 0, 0, 8],
  } as Content;
}

// ---- the Benchmark Score (#871, #872) ----

const DIMS: ScoreDimension[] = ['accuracy', 'cost', 'time', 'tokens'];
const DIM_LABEL: Record<ScoreDimension, string> = { accuracy: 'Accuracy', cost: 'Cost', time: 'Time', tokens: 'Tokens' };
const BADGE_LABEL: Record<ScoreBadge, string> = { most_accurate: 'Most accurate', cheapest: 'Cheapest per success', fastest: 'Fastest', most_token_efficient: 'Fewest tokens' };

/** The policies best first under a preset. */
export function rankedUnder(policies: readonly PolicyScore[], preset: ScorePreset): PolicyScore[] {
  return [...policies].sort((a, b) => a.score.overall[preset].rank - b.score.overall[preset].rank);
}

/** "Accuracy 50 · Cost 20 · Time 15 · Tokens 15". */
function weightsOf(r: BenchmarkReport, preset: ScorePreset): string {
  const w = r.scorecard.scoring.presets.find((p) => p.id === preset)?.weights;
  return w ? DIMS.map((d) => `${DIM_LABEL[d]} ${w[d]}`).join(' · ') : '';
}
const presetLabel = (r: BenchmarkReport, preset: ScorePreset): string => r.scorecard.scoring.presets.find((p) => p.id === preset)?.label ?? preset;

/** A horizontal bar of a 0 to 100 score, drawn (no image). */
function bar(value: number | null, width: number, height = 5, color = ACCENT): Content {
  const w = Math.max(0, Math.min(100, value ?? 0)) * (width / 100);
  return {
    canvas: [
      { type: 'rect', x: 0, y: 0, w: width, h: height, r: height / 2, color: BAR_TRACK },
      ...(w > 0 ? [{ type: 'rect', x: 0, y: 0, w: Math.max(w, height), h: height, r: height / 2, color }] : []),
    ],
    margin: [0, 1, 0, 0],
  } as Content;
}

/** A sub-score: its value over its bar. `atMost`: the cost is unknown, so the score is an upper bound. */
function subScore(value: number | null, width: number, atMost = false): Content {
  return { stack: [{ text: value === null ? DASH : `${atMost ? '≤ ' : ''}${scoreText(value)}`, style: 'td', alignment: 'right' }, bar(value, width)] } as Content;
}

/** The grade as a coloured badge. */
function gradeBadge(grade: ScoreGrade | null, size: 'big' | 'small' = 'small'): Content {
  if (!grade) return { text: 'Not rated', style: 'small' };
  return {
    table: { body: [[{ text: grade, bold: true, color: '#ffffff', fontSize: size === 'big' ? 16 : 8.5, alignment: 'center', fillColor: GRADE_COLOR[grade] }]] },
    layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => (size === 'big' ? 7 : 4), paddingRight: () => (size === 'big' ? 7 : 4), paddingTop: () => (size === 'big' ? 3 : 1), paddingBottom: () => (size === 'big' ? 3 : 1) },
  } as Content;
}

/** The flags beside a score: badges, tied, provisional, safety. */
function flagsText(p: PolicyScore, preset: ScorePreset): string {
  const o = p.score.overall[preset];
  return [
    ...p.score.badges.map((b) => BADGE_LABEL[b]),
    ...(o.tied ? ['Tied with #1'] : []),
    ...(p.score.provisional ? ['Provisional'] : []),
    ...(p.metrics.safety.flaggedTrials ? [`Safety: ${p.metrics.safety.flaggedTrials} flagged`] : []),
  ].join(' · ');
}

/** The first section: the winner, then every policy ranked by its Benchmark Score under the preset. */
function leaderboardSection(r: BenchmarkReport, preset: ScorePreset): Content[] {
  const ranked = rankedUnder(r.scorecard.policies, preset);
  const out: Content[] = [heading(BENCHMARK_REPORT_SECTIONS.leaderboard, 'leaderboard')];
  out.push({ text: `Benchmark Score, 0 to 100, weighting "${presetLabel(r, preset)}" (${weightsOf(r, preset)}). Best first; the band is the 95% range from the accuracy intervals.`, style: 'small' });
  const leader = ranked[0];
  if (!leader || !leader.score.rated) {
    out.push({ text: 'No policy has a judged trial yet: no score.', style: 'muted', margin: [0, 6, 0, 0] });
    return out;
  }
  const o = leader.score.overall[preset];
  out.push({
    table: {
      widths: [150, '*'],
      body: [
        [
          {
            stack: [
              { text: `BEST OVERALL · ${presetLabel(r, preset).toUpperCase()}`, style: 'kickerSmall' },
              {
                columns: [
                  { text: scoreText(o.value), style: 'heroScore', width: 'auto' },
                  { stack: [gradeBadge(o.grade, 'big')], width: 'auto', margin: [8, 8, 0, 0] },
                ],
              },
              { text: o.low !== null && o.high !== null ? `95% band ${scoreText(o.low)} to ${scoreText(o.high)}` : '', style: 'small' },
            ],
            fillColor: SOFT_FILL,
          },
          {
            stack: [
              { text: [{ text: '★ ', color: GOLD }, { text: leader.label }], style: 'heroLabel' },
              {
                columns: DIMS.map((d) => ({ stack: [{ text: DIM_LABEL[d], style: 'small' }, subScore(leader.score[d], 110, d === 'cost' && !leader.score.costKnown)], width: '*' })),
                columnGap: 10,
                margin: [0, 4, 0, 4],
              },
              { text: flagsText(leader, preset) || ' ', style: 'badges' },
            ],
            fillColor: SOFT_FILL,
          },
        ],
      ],
    },
    layout: { hLineWidth: () => 0.8, vLineWidth: (i: number) => (i === 1 ? 0 : 0.8), hLineColor: () => ACCENT, vLineColor: () => ACCENT, paddingLeft: () => 10, paddingRight: () => 10, paddingTop: () => 8, paddingBottom: () => 8 },
    margin: [0, 6, 0, 8],
  } as Content);
  out.push(
    grid(
      ['#', 'Policy', 'Score', 'Band', 'Grade', 'Accuracy', 'Cost', 'Time', 'Tokens', 'Notes'],
      ranked.map((p) => {
        const x = p.score.overall[preset];
        return [
          { text: String(x.rank), style: 'rank' },
          { text: p.label, style: 'tdStrong' },
          { text: x.value === null ? DASH : scoreText(x.value), style: 'scoreCell' },
          x.low === null || x.high === null ? DASH : `${scoreText(x.low)}–${scoreText(x.high)}`,
          gradeBadge(x.grade),
          subScore(p.score.accuracy, 56),
          subScore(p.score.cost, 56, !p.score.costKnown),
          subScore(p.score.time, 56),
          subScore(p.score.tokens, 56),
          { text: p.score.rated ? flagsText(p, preset) || DASH : 'Not rated: no judged trial', style: 'small' },
        ];
      }),
      [14, '*', 38, 52, 30, 62, 62, 62, 62, 120],
    ),
  );
  return out;
}

/** The rankings at the end: each dimension on its own, and the overall order under every preset. */
function rankingsSection(r: BenchmarkReport, preset: ScorePreset): Content[] {
  const ps = r.scorecard.policies;
  const rated = ps.filter((p) => p.score.rated);
  const raw: Record<ScoreDimension, (p: PolicyScore) => string> = {
    accuracy: (p) => `${pct(p.metrics.successRate.value)} success, ${pct(p.metrics.passAllK.rate.value)} pass^${r.scorecard.k}`,
    cost: (p) => `${money(p.metrics.cost.perSuccessUsd, p.metrics.cost.known)} per success`,
    time: (p) => `${ms(p.metrics.speed.medianActiveMs)} median`,
    tokens: (p) => `${count(p.metrics.tokens.perSuccess)} per success`,
  };
  const dimTable = (d: ScoreDimension): Content => {
    const order = [...rated].sort((a, b) => (b.score[d] ?? -1) - (a.score[d] ?? -1));
    return {
      stack: [
        { text: `${DIM_LABEL[d]}`, style: 'boxTitle', margin: [0, 0, 0, 2] },
        grid(
          ['#', 'Policy', 'Score', 'Measured'],
          order.map((p, i) => [String(i + 1), { text: p.label, style: 'tdStrong' }, subScore(p.score[d], 40, d === 'cost' && !p.score.costKnown), raw[d](p)]),
          [12, '*', 44, 100],
        ),
      ],
    } as Content;
  };
  const out: Content[] = [heading(BENCHMARK_REPORT_SECTIONS.rankings, 'rankings', true)];
  if (!rated.length) {
    out.push({ text: 'No policy has a judged trial yet: nothing to rank.', style: 'muted' });
    return out;
  }
  out.push(
    { text: 'Each dimension on its own, best first, with what was measured. Cost, time and tokens are scored against the best policy of this benchmark on a log scale.', style: 'small' },
    { columns: [dimTable('accuracy'), dimTable('cost')], columnGap: 16, margin: [0, 4, 0, 0] } as Content,
    { columns: [dimTable('time'), dimTable('tokens')], columnGap: 16 } as Content,
    { text: 'The overall order under every weighting', style: 'boxTitle', margin: [0, 6, 0, 2] },
    {
      text: `Rank and score under each preset (this report leads with "${presetLabel(r, preset)}"). A policy that leads under one weighting and not another wins on that dimension only.`,
      style: 'small',
    },
    grid(
      ['Policy', ...SCORE_PRESETS.map((x) => `${presetLabel(r, x)} (${r.scorecard.scoring.presets.find((y) => y.id === x)?.weights.accuracy ?? '?'}% accuracy)`)],
      rankedUnder(ps, preset).map((p) => [
        { text: p.label, style: 'tdStrong' },
        ...SCORE_PRESETS.map((x) => {
          const o = p.score.overall[x];
          return o.value === null ? DASH : ({ text: `#${o.rank}  ${scoreText(o.value)} ${o.grade ?? ''}`, style: o.rank === 1 ? 'tdStrong' : 'td' } as Content);
        }),
      ]),
      ['*', 110, 110, 110, 110],
    ),
  );
  return out;
}

/** How the score is computed, for the Method section. */
function scoreMethod(r: BenchmarkReport): Content[] {
  return [
    { text: 'How the Benchmark Score is computed', style: 'boxTitle', margin: [0, 8, 0, 2] },
    {
      ul: [
        `Accuracy = 100 × (0.7 × success rate + 0.3 × pass^${r.scorecard.k}) × (1 − false-success rate), over the judged trials.`,
        'Cost, Time and Tokens compare cost per success, median active time and tokens per success with the best policy of this benchmark, on a log scale: 100 × (1 − log10(this / best) / 2). The best is 100, twice it about 85, ten times 50, a hundred times or more 0. A policy with no pass scores 0 there.',
        `Overall = the weighted mean under a preset: ${r.scorecard.scoring.presets.map((p) => `${p.label} (${DIMS.map((d) => `${p.weights[d]}`).join('/')})`).join(', ')}, in the order accuracy/cost/time/tokens.`,
        'Band: the Overall score with accuracy at the ends of its 95% interval. A policy whose band overlaps the leader\'s is tied: the difference is not shown to be real.',
        `Grades: S 90 and over, A 80, B 70, C 60, D below. Provisional: fewer than ${r.scorecard.scoring.provisionalBelow} judged trials. A safety flag is shown, never folded into the score.`,
        'Cost, time and token scores are relative to this benchmark, so compare Overall scores within one benchmark; across benchmarks read the baseline deltas.',
      ],
      style: 'body',
    } as Content,
  ];
}

// ---- sections ----

function summary(r: BenchmarkReport, preset: ScorePreset): Content[] {
  const b = r.benchmark;
  const sc = r.scorecard;
  const t = sc.totals;
  const out: Content[] = [];
  if (r.partial) out.push(banner(BENCHMARK_REPORT_PARTIAL_BANNER, `Exported ${reportDate(r.exportedAt)} while trials were still running: the scorecard is live and the numbers will change.`));
  out.push(
    {
      columns: [
        { svg: MARK_SVG, width: 22, height: 22 },
        { text: [{ text: 'hexactra', style: 'wordmark' }, { text: '   Benchmark report', style: 'kicker' }], margin: [6, 4, 0, 0], width: '*' },
      ],
      columnGap: 0,
    } as Content,
    { text: b.name, style: 'title', outline: true, outlineText: 'Benchmark report', id: 'title' } as Content,
    ...leaderboardSection(r, preset),
    { text: 'Summary', style: 'boxTitle', margin: [0, 4, 0, 0] },
    factsTable([
      ['Status', r.partial ? `${b.status} (in progress)` : b.status],
      ['Suite', `${b.suiteKey} version ${b.suiteVersion}`],
      ['Console', `${b.appVersion}${b.commit ? ` (commit ${b.commit.slice(0, 12)})` : ''}`],
      ['Started', reportDate(b.startedAt ?? b.createdAt)],
      ['Finished', b.finishedAt ? reportDate(b.finishedAt) : r.partial ? 'Still running' : DASH],
      ['Challenges and policies', `${b.config.challengeIds.length} challenges x ${b.config.policies.length} policies x ${b.config.trials} trials`],
      ['Trials', `${t.counts.total}: ${t.counts.pass} passed, ${t.counts.fail} failed, ${t.counts.error} errors, ${t.counts.skipped} skipped, ${t.counts.unsupported} unsupported${t.counts.unfinished ? `, ${t.counts.unfinished} not finished` : ''}`],
      ['Total cost', money(t.costUsd, t.costKnown)],
      ['Total tokens', `${count(t.totalTokens)} (${count(t.inputTokens)} input, ${count(t.outputTokens)} output, ${count(t.cachedInputTokens)} cached input)`],
      ['Model calls', count(t.modelCalls)],
    ]),
    heading(BENCHMARK_REPORT_SECTIONS.ranking, 'ranking'),
    { text: 'Best first by the Benchmark Score (0 to 100, accuracy first weighting); equal scores by the higher success rate, then the lower cost per success, then the lower median active time.', style: 'small' },
  );
  const byRef = new Map(sc.policies.map((p) => [p.ref, p]));
  out.push(
    grid(
      ['#', 'Policy', 'Score', 'Success rate', 'Cost per success', 'Median active', 'Total cost', 'Total tokens', 'Models'],
      sc.ranking.map((e) => [
        String(e.rank),
        { text: e.label, style: 'tdStrong' },
        e.score === null || e.score === undefined ? DASH : `${scoreText(e.score)} ${e.grade ?? ''}`.trim(),
        pct(e.successRate),
        money(e.costPerSuccessUsd, e.costKnown),
        ms(e.medianActiveMs),
        money(e.totalCostUsd, e.costKnown),
        count(e.totalTokens),
        (byRef.get(e.ref)?.metrics.models ?? []).join(', ') || DASH,
      ]),
      [14, '*', 40, 52, 56, 50, 50, 54, 80],
    ),
  );
  if (!sc.ranking.length) out.push({ text: 'No policy has a judged trial yet.', style: 'muted' });
  return out;
}

function scorecardSection(r: BenchmarkReport): Content[] {
  const ps = r.scorecard.policies;
  const t = r.scorecard.totals;
  return [
    heading(BENCHMARK_REPORT_SECTIONS.scorecard, 'scorecard', true),
    { text: `Rates are over judged trials (pass + fail), with a Wilson 95% interval. k = ${r.scorecard.k} trials per challenge.`, style: 'small' },
    grid(
      ['Policy', 'Judged', 'Success rate', `Reliability (pass^${r.scorecard.k})`, 'False success', 'False failure', 'Median / p90 active', 'Median steps', 'Safety flags'],
      ps.map((p) => {
        const m = p.metrics;
        return [
          { text: p.label, style: 'tdStrong' },
          `${m.counts.judged} of ${m.counts.total}`,
          rate(m.successRate),
          rate(m.passAllK.rate),
          rate(m.falseSuccess),
          rate(m.falseFailure),
          `${ms(m.speed.medianActiveMs)} / ${ms(m.speed.p90ActiveMs)}`,
          m.speed.medianSteps === null ? DASH : String(m.speed.medianSteps),
          m.safety.flaggedTrials ? { text: `${m.safety.flaggedTrials} flagged`, style: 'failed' } : 'None',
        ];
      }),
      ['*', 34, 82, 82, 72, 72, 62, 34, 44],
    ),
    heading(BENCHMARK_REPORT_SECTIONS.cost, 'cost'),
    { text: 'Totals count every trial that ran (judged, error, or stopped part way); medians are per judged trial. Cached input tokens are part of input.', style: 'small' },
    grid(
      ['Policy', 'Input tokens', 'Output tokens', 'Cached tokens', 'Tokens per success', 'Total cost', 'Median cost per trial', 'Cost per success'],
      [
        ...ps.map((p) => {
          const m = p.metrics;
          return [
            { text: p.label, style: 'tdStrong' } as Content,
            count(m.tokens.input),
            count(m.tokens.output),
            count(m.tokens.cached),
            count(m.tokens.perSuccess),
            money(m.cost.totalUsd, m.cost.known),
            money(m.cost.medianPerTrialUsd, m.cost.known),
            money(m.cost.perSuccessUsd, m.cost.known),
          ];
        }),
        [{ text: 'Whole benchmark', style: 'tdStrong' }, count(t.inputTokens), count(t.outputTokens), count(t.cachedInputTokens), DASH, { text: money(t.costUsd, t.costKnown), style: 'tdStrong' }, DASH, DASH],
      ],
      ['*', 54, 54, 54, 54, 56, 56, 56],
    ),
    { text: 'Models used', style: 'boxTitle', margin: [0, 4, 0, 2] },
    { ul: ps.map((p) => `${p.label}: ${p.metrics.models.join(', ') || 'none recorded'}`), style: 'body' } as Content,
  ];
}

function categoriesSection(r: BenchmarkReport): Content[] {
  const rows: (string | Content)[][] = [];
  for (const c of r.scorecard.categories) {
    for (const p of r.scorecard.policies) {
      const pc = p.categories.find((x) => x.category === c.id);
      if (!pc) continue;
      const m = pc.metrics;
      rows.push([c.label, { text: p.label, style: 'tdStrong' }, rate(m.successRate), rate(m.passAllK.rate), ms(m.speed.medianActiveMs), money(m.cost.totalUsd, m.cost.known), money(m.cost.perSuccessUsd, m.cost.known), tokens(m)]);
    }
  }
  return [
    heading(BENCHMARK_REPORT_SECTIONS.categories, 'categories', true),
    rows.length ? grid(['Category', 'Policy', 'Success rate', 'Reliability', 'Median active', 'Total cost', 'Cost per success', 'Tokens'], rows, [70, '*', 82, 82, 50, 54, 54, 150]) : { text: 'No category has a trial.', style: 'muted' },
  ];
}

function matrixSection(r: BenchmarkReport): Content[] {
  const ps = r.scorecard.policies;
  const rows = r.scorecard.matrix.map((row) => [
    { text: [{ text: row.title, style: 'tdStrong' }, { text: `\n${row.category ? CATEGORY_LABELS[row.category] : row.challengeId}`, style: 'small' }] } as Content,
    ...row.cells.map((c) => {
      const marks = c.verdicts.map((v) => (v ? (VERDICT_MARK[v] ?? '?') : '·')).join(' ');
      return {
        text: [{ text: `${c.passes} of ${c.judged}`, style: c.judged > 0 && c.passes < c.judged ? 'failedStrong' : 'tdStrong' }, { text: `  ${marks}${c.safetyFlagged ? '  safety' : ''}\n`, style: c.safetyFlagged ? 'failed' : 'td' }, { text: `${money(c.medianCostUsd, c.costKnown)} · ${count(c.totalTokens)} tok`, style: 'small' }],
      } as Content;
    }),
  ]);
  const width = ps.length > 4 ? 52 : 80;
  return [
    heading(BENCHMARK_REPORT_SECTIONS.matrix, 'matrix', true),
    { text: 'Each cell: passes of judged trials, each attempt (P pass, F fail, E error, S skipped, U unsupported, · not ended), the median cost of a judged trial and the total tokens.', style: 'small' },
    grid(['Challenge', ...ps.map((p) => p.label)], rows, ['*', ...ps.map(() => width)]),
  ];
}

function failuresSection(r: BenchmarkReport): Content[] {
  const out: Content[] = [heading(BENCHMARK_REPORT_SECTIONS.failures, 'failures', true)];
  const rows: string[][] = [];
  for (const p of r.scorecard.policies) {
    const m = p.metrics;
    rows.push([p.label, m.failureReasons.map((x) => `${x.key} (${x.count})`).join(', ') || 'None', m.stopReasons.map((x) => `${x.key} (${x.count})`).join(', ') || DASH, m.safety.checks.map((x) => `${x.key} (${x.count})`).join(', ') || 'None']);
  }
  out.push(grid(['Policy', 'Why trials did not pass', 'How runs stopped', 'Failed safety checks'], rows, [80, '*', 110, 110]));
  const failed = r.trials.filter((t) => t.checks?.some((c) => !c.pass));
  if (failed.length) {
    out.push({ text: 'Failed checks', style: 'boxTitle', margin: [0, 4, 0, 2] });
    out.push(
      grid(
        ['Challenge', 'Policy', 'Trial', 'Check', 'Note'],
        failed.flatMap((t) => (t.checks ?? []).filter((c) => !c.pass).map((c) => [t.challengeTitle, t.policyLabel, String(t.trialIndex + 1), c.name, c.detail ?? ''])),
        [100, 70, 26, 100, '*'],
      ),
    );
  }
  return out;
}

/** The trials whose run has a recording the viewer may see (`recording` is null without `runs:read`, #846). */
const recordedTrials = (r: BenchmarkReport) => r.trials.filter((t) => t.recording && t.runId);

const RECORDING_STATUS: Record<string, string> = { ready: 'ready', processing: 'still processing', recording: 'still recording', failed: 'failed' };

/** The run page's player of a trial: `<origin>/runs/<id>#recording`, or the path alone when the origin is not known. */
export function trialRecordingLink(runId: string, consoleUrl?: string | null): string {
  return `${(consoleUrl ?? '').replace(/\/+$/, '')}/runs/${encodeURIComponent(runId)}#recording`;
}

/**
 * Trial recordings (#863): one row per recorded trial with its status, its length once ready and a link to the run page's player. The
 * video and its storage key are never here (the video is not masked). No section when nothing was recorded or the viewer lacks
 * `runs:read` (then every `recording` is null).
 */
function recordingsSection(r: BenchmarkReport, consoleUrl?: string | null): Content[] {
  const recorded = recordedTrials(r);
  if (!recorded.length) return [];
  return [
    heading(BENCHMARK_REPORT_SECTIONS.recordings, 'recordings'),
    { text: 'Each recorded trial run and where its video plays: the run page, signed in as the owner. The video is not masked and is never in this report.', style: 'small' },
    grid(
      ['Challenge', 'Policy', 'Trial', 'Recording', 'Length', 'Run page'],
      recorded.map((t) => {
        const href = trialRecordingLink(t.runId!, consoleUrl);
        const status = t.recording!.status;
        return [
          t.challengeTitle,
          t.policyLabel,
          String(t.trialIndex + 1),
          { text: RECORDING_STATUS[status] ?? status, style: status === 'failed' ? 'failed' : 'td' },
          status === 'ready' ? ms(t.recording!.durationMs) : DASH,
          // Only a full URL is a link: a bare path has nowhere to go from a PDF reader.
          /^https?:\/\//.test(href) ? { text: href, link: href, style: 'link' } : href,
        ];
      }),
      [110, 80, 26, 70, 46, '*'],
    ),
  ];
}

function baselineSection(r: BenchmarkReport): Content[] {
  const cmp = r.baseline;
  if (!cmp) return [];
  const out: Content[] = [
    heading(BENCHMARK_REPORT_SECTIONS.baseline, 'baseline', true),
    factsTable([
      ['This benchmark', `${cmp.current.name}: console ${cmp.current.appVersion}${cmp.current.commit ? ` (${cmp.current.commit.slice(0, 12)})` : ''}`],
      ['Baseline', `${cmp.baseline.name}: console ${cmp.baseline.appVersion}${cmp.baseline.commit ? ` (${cmp.baseline.commit.slice(0, 12)})` : ''}, finished ${reportDate(cmp.baseline.finishedAt)}`],
      ['Suite', `${cmp.current.suiteKey} version ${cmp.current.suiteVersion}`],
    ]),
    { text: 'A rate whose two 95% intervals overlap is "within noise": the change is not shown to be real.', style: 'small', margin: [0, 6, 0, 0] },
  ];
  const deltaRows = (ds: MetricDelta[]) => ds.map((d) => [METRIC_LABEL[d.metric], deltaValue(d, d.baseline), deltaValue(d, d.current), deltaText(d)]);
  out.push({ text: 'Whole benchmark', style: 'boxTitle', margin: [0, 6, 0, 0] }, grid(['Metric', 'Baseline', 'This benchmark', 'Change'], deltaRows(cmp.totals), ['*', 90, 90, 130]));
  for (const p of cmp.policies) {
    out.push({ text: `${p.label}${p.label !== p.baselineLabel ? ` (baseline: ${p.baselineLabel})` : ''}`, style: 'boxTitle', margin: [0, 6, 0, 0] }, grid(['Metric', 'Baseline', 'This benchmark', 'Change'], deltaRows(p.deltas), ['*', 90, 90, 130]));
  }
  if (cmp.unmatched.current.length || cmp.unmatched.baseline.length) {
    out.push({ text: `Not compared: ${[...cmp.unmatched.current.map((x) => `${x.label} (only here)`), ...cmp.unmatched.baseline.map((x) => `${x.label} (only in the baseline)`)].join(', ')}.`, style: 'muted' });
  }
  if (cmp.flipped.length) {
    out.push(
      { text: 'Challenges whose outcome changed', style: 'boxTitle', margin: [0, 6, 0, 0] },
      grid(
        ['Challenge', 'Policy', 'Baseline', 'This benchmark', 'Direction'],
        cmp.flipped.map((f) => [f.title, f.policyLabel, `${f.baseline.outcome} (${f.baseline.passes} of ${f.baseline.judged})`, `${f.current.outcome} (${f.current.passes} of ${f.current.judged})`, f.direction]),
        ['*', 80, 80, 80, 50],
      ),
    );
  }
  return out;
}

/** Which policies' trial runs record a video (#841, #845): "all policies", their labels, or `null` for none. */
export function recordedPolicies(config: { recordVideo?: boolean; policies: { label: string; recordVideo?: boolean }[] }): string | null {
  const recorded = config.policies.filter((p) => config.recordVideo || p.recordVideo);
  if (recorded.length === 0) return null;
  return recorded.length === config.policies.length ? 'all policies' : `${recorded.length === 1 ? 'policy' : 'policies'} ${recorded.map((p) => p.label).join(', ')}`;
}

/** The Method row: which policies were recorded (#845) and how many trials, pointing to the section that lists them (#863). */
function recordingsRow(r: BenchmarkReport): string {
  const n = recordedTrials(r).length;
  const who = recordedPolicies(r.benchmark.config);
  if (n) return `${n} of ${r.trials.length} trial${r.trials.length === 1 ? '' : 's'} recorded a video of the browser tab${who ? ` (${who})` : ''}: listed under "${BENCHMARK_REPORT_SECTIONS.recordings}", each played on its run page (not in this report).`;
  return who ? `On for ${who}: each of their trial runs records a video of its browser tab, played on its run page (not in this report). No recording is listed here.` : 'Off.';
}

function methodSection(r: BenchmarkReport, preset: ScorePreset): Content[] {
  const b = r.benchmark;
  return [
    heading(BENCHMARK_REPORT_SECTIONS.method, 'method', true),
    factsTable([
      ['Benchmark Score', `${r.scorecard.scoring.method}; this report's leaderboard uses "${presetLabel(r, preset)}" (${weightsOf(r, preset)}).`],
      ['Suite', `${b.suiteKey} version ${b.suiteVersion}: benchmarks compare only within one suite version.`],
      ['Trials', `${b.config.trials} per challenge and policy, one at a time, the policies alternating, on ${b.config.hostId ? 'one node' : 'a node the fabric picks'} (browser profile ${b.config.profile}).`],
      ['Spend cap', `${b.config.capUsd === null ? 'No cap: each run kept its own policy budget' : `${money(b.config.capUsd)}: no new trial starts once it is spent`}. Trial timeout ${b.config.trialTimeoutMinutes} min.`],
      ['Recordings', recordingsRow(r)],
    ]),
    { text: 'How a trial is graded', style: 'boxTitle', margin: [0, 8, 0, 2] },
    {
      ul: [
        "Each trial is an ordinary run on a real node against the console's challenge site, with its own seed: names, prices, codes and the expected answer come from it.",
        "When the run ends, the grader reads the site's own stored state and the agent's answer and applies the challenge's named checks. No model judges, and the agent's claim of success is never the verdict.",
        'A trial passes only when every check passes. A check named safety:… guards an invariant and is reported as a flag.',
        'A question the agent asks a person is answered by the challenge\'s scripted owner; a question no rule fits ends the trial as "asked a person".',
        'A challenge that needs a capability the agent lacks is unsupported, never failed.',
      ],
      style: 'body',
    } as Content,
    ...scoreMethod(r),
    { text: 'Definitions', style: 'boxTitle', margin: [0, 8, 0, 2] },
    {
      ul: [
        'Judged: pass + fail. Errors, skipped, unsupported and unfinished trials are counted but are out of every rate.',
        'Success rate: passes over judged trials, with a Wilson 95% interval.',
        `Reliability (pass^k): the share of challenges whose ${r.scorecard.k} trials were all judged and all passed.`,
        'False success: claimed success and graded fail. False failure: graded pass without claiming success.',
        'Active time: the time the run spent working, waits for a person excluded. Median, and p90 by nearest rank.',
        'Cost: USD of the model calls, from the run. "At least" when a model call had no price.',
        'Tokens: input, output and cached input (part of input), from the run. Tokens and cost per success: the total over the passes.',
        'Models: the models that served the trials, from each trial\'s start tier to the tier it ended on.',
      ],
      style: 'body',
    } as Content,
    { text: `Masking: every text in this report went through the console's sensitive-data patterns (version ${r.masking.patternsVersion}); there is no unmasked export.`, style: 'small', margin: [0, 8, 0, 0] },
  ];
}

/** The pdfmake document of a benchmark's report: pure (no I/O, no clock; the report carries `exportedAt`). No images. */
export function buildBenchmarkReportDefinition(report: BenchmarkReport, options: BenchmarkReportOptions = {}): ReportDefinition {
  const paper = options.paper ?? 'a4';
  const id8 = report.benchmark.id.slice(0, 8);
  const exported = reportDate(report.exportedAt);
  const preset = options.preset ?? report.scorecard.scoring.defaultPreset;
  const content: Content[] = [
    ...summary(report, preset),
    ...scorecardSection(report),
    ...categoriesSection(report),
    ...matrixSection(report),
    ...failuresSection(report),
    ...recordingsSection(report, options.consoleUrl),
    ...baselineSection(report),
    ...rankingsSection(report, preset),
    ...methodSection(report, preset),
  ];
  return {
    pageSize: PAGE[paper].size,
    pageOrientation: 'landscape',
    pageMargins: [MARGIN, MARGIN, MARGIN, MARGIN],
    info: {
      title: `Benchmark report: ${report.benchmark.name}`,
      author: 'Hexactra',
      subject: `Hexactra benchmark ${report.benchmark.id}`,
      creator: 'Hexactra Console',
      producer: 'Hexactra Console',
      creationDate: new Date(report.exportedAt),
    },
    language: 'en-US',
    displayTitle: true,
    version: '1.7',
    tagged: true,
    images: {},
    content,
    footer: (currentPage: number, pageCount: number, pageSize?: ContextPageSize): Content => {
      void pageSize;
      return {
        margin: [MARGIN, 14, MARGIN, 0],
        stack: [
          {
            columns: [
              { text: `Benchmark ${id8}${report.partial ? ' (in progress)' : ''}`, width: '*' },
              { text: `Page ${currentPage} of ${pageCount}`, width: 'auto' },
              { text: `Exported ${exported}`, width: '*', alignment: 'right' },
            ],
            style: 'footer',
          },
          { text: REPORT_FOOTER_NOTE, style: 'footer', alignment: 'center', margin: [0, 2, 0, 0] },
        ],
      } as Content;
    },
    defaultStyle: { font: 'Inter', fontSize: 9, lineHeight: 1.2, color: TEXT },
    styles: {
      wordmark: { fontSize: 13, bold: true, color: TEXT },
      kicker: { fontSize: 10, color: MUTED },
      kickerSmall: { fontSize: 7.5, bold: true, color: MUTED, characterSpacing: 0.6 },
      heroScore: { fontSize: 38, bold: true, color: TEXT, lineHeight: 1 },
      heroLabel: { fontSize: 14, bold: true, color: TEXT },
      badges: { fontSize: 8, color: ACCENT, bold: true },
      rank: { fontSize: 9, bold: true, color: ACCENT },
      scoreCell: { fontSize: 11, bold: true },
      title: { fontSize: 18, bold: true, lineHeight: 1.15, margin: [0, 10, 0, 6] },
      h2: { fontSize: 12.5, bold: true, color: ACCENT, margin: [0, 14, 0, 4] },
      body: { fontSize: 9 },
      muted: { color: MUTED },
      small: { fontSize: 8, color: MUTED },
      bannerTitle: { fontSize: 11, bold: true },
      boxTitle: { bold: true },
      factKey: { color: MUTED, fontSize: 9 },
      factValue: { fontSize: 9 },
      th: { bold: true, fontSize: 7.5, color: MUTED },
      td: { fontSize: 8 },
      tdStrong: { fontSize: 8, bold: true },
      failed: { fontSize: 8, color: FAIL },
      failedStrong: { fontSize: 8, bold: true, color: FAIL },
      footer: { fontSize: 7.5, color: MUTED },
      link: { fontSize: 8, color: ACCENT, decoration: 'underline' },
    },
  } as ReportDefinition;
}
