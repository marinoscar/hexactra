import { useCallback, useEffect, useState } from 'react';
import { Box, Button, Chip, Stack, TextField, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { PolicySelect } from '../policies/PolicySelect';
import type { PolicyCatalog } from '../policies/usePolicyCatalog';
import type { TaskSchedule } from '../types/tasks';
import { ErrorBanner, RelativeTime, useApiAction, useConfirm } from '../ui';

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
  const { run, busy, error } = useApiAction();
  const confirm = useConfirm();
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

  /** Run a change, then reload. */
  const act = (key: string, change: () => Promise<unknown>) =>
    run(key, async () => {
      await change();
      await load();
    });

  const remove = async (schedule: TaskSchedule) => {
    if (await confirm({ title: 'Delete this schedule?', confirmLabel: 'Delete', destructive: true })) await act(schedule.id, () => api.delete(`/schedules/${schedule.id}`));
  };

  return (
    <Box sx={{ mt: 2 }} aria-label="Schedules">
      <Typography variant="subtitle2">Schedules</Typography>
      <ErrorBanner error={error} />
      <Stack spacing={1} sx={{ my: 1 }}>
        {items.map((s) => (
          <Stack key={s.id} direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
            <Chip size="small" label={`${s.cron} (${s.timezone})`} color={s.enabled ? 'primary' : 'default'} />
            {s.policyId && <Chip size="small" variant="outlined" label={`policy: ${catalog?.byId(s.policyId)?.name ?? 'unavailable'}`} />}
            <Typography variant="caption" color="text.secondary">
              {s.enabled && s.nextRunAt ? <RelativeTime iso={s.nextRunAt} prefix="next " /> : 'paused'}
              {s.consecutiveFailures ? ` · ${s.consecutiveFailures} failed in a row` : ''}
            </Typography>
            {canWrite && (
              <>
                <Button size="small" disabled={busy !== null} onClick={() => void act(s.id, () => api.patch(`/schedules/${s.id}`, { enabled: !s.enabled }))}>
                  {s.enabled ? 'Pause' : 'Resume'}
                </Button>
                <Button size="small" color="error" disabled={busy !== null} onClick={() => void remove(s)}>
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
              disabled={!cron.trim() || busy !== null}
              onClick={() =>
                void act('new', async () => {
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
