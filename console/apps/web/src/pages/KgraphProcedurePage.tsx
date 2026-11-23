import { Box, Chip, List, ListItem, Paper, Stack, Typography } from '@mui/material';
import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';

import { forgetProcedure, getKgStatus, getProcedure, putTaskKgraph, restoreVersion, type KgProcedureDetail, type KgStatus, type KgStep, type KgStepArg, type KgVersionItem } from '../kgraph/api';
import { AiChip, HealthChip, KgraphOffNotice, StateChip, everydayUsesText, kindLabel } from '../kgraph/labels';
import { VersionHistory } from '../kgraph/VersionHistory';
import { CardSkeleton, EmptyState, ErrorBanner, PageContainer, PageHeader, formatDateTime, toast, useApiAction, useConfirm } from '../ui';

const SOURCE_LABEL: Record<KgStepArg['source'], string> = { literal: 'fixed', parameter: 'parameter', output: 'from an earlier step', judge: 'decided by a small AI call', secret: 'saved login' };

/** One step. A branch or a loop shows its kind (Choice, Repeat); the step view does not say which steps are its body, so they are not indented. */
function StepRow({ step, index }: { step: KgStep; index: number }) {
  return (
    <ListItem divider sx={{ display: 'block' }} aria-label={`Step ${index + 1}`}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <Typography component="span" color="text.secondary">
          {index + 1}.
        </Typography>
        <Typography component="span" sx={{ fontWeight: 500, overflowWrap: 'anywhere', minWidth: 0 }}>
          {step.label}
        </Typography>
        <AiChip kind={step.kind} usesAi={step.usesAi} />
        <HealthChip health={step.health} />
        {step.commitClass && <Chip size="small" variant="outlined" label="Sends or pays" />}
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
        {kindLabel(step.kind)}
        {step.tool && ` · ${step.tool}`}
        {step.target && ` · on ${step.target}`}
        {` · ${step.counts.successes} succeeded, ${step.counts.failures} failed, ${step.counts.repairs} repaired`}
      </Typography>
      {step.args.length > 0 && (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ overflowWrap: 'anywhere' }}>
          {step.args.map((a) => `${a.name}: ${SOURCE_LABEL[a.source]}${a.detail ? ` (${a.detail})` : ''}`).join(' · ')}
        </Typography>
      )}
    </ListItem>
  );
}

/**
 * `/kgraph/procedures/:id` (E46.20): one learned procedure as an ordered step list (kind, tool, target, whether it uses AI, health),
 * its parameters and what it uses, its versions, and Restore a version, Forget, Switch this task to AI only. Every string is text.
 */
export function KgraphProcedurePage() {
  const { api, viewer } = usePlatformHost();
  const { id = '' } = useParams();
  const confirm = useConfirm();
  const action = useApiAction();
  const canWrite = viewer.hasPermission('kgraph:write');
  const [procedure, setProcedure] = useState<KgProcedureDetail | null>(null);
  const [status, setStatus] = useState<KgStatus | null>(null);
  const [missing, setMissing] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  const { setError } = action;

  const load = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([getProcedure(api, id), getKgStatus(api)]);
      setProcedure(p);
      setStatus(s);
    } catch (e) {
      if (isPlatformApiError(e) && e.status === 404) setMissing(true);
      else setError(e instanceof Error && e.message ? e.message : 'Could not load the procedure');
    }
  }, [api, id, setError]);
  useEffect(() => {
    void load();
  }, [load]);

  if (missing) {
    return (
      <PageContainer width="default">
        <EmptyState title="This procedure does not exist" body="It may have been deleted with everything learned." action={{ key: 'back', label: 'Back to the Knowledge Graph', to: '/kgraph' }} />
      </PageContainer>
    );
  }
  const on = status?.available === true;
  const changed = async () => {
    setHistoryKey((k) => k + 1);
    await load();
  };

  const restore = async (v: KgVersionItem) => {
    const ok = await confirm({ title: `Restore version ${v.number}?`, body: 'It comes back as a new version. Its next run checks it with you before every step that sends or pays; the current version is retired and kept in the history.', confirmLabel: 'Restore' });
    if (!ok) return;
    if (await action.run('restore', () => restoreVersion(api, id, v.id), 'Could not restore the version')) {
      toast(`Version ${v.number} restored`);
      await changed();
    }
  };
  const forget = async () => {
    const ok = await confirm({ title: 'Forget this procedure?', body: 'Every version is retired and kept in the history. The task learns again from its next successful run.', confirmLabel: 'Forget', destructive: true });
    if (!ok) return;
    if (await action.run('forget', () => forgetProcedure(api, id), 'Could not forget the procedure')) {
      toast('Procedure forgotten');
      await changed();
    }
  };
  const aiOnly = async () => {
    if (!procedure) return;
    const ok = await confirm({ title: 'Switch this task to AI only?', body: 'The agent does every run of the task again. What was learned is kept; you can switch back on the task page.', confirmLabel: 'Switch to AI only' });
    if (!ok) return;
    if (await action.run('ai-only', () => putTaskKgraph(api, procedure.taskId, 'off'), 'Could not change the task')) toast('The task now runs with AI only');
  };

  const v = procedure?.activeVersion ?? null;
  return (
    <PageContainer width="default">
      <PageHeader
        title={procedure?.taskName ?? 'Procedure'}
        back={{ to: '/kgraph', label: 'Knowledge Graph' }}
        subtitle={procedure ? `${procedure.steps} step${procedure.steps === 1 ? '' : 's'} · ${procedure.versions} version${procedure.versions === 1 ? '' : 's'}` : undefined}
        actions={[
          { key: 'forget', label: 'Forget', color: 'error', onClick: () => void forget(), hidden: !canWrite || !on || !procedure, disabled: action.busy !== null },
          { key: 'ai-only', label: 'Switch this task to AI only', onClick: () => void aiOnly(), hidden: !canWrite || !on || !procedure, disabled: action.busy !== null },
          { key: 'task', label: 'Open the task', to: procedure ? `/tasks/${procedure.taskId}` : undefined, hidden: !procedure },
        ]}
      >
        {procedure && (
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mt: 1 }}>
            <StateChip state={procedure.state} />
            <HealthChip health={procedure.health} />
          </Stack>
        )}
        {procedure && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }} data-testid="kg-everyday-uses">
            {everydayUsesText(procedure.ledger.everydayRuns)}
          </Typography>
        )}
      </PageHeader>
      {status && <KgraphOffNotice status={status} />}
      <ErrorBanner error={action.error} onClose={action.clearError} />
      {!procedure && !action.error && <CardSkeleton />}
      {procedure && (
        <Stack spacing={3}>
          <Box component="section" aria-labelledby="kg-steps">
            <Typography id="kg-steps" variant="h6" component="h2" sx={{ mb: 1 }}>
              Steps{v ? ` of version ${v.number}` : ''}
            </Typography>
            {!v && <Typography color="text.secondary">This procedure has no version to show.</Typography>}
            {v && (
              <>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                  Learned {formatDateTime(v.createdAt)}
                  {v.sourceRunId && (
                    <>
                      {' from '}
                      <Box component={RouterLink} to={`/runs/${v.sourceRunId}`} sx={{ color: 'primary.main' }}>
                        a run
                      </Box>
                    </>
                  )}
                  {` · ${v.counts.successes} succeeded, ${v.counts.failures} failed, ${v.counts.repairs} repaired`}
                </Typography>
                <Paper variant="outlined">
                  <List disablePadding aria-label="Steps">
                    {v.steps.map((s, i) => (
                      <StepRow key={s.id} step={s} index={i} />
                    ))}
                  </List>
                </Paper>
              </>
            )}
          </Box>
          {v && (v.parameters.length > 0 || v.sites.length > 0 || v.accounts.length > 0 || v.savedLogins.length > 0) && (
            <Box component="section" aria-labelledby="kg-uses">
              <Typography id="kg-uses" variant="h6" component="h2" sx={{ mb: 1 }}>
                What it uses
              </Typography>
              <Paper variant="outlined" sx={{ p: 2 }}>
                {v.parameters.length > 0 && <Typography variant="body2">Parameters: {v.parameters.map((p) => `${p.name}${p.sensitive ? ' (never stored)' : ''}`).join(', ')}</Typography>}
                {v.sites.length > 0 && <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>Sites: {v.sites.join(', ')}</Typography>}
                {v.accounts.length > 0 && <Typography variant="body2">Accounts: {v.accounts.map((a) => a.provider).join(', ')}</Typography>}
                {v.savedLogins.length > 0 && <Typography variant="body2">Saved logins: {v.savedLogins.map((l) => l.label).join(', ')}</Typography>}
              </Paper>
            </Box>
          )}
          <Box component="section" aria-labelledby="kg-history">
            <Typography id="kg-history" variant="h6" component="h2" sx={{ mb: 1 }}>
              History
            </Typography>
            <VersionHistory procedureId={procedure.id} onRestore={canWrite && on ? (ver) => void restore(ver) : undefined} refreshKey={historyKey} />
          </Box>
        </Stack>
      )}
    </PageContainer>
  );
}
