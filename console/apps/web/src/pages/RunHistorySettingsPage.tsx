import { Alert, Box, Button, Collapse, FormControlLabel, Paper, Stack, Switch, TextField, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useId, useState } from 'react';

import { RETENTION_MAX_DAYS, RETENTION_MAX_PER_TASK, SPEND_WINDOW_DAYS, type RetentionLimits, type RetentionPreview, type RetentionSettings } from '../types/retention';
import { CardSkeleton, ErrorBanner, PageContainer, PageHeader, formatCost, formatDateTime, useApiAction, useConfirm } from '../ui';

/** How long after the last keystroke the preview is asked for. */
export const PREVIEW_DEBOUNCE_MS = 400;

/** The form: text as typed, and the two "no limit" switches. */
interface Draft {
  forever: boolean;
  days: string;
  noPerTask: boolean;
  perTask: string;
  /** Empty: failed runs are kept as long as the others. */
  failedDays: string;
}

function toDraft(s: RetentionLimits): Draft {
  return {
    forever: s.keepDays === null,
    days: s.keepDays === null ? '' : String(s.keepDays),
    noPerTask: s.keepPerTask === null,
    perTask: s.keepPerTask === null ? '' : String(s.keepPerTask),
    failedDays: s.keepFailedDays === null ? '' : String(s.keepFailedDays),
  };
}

/** Why a whole number between 1 and `max` is not one; null when it is. */
function numberError(text: string, max: number): string | null {
  const n = Number(text);
  if (!text.trim() || !Number.isInteger(n)) return 'A whole number';
  if (n < 1 || n > max) return `From 1 to ${max.toLocaleString('en-US')}`;
  return null;
}

/** The limits the form holds, or null while a field is invalid. */
function toLimits(d: Draft): RetentionLimits | null {
  if (!d.forever && numberError(d.days, RETENTION_MAX_DAYS)) return null;
  if (!d.noPerTask && numberError(d.perTask, RETENTION_MAX_PER_TASK)) return null;
  if (d.failedDays.trim() && numberError(d.failedDays, RETENTION_MAX_DAYS)) return null;
  return {
    keepDays: d.forever ? null : Number(d.days),
    keepPerTask: d.noPerTask ? null : Number(d.perTask),
    keepFailedDays: d.failedDays.trim() ? Number(d.failedDays) : null,
  };
}

const same = (a: RetentionLimits, b: RetentionLimits) => a.keepDays === b.keepDays && a.keepPerTask === b.keepPerTask && a.keepFailedDays === b.keepFailedDays;
const count = (n: number) => n.toLocaleString('en-US');
const runs = (n: number) => `${count(n)} ${n === 1 ? 'run' : 'runs'}`;

/** `?keepDays=30&keepPerTask=` : an empty value is "no limit". */
function previewQuery(l: RetentionLimits): string {
  return `keepDays=${l.keepDays ?? ''}&keepPerTask=${l.keepPerTask ?? ''}&keepFailedDays=${l.keepFailedDays ?? ''}`;
}

/** The live line under the fields: what the rule would delete. */
export function previewLine(p: RetentionPreview): string {
  if (p.finished === 0) return 'You have no finished runs yet, so nothing would be deleted.';
  if (p.wouldDelete === 0) return `With these settings, none of your ${count(p.finished)} finished ${p.finished === 1 ? 'run' : 'runs'} would be deleted tonight.`;
  const cost = formatCost(p.costUsd);
  const kept = p.oldestKept ? ` The oldest kept run would be from ${formatDateTime(p.oldestKept, { day: 'numeric', month: 'short', year: 'numeric' })}.` : ' No finished run would be kept.';
  return `With these settings, ${count(p.wouldDelete)} of your ${count(p.finished)} finished ${p.finished === 1 ? 'run' : 'runs'} would be deleted tonight${cost ? ` (recorded spend ${cost})` : ''}.${kept}`;
}

/**
 * `/settings/run-history`: how long the signed-in user's finished runs are
 * kept (#422). The rule is the `runs` namespace of their settings; the nightly
 * job applies it, and "Apply now" applies the saved rule at once.
 */
export function RunHistorySettingsPage() {
  const { api, viewer } = usePlatformHost();
  const canSave = viewer.hasPermission('user_settings:write');
  const confirm = useConfirm();
  const action = useApiAction();
  const moreId = useId();
  const [settings, setSettings] = useState<RetentionSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [more, setMore] = useState(false);
  const [preview, setPreview] = useState<RetentionPreview | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { setError } = action;

  const load = useCallback(async () => {
    try {
      const s = await api.get<RetentionSettings>('/runs/retention');
      setSettings(s);
      setDraft(toDraft(s));
      setMore(s.keepFailedDays !== null);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not load your run history settings');
    }
  }, [api, setError]);

  useEffect(() => {
    void load();
  }, [load]);

  const limits = draft ? toLimits(draft) : null;
  const query = limits ? previewQuery(limits) : null;

  // The live line: asked for 400 ms after the last change, and never for an invalid form.
  useEffect(() => {
    if (query === null) {
      setPreview(null);
      return undefined;
    }
    let stale = false;
    const timer = setTimeout(() => {
      api
        .get<RetentionPreview>(`/runs/retention/preview?${query}`)
        .then((p) => {
          if (stale) return;
          setPreview(p);
          setPreviewError(false);
        })
        .catch(() => {
          if (!stale) setPreviewError(true);
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [api, query]);

  if (!settings || !draft) {
    return (
      <PageContainer width="narrow">
        <PageHeader title="Run history" subtitle="How long finished runs are kept." back={{ to: '/settings', label: 'Settings' }} />
        <ErrorBanner error={action.error} />
        {!action.error && <CardSkeleton />}
      </PageContainer>
    );
  }

  const dirty = limits !== null && !same(limits, settings);
  const busy = action.busy !== null;
  const max = settings.maxKeepDays;
  const set = (patch: Partial<Draft>) => {
    setNotice(null);
    setDraft({ ...draft, ...patch });
  };
  const daysError = draft.forever ? null : numberError(draft.days, RETENTION_MAX_DAYS);
  const perTaskError = draft.noPerTask ? null : numberError(draft.perTask, RETENTION_MAX_PER_TASK);
  const failedError = draft.failedDays.trim() ? numberError(draft.failedDays, RETENTION_MAX_DAYS) : null;
  const days = draft.forever || daysError ? null : Number(draft.days);
  const cappedDays = max !== null && (draft.forever || (days !== null && days > max));
  const cappedFailed = max !== null && !failedError && draft.failedDays.trim() !== '' && Number(draft.failedDays) > max;
  const shortSpend = (days !== null && days < SPEND_WINDOW_DAYS) || (max !== null && max < SPEND_WINDOW_DAYS && cappedDays);

  const save = async () => {
    if (!limits) return;
    const done = await action.run('save', () => api.patch('/user-settings', { runs: limits }), 'Could not save your run history settings');
    if (done === undefined) return;
    setSettings({ ...settings, ...limits, saved: true });
    setNotice('Saved. The nightly cleanup uses these settings.');
  };

  const applyNow = async () => {
    if (!preview) return;
    const ok = await confirm({
      title: `Delete ${runs(preview.wouldDelete)} now?`,
      body: `This permanently deletes the ${runs(preview.wouldDelete)} that fall outside your saved settings, with their steps and screenshots. It cannot be undone.`,
      confirmLabel: 'Delete runs',
      destructive: true,
    });
    if (!ok) return;
    const done = await action.run('apply', () => api.post<{ jobId: string }>('/runs/retention/apply'), 'Could not start the cleanup');
    if (done !== undefined) setNotice('Cleanup started. The runs disappear from your history in a moment.');
  };

  const floor = settings.floorHours === 24 ? '24 hours' : `${settings.floorHours} hours`;

  return (
    <PageContainer width="narrow">
      <PageHeader title="Run history" subtitle="How long finished runs are kept." back={{ to: '/settings', label: 'Settings' }} />
      <ErrorBanner error={action.error} />
      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
        <Stack spacing={3}>
          {!settings.saved && (
            <Alert severity="info">
              You have not chosen a rule yet, so the default applies: runs are kept for 90 days. Before the first cleanup removes anything, you get one notification and a day to change this.
            </Alert>
          )}
          {!canSave && <Alert severity="info">You can look at these settings but not change them.</Alert>}

          <Box>
            <Typography variant="subtitle2" component="h2" gutterBottom>
              Keep runs for
            </Typography>
            <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
              <TextField
                sx={{ flex: 1, minWidth: 0 }}
                size="small"
                type="number"
                label="Days"
                value={draft.forever ? '' : draft.days}
                disabled={!canSave || draft.forever}
                error={Boolean(daysError)}
                helperText={daysError ?? undefined}
                onChange={(e) => set({ days: e.target.value })}
                slotProps={{ htmlInput: { min: 1, max: RETENTION_MAX_DAYS, inputMode: 'numeric', 'aria-label': 'Keep runs for (days)' } }}
              />
              <FormControlLabel
                sx={{ flexShrink: 0, mr: 0, minHeight: 44 }}
                control={<Switch checked={draft.forever} disabled={!canSave} onChange={(e) => set({ forever: e.target.checked })} slotProps={{ input: { 'aria-label': 'Keep runs forever' } }} />}
                label="Forever"
              />
            </Stack>
            {cappedDays && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                Capped at {count(max!)} days by your administrator.
              </Typography>
            )}
            {shortSpend && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                Task spend covers {SPEND_WINDOW_DAYS} days; with fewer days kept it will only reflect the runs that remain.
              </Typography>
            )}
          </Box>

          <Box>
            <Typography variant="subtitle2" component="h2" gutterBottom>
              Keep only the latest runs of each task
            </Typography>
            <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
              <TextField
                sx={{ flex: 1, minWidth: 0 }}
                size="small"
                type="number"
                label="Runs per task"
                value={draft.noPerTask ? '' : draft.perTask}
                disabled={!canSave || draft.noPerTask}
                error={Boolean(perTaskError)}
                helperText={perTaskError ?? undefined}
                onChange={(e) => set({ perTask: e.target.value })}
                slotProps={{ htmlInput: { min: 1, max: RETENTION_MAX_PER_TASK, inputMode: 'numeric', 'aria-label': 'Keep only the latest N runs of each task' } }}
              />
              <FormControlLabel
                sx={{ flexShrink: 0, mr: 0, minHeight: 44 }}
                control={
                  <Switch checked={draft.noPerTask} disabled={!canSave} onChange={(e) => set({ noPerTask: e.target.checked })} slotProps={{ input: { 'aria-label': 'No limit on runs per task' } }} />
                }
                label="No limit"
              />
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Runs started without a task count together as one group.
            </Typography>
          </Box>

          <Box>
            <Button size="small" onClick={() => setMore(!more)} aria-expanded={more} aria-controls={moreId} sx={{ minHeight: 44, ml: -1 }}>
              {more ? 'Fewer options' : 'More options'}
            </Button>
            <Collapse in={more} id={moreId} unmountOnExit>
              <Box sx={{ pt: 1 }}>
                <Typography variant="subtitle2" component="h2" gutterBottom>
                  Keep failed runs longer
                </Typography>
                <TextField
                  fullWidth
                  size="small"
                  type="number"
                  label="Days (optional)"
                  value={draft.failedDays}
                  disabled={!canSave}
                  error={Boolean(failedError)}
                  helperText={failedError ?? 'Leave empty to keep failed runs as long as the others.'}
                  onChange={(e) => set({ failedDays: e.target.value })}
                  slotProps={{ htmlInput: { min: 1, max: RETENTION_MAX_DAYS, inputMode: 'numeric', 'aria-label': 'Keep failed runs for (days)' } }}
                />
                {cappedFailed && (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                    Capped at {count(max!)} days by your administrator.
                  </Typography>
                )}
              </Box>
            </Collapse>
          </Box>

          <Box aria-live="polite" data-testid="retention-preview">
            {limits === null ? (
              <Typography variant="body2" color="text.secondary">
                Correct the fields above to see what would be deleted.
              </Typography>
            ) : previewError ? (
              <Typography variant="body2" color="text.secondary">
                The preview could not be loaded.
              </Typography>
            ) : preview ? (
              <Typography variant="body2">{previewLine(preview)}</Typography>
            ) : (
              <Typography variant="body2" color="text.secondary">
                Counting your runs…
              </Typography>
            )}
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Never removed: live runs, runs waiting for your answer, and runs that finished in the last {floor}.
            </Typography>
          </Box>

          {notice && <Alert severity="success">{notice}</Alert>}

          {dirty && (
            <Typography variant="body2" color="text.secondary">
              Save your changes to apply them now.
            </Typography>
          )}
        </Stack>
        {/* On a phone the actions stay in view above the bottom navigation, however long the form gets. */}
        <Stack
          direction="row"
          spacing={1.5}
          useFlexGap
          sx={{
            flexWrap: 'wrap',
            position: { xs: 'sticky', sm: 'static' },
            bottom: { xs: 56 },
            zIndex: 1,
            bgcolor: 'background.paper',
            // A footer bar across the card on a phone, so what scrolls under it is cut at a line.
            mt: 3,
            mx: { xs: -2, sm: 0 },
            px: { xs: 2, sm: 0 },
            py: { xs: 1.5, sm: 0 },
            borderTop: { xs: 1, sm: 0 },
            borderColor: { xs: 'divider' },
          }}
        >
          {canSave && (
            <Button variant="contained" sx={{ minHeight: 44 }} disabled={busy || !dirty} onClick={() => void save()}>
              Save
            </Button>
          )}
          <Button
            variant="outlined"
            color="error"
            sx={{ minHeight: 44 }}
            disabled={busy || limits === null || dirty || !preview || preview.wouldDelete === 0}
            onClick={() => void applyNow()}
          >
            Apply now
          </Button>
        </Stack>
      </Paper>
    </PageContainer>
  );
}
