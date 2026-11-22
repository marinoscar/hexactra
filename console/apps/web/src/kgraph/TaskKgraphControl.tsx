import { Alert, FormControl, FormControlLabel, FormHelperText, FormLabel, Link, Paper, Radio, RadioGroup, Stack, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useId, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { getKgStatus, getTaskKgraph, putTaskKgraph, type KgMode, type KgStatus } from './api';
import { MODE_CHOICES, offReason } from './labels';
import { ErrorBanner, toast, useApiAction } from '../ui';

/**
 * A task's "Knowledge Graph" control (E46.20): AI only, Learn only, Learn and reuse, each with one line of help. Saved through
 * `PUT /api/tasks/{id}/kgraph` (the task routes are untouched). Disabled with the reason while the deployment's or the owner's switch
 * is off; the stored mode is kept. Renders nothing for a viewer without `kgraph:read`, so a task page without the feature is unchanged.
 */
export function TaskKgraphControl({ taskId, mt }: { taskId: string; /** Space above it, when it renders. */ mt?: number }) {
  const { api, viewer } = usePlatformHost();
  const uid = useId();
  const canRead = viewer.hasPermission('kgraph:read');
  const canWrite = viewer.hasPermission('kgraph:write');
  const action = useApiAction('Could not change the Knowledge Graph setting');
  const [status, setStatus] = useState<KgStatus | null>(null);
  const [mode, setMode] = useState<KgMode | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([getKgStatus(api), getTaskKgraph(api, taskId)]);
      setStatus(s);
      setMode(t.mode);
    } catch {
      setFailed(true);
    }
  }, [api, taskId]);
  useEffect(() => {
    if (canRead) void load();
  }, [canRead, load]);

  if (!canRead || failed || mode === null) return null;
  const reason = offReason(status);
  const choose = async (next: KgMode) => {
    const saved = await action.run('mode', () => putTaskKgraph(api, taskId, next));
    if (!saved) return;
    setMode(saved.mode);
    toast('Knowledge Graph setting saved');
  };

  return (
    <Paper variant="outlined" component="section" aria-labelledby={`${uid}-title`} sx={{ p: 2, minWidth: 0, mt }} data-testid="task-kgraph">
      <Typography id={`${uid}-title`} variant="h6" component="h2" sx={{ mb: 0.5 }}>
        Knowledge Graph
      </Typography>
      <FormControl component="fieldset" disabled={Boolean(reason) || !canWrite || action.busy !== null} sx={{ minWidth: 0 }}>
        <FormLabel component="legend" sx={{ typography: 'body2' }}>
          How this task&apos;s runs use what was learned
        </FormLabel>
        <RadioGroup value={mode} onChange={(e) => void choose(e.target.value as KgMode)}>
          {MODE_CHOICES.map((c) => (
            <Stack key={c.value} sx={{ mb: 0.5 }}>
              <FormControlLabel value={c.value} control={<Radio />} label={c.label} sx={{ minHeight: 44, mr: 0 }} />
              <FormHelperText sx={{ mt: -0.75, ml: 4 }}>{c.help}</FormHelperText>
            </Stack>
          ))}
        </RadioGroup>
      </FormControl>
      {reason && (
        <Alert severity="info" sx={{ mt: 1 }}>
          {reason}
        </Alert>
      )}
      {!reason && mode !== 'off' && (
        <Typography variant="body2" sx={{ mt: 1 }}>
          <Link component={RouterLink} to="/kgraph">
            See what was learned
          </Link>
        </Typography>
      )}
      <ErrorBanner error={action.error} onClose={action.clearError} />
    </Paper>
  );
}
