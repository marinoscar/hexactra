// A benchmark's trials (E44.5, #743): verdict, why it did not pass, the grader's checks, tokens
// and cost, and a link to the trial's run ("run removed" once the run is deleted). When the run was
// recorded (#846), "Recording" next to it opens the run page at its video; the video stays there.
import { Box, Card, CardContent, Link, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

import type { BenchmarkTrial } from '../types/benchmarks';
import { ResponsiveList, type Column } from '../ui';
import { VerdictChip } from './BenchmarkChips';
import { duration, failureReasonLabel, modelName, money, tokens } from './format';

function checksText(t: BenchmarkTrial): string {
  if (!t.checks || t.checks.length === 0) return 'n/a';
  const failed = t.checks.filter((c) => !c.pass);
  const head = `${t.checks.length - failed.length} of ${t.checks.length} passed`;
  return failed.length ? `${head}; failed: ${failed.map((c) => c.name).join(', ')}` : head;
}

const tokenText = (t: BenchmarkTrial) => (t.inputTokens === null && t.outputTokens === null ? 'n/a' : `${tokens(t.inputTokens)} in / ${tokens(t.outputTokens)} out / ${tokens(t.cachedInputTokens)} cached`);

/** The table's narrow form: "37.7k / 3.3k / 16.4k". */
const shortTokens = (t: BenchmarkTrial) => (t.inputTokens === null && t.outputTokens === null ? 'n/a' : `${tokens(t.inputTokens)} / ${tokens(t.outputTokens)} / ${tokens(t.cachedInputTokens)}`);

const LINK_SX = { display: 'inline-flex', alignItems: 'center', minHeight: 32 } as const;

/** The run's video: a link once it is ready, "Recording…" while it is made, nothing when it failed or there is none. */
function RecordingLink({ t }: { t: BenchmarkTrial }) {
  if (!t.runId || !t.recording) return null;
  if (t.recording.status === 'ready') {
    return (
      <Link component={RouterLink} to={`/runs/${t.runId}#recording`} sx={LINK_SX} aria-label={`Recording of ${t.challengeTitle}, ${t.policyLabel}, attempt ${t.trialIndex + 1}`}>
        Recording
      </Link>
    );
  }
  if (t.recording.status === 'failed') return null;
  return (
    <Typography variant="body2" color="text.secondary" component="span" sx={LINK_SX}>
      Recording…
    </Typography>
  );
}

function RunLink({ t }: { t: BenchmarkTrial }) {
  if (t.runId) {
    return (
      <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: 'center', whiteSpace: 'nowrap' }}>
        <Link component={RouterLink} to={`/runs/${t.runId}`} sx={LINK_SX}>
          Open run
        </Link>
        <RecordingLink t={t} />
      </Stack>
    );
  }
  // A trial that started but has no run any more: the run was deleted (the trial's metrics stay).
  if (t.startedAt) return <Typography variant="body2" color="text.secondary">run removed</Typography>;
  return <Typography variant="body2" color="text.secondary">not started</Typography>;
}

export function TrialList({ trials }: { trials: BenchmarkTrial[] }) {
  const columns: Column<BenchmarkTrial>[] = [
    {
      key: 'challenge',
      header: 'Challenge',
      grow: true,
      render: (t) => (
        <Box sx={{ overflowWrap: 'anywhere', minWidth: 180 }}>
          {t.challengeTitle}
          <Typography variant="caption" color="text.secondary" component="div">
            {t.policyLabel} · attempt {t.trialIndex + 1}
          </Typography>
        </Box>
      ),
    },
    { key: 'verdict', header: 'Verdict', render: (t) => <VerdictChip verdict={t.verdict} pending={t.status} /> },
    { key: 'reason', header: 'Why', render: (t) => <Box sx={{ whiteSpace: 'normal', minWidth: 90 }}>{t.failureReason ? failureReasonLabel(t.failureReason) : ''}</Box> },
    { key: 'checks', header: 'Checks', hideBelow: 'lg', render: (t) => <Box sx={{ whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 120, maxWidth: 220 }}>{checksText(t)}</Box> },
    { key: 'tokens', header: 'Tokens in / out / cached', render: (t) => shortTokens(t) },
    { key: 'cost', header: 'Cost', align: 'right', render: (t) => money(t.costUsd, t.costKnown !== false) },
    { key: 'time', header: 'Active', hideBelow: 'lg', align: 'right', render: (t) => duration(t.activeMs) },
    { key: 'run', header: 'Run', render: (t) => <RunLink t={t} /> },
  ];
  return (
    <ResponsiveList
      aria-label="Trials"
      items={trials}
      columns={columns}
      getKey={(t) => t.id}
      windowAfter={300}
      renderCard={(t) => (
        <Card variant="outlined">
          <CardContent>
            <Stack direction="row" spacing={1} sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="subtitle2" component="h3" sx={{ overflowWrap: 'anywhere' }}>
                  {t.challengeTitle}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {t.policyLabel} · attempt {t.trialIndex + 1}
                </Typography>
              </Box>
              <VerdictChip verdict={t.verdict} pending={t.status} />
            </Stack>
            {t.failureReason && <Typography variant="body2">Why: {failureReasonLabel(t.failureReason)}</Typography>}
            <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
              Checks: {checksText(t)}
            </Typography>
            <Typography variant="body2">Tokens: {tokenText(t)}</Typography>
            <Typography variant="body2">
              Cost: {money(t.costUsd, t.costKnown !== false)} · active {duration(t.activeMs)}
              {t.model ? ` · ${modelName(t.model)}` : ''}
            </Typography>
            <RunLink t={t} />
          </CardContent>
        </Card>
      )}
    />
  );
}
