import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { isPlatformApiError } from '@marinoscar/platform-web/core';
import { useEffect, useState } from 'react';

import { useBreakpoint } from '../ui';
import { KIND_LABEL, MEMORY_KINDS, type Memory, type MemoryInput, type MemoryKind } from './api';

interface Row {
  name: string;
  value: string;
}

export interface MemoryDialogProps {
  open: boolean;
  /** The memory to edit; null adds a new one. */
  memory: Memory | null;
  onClose: () => void;
  /** Saves; a rejected promise's API error is shown in the dialog (a secret check under its field). */
  onSave: (input: MemoryInput) => Promise<void>;
}

interface FieldIssue {
  field: string;
  message: string;
}

/** The fields a `MEMORY_HOLDS_SECRET` refusal names, by field. */
function issuesOf(e: unknown): FieldIssue[] {
  if (!isPlatformApiError(e) || e.code !== 'MEMORY_HOLDS_SECRET') return [];
  const issues = (e.details as { issues?: FieldIssue[] } | undefined)?.issues;
  return Array.isArray(issues) ? issues : [];
}

const blankRow = (): Row => ({ name: '', value: '' });

/** Add or edit a memory: kind, label, aliases, named values and a note. Full screen below `sm`. */
export function MemoryDialog({ open, memory, onClose, onSave }: MemoryDialogProps) {
  const { isPhone } = useBreakpoint();
  const [kind, setKind] = useState<MemoryKind>('person');
  const [label, setLabel] = useState('');
  const [aliases, setAliases] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([blankRow()]);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<FieldIssue[]>([]);

  useEffect(() => {
    if (!open) return;
    setKind(memory?.kind ?? 'person');
    setLabel(memory?.label ?? '');
    setAliases(memory?.aliases ?? []);
    const existing = Object.entries(memory?.attributes ?? {}).map(([name, value]) => ({ name, value }));
    setRows(existing.length ? existing : [blankRow()]);
    setNote(memory?.note ?? '');
    setError(null);
    setIssues([]);
  }, [open, memory]);

  const issueFor = (field: string) => issues.find((i) => i.field === field)?.message;
  const setRow = (index: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  const filled = rows.filter((r) => r.name.trim() || r.value.trim());
  const rowError = filled.some((r) => !r.name.trim() || !r.value.trim());
  const canSave = label.trim().length > 0 && !rowError && !saving;

  const save = async () => {
    setSaving(true);
    setError(null);
    setIssues([]);
    try {
      await onSave({
        kind,
        label: label.trim(),
        aliases,
        attributes: Object.fromEntries(filled.map((r) => [r.name.trim(), r.value.trim()])),
        note: note.trim() ? note.trim() : null,
      });
    } catch (e) {
      const found = issuesOf(e);
      setIssues(found);
      setError(found.length ? null : e instanceof Error ? e.message : 'Could not save the memory');
    } finally {
      setSaving(false);
    }
  };

  const titleId = 'memory-dialog-title';
  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm" fullScreen={isPhone} aria-labelledby={titleId}>
      <DialogTitle id={titleId}>{memory ? 'Edit memory' : 'Add a memory'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField select label="Kind" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)} fullWidth>
            {MEMORY_KINDS.map((k) => (
              <MenuItem key={k} value={k}>
                {KIND_LABEL[k]}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            label="Label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            required
            fullWidth
            slotProps={{ htmlInput: { maxLength: 120 } }}
            helperText={issueFor('label') ?? 'What you call it, for example "My wife" or "Checking account".'}
            error={Boolean(issueFor('label'))}
          />
          <Autocomplete
            multiple
            freeSolo
            options={[] as string[]}
            value={aliases}
            onChange={(_e, value) => setAliases(value.map((v) => v.trim().toLowerCase()).filter(Boolean).slice(0, 10))}
            renderValue={(value, getItemProps) =>
              value.map((option, index) => {
                const { key, ...props } = getItemProps({ index });
                return <Chip key={key} label={option} size="small" {...props} />;
              })
            }
            renderInput={(params) => <TextField {...params} label="Other words for it" helperText={issueFor('aliases') ?? 'Press Enter after each one: "wife", a first name.'} error={Boolean(issueFor('aliases'))} />}
          />
          <Box>
            <Typography variant="subtitle2" component="h3" sx={{ mb: 1 }}>
              Details
            </Typography>
            <Stack spacing={1.5}>
              {rows.map((row, index) => {
                const issue = issueFor(row.name.trim());
                return (
                  <Stack key={index} direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'flex-start' } }}>
                    <TextField label="Name" size="small" value={row.name} onChange={(e) => setRow(index, { name: e.target.value })} sx={{ flex: 1 }} slotProps={{ htmlInput: { maxLength: 60, 'aria-label': `Detail ${index + 1} name` } }} />
                    <TextField
                      label="Value"
                      size="small"
                      value={row.value}
                      onChange={(e) => setRow(index, { value: e.target.value })}
                      sx={{ flex: 2 }}
                      error={Boolean(issue)}
                      helperText={issue}
                      slotProps={{ htmlInput: { maxLength: 500, 'aria-label': `Detail ${index + 1} value` } }}
                    />
                    <IconButton aria-label={`Remove detail ${index + 1}`} onClick={() => setRows((rs) => (rs.length === 1 ? [blankRow()] : rs.filter((_r, i) => i !== index)))} sx={{ alignSelf: { xs: 'flex-end', sm: 'center' } }}>
                      <CloseIcon />
                    </IconButton>
                  </Stack>
                );
              })}
            </Stack>
            <Button startIcon={<AddIcon />} onClick={() => setRows((rs) => [...rs, blankRow()])} disabled={rows.length >= 20} sx={{ mt: 1 }}>
              Add a detail
            </Button>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              Never a password, a code or a full card or account number: keep the last four digits ("ending 0659").
            </Typography>
          </Box>
          <TextField
            label="Note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            multiline
            minRows={2}
            fullWidth
            slotProps={{ htmlInput: { maxLength: 1000 } }}
            error={Boolean(issueFor('note'))}
            helperText={issueFor('note')}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void save()} disabled={!canSave}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
