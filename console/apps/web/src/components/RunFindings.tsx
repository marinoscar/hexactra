import { Box, Chip, Link, List, ListItem, Stack, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useEffect, useState } from 'react';

/** One finding of a run (E52.6, #1021): what `GET /runs/{id}/diagnostics` answers. Facts computed from the steps; no model. */
export interface RunFinding {
  code: string;
  severity: 'info' | 'warn';
  title: string;
  detail: string;
  seqFrom: number | null;
  seqTo: number | null;
  stepsSpent: number;
}

interface RunDiagnostics {
  runId: string;
  truncated: boolean;
  findings: RunFinding[];
}

/** "Steps 53–110", or "Step 4". */
export function stepsLabel(f: Pick<RunFinding, 'seqFrom' | 'seqTo'>): string | null {
  if (f.seqFrom === null) return null;
  return f.seqTo !== null && f.seqTo !== f.seqFrom ? `Steps ${f.seqFrom}–${f.seqTo}` : `Step ${f.seqFrom}`;
}

/** Scrolls the run's timeline to a step (its row has `data-testid="step-<seq>"`). */
function goToStep(seq: number) {
  const row = document.querySelector(`[data-testid="step-${seq}"]`);
  if (row && 'scrollIntoView' in row) (row as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** The list itself, for a run's findings: warnings first, as the API orders them. Nothing when there are none. */
export function RunFindingsList({ findings, truncated = false }: { findings: RunFinding[]; truncated?: boolean }) {
  if (findings.length === 0) return null;
  return (
    <Box component="section" aria-label="What happened" sx={{ mt: 2 }} data-testid="run-findings">
      <Typography variant="subtitle2" component="h2" gutterBottom>
        What happened
      </Typography>
      <List dense disablePadding>
        {findings.map((f, i) => {
          const where = stepsLabel(f);
          return (
            <ListItem key={`${f.code}-${i}`} disableGutters sx={{ alignItems: 'flex-start' }} data-code={f.code}>
              <Stack spacing={0.25} sx={{ minWidth: 0, width: '100%' }}>
                <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <Chip size="small" variant="outlined" color={f.severity === 'warn' ? 'warning' : 'default'} label={f.severity === 'warn' ? 'Worth fixing' : 'Note'} />
                  <Typography variant="body2" sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>
                    {f.title}
                  </Typography>
                </Stack>
                <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                  {f.detail}{' '}
                  {where && f.seqFrom !== null && (
                    <Link component="button" type="button" variant="body2" onClick={() => goToStep(f.seqFrom!)} sx={{ verticalAlign: 'baseline' }}>
                      {where}
                    </Link>
                  )}
                </Typography>
              </Stack>
            </ListItem>
          );
        })}
      </List>
      {truncated && (
        <Typography variant="caption" color="text.secondary">
          This run is long: the findings cover its first 2,000 steps.
        </Typography>
      )}
    </Box>
  );
}

/**
 * "What happened" (E52.6, #1021): the run's findings, under its outcome, once it has ended. Information only: nothing changes by itself.
 * Nothing while the run is live, when there are none, or when they cannot be read.
 */
export function RunFindings({ runId, ended }: { runId: string; ended: boolean }) {
  const { api } = usePlatformHost();
  const [data, setData] = useState<RunDiagnostics | null>(null);
  useEffect(() => {
    if (!ended) return;
    let live = true;
    api
      .get<RunDiagnostics>(`/runs/${runId}/diagnostics`)
      .then((d) => live && setData(d))
      .catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, [api, runId, ended]);
  if (!ended || !data) return null;
  return <RunFindingsList findings={data.findings} truncated={data.truncated} />;
}
