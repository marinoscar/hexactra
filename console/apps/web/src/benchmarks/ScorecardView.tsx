// The scorecard of a benchmark (E44.5, #743): one column per policy with every metric of #742,
// the two charts with their tables, and the challenge x policy matrix. The numbers are the API's;
// nothing here computes a metric.
import { Box, Paper, Skeleton, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { rainbowSurgePalette } from '@mui/x-charts/colorPalettes';
import { Suspense, lazy, useId, type ReactNode } from 'react';

import type { Counted, PolicyScore, ScoreMetrics, Scorecard } from '../types/benchmarks';
import { useBreakpoint } from '../ui';
import { VERDICT_MARK } from './BenchmarkChips';
import { costOf, duration, failureReasonLabel, modelName, money, num, ofText, pct, rateText, scoreText, tokens } from './format';

const CategoryChart = lazy(() => import('./BenchmarkCharts').then((m) => ({ default: m.CategoryChart })));
const SuccessCostChart = lazy(() => import('./BenchmarkCharts').then((m) => ({ default: m.SuccessCostChart })));

const counted = (list: Counted[], label: (k: string) => string = (k) => k) => (list.length === 0 ? 'none' : list.map((c) => `${label(c.key)} (${c.count})`).join(', '));

/** Every metric row of the scorecard: its name and how a policy's metrics read. */
const METRIC_ROWS: { key: string; label: string; value: (m: ScoreMetrics, p: PolicyScore) => ReactNode }[] = [
  { key: 'rank', label: 'Rank', value: (_m, p) => `#${p.rank}` },
  {
    key: 'score',
    label: 'Benchmark Score (default weighting)',
    value: (_m, p) => {
      const o = p.score?.overall.accuracy;
      return !o || o.value === null ? 'not rated' : `${scoreText(o.value)} · grade ${o.grade}${p.score.provisional ? ' · provisional' : ''}`;
    },
  },
  {
    key: 'subScores',
    label: 'Accuracy / cost / time / tokens score',
    value: (_m, p) => (p.score?.rated ? `${scoreText(p.score.accuracy)} / ${scoreText(p.score.cost)} / ${scoreText(p.score.time)} / ${scoreText(p.score.tokens)}` : 'not rated'),
  },
  { key: 'success', label: 'Success rate (95% interval)', value: (m) => `${rateText(m.successRate)} · ${ofText(m.successRate.k, m.successRate.n)}` },
  { key: 'passk', label: 'Reliability (pass^k)', value: (m) => `${pct(m.passAllK.rate.value)} · ${ofText(m.passAllK.allPassed, m.passAllK.challenges)} challenges` },
  { key: 'cost', label: 'Total cost', value: (m) => costOf(m) },
  { key: 'perSuccess', label: 'Cost per success', value: (m) => money(m.cost.perSuccessUsd, m.cost.known) },
  { key: 'medianCost', label: 'Median cost per trial', value: (m) => money(m.cost.medianPerTrialUsd, m.cost.known) },
  { key: 'tokens', label: 'Total tokens', value: (m) => tokens(m.tokens.total) },
  { key: 'tokenSplit', label: 'Input / output / cached tokens', value: (m) => `${tokens(m.tokens.input)} / ${tokens(m.tokens.output)} / ${tokens(m.tokens.cached)}` },
  { key: 'tokensPerSuccess', label: 'Tokens per success', value: (m) => tokens(m.tokens.perSuccess) },
  { key: 'medianTokens', label: 'Median input / output / cached', value: (m) => `${tokens(m.tokens.medianInput)} / ${tokens(m.tokens.medianOutput)} / ${tokens(m.tokens.medianCached)}` },
  { key: 'models', label: 'Models used', value: (m) => (m.models.length === 0 ? 'none' : m.models.map(modelName).join(', ')) },
  { key: 'time', label: 'Median / p90 active time', value: (m) => `${duration(m.speed.medianActiveMs)} / ${duration(m.speed.p90ActiveMs)}` },
  { key: 'steps', label: 'Median steps / model calls', value: (m) => `${num(m.speed.medianSteps)} / ${num(m.speed.medianModelCalls)}` },
  { key: 'falseSuccess', label: 'False success', value: (m) => `${pct(m.falseSuccess.value)} · ${ofText(m.falseSuccess.k, m.falseSuccess.n)}` },
  { key: 'falseFailure', label: 'False failure', value: (m) => `${pct(m.falseFailure.value)} · ${ofText(m.falseFailure.k, m.falseFailure.n)}` },
  { key: 'failures', label: 'Failure reasons', value: (m) => counted(m.failureReasons, failureReasonLabel) },
  { key: 'stops', label: 'Stop reasons', value: (m) => counted(m.stopReasons) },
  {
    key: 'safety',
    label: 'Safety flags',
    value: (m) => (m.safety.flaggedTrials === 0 ? 'none' : <Box component="span" sx={{ color: 'error.main', fontWeight: 600 }}>⚠ {m.safety.flaggedTrials} flagged: {counted(m.safety.checks)}</Box>),
  },
  { key: 'counts', label: 'Trials', value: (m) => `${m.counts.judged} judged · ${m.counts.error} error · ${m.counts.skipped} skipped · ${m.counts.unsupported} unsupported${m.counts.unfinished ? ` · ${m.counts.unfinished} unfinished` : ''}` },
];

function Panel({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <Paper variant="outlined" component="section" aria-label={title} data-testid={testId} sx={{ p: { xs: 1.5, sm: 2 }, minWidth: 0 }}>
      <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
        {title}
      </Typography>
      {children}
    </Paper>
  );
}

/** A table that scrolls in its own box, never the page. */
function ScrollTable({ label, id, children, testId }: { label: string; id?: string; children: ReactNode; testId?: string }) {
  return (
    <TableContainer sx={{ overflowX: 'auto', maxWidth: '100%' }} data-testid={testId}>
      <Table size="small" aria-label={label} id={id}>
        {children}
      </Table>
    </TableContainer>
  );
}

function PolicyColumns({ scorecard }: { scorecard: Scorecard }) {
  return (
    <ScrollTable label="Scorecard by policy" testId="scorecard-table">
      <TableHead>
        <TableRow>
          <TableCell component="th" scope="col">
            Metric
          </TableCell>
          {scorecard.policies.map((p) => (
            <TableCell key={p.ref} component="th" scope="col" sx={{ minWidth: 160 }}>
              {p.label}
            </TableCell>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {METRIC_ROWS.map((row) => (
          <TableRow key={row.key}>
            <TableCell component="th" scope="row" sx={{ color: 'text.secondary', minWidth: 140 }}>
              {row.label}
            </TableCell>
            {scorecard.policies.map((p) => (
              <TableCell key={p.ref} data-metric={row.key} sx={{ fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>
                {row.value(p.metrics, p)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </ScrollTable>
  );
}

/** On a phone: one card per policy, the metrics as a list. */
function PolicyCards({ scorecard }: { scorecard: Scorecard }) {
  return (
    <Stack spacing={1.5} data-testid="scorecard-cards">
      {scorecard.policies.map((p) => (
        <Paper key={p.ref} variant="outlined" component="article" aria-label={p.label} sx={{ p: 1.5 }}>
          <Typography variant="subtitle1" component="h3" sx={{ overflowWrap: 'anywhere' }}>
            #{p.rank} {p.label}
          </Typography>
          <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 3fr)', columnGap: 1, rowGap: 0.5 }}>
            {METRIC_ROWS.filter((r) => r.key !== 'rank').map((row) => (
              <Box key={row.key} sx={{ display: 'contents' }}>
                <Typography component="dt" variant="caption" color="text.secondary">
                  {row.label}
                </Typography>
                <Typography component="dd" variant="body2" data-metric={row.key} sx={{ m: 0, overflowWrap: 'anywhere', fontVariantNumeric: 'tabular-nums' }}>
                  {row.value(p.metrics, p)}
                </Typography>
              </Box>
            ))}
          </Box>
        </Paper>
      ))}
    </Stack>
  );
}

function Legend({ scorecard, colors }: { scorecard: Scorecard; colors: readonly string[] }) {
  return (
    <Stack direction="row" useFlexGap aria-label="Legend" sx={{ flexWrap: 'wrap', gap: 1.5, mt: 1 }}>
      {scorecard.policies.map((p, i) => (
        <Typography key={p.ref} variant="caption" color="text.secondary" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, minWidth: 0, overflowWrap: 'anywhere' }}>
          <Box component="span" aria-hidden sx={{ width: 10, height: 10, borderRadius: '2px', flex: '0 0 auto', bgcolor: colors[i % colors.length] }} />
          {p.label}
        </Typography>
      ))}
    </Stack>
  );
}

function Matrix({ scorecard }: { scorecard: Scorecard }) {
  return (
    <ScrollTable label="Challenges by policy" testId="benchmark-matrix">
      <TableHead>
        <TableRow>
          <TableCell component="th" scope="col" sx={{ minWidth: 160 }}>
            Challenge
          </TableCell>
          {scorecard.policies.map((p) => (
            <TableCell key={p.ref} component="th" scope="col" sx={{ minWidth: 130 }}>
              {p.label}
            </TableCell>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {scorecard.matrix.map((row) => (
          <TableRow key={row.challengeId}>
            <TableCell component="th" scope="row" sx={{ overflowWrap: 'anywhere' }}>
              {row.title}
            </TableCell>
            {row.cells.map((c) => {
              const words = c.verdicts.map((v, i) => `attempt ${i + 1}: ${v ?? 'not ended'}`).join(', ');
              return (
                <TableCell key={c.policyRef} data-testid={`cell-${row.challengeId}-${c.policyRef}`} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                  <Box component="span" aria-label={words} title={words} sx={{ letterSpacing: 2, fontWeight: 600 }}>
                    {c.verdicts.map((v) => (v ? (VERDICT_MARK[v] ?? '?') : '·')).join('')}
                  </Box>{' '}
                  <Typography component="span" variant="body2">
                    {c.passes}/{c.judged}
                  </Typography>
                  {c.safetyFlagged && (
                    <Box component="span" sx={{ color: 'error.main', ml: 0.5 }}>
                      ⚠ safety
                    </Box>
                  )}
                  <Typography variant="caption" color="text.secondary" component="div" sx={{ whiteSpace: 'nowrap' }}>
                    {money(c.medianCostUsd, c.costKnown)} · {tokens(c.totalTokens)} tok · {duration(c.medianActiveMs)}
                  </Typography>
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </ScrollTable>
  );
}

export function ScorecardView({ scorecard }: { scorecard: Scorecard }) {
  const theme = useTheme();
  const { isPhone } = useBreakpoint();
  const colors = rainbowSurgePalette(theme.palette.mode);
  const categoryTable = useId();
  const costTable = useId();
  if (scorecard.policies.length === 0) return null;
  return (
    <Stack spacing={2}>
      <Panel title={scorecard.live ? 'Scorecard (live, while the benchmark runs)' : 'Scorecard'} testId="scorecard">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Ranked by the Benchmark Score (accuracy first weighting; the Leaderboard switches it), then success rate, cost per success and median active time. {scorecard.k} trials per challenge and policy.
        </Typography>
        {isPhone ? <PolicyCards scorecard={scorecard} /> : <PolicyColumns scorecard={scorecard} />}
      </Panel>

      {scorecard.categories.length > 0 && (
        <Panel title="Success by category" testId="category-panel">
          <Suspense fallback={<Skeleton variant="rounded" height={260} />}>
            <CategoryChart scorecard={scorecard} describedBy={categoryTable} colors={colors} />
          </Suspense>
          <Legend scorecard={scorecard} colors={colors} />
          <ScrollTable label="Success by category, per policy" id={categoryTable} testId="category-table">
            <TableHead>
              <TableRow>
                <TableCell component="th" scope="col">
                  Category
                </TableCell>
                {scorecard.policies.map((p) => (
                  <TableCell key={p.ref} component="th" scope="col" sx={{ minWidth: 130 }}>
                    {p.label}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {scorecard.categories.map((c) => (
                <TableRow key={c.id}>
                  <TableCell component="th" scope="row">
                    {c.label}
                  </TableCell>
                  {scorecard.policies.map((p) => {
                    const m = p.categories.find((x) => x.category === c.id)?.metrics;
                    return (
                      <TableCell key={p.ref} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                        {m ? (
                          <>
                            {pct(m.successRate.value)} · {ofText(m.successRate.k, m.successRate.n)}
                            <Typography variant="caption" color="text.secondary" component="div">
                              {costOf(m)} · {tokens(m.tokens.total)} tokens
                            </Typography>
                          </>
                        ) : (
                          'n/a'
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </ScrollTable>
        </Panel>
      )}

      <Panel title="Success against cost per success" testId="cost-panel">
        <Suspense fallback={<Skeleton variant="rounded" height={260} />}>
          <SuccessCostChart scorecard={scorecard} describedBy={costTable} colors={colors} />
        </Suspense>
        <Legend scorecard={scorecard} colors={colors} />
        <ScrollTable label="Success, cost and tokens per policy" id={costTable} testId="cost-table">
          <TableHead>
            <TableRow>
              {['Rank', 'Policy', 'Success rate', 'Cost per success', 'Total cost', 'Total tokens', 'Median active time'].map((h) => (
                <TableCell key={h} component="th" scope="col">
                  {h}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {scorecard.ranking.map((r) => (
              <TableRow key={r.ref}>
                <TableCell>#{r.rank}</TableCell>
                <TableCell component="th" scope="row" sx={{ overflowWrap: 'anywhere' }}>
                  {r.label}
                </TableCell>
                <TableCell>{pct(r.successRate)}</TableCell>
                <TableCell>{money(r.costPerSuccessUsd, r.costKnown)}</TableCell>
                <TableCell>{money(r.totalCostUsd, r.costKnown)}</TableCell>
                <TableCell>{tokens(r.totalTokens)}</TableCell>
                <TableCell>{duration(r.medianActiveMs)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </ScrollTable>
      </Panel>

      <Panel title="Challenges by policy" testId="matrix-panel">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Each attempt: ✓ pass, ✗ fail, ! error, – skipped, ∅ unsupported, · not ended. Then passes of judged, median cost, tokens and median active time.
        </Typography>
        <Matrix scorecard={scorecard} />
      </Panel>
    </Stack>
  );
}
