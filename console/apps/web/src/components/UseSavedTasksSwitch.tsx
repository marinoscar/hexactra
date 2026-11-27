import { FormControlLabel, FormHelperText, Switch } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import type { PlatformApiClient } from '@marinoscar/platform-web/core';
import { useEffect, useState } from 'react';

export const USE_SAVED_TASKS_LABEL = 'Use my saved tasks when one fits';
export const USE_SAVED_TASKS_HELP = 'The chat runs one of your saved tasks, with its own limits, when it does what you ask. Off, it runs a task only when you name it. Applies to all your chats.';

type Doc = { chat?: { useSavedTasks?: boolean } | null };

/** Whether the chat may use the owner's saved tasks (`chat.useSavedTasks` of the user settings, on by default). */
export async function getUseSavedTasks(api: PlatformApiClient): Promise<boolean> {
  const doc = await api.get<Doc>('/user-settings');
  return doc.chat?.useSavedTasks !== false;
}

/** Turns the chat's use of saved tasks on or off. */
export async function setUseSavedTasks(api: PlatformApiClient, useSavedTasks: boolean): Promise<boolean> {
  const doc = await api.patch<Doc>('/user-settings', { chat: { useSavedTasks } });
  return doc.chat?.useSavedTasks !== false;
}

/**
 * "Use my saved tasks when one fits" (E51.2, #1007): the user setting `chat.useSavedTasks`, on by default, saved as soon as it is
 * switched. Off, the chat is not shown your tasks; you can still name one.
 */
export function UseSavedTasksSwitch({ disabled }: { disabled?: boolean }) {
  const { api } = usePlatformHost();
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getUseSavedTasks(api)
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
      setOn(await setUseSavedTasks(api, next));
    } catch {
      setOn(before);
      setError('Could not save this setting. Try again.');
    }
  };

  return (
    <>
      <FormControlLabel
        control={<Switch checked={on ?? true} disabled={disabled || on === null} onChange={(e) => void toggle(e.target.checked)} slotProps={{ input: { 'aria-describedby': 'use-saved-tasks-help' } }} />}
        label={USE_SAVED_TASKS_LABEL}
      />
      <FormHelperText id="use-saved-tasks-help" error={error !== null} sx={{ mt: -0.5 }}>
        {error ?? USE_SAVED_TASKS_HELP}
      </FormHelperText>
    </>
  );
}
