// A write-only key field (E50.5; E50.14, #984): a password field that is never pre-filled and never autofilled, emptied after Save (and
// gone with the page). A stored key is said in words ("Key saved on 26 Nov 2026"), never shown, not even in part. The value never goes
// into storage, the address or a toast.
import { Button, Stack, TextField, Typography } from '@mui/material';
import { useState } from 'react';

import { formatDateTime } from '../ui';

export interface KeyFieldProps {
  label: string;
  /** A key is stored at this tier. */
  hasKey: boolean;
  /** When it was stored. */
  setAt?: string | null;
  /** Where it is kept, in a sentence. */
  kept?: string;
  busy: boolean;
  disabled?: boolean;
  onSave: (value: string) => Promise<boolean>;
  onRemove: () => Promise<void>;
}

export function KeyField({ label, hasKey, setAt, kept, busy, disabled, onSave, onRemove }: KeyFieldProps) {
  const [value, setValue] = useState('');
  // The value lives in this component's state only: emptied on Save, gone when the page goes.
  return (
    <Stack spacing={1}>
      {hasKey && (
        <Typography variant="body2" data-testid="key-saved">
          {setAt ? `Key saved on ${formatDateTime(setAt, { dateStyle: 'medium' })}.` : 'A key is saved.'} Type a new one to replace it.
        </Typography>
      )}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'flex-start' } }}>
        <TextField
          size="small"
          type="password"
          label={label}
          value={value}
          disabled={disabled || busy}
          helperText={kept ?? 'Write-only: it is never shown again.'}
          onChange={(e) => setValue(e.target.value)}
          slotProps={{ htmlInput: { autoComplete: 'new-password', spellCheck: false, 'data-lpignore': 'true', 'data-1p-ignore': 'true', name: 'hx-write-only-key' } }}
          sx={{ flex: 1 }}
        />
        <Button
          variant="contained"
          sx={{ minHeight: 40 }}
          disabled={disabled || busy || value.trim().length === 0}
          onClick={async () => {
            const v = value.trim();
            setValue('');
            await onSave(v);
          }}
        >
          Save key
        </Button>
        {hasKey && (
          <Button sx={{ minHeight: 40 }} color="error" disabled={disabled || busy} onClick={() => void onRemove()}>
            Remove
          </Button>
        )}
      </Stack>
    </Stack>
  );
}
