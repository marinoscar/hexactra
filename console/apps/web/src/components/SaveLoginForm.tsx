import { Box, Button, Stack, TextField, Typography } from '@mui/material';
import { useState, type FormEvent } from 'react';

import type { AnswerBody, SaveLoginCard } from './questions';

/** One action button: full width and 44 px tall on a phone, its own width from `sm` up. */
const ACTION_SX = { width: { xs: '100%', sm: 'auto' }, minHeight: { xs: 44, sm: 'auto' } } as const;
const WRAP = { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 } as const;

/** The longest name a saved login may have (the API's and the vault's limit). */
export const SAVE_LOGIN_NAME_MAX = 200;

export interface SaveLoginFormProps {
  card: SaveLoginCard;
  /** Sends the answer: Save (the name as edited here), Not now (`cancelled`) or Never for this site (`cancelled` with `neverForSite`). */
  onSubmit: (answer: AnswerBody) => void | Promise<void>;
  disabled?: boolean;
  busy?: boolean;
}

/**
 * The card of "Save this login?" (E37.4b): after the owner signed in by hand, the agent offers to save that sign-in in their vault so
 * the next run does not ask. It shows the site and the username, an editable name, and says what the password is without showing it:
 * "the one you just typed". The password is not in the browser at all (the fabric holds it and sends it to the vault when Save is
 * pressed). Nothing is saved until Save is pressed.
 */
export function SaveLoginForm({ card, onSubmit, disabled: off, busy = false }: SaveLoginFormProps) {
  const disabled = Boolean(off) || busy;
  const [name, setName] = useState(card.name);
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= SAVE_LOGIN_NAME_MAX && !/[\r\n]/.test(name);

  const save = (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid || disabled) return;
    void onSubmit({ outcome: 'completed', saveLogin: { name: trimmed } });
  };

  return (
    <Box component="form" onSubmit={save} noValidate aria-label={`Save this sign-in for ${card.site}`} sx={{ mt: 1.5, minWidth: 0 }}>
      <TextField
        label="Name it"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={disabled}
        fullWidth
        size="small"
        required
        error={name.length > 0 && !valid}
        helperText={name.length > 0 && !valid ? `1 to ${SAVE_LOGIN_NAME_MAX} characters, on one line` : undefined}
        slotProps={{ htmlInput: { maxLength: SAVE_LOGIN_NAME_MAX }, inputLabel: { shrink: true } }}
        sx={{ mb: 1.5 }}
      />
      <Stack spacing={0.5} sx={{ mb: 1.5 }}>
        <Typography variant="body2" sx={WRAP}>
          <Box component="span" sx={{ color: 'text.secondary' }}>
            Site:{' '}
          </Box>
          {card.site}
        </Typography>
        <Typography variant="body2" sx={WRAP}>
          <Box component="span" sx={{ color: 'text.secondary' }}>
            Username:{' '}
          </Box>
          {card.username}
        </Typography>
        <Typography variant="body2" sx={WRAP}>
          <Box component="span" sx={{ color: 'text.secondary' }}>
            Password:{' '}
          </Box>
          the one you just typed
        </Typography>
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
        <Button type="submit" variant="contained" disabled={disabled || !valid} sx={ACTION_SX}>
          Save
        </Button>
        <Button variant="outlined" onClick={() => void onSubmit({ outcome: 'cancelled' })} disabled={disabled} sx={ACTION_SX}>
          Not now
        </Button>
        <Button variant="text" color="inherit" onClick={() => void onSubmit({ outcome: 'cancelled', neverForSite: true })} disabled={disabled} sx={ACTION_SX}>
          Never for this site
        </Button>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1, ...WRAP }}>
        Saved in your vault, where you decide which logins the agent may use. “Never for this site” stops these offers for {card.domain}; you can undo it in Settings → Secrets.
      </Typography>
    </Box>
  );
}
