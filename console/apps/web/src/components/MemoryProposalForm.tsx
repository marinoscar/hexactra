import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import { Box, Button, IconButton, Stack, TextField, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useEffect, useState, type FormEvent } from 'react';

import type { AnswerBody, MemoryProposal } from './questions';

/** One action button: full width and 44 px tall on a phone, its own width from `sm` up. */
const ACTION_SX = { width: { xs: '100%', sm: 'auto' }, minHeight: { xs: 44, sm: 'auto' } } as const;
const WRAP = { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 } as const;

export const MEMORY_SAVED_HINT = 'Saved to your Memories. You can change or delete it there.';

interface Row {
  key: string;
  value: string;
}

export interface MemoryProposalFormProps {
  proposal: MemoryProposal;
  /** Sends the answer: Save (the memory as edited here) or Not now (`cancelled`). */
  onSubmit: (answer: AnswerBody) => void | Promise<void>;
  disabled?: boolean;
  busy?: boolean;
}

/**
 * The card of a memory the agent proposes (#553): the label and each value as
 * editable fields (the owner may correct them before saving), for a changed
 * value the current and the new value side by side, then Save and Not now.
 * Every value is plain text; nothing is saved until Save is pressed.
 */
export function MemoryProposalForm({ proposal, onSubmit, disabled: off, busy = false }: MemoryProposalFormProps) {
  const { api } = usePlatformHost();
  const disabled = Boolean(off) || busy;
  const [label, setLabel] = useState(proposal.label);
  const [rows, setRows] = useState<Row[]>(() => Object.entries(proposal.attributes).map(([key, value]) => ({ key, value })));
  const [current, setCurrent] = useState<Record<string, string> | null>(null);

  // A changed value: show what is remembered now next to the new value.
  useEffect(() => {
    if (!proposal.supersedes) return;
    let live = true;
    api
      .get<{ attributes: Record<string, string> }>(`/memories/${encodeURIComponent(proposal.supersedes)}`)
      .then((m) => live && setCurrent(m.attributes))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, proposal.supersedes]);

  const filled = rows.filter((r) => r.key.trim() && r.value.trim());
  const keys = filled.map((r) => r.key.trim());
  const duplicate = new Set(keys).size !== keys.length;
  const valid = label.trim().length > 0 && filled.length > 0 && filled.length <= 20 && !duplicate;

  const save = (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid || disabled) return;
    void onSubmit({
      outcome: 'completed',
      memory: { kind: proposal.kind, label: label.trim(), aliases: proposal.aliases, attributes: Object.fromEntries(filled.map((r) => [r.key.trim(), r.value.trim()])) },
    });
  };
  const setRow = (i: number, patch: Partial<Row>) => setRows((all) => all.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Box component="form" onSubmit={save} noValidate aria-label="Suggested memory" sx={{ mt: 1.5, minWidth: 0 }}>
      <TextField label="Name it" value={label} onChange={(e) => setLabel(e.target.value)} disabled={disabled} fullWidth size="small" required slotProps={{ htmlInput: { maxLength: 120 }, inputLabel: { shrink: true } }} sx={{ mb: 1.5 }} />
      <Stack spacing={1.25} role="group" aria-label="Details">
        {rows.map((r, i) => (
          <Box key={i} sx={{ minWidth: 0 }}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'flex-start' } }}>
              <TextField label="Detail" value={r.key} onChange={(e) => setRow(i, { key: e.target.value })} disabled={disabled} size="small" slotProps={{ htmlInput: { maxLength: 60 }, inputLabel: { shrink: true } }} sx={{ width: { xs: '100%', sm: 140 }, flexShrink: 0 }} />
              <Stack direction="row" spacing={0.5} sx={{ flex: 1, minWidth: 0, alignItems: 'flex-start' }}>
                <TextField label="Value" value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} disabled={disabled} size="small" fullWidth slotProps={{ htmlInput: { maxLength: 500 }, inputLabel: { shrink: true } }} />
                <IconButton aria-label={`Remove ${r.key || 'this detail'}`} onClick={() => setRows((all) => all.filter((_, j) => j !== i))} disabled={disabled || rows.length <= 1} sx={{ width: 44, height: 44 }}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Stack>
            </Stack>
            {current && current[r.key] !== undefined && current[r.key] !== r.value && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25, ...WRAP }} data-testid="memory-current">
                Now remembered: {current[r.key]} → new: {r.value}
              </Typography>
            )}
          </Box>
        ))}
      </Stack>
      <Button size="small" startIcon={<AddIcon />} onClick={() => setRows((all) => [...all, { key: '', value: '' }])} disabled={disabled || rows.length >= 20} sx={{ mt: 1, minHeight: { xs: 44, sm: 'auto' } }}>
        Add a detail
      </Button>
      {duplicate && (
        <Typography variant="caption" color="error" role="alert" sx={{ display: 'block' }}>
          Each detail needs its own name.
        </Typography>
      )}
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5, ...WRAP }}>
        {MEMORY_SAVED_HINT}
      </Typography>
      <Stack direction={{ xs: 'column-reverse', sm: 'row' }} spacing={1} sx={{ mt: 1.5, justifyContent: 'flex-end' }}>
        <Button onClick={() => void onSubmit({ outcome: 'cancelled' })} disabled={disabled} sx={ACTION_SX}>
          Not now
        </Button>
        <Button type="submit" variant="contained" disabled={!valid || disabled} sx={ACTION_SX}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </Stack>
    </Box>
  );
}
