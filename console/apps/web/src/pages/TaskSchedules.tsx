import { useCallback, useEffect, useState } from 'react';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { ScheduleEditor } from '../components/ScheduleEditor';
import { ScheduleSummary } from '../components/ScheduleSummary';
import type { PolicyCatalog } from '../policies/usePolicyCatalog';
import { draftFromSchedule, draftToItem, newScheduleDraft, type ScheduleDraft } from '../schedule/draft';
import type { TaskSchedule } from '../types/tasks';
import { ErrorBanner, useApiAction, useBreakpoint, useConfirm, useProfileTimeZone } from '../ui';

export interface TaskSchedulesProps {
  taskId: string;
  canWrite: boolean;
  /** The policies to offer as a schedule's override; without it there is no policy picker. */
  catalog?: Pick<PolicyCatalog, 'policies' | 'defaultId' | 'byId'>;
  /** The task's own policy (null follows the default): what a schedule without an override uses. */
  taskPolicyId?: string | null;
}

/** A task's schedules: add or edit one in the schedule editor, pause, resume, delete. */
export function TaskSchedules({ taskId, canWrite, catalog, taskPolicyId }: TaskSchedulesProps) {
  const { api } = usePlatformHost();
  const profileTimezone = useProfileTimeZone();
  const { isPhone } = useBreakpoint();
  const [items, setItems] = useState<TaskSchedule[]>([]);
  const { run, busy, error } = useApiAction();
  const save = useApiAction('The schedule could not be saved');
  const confirm = useConfirm();
  // The schedule in the editor dialog; null while it is closed.
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [valid, setValid] = useState(true);

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

  const open = (next: ScheduleDraft) => {
    save.clearError();
    setValid(true);
    setDraft(next);
  };

  const submit = async () => {
    if (!draft) return;
    const { id, ...fields } = draftToItem(draft);
    const saved = await save.run('save', async () => {
      if (id) await api.patch(`/schedules/${id}`, fields);
      else await api.post('/schedules', { taskId, ...fields });
      return true;
    });
    if (saved) {
      setDraft(null);
      await load();
    }
  };

  return (
    <Box sx={{ mt: 2 }} aria-label="Schedules">
      <Typography variant="subtitle2">Schedules</Typography>
      <ErrorBanner error={error} />
      <Stack spacing={1} sx={{ my: 1 }}>
        {items.map((s) => (
          <Stack key={s.id} direction="row" spacing={1} aria-label={`Schedule ${s.description ?? s.cron}`} role="group" sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
            <Box sx={{ flex: '1 1 200px', minWidth: 0 }}>
              <ScheduleSummary schedule={s} catalog={catalog} profileTimezone={profileTimezone} />
            </Box>
            {canWrite && (
              <Stack direction="row" spacing={0.5} sx={{ '& .MuiButton-root': { minHeight: { xs: 44, sm: 'auto' } } }}>
                <Button size="small" disabled={busy !== null} onClick={() => open(draftFromSchedule(s))}>
                  Edit
                </Button>
                <Button size="small" disabled={busy !== null} onClick={() => void act(s.id, () => api.patch(`/schedules/${s.id}`, { enabled: !s.enabled }))}>
                  {s.enabled ? 'Pause' : 'Resume'}
                </Button>
                <Button size="small" color="error" disabled={busy !== null} onClick={() => void remove(s)}>
                  Delete
                </Button>
              </Stack>
            )}
          </Stack>
        ))}
      </Stack>
      {canWrite && (
        <Button disabled={busy !== null} onClick={() => open(newScheduleDraft(profileTimezone))} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
          Add schedule
        </Button>
      )}
      {draft && (
        <Dialog open fullWidth maxWidth="sm" fullScreen={isPhone} onClose={() => save.busy === null && setDraft(null)} aria-labelledby={`schedule-dialog-${taskId}`}>
          <DialogTitle id={`schedule-dialog-${taskId}`}>{draft.id ? 'Edit schedule' : 'Add schedule'}</DialogTitle>
          <DialogContent>
            <ErrorBanner error={save.error} />
            <Box sx={{ pt: 1 }}>
              <ScheduleEditor value={draft} onChange={setDraft} onValidity={setValid} disabled={save.busy !== null} profileTimezone={profileTimezone} catalog={catalog} taskPolicyId={taskPolicyId} />
            </Box>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button onClick={() => setDraft(null)} disabled={save.busy !== null} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
              Cancel
            </Button>
            <Button variant="contained" onClick={() => void submit()} disabled={!valid || save.busy !== null} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
              {draft.id ? 'Save schedule' : 'Add schedule'}
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </Box>
  );
}
