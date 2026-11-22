import { Box, Link, List, ListItem, Paper, Stack, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { getKgRun, listKgSites, listSiteFacts, sitesTabPath, type KgRun, type KgSiteFact } from './api';
import { HowChip, kindLabel, MODE_LABEL } from './labels';
import { factKindLabel } from './siteFacts';

/**
 * "Used site facts" (E46.33): the facts the run used, by the ids the run view lists (`kgFactIds`, #854), each with a link to its site in
 * the Sites tab. Nothing when the run view has no such field or it is empty. A fact deleted since is counted, not shown.
 */
export function UsedSiteFacts({ ids }: { ids: readonly string[] | null | undefined }) {
  const { api } = usePlatformHost();
  const [facts, setFacts] = useState<KgSiteFact[] | null>(null);
  const key = (ids ?? []).join(',');
  useEffect(() => {
    const wanted = new Set(key ? key.split(',') : []);
    if (wanted.size === 0) return;
    let live = true;
    (async () => {
      const sites = await listKgSites(api);
      const found: KgSiteFact[] = [];
      for (const s of sites) {
        if (found.length === wanted.size) break;
        for (const f of await listSiteFacts(api, s.site)) if (wanted.has(f.id)) found.push(f);
      }
      if (live) setFacts(found);
    })().catch(() => live && setFacts([]));
    return () => {
      live = false;
    };
  }, [api, key]);
  if (!ids || ids.length === 0) return null;
  const gone = facts ? ids.length - facts.length : 0;
  return (
    <Box component="section" aria-label="Used site facts" sx={{ mt: 1.5 }} data-testid="run-used-site-facts">
      <Typography variant="subtitle2" component="h3">
        Used site facts
      </Typography>
      {facts === null && (
        <Typography variant="body2" color="text.secondary">
          {ids.length} fact{ids.length === 1 ? '' : 's'}
        </Typography>
      )}
      {facts && facts.length > 0 && (
        <Stack component="ul" spacing={0.5} sx={{ pl: 2, my: 0.5 }}>
          {facts.map((f) => (
            <li key={f.id}>
              <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                {f.text}{' '}
                <Typography component="span" variant="caption" color="text.secondary">
                  ({factKindLabel(f.kind)}){' '}
                </Typography>
                <Link component={RouterLink} to={sitesTabPath(f.site)}>
                  {f.site}
                </Link>
              </Typography>
            </li>
          ))}
        </Stack>
      )}
      {gone > 0 && (
        <Typography variant="body2" color="text.secondary">
          {gone} fact{gone === 1 ? ' was' : 's were'} deleted since.
        </Typography>
      )}
    </Box>
  );
}

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
  if (!run) return null;
  if (run.mode === 'off' && !run.aiOnly) {
    // A run without a procedure (an everyday run, #850) may still have read site facts: only that list, else nothing.
    if (!run.kgFactIds?.length) return null;
    return (
      <Paper variant="outlined" component="section" aria-label="Knowledge Graph" sx={{ p: 2, my: 2, minWidth: 0 }} data-testid="run-kgraph">
        <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 500 }}>
          Knowledge Graph
        </Typography>
        <UsedSiteFacts ids={run.kgFactIds} />
      </Paper>
    );
  }
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
      <UsedSiteFacts ids={run.kgFactIds} />
    </Paper>
  );
}
