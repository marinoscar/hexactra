// "Where the result goes" (E39.10, #607): the task's deliveries as rows with a one-line summary, a switch, Send a test, Edit, Remove and
// Move up / Move down (keyboard accessible), and "Add a delivery". Changes are held in the form; they are saved with the task.
import AddIcon from '@mui/icons-material/Add';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import { Alert, Box, Button, Chip, IconButton, Menu, MenuItem, Paper, Stack, Switch, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useEffect, useMemo, useState } from 'react';

import { updateConnection, type Connection } from '../connections/api';
import type { TaskOutput } from '../taskOutputs/model';
import { useConfirm } from '../ui';
import { DeliveryEditor, type EditorContext } from './DeliveryEditor';
import { GuidedSetup, type GuidedResult } from './GuidedSetup';
import {
  KIND_ADD_LABEL,
  KIND_ORDER,
  MAX_DELIVERIES,
  changed,
  connectionIssue,
  newDraft,
  summarize,
  type DeliveryDraft,
  type EmailConfig,
  type TaskDelivery,
} from './drafts';
import { listRecipients, needsConfirming, ownAddresses, type RecipientRecord } from './recipients';

export interface DeliveriesSectionProps {
  drafts: readonly DeliveryDraft[];
  onChange: (next: DeliveryDraft[]) => void;
  /** What the server holds: a delivery that matches it can be tested. */
  saved: readonly TaskDelivery[];
  /** `null` for a task that is not saved yet. */
  taskId: string | null;
  taskName: string;
  outputs: readonly TaskOutput[];
  /** `null` while loading, or without `connections:read`. */
  connections: readonly Connection[] | null;
  /** `runs:write`: without it the rows are read-only. */
  canEdit: boolean;
  /** The saved deliveries could not be read: nothing here may be edited. */
  loadFailed?: boolean;
  /** Fill in the form from the guided setup: outputs to add and deliveries to add. */
  onGuided: (result: GuidedResult) => void;
  loadPicker?: () => Promise<void>;
  /** Open the guided setup on mount (tests, and the form's empty-state button). */
  guidedOpen?: boolean;
  onGuidedOpenChange?: (open: boolean) => void;
}

const TAP = { minHeight: { xs: 44, sm: 'auto' } } as const;
const ALLOW_WORDS = { mail_send: 'Allow this account to send mail', docs_write: 'Allow this account to change documents' } as const;
const ALLOW_CAPABILITY_WORDS = { mail_send: 'mail_send', docs_write: 'docs_write' } as const;

export function DeliveriesSection({ drafts, onChange, saved, taskId, taskName, outputs, connections, canEdit, loadFailed = false, onGuided, loadPicker, guidedOpen, onGuidedOpenChange }: DeliveriesSectionProps) {
  const { api, viewer } = usePlatformHost();
  const confirm = useConfirm();
  const [recipients, setRecipients] = useState<RecipientRecord[]>([]);
  const [editing, setEditing] = useState<{ draft: DeliveryDraft; isNew: boolean } | null>(null);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [guided, setGuided] = useState(false);
  const guidedShown = guidedOpen ?? guided;
  const setGuidedShown = (open: boolean) => (onGuidedOpenChange ? onGuidedOpenChange(open) : setGuided(open));
  const canReadRuns = viewer.hasPermission('runs:read');
  const list = connections ?? [];
  const own = useMemo(() => ownAddresses(viewer.email, list), [viewer.email, list]);

  useEffect(() => {
    if (!canReadRuns) return;
    let stale = false;
    listRecipients(api)
      .then((rows) => !stale && setRecipients(Array.isArray(rows) ? rows : []))
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [api, canReadRuns]);

  const ctx: EditorContext = {
    outputs,
    connections: list,
    taskName,
    own,
    recipients,
    onRecipientConfirmed: (r) => setRecipients((all) => [...all.filter((x) => x.address.toLowerCase() !== r.address.toLowerCase()), r]),
    loadPicker,
  };

  const editable = canEdit && !loadFailed;
  const replace = (draft: DeliveryDraft) => onChange(drafts.map((d) => (d.key === draft.key ? draft : d)));
  const add = (draft: DeliveryDraft) => onChange([...drafts, draft]);
  const move = (index: number, by: -1 | 1) => {
    const next = [...drafts];
    const [m] = next.splice(index, 1);
    next.splice(index + by, 0, m!);
    onChange(next);
  };

  const toggle = (d: DeliveryDraft, on: boolean) => {
    // An address that is not the owner's must be confirmed before the delivery can be on: the editor asks.
    if (on && d.kind === 'email') {
      const c = d.config as EmailConfig;
      if (needsConfirming([...c.to, ...(c.cc ?? [])], own, recipients).length > 0) return setEditing({ draft: { ...d, enabled: true }, isNew: false });
    }
    replace({ ...d, enabled: on });
  };

  const test = async (d: DeliveryDraft) => {
    if (!taskId || !d.id) return;
    setBusy(d.key);
    try {
      const r = await api.post<{ ok: boolean; message: string; detail?: Record<string, unknown> }>(`/tasks/${taskId}/deliveries/${d.id}/test`, {});
      const where = typeof r.detail?.location === 'string' ? ` The row is at ${r.detail.location}.` : '';
      setResults((all) => ({ ...all, [d.key]: { ok: r.ok, text: `${r.message}${r.ok ? where : ''}` } }));
    } catch (e) {
      setResults((all) => ({ ...all, [d.key]: { ok: false, text: e instanceof Error && e.message ? e.message : 'The test could not be sent' } }));
    } finally {
      setBusy(null);
    }
  };

  const allow = async (d: DeliveryDraft, connectionId: string, capability: 'mail_send' | 'docs_write') => {
    const c = list.find((x) => x.id === connectionId);
    if (!c) return;
    const ok = await confirm({
      title: ALLOW_WORDS[capability],
      body: `You will go to ${c.provider === 'google' ? 'Google' : 'Microsoft'} to give ${c.label} this permission, then come back to this page. What you changed on this page and have not saved will be lost: save the task first.`,
      confirmLabel: 'Continue',
    });
    if (!ok) return;
    try {
      const r = await updateConnection(api, connectionId, { capabilities: [...new Set([...c.capabilities, ALLOW_CAPABILITY_WORDS[capability]])], returnTo: `${window.location.pathname}${window.location.search}` });
      if (r.consent) window.location.assign(r.consent.authorizeUrl);
      else setResults((all) => ({ ...all, [d.key]: { ok: true, text: 'Switched on. Reload the page to see it.' } }));
    } catch (e) {
      setResults((all) => ({ ...all, [d.key]: { ok: false, text: e instanceof Error && e.message ? e.message : 'Could not ask for the permission' } }));
    }
  };

  const savedOf = (d: DeliveryDraft, index: number) => (d.id ? saved.find((s) => s.id === d.id) : undefined) && !changed(d, saved.find((s) => s.id === d.id), index);

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        When a run ends, Hexactra can send the result for you: an email with the report, a row in a spreadsheet, files in a folder, or a message to a web address. You choose where each goes; nothing in a run can change it.
      </Typography>
      {loadFailed && <Alert severity="warning">The deliveries could not be loaded, so they cannot be changed here right now. Reload the page to try again.</Alert>}
      {drafts.length === 0 && !loadFailed && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography sx={{ fontWeight: 600 }}>Nothing is sent yet</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Most tasks that run on their own keep a record: the values they captured, in an email and a spreadsheet.
          </Typography>
          {editable && (
            <Button variant="outlined" onClick={() => setGuidedShown(true)} sx={TAP}>
              Keep a record of each run
            </Button>
          )}
        </Paper>
      )}
      <Stack component="ul" spacing={1} sx={{ listStyle: 'none', m: 0, p: 0 }} aria-label="Deliveries">
        {drafts.map((d, i) => {
          const issue = connectionIssue(d, list);
          const result = results[d.key];
          const testable = Boolean(taskId && d.id && savedOf(d, i));
          return (
            <Paper component="li" key={d.key} variant="outlined" sx={{ p: 1.5, minWidth: 0 }} data-testid={`delivery-${i}`}>
              <Stack spacing={1}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography sx={{ overflowWrap: 'anywhere' }}>{summarize(d, list)}</Typography>
                    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', mt: 0.5 }}>
                      <Chip size="small" variant="outlined" label={KIND_ADD_LABEL[d.kind]} />
                      {!d.enabled && <Chip size="small" color="warning" variant="outlined" label="Switched off" />}
                      {!d.id && <Chip size="small" color="info" variant="outlined" label="Not saved yet" />}
                    </Stack>
                  </Box>
                  <Switch checked={d.enabled} disabled={!editable} onChange={(e) => toggle(d, e.target.checked)} slotProps={{ input: { 'aria-label': `Send ${summarize(d, list)}` } }} />
                </Stack>
                {issue && (
                  <Alert severity="warning" action={issue.capability && issue.connectionId && editable ? <Button color="inherit" size="small" onClick={() => void allow(d, issue.connectionId!, issue.capability!)}>{ALLOW_WORDS[issue.capability]}</Button> : undefined}>
                    {issue.text}
                  </Alert>
                )}
                {result && (
                  <Alert severity={result.ok ? 'success' : 'error'} role="status" onClose={() => setResults(({ [d.key]: _gone, ...rest }) => rest)}>
                    {result.text}
                  </Alert>
                )}
                <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                  <Button size="small" onClick={() => setEditing({ draft: d, isNew: false })} disabled={!editable} sx={TAP}>
                    Edit
                  </Button>
                  <Button size="small" disabled={!testable || busy === d.key || !canEdit} onClick={() => void test(d)} sx={TAP} title={testable ? undefined : 'Save the task first, then send a test'}>
                    {busy === d.key ? 'Sending…' : 'Send a test'}
                  </Button>
                  <Button size="small" color="error" disabled={!editable} onClick={() => onChange(drafts.filter((x) => x.key !== d.key))} sx={TAP}>
                    Remove
                  </Button>
                  <IconButton aria-label={`Move delivery ${i + 1} up`} disabled={!editable || i === 0} onClick={() => move(i, -1)} sx={{ minWidth: 44, minHeight: 44 }}>
                    <ArrowUpwardIcon fontSize="small" />
                  </IconButton>
                  <IconButton aria-label={`Move delivery ${i + 1} down`} disabled={!editable || i === drafts.length - 1} onClick={() => move(i, 1)} sx={{ minWidth: 44, minHeight: 44 }}>
                    <ArrowDownwardIcon fontSize="small" />
                  </IconButton>
                </Stack>
                {!testable && d.id && <Typography variant="caption" color="text.secondary">Save the task to send a test of the changes.</Typography>}
              </Stack>
            </Paper>
          );
        })}
      </Stack>
      {editable && (
        <Box>
          <Button variant={drafts.length === 0 ? 'outlined' : 'text'} startIcon={<AddIcon />} onClick={(e) => setMenu(e.currentTarget)} disabled={drafts.length >= MAX_DELIVERIES} aria-haspopup="menu" sx={TAP}>
            Add a delivery
          </Button>
          {drafts.length >= MAX_DELIVERIES && <Typography variant="caption" color="text.secondary" component="p">A task has at most {MAX_DELIVERIES} deliveries.</Typography>}
          <Menu anchorEl={menu} open={Boolean(menu)} onClose={() => setMenu(null)}>
            {KIND_ORDER.map((k) => (
              <MenuItem
                key={k}
                sx={{ minHeight: 44 }}
                onClick={() => {
                  setMenu(null);
                  setEditing({ draft: newDraft(k, { ownAddress: own[0] ?? null, outputs, connections: list }), isNew: true });
                }}
              >
                {KIND_ADD_LABEL[k]}
              </MenuItem>
            ))}
          </Menu>
        </Box>
      )}
      {!canEdit && drafts.length > 0 && <Typography variant="caption" color="text.secondary">You can see these deliveries; changing them needs permission to run tasks.</Typography>}
      <DeliveryEditor
        open={editing !== null}
        draft={editing?.draft ?? null}
        isNew={editing?.isNew ?? true}
        ctx={ctx}
        onClose={() => setEditing(null)}
        onSave={(d) => (editing?.isNew ? add(d) : replace(d))}
      />
      <GuidedSetup
        open={guidedShown}
        onClose={() => setGuidedShown(false)}
        taskName={taskName}
        connections={list}
        ownAddress={own[0] ?? null}
        existingOutputs={outputs}
        onApply={(r) => {
          setGuidedShown(false);
          onGuided(r);
        }}
      />
    </Stack>
  );
}
