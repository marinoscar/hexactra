import { FormControlLabel, FormHelperText, Switch } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useEffect, useState } from 'react';

import { getSuggestMemories, setSuggestMemories } from './api';

export const SUGGEST_HELP = 'The agent offers to remember people, accounts and preferences you tell it. Nothing is saved until you approve it. Applies to all your chats and runs.';

/**
 * "Suggest memories" (#553): the user setting `memories.suggest`, on by
 * default, saved as soon as it is switched. Off, the agent stops proposing
 * memories; the ones already saved are still used.
 */
export function SuggestMemoriesSwitch({ disabled }: { disabled?: boolean }) {
  const { api } = usePlatformHost();
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getSuggestMemories(api)
      .then((v) => live && setOn(v))
      .catch(() => live && setOn(true));
    return () => {
      live = false;
    };
  }, [api]);

  const toggle = async (next: boolean) => {
    const before = on;
    setOn(next);
    setError(null);
    try {
      setOn(await setSuggestMemories(api, next));
    } catch {
      setOn(before);
      setError('Could not save this setting. Try again.');
    }
  };

  return (
    <>
      <FormControlLabel
        control={<Switch checked={on ?? true} disabled={disabled || on === null} onChange={(e) => void toggle(e.target.checked)} slotProps={{ input: { 'aria-describedby': 'suggest-memories-help' } }} />}
        label="Suggest memories"
      />
      <FormHelperText id="suggest-memories-help" error={error !== null} sx={{ mt: -0.5 }}>
        {error ?? SUGGEST_HELP}
      </FormHelperText>
    </>
  );
}
