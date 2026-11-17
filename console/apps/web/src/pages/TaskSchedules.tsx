import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, Stack, TextField, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { PolicySelect } from '../policies/PolicySelect';
import type { PolicyCatalog } from '../policies/usePolicyCatalog';

/** `GET /api/schedules?taskId=`. */
export interface TaskSchedule {
  id: string;
  taskId: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  concurrency: 'skip' | 'queue';
  nextRunAt: string | null;
  lastRunAt: string | null;
  consecutiveFailures: number;
  /** Overrides the task's agent policy for scheduled runs; null follows the task. */
  policyId?: string | null;
}

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export interface TaskSchedulesProps {
  taskId: string;
  canWrite: boolean;
  /** The policies to offer as a schedule's override; without it there is no policy picker. */
  catalog?: Pick<PolicyCatalog, 'policies' | 'defaultId' | 'byId'>;
  /** The task's own policy (null follows the default): what a schedule without an override uses. */
  taskPolicyId?: string | null;
}

/** A task's schedules: add one (cron + time zone, optionally another policy), pause, resume, delete. */
export function TaskSchedules({ taskId, canWrite, catalog, taskPolicyId }: TaskSchedulesProps) {
  const { api } = usePlatformHost();
  const [items, setItems] = useState<TaskSchedule[]>([]);
  const [cron, setCron] = useState('');
  const [tz, setTz] = useState(browserZone());
  const [error, setError] = useState<string | null>(null);
  const [policyId, setPolicyId] = useState<string | null>(null);
  const taskPolicy = catalog?.byId(taskPolicyId ?? catalog.defaultId);

  const load = useCallback(async () => {
    try {
      setItems(await api.get<TaskSchedule[]>(`/schedules?taskId=${taskId}`));
    } catch {
      setItems([]);
    }
  }, [api, taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (run: () => Promise<unknown>) => {
    setError(null);
    try {
      await run();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The change failed');
    }
  };

  return (
    <Box sx={{ mt: 2 }} aria-label="Schedules">
      <Typography variant="subtitle2">Schedules</Typography>
      {error && (
        <Alert severity="error" sx={{ my: 1 }}>
          {error}
        </Alert>
      )}
      <Stack spacing={1} sx={{ my: 1 }}>
        {items.map((s) => (
          <Stack key={s.id} direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
            <Chip size="small" label={`${s.cron} (${s.timezone})`} color={s.enabled ? 'primary' : 'default'} />
            {s.policyId && <Chip size="small" variant="outlined" label={`policy: ${catalog?.byId(s.policyId)?.name ?? 'unavailable'}`} />}
            <Typography variant="caption" color="text.secondary">
              {s.enabled && s.nextRunAt ? `next ${new Date(s.nextRunAt).toLocaleString()}` : 'paused'}
              {s.consecutiveFailures ? ` · ${s.consecutiveFailures} failed in a row` : ''}
            </Typography>
            {canWrite && (
              <>
                <Button size="small" onClick={() => void act(() => api.patch(`/schedules/${s.id}`, { enabled: !s.enabled }))}>
                  {s.enabled ? 'Pause' : 'Resume'}
                </Button>
                <Button size="small" color="error" onClick={() => void act(() => api.delete(`/schedules/${s.id}`))}>
                  Delete
                </Button>
              </>
            )}
          </Stack>
        ))}
      </Stack>
      {canWrite && (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <TextField size="small" label="Cron" placeholder="0 9 * * 1-5" value={cron} onChange={(e) => setCron(e.target.value)} helperText="minute hour day month weekday" />
          <TextField size="small" label="Time zone" value={tz} onChange={(e) => setTz(e.target.value)} />
          {catalog && catalog.policies.length > 0 && (
            <Box sx={{ minWidth: { sm: 220 } }}>
              <PolicySelect
                size="small"
                label="Policy override"
                nullLabel="Task's policy"
                nullPolicyId={taskPolicy?.id ?? null}
                catalog={catalog}
                value={policyId}
                onChange={setPolicyId}
              />
            </Box>
          )}
          <Box>
            <Button
              disabled={!cron.trim()}
              onClick={() =>
                void act(async () => {
                  await api.post('/schedules', { taskId, cron: cron.trim(), timezone: tz.trim() || 'UTC', ...(policyId ? { policyId } : {}) });
                  setCron('');
                  setPolicyId(null);
                })
              }
            >
              Add schedule
            </Button>
          </Box>
        </Stack>
      )}
    </Box>
  );
}
