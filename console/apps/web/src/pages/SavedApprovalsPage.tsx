import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import VerifiedUserOutlinedIcon from '@mui/icons-material/VerifiedUserOutlined';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Link,
  ListItemIcon,
  Menu,
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useLocation } from 'react-router-dom';

import {
  AMOUNT_CATEGORIES,
  RISKY_CATEGORIES,
  categoryLabel,
  groupBySite,
  limitPatch,
  limitsText,
  toLimitDraft,
  usesText,
  type ApprovalRule,
  type ApprovalRulesList,
  type LimitDraft,
} from '../approvals/types';
import { EmptyState, ErrorBanner, ListSkeleton, PageContainer, PageHeader, RelativeTime, formatDateTime, useApiAction, useBreakpoint, useConfirm, useProfileTimeZone } from '../ui';


interface TaskOption {
  id: string;
  name: string;
}

/** The "Add a limit" dialog: set or tighten an amount, an end date or a task. Never loosens. */
function LimitDialog({ rule, onClose, onSaved }: { rule: ApprovalRule; onClose: () => void; onSaved: (r: ApprovalRule) => void }) {
  const { api } = usePlatformHost();
  const { isPhone } = useBreakpoint();
  const [draft, setDraft] = useState<LimitDraft>(() => toLimitDraft(rule));
  const [tasks, setTasks] = useState<TaskOption[]>([]);
  const [error, setError] = useState<{ field: keyof LimitDraft | null; message: string } | null>(null);
  const action = useApiAction('Could not save the limit');

  useEffect(() => {
    let live = true;
    api
      .get<TaskOption[] | { items?: TaskOption[] }>('/tasks')
      .then((r) => {
        if (live) setTasks((Array.isArray(r) ? r : (r.items ?? [])).map((t) => ({ id: t.id, name: t.name })));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api]);

  const save = async () => {
    const out = limitPatch(rule, draft);
    if ('error' in out) {
      setError({ field: out.field, message: out.error });
      return;
    }
    if (Object.keys(out.patch).length === 0) {
      onClose();
      return;
    }
    setError(null);
    const saved = await action.run('save', () => api.patch<ApprovalRule>(`/approval-rules/${rule.id}`, out.patch));
    if (saved) onSaved(saved);
  };
  const fieldError = (f: keyof LimitDraft) => (error?.field === f ? error.message : undefined);

  return (
    <Dialog open onClose={onClose} fullScreen={isPhone} fullWidth maxWidth="sm" aria-labelledby="limit-title">
      <DialogTitle id="limit-title">Add a limit</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            {rule.summary}. Limits can be tightened here, never loosened. For a looser rule, answer a new request and tick &ldquo;Don&rsquo;t ask again&rdquo;.
          </Typography>
          {(rule.kind === 'gate' && AMOUNT_CATEGORIES.includes(rule.category ?? '')) || rule.maxAmount !== null ? (
            <TextField
              label="Up to an amount (USD)"
              value={draft.maxAmount}
              onChange={(e) => setDraft({ ...draft, maxAmount: e.target.value })}
              slotProps={{ htmlInput: { inputMode: 'decimal' } }}
              helperText={fieldError('maxAmount') ?? 'The step goes ahead only when the amount is known and not larger.'}
              error={Boolean(fieldError('maxAmount'))}
            />
          ) : null}
          <TextField
            label="Until"
            type="date"
            value={draft.expiresOn}
            onChange={(e) => setDraft({ ...draft, expiresOn: e.target.value })}
            slotProps={{ inputLabel: { shrink: true } }}
            helperText={fieldError('expiresOn') ?? 'After this day, the agent asks again.'}
            error={Boolean(fieldError('expiresOn'))}
          />
          <TextField
            select
            label="Only in a task"
            value={draft.taskId}
            onChange={(e) => setDraft({ ...draft, taskId: e.target.value })}
            disabled={Boolean(rule.taskId)}
            helperText={fieldError('taskId') ?? (rule.taskId ? 'Already limited to this task.' : 'Leave empty for every task and chat.')}
            error={Boolean(fieldError('taskId'))}
            slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
          >
            <option value="">Every task and chat</option>
            {rule.taskId && !tasks.some((t) => t.id === rule.taskId) && <option value={rule.taskId}>{rule.taskName ?? 'This task'}</option>}
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </TextField>
          {action.error && <Alert severity="error">{action.error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={() => void save()} disabled={action.busy !== null}>
          Save limit
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** One rule: the summary, the category, the limits, its use, its switch and its menu. */
function RuleRow({ rule, canWrite, busy, onToggle, onLimit, onDelete }: { rule: ApprovalRule; canWrite: boolean; busy: boolean; onToggle: (on: boolean) => void; onLimit: () => void; onDelete: () => void }) {
  const timeZone = useProfileTimeZone();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const risky = rule.kind === 'gate' && RISKY_CATEGORIES.includes(rule.category ?? '');
  return (
    <Paper variant="outlined" id={`rule-${rule.id}`} data-testid={`rule-${rule.id}`} sx={{ p: 1.5, display: 'flex', alignItems: 'flex-start', gap: 1, minWidth: 0, opacity: rule.enabled ? 1 : 0.7 }}>
      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
          <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{rule.summary}</Typography>
          <Chip size="small" variant="outlined" color={risky ? 'warning' : 'default'} label={categoryLabel(rule)} data-testid={`category-${rule.id}`} />
          {!rule.enabled && <Chip size="small" label="Off" />}
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          {limitsText(rule, (iso) => formatDateTime(iso, { dateStyle: 'medium', timeZone }))}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {usesText(rule)}
          {rule.lastUsedAt && (
            <>
              , last{' '}
              {rule.lastUsedRunId ? (
                <Link component={RouterLink} to={`/runs/${rule.lastUsedRunId}`}>
                  <RelativeTime iso={rule.lastUsedAt} />
                </Link>
              ) : (
                <RelativeTime iso={rule.lastUsedAt} />
              )}
            </>
          )}
        </Typography>
      </Box>
      {canWrite ? (
        <>
          <FormControlLabel
            sx={{ m: 0 }}
            label=""
            control={<Switch checked={rule.enabled} disabled={busy} onChange={(e) => onToggle(e.target.checked)} slotProps={{ input: { 'aria-label': `${rule.enabled ? 'Turn off' : 'Turn on'}: ${rule.summary}` } }} />}
          />
          <IconButton aria-label={`More for ${rule.summary}`} onClick={(e) => setAnchor(e.currentTarget)} sx={{ minWidth: 44, minHeight: 44 }}>
            <MoreVertIcon />
          </IconButton>
          <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)}>
            <MenuItem
              onClick={() => {
                setAnchor(null);
                onLimit();
              }}
            >
              <ListItemIcon>
                <TuneOutlinedIcon fontSize="small" />
              </ListItemIcon>
              Add a limit
            </MenuItem>
            <MenuItem
              onClick={() => {
                setAnchor(null);
                onDelete();
              }}
              sx={{ color: 'error.main' }}
            >
              <ListItemIcon>
                <DeleteOutlineIcon fontSize="small" color="error" />
              </ListItemIcon>
              Delete
            </MenuItem>
          </Menu>
        </>
      ) : null}
    </Paper>
  );
}

/**
 * `/settings/approvals` (#554): the steps the owner told the agent not to ask
 * about again, grouped by site: what each allows, its limits, how often it was
 * used, and a switch. "Pause all" turns every rule off. Rules are made only by
 * ticking "Don't ask again" on a request (#555); this page can narrow, turn off
 * and delete them, never create or loosen one.
 */
export function SavedApprovalsPage() {
  const { api, viewer } = usePlatformHost();
  const confirm = useConfirm();
  const canWrite = viewer.hasPermission('approvals:write');
  const [list, setList] = useState<ApprovalRulesList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [limiting, setLimiting] = useState<ApprovalRule | null>(null);
  const action = useApiAction('Could not change the saved approval');

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setList(await api.get<ApprovalRulesList>('/approval-rules'));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load your saved approvals');
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  // A run step links here as `#rule-<id>` (#555): bring that rule into view once the list is in.
  const { hash } = useLocation();
  useEffect(() => {
    if (!list || !hash.startsWith('#rule-')) return;
    const el = document.getElementById(hash.slice(1));
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
  }, [list, hash]);

  const replace = (r: ApprovalRule) => setList((l) => (l ? { ...l, rules: l.rules.map((x) => (x.id === r.id ? r : x)) } : l));

  const toggle = (r: ApprovalRule, enabled: boolean) =>
    void action.run(r.id, async () => {
      replace(await api.patch<ApprovalRule>(`/approval-rules/${r.id}`, { enabled }));
    });

  const remove = async (r: ApprovalRule) => {
    const ok = await confirm({
      title: 'Delete this saved approval?',
      body: `${r.summary}. The agent will ask you again the next time it reaches this step.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    await action.run(r.id, async () => {
      await api.delete(`/approval-rules/${r.id}`);
      setList((l) => (l ? { ...l, rules: l.rules.filter((x) => x.id !== r.id) } : l));
    });
  };

  const setPaused = (paused: boolean) =>
    void action.run('paused', async () => {
      const res = await api.put<{ paused: boolean }>('/approval-rules/paused', { paused });
      setList((l) => (l ? { ...l, paused: res.paused } : l));
    });

  const pauseSwitch =
    list && canWrite ? (
      <FormControlLabel
        sx={{ m: 0 }}
        control={<Switch checked={list.paused} disabled={action.busy === 'paused'} onChange={(e) => setPaused(e.target.checked)} slotProps={{ input: { 'aria-label': 'Pause all saved approvals' } }} />}
        label="Pause all"
      />
    ) : null;

  return (
    <PageContainer>
      <PageHeader title="Saved approvals" subtitle="Steps you told the agent not to ask about again. You can stop any of them here." back={{ to: '/settings', label: 'Settings' }}>
        {pauseSwitch}
      </PageHeader>
      <ErrorBanner error={loadError ?? action.error} onRetry={loadError ? () => void load() : undefined} onClose={loadError ? undefined : action.clearError} />
      {list?.paused && (
        <Alert severity="warning" sx={{ mb: 2 }} data-testid="paused-banner">
          All saved approvals are paused. The agent asks before every step, as if none existed, until you turn this off.
        </Alert>
      )}
      {list === null && !loadError && <ListSkeleton rows={3} />}
      {list !== null && list.rules.length === 0 && (
        <EmptyState
          Icon={VerifiedUserOutlinedIcon}
          title="No saved approvals"
          body={
            <>
              When the agent asks before a step, such as pressing &ldquo;Pay&rdquo; or choosing a date, tick &ldquo;Don&rsquo;t ask again&rdquo; on the request. The next time it reaches the same step on the same site, it goes ahead and the run records it. Every saved approval shows up here, where you can limit, turn off or delete it.
            </>
          }
        />
      )}
      {list !== null && list.rules.length > 0 && (
        <Stack spacing={3}>
          {groupBySite(list.rules).map((g) => (
            <Box key={g.host} component="section" aria-labelledby={`site-${g.host}`}>
              <Typography id={`site-${g.host}`} variant="h6" component="h2" sx={{ mb: 1, overflowWrap: 'anywhere' }}>
                {g.host}
              </Typography>
              <Stack spacing={1}>
                {g.rules.map((r) => (
                  <RuleRow key={r.id} rule={r} canWrite={canWrite} busy={action.busy === r.id} onToggle={(on) => toggle(r, on)} onLimit={() => setLimiting(r)} onDelete={() => void remove(r)} />
                ))}
              </Stack>
            </Box>
          ))}
        </Stack>
      )}
      <Typography variant="body2" color="text.secondary" sx={{ mt: 3 }}>
        A saved approval applies only on its site and only to the exact button or kind of question you approved. It never applies to a password, a code or a sign-in. An AI app whose limits say &ldquo;confirm purchases&rdquo; is always asked at a payment, whatever is saved here.
      </Typography>
      {limiting && (
        <LimitDialog
          rule={limiting}
          onClose={() => setLimiting(null)}
          onSaved={(r) => {
            replace(r);
            setLimiting(null);
          }}
        />
      )}
    </PageContainer>
  );
}
