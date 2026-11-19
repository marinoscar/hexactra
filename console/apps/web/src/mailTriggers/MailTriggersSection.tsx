// "When an email arrives" on the task page (E39.8, #605), beside the schedules: the task's email triggers, each with its rules in
// words, its status, an on/off switch, Test (what would match, nothing started), Edit and Delete, and what it did with each message.
import AddIcon from '@mui/icons-material/Add';
import { Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Paper, Stack, Switch, Typography } from '@mui/material';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import type { TaskParameter } from '@app/shared/task-params';

import { listConnections, type Connection } from '../connections/api';
import { RelativeTime, useBreakpoint, useConfirm } from '../ui';
import { createTrigger, deleteTrigger, listTriggers, testTrigger, updateTrigger, type MailTrigger, type TriggerPreview } from './api';
import { MailTriggerForm } from './MailTriggerForm';
import { draftFromTrigger, draftProblems, draftToBody, matchText, newDraft, previewReason, STATUS_TEXT, type TriggerDraft } from './model';
import { TriggerEvents } from './TriggerEvents';

export interface MailTriggersSectionProps {
  taskId: string;
  parameters: readonly TaskParameter[];
  /** `runs:write`: without it the rows are read-only. */
  canWrite: boolean;
  /** `runs:read`: the history and its links to runs. */
  canRead: boolean;
  /** `connections:read`: the accounts to choose from. */
  canReadConnections: boolean;
}

const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const touch = { minHeight: { xs: 44, md: 'auto' } } as const;
/** The server's `details.issues` of a 400, by parameter key, as form errors. */
function serverErrors(e: unknown): Record<string, string> {
  const issues = (e as { details?: { issues?: { key?: string; message?: string }[] } } | null)?.details?.issues;
  return Object.fromEntries((issues ?? []).flatMap((i) => (i.key && i.message ? [[`mapping:${i.key}`, i.message] as const] : [])));
}

export function MailTriggersSection({ taskId, parameters, canWrite, canRead, canReadConnections }: MailTriggersSectionProps) {
  const { api } = usePlatformHost();
  const confirm = useConfirm();
  const { isPhone } = useBreakpoint();
  const [triggers, setTriggers] = useState<MailTrigger[] | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!canRead) return;
    let stale = false;
    listTriggers(api, taskId)
      .then((rows) => {
        if (!stale) {
          setTriggers(rows);
          setLoadError(null);
        }
      })
      .catch((e: unknown) => {
        if (!stale) setLoadError(errorText(e, 'Could not load the email triggers'));
      });
    return () => {
      stale = true;
    };
  }, [api, taskId, canRead, version]);

  useEffect(() => {
    if (!canWrite || !canReadConnections) return;
    let stale = false;
    listConnections(api)
      .then((rows) => {
        if (!stale) setConnections(rows.filter((c) => c.provider !== 'mcp' && c.capabilities.includes('mail_read')));
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [api, canWrite, canReadConnections]);

  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const act = async (id: string, fallback: string, fn: () => Promise<unknown>) => {
    setBusy((b) => ({ ...b, [id]: true }));
    setRowError(({ [id]: _gone, ...rest }) => rest);
    try {
      await fn();
      refresh();
    } catch (e) {
      setRowError((all) => ({ ...all, [id]: errorText(e, fallback) }));
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  // ---- Test: what would match, nothing started ----
  const [previews, setPreviews] = useState<Record<string, TriggerPreview>>({});
  const test = (t: MailTrigger) =>
    act(t.id, 'Could not read the mailbox', async () => {
      const r = await testTrigger(api, t.id);
      setPreviews((p) => ({ ...p, [t.id]: r }));
    });

  const remove = async (t: MailTrigger) => {
    const ok = await confirm({ title: 'Delete this email trigger?', body: `“${t.name}” stops starting this task. Its history goes with it; runs it started are kept.`, confirmLabel: 'Delete', destructive: true });
    if (ok) await act(t.id, 'Could not delete the trigger', () => deleteTrigger(api, t.id));
  };

  // ---- The editor dialog ----
  const [draft, setDraft] = useState<TriggerDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const open = (d: TriggerDraft) => {
    setSaveError(null);
    setFieldErrors({});
    setAttempted(false);
    setDraft(d);
  };
  const canModify = (d: TriggerDraft) => Boolean(connections.find((c) => c.id === d.connectionId)?.capabilities.includes('mail_modify'));
  const problems = useMemo(() => (draft ? draftProblems(draft, { canModify: canModify(draft) }) : {}), [draft, connections]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownErrors = { ...(attempted ? problems : {}), ...fieldErrors };

  const save = async () => {
    if (!draft) return;
    setAttempted(true);
    if (Object.keys(problems).length > 0) return;
    setSaving(true);
    setSaveError(null);
    setFieldErrors({});
    try {
      const body = draftToBody(draft);
      if (draft.id) await updateTrigger(api, draft.id, body);
      else await createTrigger(api, taskId, body);
      setDraft(null);
      refresh();
    } catch (e) {
      setFieldErrors(serverErrors(e));
      setSaveError(errorText(e, 'Could not save the trigger'));
    } finally {
      setSaving(false);
    }
  };

  if (!canRead) return null;
  const list = triggers ?? [];
  return (
    <Box component="section" id="mail-triggers" aria-labelledby="mail-triggers-title" sx={{ scrollMarginTop: '72px', minWidth: 0 }}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography variant="h6" component="h2" id="mail-triggers-title">
          When an email arrives
        </Typography>
        {canWrite && list.length > 0 && (
          <Button size="small" startIcon={<AddIcon />} onClick={() => open(newDraft(connections[0]?.id ?? ''))} sx={touch}>
            Add a trigger
          </Button>
        )}
      </Stack>

      {loadError && (
        <Alert severity="error" role="alert" sx={{ mb: 1 }}>
          {loadError}
        </Alert>
      )}

      {triggers !== null && list.length === 0 && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography color="text.secondary">No email triggers</Typography>
          <Typography variant="body2" color="text.secondary">
            Start this task when an email from someone you name arrives in a connected account.
          </Typography>
          {canWrite && (
            <Button variant="outlined" startIcon={<AddIcon />} onClick={() => open(newDraft(connections[0]?.id ?? ''))} sx={{ ...touch, mt: 1.5 }}>
              Add a trigger
            </Button>
          )}
        </Paper>
      )}

      <Stack spacing={1.5}>
        {list.map((t) => {
          const status = STATUS_TEXT[t.status];
          const preview = previews[t.id];
          return (
            <Paper key={t.id} variant="outlined" data-testid="mail-trigger" aria-label={`Email trigger: ${t.name}`} sx={{ p: 1.5, minWidth: 0 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
                <Box sx={{ minWidth: 0 }}>
                  <Typography sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{t.name}</Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                    {matchText(t.match)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" component="div">
                    {t.connectionLabel ?? 'Account removed'} · {t.runsToday} of {t.maxRunsPerDay} runs today
                    {t.lastCheckedAt ? <> · checked <RelativeTime iso={t.lastCheckedAt} /></> : ' · not checked yet'}
                  </Typography>
                  {t.enabled && t.status !== 'ok' && <Chip size="small" color={status.color} label={status.label} sx={{ mt: 0.5 }} />}
                </Box>
                {canWrite ? (
                  <Box component="label" sx={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0, minHeight: 44 }}>
                    <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
                      {t.enabled ? 'On' : 'Off'}
                    </Typography>
                    <Switch checked={t.enabled} disabled={busy[t.id]} onChange={(e) => void act(t.id, 'Could not change the trigger', () => updateTrigger(api, t.id, { enabled: e.target.checked }))} slotProps={{ input: { 'aria-label': `On: ${t.name}` } }} />
                  </Box>
                ) : (
                  <Typography variant="caption" color="text.secondary">
                    {t.enabled ? 'On' : 'Off'}
                  </Typography>
                )}
              </Stack>

              {rowError[t.id] && (
                <Alert severity="error" role="alert" sx={{ mt: 1, py: 0, overflowWrap: 'anywhere' }} onClose={() => setRowError(({ [t.id]: _gone, ...rest }) => rest)}>
                  {rowError[t.id]}
                </Alert>
              )}

              {preview && (
                <Box sx={{ mt: 1 }} data-testid="trigger-preview">
                  <Typography variant="subtitle2">Recent matching mail (nothing was started)</Typography>
                  {preview.messages.length === 0 && <Typography variant="body2" color="text.secondary">{preview.note ?? 'No recent message matches.'}</Typography>}
                  <Stack component="ul" spacing={0.5} sx={{ listStyle: 'none', m: 0, p: 0 }}>
                    {preview.messages.map((m, i) => (
                      <Typography key={i} component="li" variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                        “{m.subject || '(no subject)'}” {m.from ? `from ${m.from}` : ''} · <strong>{previewReason(m)}</strong>
                      </Typography>
                    ))}
                  </Stack>
                </Box>
              )}

              <Box sx={{ mt: 1 }}>
                <Typography variant="subtitle2">History</Typography>
                <TriggerEvents triggerId={t.id} refreshKey={`${version}:${t.lastMatchedAt ?? ''}:${t.runsToday}`} canReadRuns={canRead} />
              </Box>

              {canWrite && (
                <Stack direction="row" spacing={1} sx={{ mt: 0.5, ml: -1, flexWrap: 'wrap' }}>
                  <Button size="small" disabled={busy[t.id]} aria-label={`Test: ${t.name}`} onClick={() => void test(t)} sx={touch}>
                    Test
                  </Button>
                  <Button size="small" disabled={busy[t.id]} aria-label={`Edit trigger: ${t.name}`} onClick={() => open(draftFromTrigger(t))} sx={touch}>
                    Edit
                  </Button>
                  <Button size="small" color="error" disabled={busy[t.id]} aria-label={`Delete trigger: ${t.name}`} onClick={() => void remove(t)} sx={touch}>
                    Delete
                  </Button>
                </Stack>
              )}
            </Paper>
          );
        })}
      </Stack>

      <Dialog open={draft !== null} onClose={saving ? undefined : () => setDraft(null)} fullWidth maxWidth="sm" fullScreen={isPhone} aria-labelledby="mail-trigger-dialog-title">
        <DialogTitle id="mail-trigger-dialog-title">{draft?.id ? 'Edit email trigger' : 'Start this task when an email arrives'}</DialogTitle>
        <DialogContent>
          {saveError && (
            <Alert severity="error" role="alert" sx={{ mb: 2, overflowWrap: 'anywhere' }}>
              {saveError}
            </Alert>
          )}
          {draft && <MailTriggerForm draft={draft} onChange={setDraft} connections={connections} parameters={parameters} errors={shownErrors} disabled={saving} />}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDraft(null)} disabled={saving} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
            Cancel
          </Button>
          <Button variant="contained" onClick={() => void save()} disabled={saving || (draft !== null && !draft.from.trim())} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
            {draft?.id ? 'Save' : 'Add'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
