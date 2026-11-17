import AddIcon from '@mui/icons-material/Add';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DownloadIcon from '@mui/icons-material/Download';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import UploadIcon from '@mui/icons-material/Upload';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';
import { useRef, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { deletePolicy, duplicatePolicy, exportPolicies, importPolicies, saveFile, setDefaultPolicy } from '../policies/api';
import { budgetSummary, copyName, tierRange, usageText } from '../policies/format';
import { CONFLICT_MODES, type AgentPolicy, type ConflictMode, type ImportResult, type PolicyFile, type PolicyInUseDetails } from '../policies/types';
import { errorText, usePolicyCatalog } from '../policies/usePolicyCatalog';
import { ErrorBanner, PageContainer, PageHeader, useConfirm } from '../ui';

const CONFLICT_LABEL: Record<ConflictMode, string> = {
  rename: 'Keep both: rename the imported one ("Name (2)")',
  skip: 'Skip it: keep mine',
  replace: 'Replace mine with the imported one',
};

/** `/settings/agent-policies`: the built-in policies and the user's own; create, duplicate, edit, default, export, import, delete. */
export function AgentPoliciesPage() {
  const { api, viewer } = usePlatformHost();
  const navigate = useNavigate();
  const canWrite = viewer.hasPermission('agent_policies:write');
  const catalog = usePolicyCatalog({ withTiers: false });
  const { policies, loading } = catalog;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [includePins, setIncludePins] = useState(true);
  const [templateAnchor, setTemplateAnchor] = useState<HTMLElement | null>(null);
  const [rowMenu, setRowMenu] = useState<{ anchor: HTMLElement; policy: AgentPolicy } | null>(null);
  const [duplicating, setDuplicating] = useState<{ policy: AgentPolicy; name: string } | null>(null);
  const confirm = useConfirm();
  const [reassign, setReassign] = useState<{ policy: AgentPolicy; details: PolicyInUseDetails; to: string } | null>(null);
  const [importing, setImporting] = useState<{ file: PolicyFile; fileName: string; onConflict: ConflictMode; result: ImportResult | null; error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const act = async (work: () => Promise<void>, fallback: string) => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setError(errorText(e, fallback));
    } finally {
      setBusy(false);
    }
  };

  const doExport = (ids: 'all' | string[]) =>
    act(async () => {
      saveFile(await exportPolicies(api, ids, includePins));
    }, 'Could not export the policies');

  const doDuplicate = () =>
    act(async () => {
      if (!duplicating) return;
      const copy = await duplicatePolicy(api, duplicating.policy.id, duplicating.name.trim());
      setDuplicating(null);
      navigate(`/settings/agent-policies/${copy.id}`);
    }, 'Could not duplicate the policy');

  const doDelete = (policy: AgentPolicy, reassignTo?: string) =>
    act(async () => {
      try {
        await deletePolicy(api, policy.id, reassignTo);
      } catch (e) {
        if (isPlatformApiError(e) && e.status === 409 && e.code === 'POLICY_IN_USE') {
          const details = (e.details ?? { tasks: [], schedules: [] }) as PolicyInUseDetails;
          const to = catalog.defaultId && catalog.defaultId !== policy.id ? catalog.defaultId : (policies.find((p) => p.id !== policy.id)?.id ?? '');
          setReassign({ policy, details: { tasks: details.tasks ?? [], schedules: details.schedules ?? [] }, to });
          return;
        }
        throw e;
      }
      setReassign(null);
      setNotice(`Deleted "${policy.name}".`);
      await catalog.reload();
    }, 'Could not delete the policy');

  /** Delete asks first; a policy in use then offers to move its tasks and schedules (the reassign dialog). */
  const askDelete = async (policy: AgentPolicy) => {
    const ok = await confirm({
      title: `Delete “${policy.name}”?`,
      body: 'Runs that already used it keep their own copy. This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (ok) await doDelete(policy);
  };

  const doSetDefault = (policy: AgentPolicy) =>
    act(async () => {
      await setDefaultPolicy(api, policy.id);
      setNotice(`"${policy.name}" is now your default policy.`);
      await catalog.reload();
    }, 'Could not set the default policy');

  const pickFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(null);
    try {
      const parsed = JSON.parse(await file.text()) as PolicyFile;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.policies)) throw new Error('not a policy file');
      setImporting({ file: parsed, fileName: file.name, onConflict: 'rename', result: null, error: null });
    } catch {
      setError(`${file.name} is not an agent policy file (a JSON file exported from this page).`);
    }
  };

  const doImport = async () => {
    if (!importing) return;
    setBusy(true);
    try {
      const result = await importPolicies(api, importing.file, importing.onConflict);
      setImporting({ ...importing, result, error: null });
      await catalog.reload();
    } catch (e) {
      const issues =
        isPlatformApiError(e) && e.details && typeof e.details === 'object' && Array.isArray((e.details as { errors?: unknown }).errors)
          ? ((e.details as { errors: ImportResult['errors'] }).errors.map((x) => `#${x.index + 1}${x.name ? ` ${x.name}` : ''}: ${x.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`))
          : [];
      setImporting({ ...importing, error: [errorText(e, 'The import failed'), ...issues].join('\n') });
    } finally {
      setBusy(false);
    }
  };

  const builtins = policies.filter((p) => p.builtin);

  return (
    <PageContainer>
      <PageHeader
        title="Agent policies"
        subtitle="A policy says which models a run uses and how much it may spend. Choose one per task, per schedule, or for a single run with “Run with…”."
      />

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: 2, alignItems: { sm: 'center' }, flexWrap: 'wrap', rowGap: 1 }} aria-label="Policy actions">
        {canWrite && (
          <Button variant="contained" startIcon={<AddIcon />} onClick={(e) => setTemplateAnchor(e.currentTarget)} aria-haspopup="menu">
            New policy
          </Button>
        )}
        {canWrite && (
          <Button variant="outlined" startIcon={<UploadIcon />} onClick={() => fileInput.current?.click()}>
            Import
          </Button>
        )}
        <Button variant="outlined" startIcon={<DownloadIcon />} onClick={() => void doExport('all')} disabled={busy}>
          Export all
        </Button>
        <FormControlLabel control={<Switch checked={includePins} onChange={(e) => setIncludePins(e.target.checked)} />} label="Include model pins" />
        <input ref={fileInput} type="file" accept="application/json,.json" hidden data-testid="import-file" onChange={(e) => void pickFile(e)} />
      </Stack>
      <Menu anchorEl={templateAnchor} open={Boolean(templateAnchor)} onClose={() => setTemplateAnchor(null)}>
        <MenuItem disabled>
          <Typography variant="caption">Start from a built-in</Typography>
        </MenuItem>
        {builtins.map((p) => (
          <MenuItem key={p.id} onClick={() => navigate(`/settings/agent-policies/new?from=${encodeURIComponent(p.id)}`)}>
            <ListItemText primary={p.name} secondary={`${tierRange(p.spec)} · ${budgetSummary(p.spec)}`} />
          </MenuItem>
        ))}
      </Menu>

      <ErrorBanner error={error} onClose={() => setError(null)} />
      <ErrorBanner error={catalog.error} />
      {notice && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      {loading && <CircularProgress aria-label="Loading" />}

      <Stack spacing={1.5} component="ul" aria-label="Policies" sx={{ listStyle: 'none', p: 0, m: 0 }}>
        {policies.map((p) => (
          <Card component="li" key={p.id} variant="outlined" aria-label={`Policy ${p.name}`}>
            <CardContent sx={{ pb: 1 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
                {p.builtin && (
                  <LockOutlinedIcon fontSize="small" color="action" titleAccess="Built-in (read-only)" />
                )}
                <Typography variant="h6" component="h2" sx={{ fontSize: '1.05rem', wordBreak: 'break-word' }}>
                  {p.name}
                </Typography>
                {p.isDefault && <Chip size="small" color="primary" label="Default" />}
                {p.hasNoHardStop && <Chip size="small" color="warning" variant="outlined" label="No hard stop" />}
              </Stack>
              {p.description && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  {p.description}
                </Typography>
              )}
              <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 1 }}>
                <Chip size="small" label={tierRange(p.spec)} aria-label={`Tiers ${tierRange(p.spec)}`} />
                <Chip size="small" label={budgetSummary(p.spec)} />
                <Chip size="small" variant="outlined" label={usageText(p)} />
                <Chip size="small" variant="outlined" label={`v${p.version}`} />
              </Stack>
            </CardContent>
            <CardActions sx={{ flexWrap: 'wrap', px: 2, pb: 1.5 }}>
              <Button size="small" startIcon={p.builtin || !canWrite ? <VisibilityOutlinedIcon /> : <EditOutlinedIcon />} onClick={() => navigate(`/settings/agent-policies/${p.id}`)}>
                {p.builtin || !canWrite ? 'View' : 'Edit'}
              </Button>
              {canWrite && (
                <Button size="small" startIcon={<ContentCopyIcon />} onClick={() => setDuplicating({ policy: p, name: copyName(p.name, policies.map((x) => x.name)) })}>
                  Duplicate
                </Button>
              )}
              <Box sx={{ flex: 1 }} />
              <IconButton size="small" aria-label={`More actions for ${p.name}`} onClick={(e) => setRowMenu({ anchor: e.currentTarget, policy: p })}>
                <MoreVertIcon />
              </IconButton>
            </CardActions>
          </Card>
        ))}
      </Stack>

      <Menu anchorEl={rowMenu?.anchor} open={Boolean(rowMenu)} onClose={() => setRowMenu(null)}>
        {canWrite && (
          <MenuItem
            disabled={rowMenu?.policy.isDefault}
            onClick={() => {
              const p = rowMenu!.policy;
              setRowMenu(null);
              void doSetDefault(p);
            }}
          >
            Set as default
          </MenuItem>
        )}
        <MenuItem
          onClick={() => {
            const p = rowMenu!.policy;
            setRowMenu(null);
            void doExport([p.id]);
          }}
        >
          Export
        </MenuItem>
        {canWrite && !rowMenu?.policy.builtin && (
          <MenuItem
            sx={{ color: 'error.main' }}
            onClick={() => {
              const p = rowMenu!.policy;
              setRowMenu(null);
              void askDelete(p);
            }}
          >
            Delete
          </MenuItem>
        )}
      </Menu>

      {/* Duplicate: name the copy, then edit it. */}
      <Dialog open={Boolean(duplicating)} onClose={() => setDuplicating(null)} fullWidth maxWidth="xs">
        <DialogTitle sx={{ overflowWrap: 'anywhere' }}>Duplicate “{duplicating?.policy.name}”</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label="Name of the copy"
            value={duplicating?.name ?? ''}
            onChange={(e) => duplicating && setDuplicating({ ...duplicating, name: e.target.value })}
            slotProps={{ htmlInput: { maxLength: 100 } }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDuplicating(null)}>Cancel</Button>
          <Button variant="contained" disabled={busy || !duplicating?.name.trim()} onClick={() => void doDuplicate()}>
            Duplicate and edit
          </Button>
        </DialogActions>
      </Dialog>

      {/* In use (409 POLICY_IN_USE): move its tasks and schedules to another policy, then delete. */}
      <Dialog open={Boolean(reassign)} onClose={() => setReassign(null)} fullWidth maxWidth="sm" aria-labelledby="reassign-title">
        <DialogTitle id="reassign-title" sx={{ overflowWrap: 'anywhere' }}>“{reassign?.policy.name}” is in use</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 1 }}>
            {reassign && `It is used by ${reassign.details.tasks.length} ${reassign.details.tasks.length === 1 ? 'task' : 'tasks'} and ${reassign.details.schedules.length} ${reassign.details.schedules.length === 1 ? 'schedule' : 'schedules'}. Choose the policy they use instead, then delete it.`}
          </DialogContentText>
          {reassign && reassign.details.tasks.length > 0 && (
            <List dense disablePadding aria-label="Tasks using it">
              {reassign.details.tasks.slice(0, 8).map((t) => (
                <ListItem key={t.id} disableGutters>
                  <ListItemText primary={t.name} />
                </ListItem>
              ))}
              {reassign.details.tasks.length > 8 && <ListItem disableGutters>…and {reassign.details.tasks.length - 8} more</ListItem>}
            </List>
          )}
          <TextField select fullWidth margin="dense" label="Replacement policy" value={reassign?.to ?? ''} onChange={(e) => reassign && setReassign({ ...reassign, to: e.target.value })}>
            {policies
              .filter((p) => p.id !== reassign?.policy.id)
              .map((p) => (
                <MenuItem key={p.id} value={p.id}>
                  {p.name}
                  {p.isDefault ? ' (default)' : ''}
                </MenuItem>
              ))}
          </TextField>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReassign(null)}>Cancel</Button>
          <Button color="error" variant="contained" disabled={busy || !reassign?.to} onClick={() => reassign && void doDelete(reassign.policy, reassign.to)}>
            Move and delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Import: what the file holds and the conflict mode, then what happened. */}
      <Dialog open={Boolean(importing)} onClose={() => setImporting(null)} fullWidth maxWidth="sm" aria-labelledby="import-title">
        <DialogTitle id="import-title" sx={{ overflowWrap: 'anywhere' }}>{importing?.result ? 'Import finished' : `Import ${importing?.fileName ?? ''}`}</DialogTitle>
        <DialogContent>
          {importing && !importing.result && (
            <>
              <DialogContentText sx={{ overflowWrap: 'anywhere' }}>
                {importing.file.policies.length} {importing.file.policies.length === 1 ? 'policy' : 'policies'}: {importing.file.policies.map((p) => p.name).join(', ')}
              </DialogContentText>
              <TextField
                select
                fullWidth
                margin="normal"
                label="When you already have a policy with the same name"
                value={importing.onConflict}
                onChange={(e) => setImporting({ ...importing, onConflict: e.target.value as ConflictMode })}
              >
                {CONFLICT_MODES.map((m) => (
                  <MenuItem key={m} value={m}>
                    {CONFLICT_LABEL[m]}
                  </MenuItem>
                ))}
              </TextField>
              {importing.error && (
                <Alert severity="error" sx={{ whiteSpace: 'pre-line' }}>
                  {importing.error}
                </Alert>
              )}
            </>
          )}
          {importing?.result && <ImportReport result={importing.result} />}
        </DialogContent>
        <DialogActions>
          {importing?.result ? (
            <Button variant="contained" onClick={() => setImporting(null)}>
              Done
            </Button>
          ) : (
            <>
              <Button onClick={() => setImporting(null)}>Cancel</Button>
              <Button variant="contained" disabled={busy} onClick={() => void doImport()}>
                Import
              </Button>
            </>
          )}
        </DialogActions>
      </Dialog>
    </PageContainer>
  );
}

/** What an import created, replaced, skipped and warned about. */
function ImportReport({ result }: { result: ImportResult }) {
  const rows: { label: string; items: string[] }[] = [
    { label: 'Created', items: result.created.map((c) => (c.renamedFrom ? `${c.name} (renamed from ${c.renamedFrom})` : c.name)) },
    { label: 'Replaced', items: result.replaced.map((r) => `${r.name} (now v${r.version})`) },
    { label: 'Skipped', items: result.skipped.map((s) => `${s.name}: you already have one with this name`) },
  ];
  return (
    <Stack spacing={1.5} aria-label="Import result">
      {rows.map((row) => (
        <Box key={row.label}>
          <Typography variant="subtitle2">
            {row.label}: {row.items.length}
          </Typography>
          {row.items.length > 0 && (
            <Typography variant="body2" color="text.secondary">
              {row.items.join(', ')}
            </Typography>
          )}
        </Box>
      ))}
      {result.warnings.length > 0 && (
        <Alert severity="warning">
          <Typography variant="subtitle2">Warnings</Typography>
          <Box component="ul" sx={{ m: 0, pl: 2 }}>
            {result.warnings.map((w, i) => (
              <li key={i}>
                {w.name}: {w.message}
              </li>
            ))}
          </Box>
        </Alert>
      )}
    </Stack>
  );
}
