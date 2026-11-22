import { Box, Link, List, ListItem, Paper, Stack, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { getKgRun, type KgRun } from './api';
import { HowChip, kindLabel, MODE_LABEL } from './labels';

/** "14 of 17 steps without AI; 1 repaired": from the ledger once written, else from the steps' tags. */
export function runSummary(run: KgRun): string {
  if (run.aiOnly) return 'This run used AI only: the learned procedure was not used.';
  if (run.mode === 'learn') return 'The agent did this run; its steps were saved for the procedure.';
  const counts = run.ledger ?? {
    replayed: run.steps.filter((s) => s.how === 'replayed').length,
    recovered: run.steps.filter((s) => s.how === 'recovered').length,
    judge: run.steps.filter((s) => s.how === 'judged').length,
    agent: run.steps.filter((s) => s.how === 'agent').length,
  };
  const total = counts.replayed + counts.recovered + counts.judge + counts.agent;
  if (total === 0) return 'No step of the procedure ran.';
  const withoutAi = counts.replayed + counts.recovered;
  return `${withoutAi} of ${total} step${total === 1 ? '' : 's'} without AI${counts.recovered > 0 ? `; ${counts.recovered} repaired` : ''}`;
}

/**
 * "Knowledge Graph" on the run page (E46.20): shown only when `GET /api/kgraph/runs/{runId}` says the Knowledge Graph took part in
 * the run (it has a `kg_runs` row). Each step of the procedure is tagged replayed, recovered, small AI call or agent. Nothing for a
 * viewer without `kgraph:read`, or for a run without Knowledge Graph facts, so the page is unchanged for them.
 */
export function RunKgraphPanel({ runId, refreshKey }: { runId: string; refreshKey?: string }) {
  const { api, viewer } = usePlatformHost();
  const canRead = viewer.hasPermission('kgraph:read');
  const [run, setRun] = useState<KgRun | null>(null);
  useEffect(() => {
    if (!canRead) return;
    let live = true;
    getKgRun(api, runId)
      .then((r) => live && setRun(r))
      .catch(() => live && setRun(null));
    return () => {
      live = false;
    };
  }, [api, runId, canRead, refreshKey]);
  if (!run || (run.mode === 'off' && !run.aiOnly)) return null;
  return (
    <Paper variant="outlined" component="section" aria-label="Knowledge Graph" sx={{ p: 2, my: 2, minWidth: 0 }} data-testid="run-kgraph">
      <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 500 }}>
        Knowledge Graph
      </Typography>
      <Typography variant="body2" sx={{ mb: 0.5 }} data-testid="run-kgraph-summary">
        {runSummary(run)}
      </Typography>
      <Typography variant="caption" color="text.secondary" component="p">
        {MODE_LABEL[run.mode]}
        {run.versionNumber !== null && ` · version ${run.versionNumber}`}
        {run.procedureId && (
          <>
            {' · '}
            <Link component={RouterLink} to={`/kgraph/procedures/${encodeURIComponent(run.procedureId)}`}>
              the procedure
            </Link>
          </>
        )}
      </Typography>
      {run.steps.length > 0 && (
        <List dense disablePadding aria-label="Procedure steps in this run">
          {run.steps.map((s, i) => (
            <ListItem key={s.id} divider disableGutters sx={{ alignItems: 'flex-start' }}>
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', minWidth: 0, width: '100%' }}>
                <Typography variant="body2" color="text.secondary" component="span">
                  {i + 1}.
                </Typography>
                <Box component="span" sx={{ minWidth: 0, flex: '1 1 160px', overflowWrap: 'anywhere' }}>
                  <Typography variant="body2" component="span">
                    {s.label}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" component="span">
                    {' · '}
                    {kindLabel(s.kind)}
                    {s.tool ? ` · ${s.tool}` : ''}
                  </Typography>
                </Box>
                <HowChip how={s.how} />
              </Stack>
            </ListItem>
          ))}
        </List>
      )}
      {(run.siteFacts?.length ?? 0) > 0 && (
        <Box sx={{ mt: 1 }}>
          <Typography variant="body2" component="h3" sx={{ fontWeight: 500 }}>
            Site facts used
          </Typography>
          <List dense disablePadding aria-label="Site facts used in this run" data-testid="run-kgraph-facts">
            {run.siteFacts!.map((f) => (
              <ListItem key={f.id} divider disableGutters sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                <Typography variant="body2" component="span">
                  {f.text}
                  <Typography variant="caption" color="text.secondary" component="span">
                    {' · '}
                    {f.site}
                  </Typography>
                </Typography>
              </ListItem>
            ))}
          </List>
        </Box>
      )}
    </Paper>
  );
}
