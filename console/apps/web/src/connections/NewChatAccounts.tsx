import { FormHelperText, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useEffect, useState } from 'react';

import { getNewChatAccounts, setNewChatAccounts, type NewChatAccounts } from './api';

const CHOICES: { value: NewChatAccounts; label: string }[] = [
  { value: 'read_write', label: 'Everything I connected' },
  { value: 'read', label: 'Accounts, read only' },
  { value: 'off', label: 'Off' },
];

export const NEW_CHATS_HELP = 'How a new chat starts. Everything I connected (the default): every account and tool you connected, at what you switched on for each, and the agent picks the right one. Accounts, read only: your Google and Microsoft accounts, read only. A chat keeps what it has when you change this, and you can limit any chat. Sending or changing something still asks you first.';

/**
 * "New chats" (#680): the user setting `connections.newChats`, read and change by default, saved as soon as it is chosen. It only decides how a
 * NEW chat starts; each chat's own "Accounts this chat may use" is what the agent follows.
 */
export function NewChatAccountsSetting({ disabled }: { disabled?: boolean }) {
  const { api } = usePlatformHost();
  const [value, setValue] = useState<NewChatAccounts | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getNewChatAccounts(api)
      .then((v) => live && setValue(v))
      .catch(() => live && setValue('read_write'));
    return () => {
      live = false;
    };
  }, [api]);

  const choose = async (next: NewChatAccounts) => {
    const before = value;
    setValue(next);
    setError(null);
    try {
      setValue(await setNewChatAccounts(api, next));
    } catch {
      setValue(before);
      setError('Could not save this setting. Try again.');
    }
  };

  return (
    <section aria-label="New chats">
      <Typography variant="subtitle2" component="h3">
        New chats
      </Typography>
      <ToggleButtonGroup
        exclusive
        size="small"
        value={value}
        disabled={disabled || value === null}
        onChange={(_e, next: NewChatAccounts | null) => {
          if (next) void choose(next);
        }}
        aria-label="How a new chat uses your accounts"
        sx={{ mt: 0.5, flexWrap: 'wrap', '& .MuiToggleButton-root': { minHeight: { xs: 44, sm: 36 }, textTransform: 'none', px: 1.5 } }}
      >
        {CHOICES.map((c) => (
          <ToggleButton key={c.value} value={c.value} aria-label={`New chats: ${c.label}`}>
            {c.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <FormHelperText error={error !== null}>{error ?? NEW_CHATS_HELP}</FormHelperText>
    </section>
  );
}
