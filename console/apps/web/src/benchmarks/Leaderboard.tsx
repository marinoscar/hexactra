// The leaderboard of a benchmark (#871): the Benchmark Score of every policy under the chosen weighting preset, best first, the way AI
// models are ranked on a public leaderboard. Every number is the API's (`scorecard.policies[].score`); this page does no arithmetic.
// Method: docs/benchmark.md, "The Benchmark Score".
import EmojiEventsIcon from '@mui/icons-material/EmojiEventsOutlined';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Accordion, AccordionDetails, AccordionSummary, Box, Chip, LinearProgress, Paper, Stack, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';

import type { PolicyScore, Scorecard, ScoreDimension, ScorePreset } from '../types/benchmarks';
import { GRADE_TEXT, SCORE_BADGE_LABEL, SCORE_DIMENSION_LABEL, gradeColor, scoreText, weightsText } from './format';

const DIMENSIONS: ScoreDimension[] = ['accuracy', 'cost', 'time', 'tokens'];
const STORAGE_KEY = 'hexactra.benchmarks.scorePreset';

/** The preset this viewer chose last, if it is one the scorecard offers. Browser storage can be absent or throw: then the default. */
export function storedPreset(offered: readonly ScorePreset[], fallback: ScorePreset): ScorePreset {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v && (offered as readonly string[]).includes(v) ? (v as ScorePreset) : fallback;
  } catch {
    return fallback;
  }
}
export function storePreset(p: ScorePreset): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, p);
  } catch {
    /* a viewer convenience only */
  }
}

/** The policies in their order under a preset. */
export function rankedUnder(scorecard: Scorecard, preset: ScorePreset): PolicyScore[] {
  return [...scorecard.policies].sort((a, b) => a.score.overall[preset].rank - b.score.overall[preset].rank);
}

function GradeChip({ grade, size = 'small' }: { grade: PolicyScore['score']['overall'][ScorePreset]['grade']; size?: 'small' | 'medium' }) {
  if (!grade) return <Chip size={size} label="Not rated" variant="outlined" />;
  return (
    <Tooltip title={`Grade ${GRADE_TEXT[grade]}`}>
      <Chip size={size} label={grade} color={gradeColor(grade)} sx={{ fontWeight: 700, minWidth: size === 'medium' ? 44 : 32 }} data-testid="grade" />
    </Tooltip>
  );
}

function RankBadge({ rank }: { rank: number }) {
  const theme = useTheme();
  const medal = rank === 1 ? '#d4a72c' : rank === 2 ? '#9aa4b2' : rank === 3 ? '#b87333' : null;
  return (
    <Box
      aria-label={`Rank ${rank}`}
      sx={{
        width: 36,
        height: 36,
        borderRadius: '50%',
        display: 'grid',
        placeItems: 'center',
        flexShrink: 0,
        fontWeight: 700,
        fontVariantNumeric: 'tabular-nums',
        color: medal ? '#fff' : 'text.secondary',
        bgcolor: medal ?? alpha(theme.palette.text.primary, 0.06),
      }}
    >
      {rank}
    </Box>
  );
}

function DimensionBar({ dim, value, atMost }: { dim: ScoreDimension; value: number | null; atMost?: boolean }) {
  return (
    <Box sx={{ minWidth: 0 }} data-dimension={dim}>
      <Stack direction="row" sx={{ justifyContent: 'space-between', gap: 1 }}>
        <Typography variant="caption" color="text.secondary">
          {SCORE_DIMENSION_LABEL[dim]}
        </Typography>
        <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
          {atMost && value !== null ? '≤ ' : ''}
          {scoreText(value)}
        </Typography>
      </Stack>
      <LinearProgress variant="determinate" value={value ?? 0} aria-label={`${SCORE_DIMENSION_LABEL[dim]} score ${scoreText(value)} of 100`} sx={{ height: 6, borderRadius: 3 }} />
    </Box>
  );
}

function Flags({ p, preset }: { p: PolicyScore; preset: ScorePreset }) {
  const o = p.score.overall[preset];
  const flags = p.metrics.safety.flaggedTrials;
  return (
    <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 0.5 }}>
      {p.score.badges.map((b) => (
        <Chip key={b} size="small" variant="outlined" color="primary" label={SCORE_BADGE_LABEL[b]} />
      ))}
      {o.tied && (
        <Tooltip title="Its score band overlaps the leader's: the difference is not shown to be real. Run more trials to separate them.">
          <Chip size="small" variant="outlined" label="Tied with #1" />
        </Tooltip>
      )}
      {p.score.provisional && (
        <Tooltip title={`Fewer than 10 judged trials (${p.score.judged}): the score can move a lot with more trials.`}>
          <Chip size="small" variant="outlined" color="warning" label="Provisional" />
        </Tooltip>
      )}
      {flags > 0 && <Chip size="small" color="error" label={`Safety: ${flags} flagged`} />}
    </Stack>
  );
}

function Winner({ p, preset, presetLabel }: { p: PolicyScore; preset: ScorePreset; presetLabel: string }) {
  const theme = useTheme();
  const o = p.score.overall[preset];
  return (
    <Box
      data-testid="leaderboard-winner"
      sx={{
        p: { xs: 2, sm: 2.5 },
        borderRadius: 2,
        background: `linear-gradient(135deg, ${alpha(theme.palette.primary.main, 0.16)}, ${alpha(theme.palette.secondary.main, 0.1)})`,
        border: `1px solid ${alpha(theme.palette.primary.main, 0.3)}`,
        display: 'grid',
        gap: 2,
        gridTemplateColumns: { xs: '1fr', sm: 'auto 1fr' },
        alignItems: 'center',
      }}
    >
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
        <EmojiEventsIcon sx={{ fontSize: 44, color: '#d4a72c' }} aria-hidden />
        <Box>
          <Typography variant="overline" color="text.secondary" component="div" sx={{ lineHeight: 1.4 }}>
            Best overall · {presetLabel}
          </Typography>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'baseline' }}>
            <Typography component="div" sx={{ fontSize: { xs: 44, sm: 56 }, fontWeight: 800, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }} data-testid="winner-score">
              {scoreText(o.value)}
            </Typography>
            <GradeChip grade={o.grade} size="medium" />
          </Stack>
          {o.low !== null && o.high !== null && (
            <Typography variant="caption" color="text.secondary">
              95% band {scoreText(o.low)} to {scoreText(o.high)}
            </Typography>
          )}
        </Box>
      </Stack>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="h6" component="div" sx={{ overflowWrap: 'anywhere', mb: 1 }}>
          {p.label}
        </Typography>
        <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', mb: 1 }}>
          {DIMENSIONS.map((d) => (
            <DimensionBar key={d} dim={d} value={p.score[d]} atMost={d === 'cost' && !p.score.costKnown} />
          ))}
        </Box>
        <Flags p={p} preset={preset} />
      </Box>
    </Box>
  );
}

function Row({ p, preset }: { p: PolicyScore; preset: ScorePreset }) {
  const o = p.score.overall[preset];
  return (
    <Box
      component="li"
      data-testid="leaderboard-row"
      data-ref={p.ref}
      sx={{
        listStyle: 'none',
        py: 1.5,
        borderTop: 1,
        borderColor: 'divider',
        display: 'grid',
        gap: { xs: 1, md: 2 },
        alignItems: 'center',
        gridTemplateColumns: { xs: 'auto minmax(0, 1fr) auto', md: 'auto minmax(0, 1.2fr) 120px minmax(0, 2fr)' },
      }}
    >
      <RankBadge rank={o.rank} />
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, overflowWrap: 'anywhere', lineHeight: 1.3 }}>
          {p.label}
        </Typography>
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
          {p.metrics.counts.judged} judged · {p.metrics.models.join(', ') || 'no model recorded'}
        </Typography>
        <Flags p={p} preset={preset} />
      </Box>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'flex-end' }}>
        <Box sx={{ textAlign: 'right' }}>
          <Typography component="div" sx={{ fontSize: 28, fontWeight: 800, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }} data-testid="row-score">
            {o.value === null ? '—' : scoreText(o.value)}
          </Typography>
          {o.low !== null && o.high !== null && (
            <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
              {scoreText(o.low)}–{scoreText(o.high)}
            </Typography>
          )}
        </Box>
        <GradeChip grade={o.grade} />
      </Stack>
      <Box sx={{ gridColumn: { xs: '1 / -1', md: 'auto' }, display: 'grid', gap: 1, gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))' } }}>
        {DIMENSIONS.map((d) => (
          <DimensionBar key={d} dim={d} value={p.score[d]} atMost={d === 'cost' && !p.score.costKnown} />
        ))}
      </Box>
    </Box>
  );
}

function Method({ scorecard }: { scorecard: Scorecard }) {
  return (
    <Accordion disableGutters elevation={0} sx={{ bgcolor: 'transparent', '&::before': { display: 'none' } }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0, minHeight: 44 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          How the score works
        </Typography>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 0 }} data-testid="score-method">
        <Stack spacing={1} component="ul" sx={{ pl: 2, m: 0 }}>
          <Typography component="li" variant="body2">
            <b>Accuracy</b> = 100 × (0.7 × success rate + 0.3 × pass^{scorecard.k}) × (1 − false-success rate), over the judged trials.
          </Typography>
          <Typography component="li" variant="body2">
            <b>Cost, Time, Tokens</b> compare cost per success, median active time and tokens per success with the best policy of this benchmark, on a log scale: the best scores 100, twice it about 85, ten times 50, a hundred times or more 0. A policy with no pass scores 0, so failing cheaply earns nothing.
          </Typography>
          <Typography component="li" variant="body2">
            <b>Overall</b> is their weighted mean under the preset:{' '}
            {scorecard.scoring.presets.map((p) => `${p.label} (${weightsText(p.weights)})`).join('; ')}.
          </Typography>
          <Typography component="li" variant="body2">
            The band is the Overall score with accuracy at the ends of its 95% interval. Policies whose band overlaps the leader's are tied. Grades: S 90+, A 80+, B 70+, C 60+, D below. Under {scorecard.scoring.provisionalBelow} judged trials a score is provisional.
          </Typography>
          <Typography component="li" variant="body2">
            Cost, time and token scores are relative to this benchmark&apos;s best, so compare Overall scores within one benchmark; across benchmarks use Compare. A safety flag is shown, never folded into the score.
          </Typography>
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}

export interface LeaderboardProps {
  scorecard: Scorecard;
  preset: ScorePreset;
  onPresetChange: (p: ScorePreset) => void;
}

/** The leaderboard: a preset switch, the winner, then every policy ranked with its score, grade and four sub-scores. */
export function Leaderboard({ scorecard, preset, onPresetChange }: LeaderboardProps) {
  if (!scorecard.scoring || !scorecard.policies.every((p) => p.score)) return null;
  const ranked = rankedUnder(scorecard, preset);
  const presets = scorecard.scoring.presets;
  const current = presets.find((p) => p.id === preset) ?? presets[0]!;
  const leader = ranked[0];
  return (
    <Paper variant="outlined" component="section" aria-label="Leaderboard" data-testid="leaderboard" sx={{ p: { xs: 1.5, sm: 2 }, minWidth: 0 }}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ justifyContent: 'space-between', alignItems: { md: 'center' }, mb: 2 }}>
        <Box>
          <Typography variant="h6" component="h2">
            Leaderboard
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Benchmark Score, 0 to 100 · weights {weightsText(current.weights)}
            {scorecard.live ? ' · live, will change' : ''}
          </Typography>
        </Box>
        <Box sx={{ overflowX: 'auto', maxWidth: '100%' }}>
          <ToggleButtonGroup exclusive size="small" value={preset} onChange={(_, v: ScorePreset | null) => v && onPresetChange(v)} aria-label="Score weighting">
            {presets.map((p) => (
              <ToggleButton key={p.id} value={p.id} sx={{ minHeight: 44, px: 1.5, whiteSpace: 'nowrap', textTransform: 'none' }}>
                {p.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Box>
      </Stack>
      {leader && leader.score.rated ? (
        <Winner p={leader} preset={preset} presetLabel={current.label} />
      ) : (
        <Typography variant="body2" color="text.secondary" data-testid="leaderboard-empty">
          No policy has a judged trial yet: the scores appear as trials are graded.
        </Typography>
      )}
      <Box component="ol" aria-label="Policies by score" sx={{ p: 0, m: 0, mt: 2 }}>
        {ranked.map((p) => (
          <Row key={p.ref} p={p} preset={preset} />
        ))}
      </Box>
      <Method scorecard={scorecard} />
    </Paper>
  );
}
