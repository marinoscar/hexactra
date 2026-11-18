import AddIcon from '@mui/icons-material/Add';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import PsychologyOutlinedIcon from '@mui/icons-material/PsychologyOutlined';
import {
  Box,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Button,
  FormControlLabel,
  IconButton,
  Link,
  List,
  ListItem,
  Menu,
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import {
  KIND_GROUP,
  MEMORY_KINDS,
  createMemory,
  deleteMemory,
  displayValue,
  exportMemories,
  getMemory,
  listMemories,
  matchesSearch,
  saveMemory,
  setArchived,
  type Memory,
  type MemoryInput,
  type MemoryKind,
} from '../memories/api';
import { MemoryDialog } from '../memories/MemoryDialog';
import { saveFile } from '../policies/api';
import { EmptyState, ErrorBanner, ListSkeleton, PageContainer, PageHeader, RelativeTime, toast, useApiAction, useBreakpoint, useConfirm } from '../ui';

const SUBTITLE = 'Facts you let the agent use. It never saves one without asking you.';

/** Where a memory came from, with a link to the chat or run while it exists. */
function SourceLine({ memory }: { memory: Memory }) {
  if (memory.source === 'owner') return <>Added by you</>;
  const to = memory.sourceConversationId ? `/chat/${memory.sourceConversationId}` : memory.sourceRunId ? `/runs/${memory.sourceRunId}` : null;
  return (
    <>
      Suggested by the agent, approved by you
      {to && (
        <>
          {' · '}
          <Link component={RouterLink} to={to}>
            {memory.sourceConversationId ? 'the chat' : 'the run'}
          </Link>
        </>
      )}
    </>
  );
}

function AttributeChips({ attributes }: { attributes: Record<string, string> }) {
  const entries = Object.entries(attributes);
  if (entries.length === 0) return null;
  return (
    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', mt: 0.5 }}>
      {entries.map(([name, value]) => (
        <Chip key={name} size="small" variant="outlined" label={`${name}: ${displayValue(value)}`} sx={{ maxWidth: '100%' }} />
      ))}
    </Stack>
  );
}

interface RowProps {
  memory: Memory;
  canWrite: boolean;
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onHistory: () => void;
}

function MemoryRow({ memory, canWrite, onEdit, onArchive, onDelete, onHistory }: RowProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = () => setAnchor(null);
  const pick = (fn: () => void) => () => {
    close();
    fn();
  };
  return (
    <ListItem
      aria-label={`Memory ${memory.label}`}
      divider
      sx={{ alignItems: 'flex-start', pr: 7 }}
      secondaryAction={
        <IconButton aria-label={`Actions for ${memory.label}`} onClick={(e) => setAnchor(e.currentTarget)} sx={{ minWidth: 44, minHeight: 44 }}>
          <MoreVertIcon />
        </IconButton>
      }
    >
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography component="span" sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>
            {memory.label}
          </Typography>
          {memory.status === 'archived' && <Chip size="small" label="Archived" />}
        </Stack>
        {memory.aliases.length > 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            Also: {memory.aliases.join(', ')}
          </Typography>
        )}
        <AttributeChips attributes={memory.attributes} />
        {memory.note && (
          <Typography variant="body2" sx={{ mt: 0.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {memory.note}
          </Typography>
        )}
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
          <SourceLine memory={memory} />
          {' · '}
          {memory.lastUsedAt ? <RelativeTime iso={memory.lastUsedAt} prefix="last used " /> : 'not used yet'}
        </Typography>
      </Box>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={close}>
        {canWrite && <MenuItem onClick={pick(onEdit)}>Edit</MenuItem>}
        {canWrite && <MenuItem onClick={pick(onArchive)}>{memory.status === 'archived' ? 'Unarchive' : 'Archive'}</MenuItem>}
        {canWrite && (
          <MenuItem onClick={pick(onDelete)} sx={{ color: 'error.main' }}>
            Delete
          </MenuItem>
        )}
        <MenuItem onClick={pick(onHistory)}>View history</MenuItem>
      </Menu>
    </ListItem>
  );
}

function HistoryDialog({ memory, onClose }: { memory: Memory | null; onClose: () => void }) {
  const { isPhone } = useBreakpoint();
  const versions = memory ? [memory, ...(memory.history ?? [])] : [];
  return (
    <Dialog open={memory !== null} onClose={onClose} fullWidth maxWidth="sm" fullScreen={isPhone} aria-labelledby="memory-history-title">
      <DialogTitle id="memory-history-title">History of {memory?.label}</DialogTitle>
      <DialogContent>
        {versions.length <= 1 && <Typography color="text.secondary">This memory has not changed since it was saved.</Typography>}
        <List aria-label="Versions">
          {versions.map((v, i) => (
            <ListItem key={v.id} divider sx={{ display: 'block' }}>
              <Typography variant="body2" color="text.secondary">
                {i === 0 ? 'Current' : 'Earlier'} · saved <RelativeTime iso={v.createdAt} />
              </Typography>
              <AttributeChips attributes={v.attributes} />
            </ListItem>
          ))}
        </List>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * `/settings/memories` (#551): the facts the owner lets the agent use, grouped
 * by kind, with search, a kind filter and archived ones on request. Every
 * value is rendered as plain text. Writes need `memories:write`.
 */
export function MemoriesPage() {
  const { api, viewer } = usePlatformHost();
  const confirm = useConfirm();
  const action = useApiAction();
  const canWrite = viewer.hasPermission('memories:write');
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<MemoryKind | 'all'>('all');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Memory | null | 'new'>(null);
  const [history, setHistory] = useState<Memory | null>(null);

  const load = useCallback(async () => {
    try {
      setMemories(await listMemories(api, showArchived));
    } catch (e) {
      action.setError(e instanceof Error ? e.message : 'Could not load your memories');
      setMemories([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, showArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () => (memories ?? []).filter((m) => m.status !== 'superseded' && (kind === 'all' || m.kind === kind) && matchesSearch(m, search)),
    [memories, kind, search],
  );
  const groups = MEMORY_KINDS.map((k) => ({ kind: k, items: visible.filter((m) => m.kind === k) })).filter((g) => g.items.length > 0);

  const save = async (input: MemoryInput) => {
    // Errors propagate to the dialog, which shows a secret refusal under its field.
    if (editing === 'new') await createMemory(api, input);
    else if (editing) await saveMemory(api, editing, input);
    setEditing(null);
    toast('Memory saved');
    await load();
  };

  const remove = async (m: Memory) => {
    const ok = await confirm({ title: 'Delete this memory?', body: 'The agent will ask you for it again when it needs it.', confirmLabel: 'Delete', destructive: true });
    if (!ok) return;
    await action.run('delete', () => deleteMemory(api, m.id), 'Could not delete the memory');
    await load();
  };

  const toggleArchive = async (m: Memory) => {
    await action.run('archive', () => setArchived(api, m.id, m.status !== 'archived'), 'Could not change the memory');
    await load();
  };

  const openHistory = async (m: Memory) => {
    const full = await action.run('history', () => getMemory(api, m.id), 'Could not load the history');
    if (full) setHistory(full);
  };

  const download = async () => {
    const file = await action.run('export', () => exportMemories(api), 'Could not export your memories');
    if (file) saveFile(file);
  };

  const isEmpty = memories !== null && memories.filter((m) => m.status !== 'superseded').length === 0;

  return (
    <PageContainer width="narrow">
      <PageHeader
        title="Memories"
        subtitle={SUBTITLE}
        back={{ to: '/settings', label: 'Settings' }}
        primary={{ key: 'add', label: 'Add', Icon: AddIcon, onClick: () => setEditing('new'), hidden: !canWrite }}
        actions={[{ key: 'export', label: 'Export', Icon: DownloadOutlinedIcon, onClick: () => void download(), hidden: isEmpty }]}
      />
      <ErrorBanner error={action.error} />
      {memories === null && <ListSkeleton />}
      {isEmpty && !showArchived && (
        <EmptyState
          Icon={PsychologyOutlinedIcon}
          title="No memories yet"
          body={
            <>
              A memory is a fact the agent may use, so it does not have to ask you each time. For example: <q>My wife: her name and the phone she uses for Zelle</q>, or <q>Checking account: the bank and the last four digits</q>.
            </>
          }
          action={{ key: 'add', label: 'Add a memory', Icon: AddIcon, onClick: () => setEditing('new'), hidden: !canWrite }}
        />
      )}
      {memories !== null && (!isEmpty || showArchived) && (
        <Stack spacing={2}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ alignItems: { sm: 'center' } }}>
            <TextField label="Search" size="small" value={search} onChange={(e) => setSearch(e.target.value)} sx={{ flex: 1 }} type="search" />
            <TextField select label="Kind" size="small" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind | 'all')} sx={{ minWidth: 160 }}>
              <MenuItem value="all">All kinds</MenuItem>
              {MEMORY_KINDS.map((k) => (
                <MenuItem key={k} value={k}>
                  {KIND_GROUP[k]}
                </MenuItem>
              ))}
            </TextField>
            <FormControlLabel control={<Switch checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />} label="Show archived" />
          </Stack>
          {groups.length === 0 && <Typography color="text.secondary">No memory matches.</Typography>}
          {groups.map((g) => (
            <Box key={g.kind} component="section" aria-labelledby={`memories-${g.kind}`}>
              <Typography id={`memories-${g.kind}`} variant="h6" component="h2" sx={{ mb: 1 }}>
                {KIND_GROUP[g.kind]}
              </Typography>
              <Paper variant="outlined">
                <List disablePadding aria-label={KIND_GROUP[g.kind]}>
                  {g.items.map((m) => (
                    <MemoryRow
                      key={m.id}
                      memory={m}
                      canWrite={canWrite}
                      onEdit={() => setEditing(m)}
                      onArchive={() => void toggleArchive(m)}
                      onDelete={() => void remove(m)}
                      onHistory={() => void openHistory(m)}
                    />
                  ))}
                </List>
              </Paper>
            </Box>
          ))}
        </Stack>
      )}
      <MemoryDialog open={editing !== null} memory={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSave={save} />
      <HistoryDialog memory={history} onClose={() => setHistory(null)} />
    </PageContainer>
  );
}
