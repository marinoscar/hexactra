import AddIcon from '@mui/icons-material/Add';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Link, Paper, Stack, Switch, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { ScheduleEditor } from './ScheduleEditor';
import { FAILING_AFTER, ScheduleSummary } from './ScheduleSummary';
import { createSchedule, deleteSchedule, listTaskSchedules, updateSchedule } from './taskDetail';
import { taskPaths } from './taskList';
import type { PolicyCatalog } from '../policies/usePolicyCatalog';
import { draftFromSchedule, draftToItem, newScheduleDraft, type ScheduleDraft } from '../schedule/draft';
import type { TaskSummarySchedule, TaskWithSummary } from '../types/tasks';
import { RelativeTime, useBreakpoint, useConfirm, useProfileTimeZone } from '../ui';

/** A task holds at most this many schedules (the API answers 409 `SCHEDULE_LIMIT` beyond it). */
export const MAX_TASK_SCHEDULES = 10;

export interface TaskSchedulesSectionProps {
  task: TaskWithSummary;
  /** `tasks:write`: without it the rows are read-only. */
  canWrite: boolean;
  /** `runs:read`: the links to a schedule's last run. */
  canReadRuns: boolean;
  /** The policy catalog, when the viewer may read policies and it loaded: names an override and offers one in the editor. */
  catalog?: Pick<PolicyCatalog, 'policies' | 'defaultId' | 'byId'>;
  /** A schedule changed: read the task again. */
  onChanged: () => void;
}

const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const touch = { minHeight: { xs: 44, md: 'auto' } } as const;

/**
 * A task's schedules on its page (#428): one row per schedule in words, with
 * when it runs next and ran last, its own Active/Paused switch
 * (`PATCH /schedules/:id { enabled }`), Edit and Add (the schedule editor in a
 * dialog, full-screen on a phone; `PATCH /schedules/:id`, `POST /schedules`),
 * Delete (asks first) and a warning once it failed three times in a row. An
 * action's error shows on its own row.
 */
export function TaskSchedulesSection({ task, canWrite, canReadRuns, catalog, onChanged }: TaskSchedulesSectionProps) {
  const { api } = usePlatformHost();
  const confirm = useConfirm();
  const { isPhone } = useBreakpoint();
  const profileTimezone = useProfileTimeZone();
  const schedules = task.summary.schedules;

  /** Each schedule's last run (the summary does not carry it). */
  const [lastRuns, setLastRuns] = useState<Record<string, string | null>>({});
  const scheduleKey = schedules.map((s) => `${s.id}:${s.lastRunAt ?? ''}`).join(',');
  useEffect(() => {
    if (!canReadRuns || schedules.length === 0) return;
    let stale = false;
    listTaskSchedules(api, task.id)
      .then((rows) => {
        if (!stale) setLastRuns(Object.fromEntries(rows.map((r) => [r.id, r.lastRunId ?? null])));
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
    // `scheduleKey` is the identity of the schedules and their last firings.
  }, [api, task.id, canReadRuns, scheduleKey]);

  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** A switch that moved before the API answered: the schedule's id and where it went. */
  const [pending, setPending] = useState<Record<string, boolean>>({});

  /** One change to one schedule: its row is busy while it runs and shows the error when it fails. */
  const act = async (id: string, fallback: string, fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy((b) => ({ ...b, [id]: true }));
    setErrors(({ [id]: _gone, ...rest }) => rest);
    try {
      await fn();
      onChanged();
      return true;
    } catch (e) {
      setErrors((all) => ({ ...all, [id]: errorText(e, fallback) }));
      return false;
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  const setEnabled = async (s: TaskSummarySchedule, enabled: boolean) => {
    setPending((p) => ({ ...p, [s.id]: enabled }));
    await act(s.id, enabled ? 'Could not resume the schedule' : 'Could not pause the schedule', () => updateSchedule(api, s.id, { enabled }));
    setPending(({ [s.id]: _done, ...rest }) => rest);
  };

  const remove = async (s: TaskSummarySchedule) => {
    const ok = await confirm({ title: 'Delete this schedule?', body: `“${s.description || s.cron}” stops running. The task and its runs are kept.`, confirmLabel: 'Delete', destructive: true });
    if (ok) await act(s.id, 'Could not delete the schedule', () => deleteSchedule(api, s.id));
  };

  // ---- The editor dialog (a new schedule, or a saved one) ----
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [valid, setValid] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const open = (next: ScheduleDraft) => {
    setSaveError(null);
    setValid(true);
    setDraft(next);
  };
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      const { id, ...fields } = draftToItem(draft);
      if (id) await updateSchedule(api, id, fields);
      else await createSchedule(api, task.id, fields);
      setDraft(null);
      onChanged();
    } catch (e) {
      setSaveError(errorText(e, 'Could not save the schedule'));
    } finally {
      setSaving(false);
    }
  };

  const canAdd = canWrite && schedules.length < MAX_TASK_SCHEDULES;
  return (
    <Box component="section" id="schedule" aria-labelledby="task-schedules-title" sx={{ scrollMarginTop: '72px' }}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography variant="h6" component="h2" id="task-schedules-title">
          Schedules
        </Typography>
        {canAdd && schedules.length > 0 && (
          <Button size="small" startIcon={<AddIcon />} onClick={() => open(newScheduleDraft(profileTimezone))} sx={touch}>
            Add a schedule
          </Button>
        )}
      </Stack>

      {schedules.length === 0 && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography color="text.secondary">Not scheduled</Typography>
          <Typography variant="body2" color="text.secondary">
            It runs only when you start it.
          </Typography>
          {canAdd && (
            <Button variant="outlined" startIcon={<AddIcon />} onClick={() => open(newScheduleDraft(profileTimezone))} sx={{ ...touch, mt: 1.5 }}>
              Add a schedule
            </Button>
          )}
        </Paper>
      )}

      <Stack spacing={1.5}>
        {schedules.map((s, index) => {
          const enabled = pending[s.id] ?? s.enabled;
          const lastRunId = lastRuns[s.id] ?? null;
          const label = s.description || s.cron;
          return (
            <Paper key={s.id} variant="outlined" data-testid="task-schedule" aria-label={`Schedule ${index + 1}: ${label}`} sx={{ p: 1.5, minWidth: 0 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
                <Box sx={{ minWidth: 0 }}>
                  <ScheduleSummary schedule={{ ...s, enabled }} catalog={catalog} profileTimezone={profileTimezone} />
                  <Typography variant="caption" color="text.secondary" component="div">
                    {s.lastRunAt ? (
                      lastRunId && canReadRuns ? (
                        <Link component={RouterLink} to={taskPaths.run(lastRunId)} underline="hover" color="inherit">
                          <RelativeTime iso={s.lastRunAt} prefix="last run " />
                        </Link>
                      ) : (
                        <RelativeTime iso={s.lastRunAt} prefix="last run " />
                      )
                    ) : (
                      'has not run yet'
                    )}
                  </Typography>
                </Box>
                {canWrite ? (
                  <Box component="label" sx={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0, minHeight: 44, cursor: busy[s.id] ? 'default' : 'pointer' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
                      {enabled ? 'Active' : 'Paused'}
                    </Typography>
                    <Switch checked={enabled} disabled={busy[s.id]} onChange={(e) => void setEnabled(s, e.target.checked)} slotProps={{ input: { 'aria-label': `Active: ${label}` } }} />
                  </Box>
                ) : (
                  <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                    {enabled ? 'Active' : 'Paused'}
                  </Typography>
                )}
              </Stack>

              {s.consecutiveFailures >= FAILING_AFTER && (
                <Alert severity="warning" sx={{ mt: 1, py: 0, overflowWrap: 'anywhere' }}>
                  Failed {s.consecutiveFailures} times in a row.{' '}
                  {canReadRuns && (
                    <Link component={RouterLink} to={lastRunId ? taskPaths.run(lastRunId) : `/runs?taskId=${task.id}&view=failed&trigger=schedule`} color="inherit">
                      See the last run
                    </Link>
                  )}
                </Alert>
              )}
              {errors[s.id] && (
                <Alert severity="error" role="alert" sx={{ mt: 1, py: 0, overflowWrap: 'anywhere' }} onClose={() => setErrors(({ [s.id]: _gone, ...rest }) => rest)}>
                  {errors[s.id]}
                </Alert>
              )}

              {canWrite && (
                <Stack direction="row" spacing={1} sx={{ mt: 0.5, ml: -1 }}>
                  <Button size="small" disabled={busy[s.id]} aria-label={`Edit schedule: ${label}`} onClick={() => open(draftFromSchedule(s))} sx={touch}>
                    Edit
                  </Button>
                  <Button size="small" color="error" disabled={busy[s.id]} aria-label={`Delete schedule: ${label}`} onClick={() => void remove(s)} sx={touch}>
                    Delete
                  </Button>
                </Stack>
              )}
            </Paper>
          );
        })}
      </Stack>

      <Dialog open={draft !== null} onClose={saving ? undefined : () => setDraft(null)} fullWidth maxWidth="sm" fullScreen={isPhone} aria-labelledby="task-schedule-dialog-title">
        <DialogTitle id="task-schedule-dialog-title">{draft?.id ? 'Edit schedule' : 'Add a schedule'}</DialogTitle>
        <DialogContent>
          {saveError && (
            <Alert severity="error" role="alert" sx={{ mb: 2, overflowWrap: 'anywhere' }}>
              {saveError}
            </Alert>
          )}
          {draft && (
            <Box sx={{ pt: 1 }}>
              {/* One editor per draft: a stable key, so its builder state is this schedule's. */}
              <ScheduleEditor key={draft.id ?? 'new'} value={draft} onChange={setDraft} onValidity={setValid} disabled={saving} profileTimezone={profileTimezone} catalog={catalog} taskPolicyId={task.policyId} />
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDraft(null)} disabled={saving} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
            Cancel
          </Button>
          <Button variant="contained" onClick={() => void save()} disabled={saving || !valid} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
            {draft?.id ? 'Save' : 'Add'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
