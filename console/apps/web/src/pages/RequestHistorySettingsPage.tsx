import { Alert, Box, Button, Paper, Stack, TextField } from '@mui/material';
import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';

import { CardSkeleton, ErrorBanner, PageContainer, PageHeader, useApiAction } from '../ui';

/** The limits of the `questions` system settings (apps/api/src/questions/questions.settings.ts). */
export const HISTORY_MAX_DAYS = 3650;
export const DEFAULT_WAIT_MAX_MINUTES = 1440;
export const QUESTIONS_DEFAULTS = { historyKeepDays: 7, defaultWaitMinutes: 60 } as const;

interface QuestionsSettings {
  historyKeepDays: number;
  defaultWaitMinutes: number;
}
interface SystemSettingsDoc {
  version: number;
  questions?: Partial<QuestionsSettings>;
}

/** Why a whole-number field is not valid, or null. */
export function wholeNumberError(text: string, max: number): string | null {
  const n = Number(text);
  if (!text.trim() || !Number.isInteger(n)) return 'A whole number';
  if (n < 1 || n > max) return `From 1 to ${max.toLocaleString('en-US')}`;
  return null;
}

/**
 * `/admin/settings/request-history` (E40.4, #688): how long the history of
 * what agents asked is kept (days, default 7), and how long a question waits
 * for an answer when the agent set no time (minutes, default 60). The
 * `questions` namespace of the system settings; writes need
 * `system_settings:write`.
 */
export function RequestHistorySettingsPage() {
  const { api, viewer } = usePlatformHost();
  const canWrite = viewer.hasPermission('system_settings:write');
  const action = useApiAction();
  const [stored, setStored] = useState<QuestionsSettings | null>(null);
  const [draft, setDraft] = useState<{ days: string; wait: string } | null>(null);
  const [version, setVersion] = useState(0);
  const [saved, setSaved] = useState(false);
  const { setError } = action;

  const load = useCallback(async () => {
    try {
      const doc = await api.get<SystemSettingsDoc>('/system-settings');
      const s = { ...QUESTIONS_DEFAULTS, ...doc.questions };
      setStored(s);
      setDraft({ days: String(s.historyKeepDays), wait: String(s.defaultWaitMinutes) });
      setVersion(doc.version);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not load the settings');
    }
  }, [api, setError]);
  useEffect(() => {
    void load();
  }, [load]);

  const daysError = draft ? wholeNumberError(draft.days, HISTORY_MAX_DAYS) : null;
  const waitError = draft ? wholeNumberError(draft.wait, DEFAULT_WAIT_MAX_MINUTES) : null;
  const dirty = Boolean(draft && stored && !daysError && !waitError && (Number(draft.days) !== stored.historyKeepDays || Number(draft.wait) !== stored.defaultWaitMinutes));

  const save = async () => {
    if (!draft || daysError || waitError) return;
    setSaved(false);
    const next = { historyKeepDays: Number(draft.days), defaultWaitMinutes: Number(draft.wait) };
    try {
      const doc = await api.patch<SystemSettingsDoc>('/system-settings', { questions: next }, { ifMatch: String(version) });
      setVersion(doc.version);
      setStored(next);
      setSaved(true);
      setError(null);
    } catch (e) {
      setError(isPlatformApiError(e) && e.status === 409 ? 'The settings changed elsewhere; reload the page and try again.' : e instanceof Error && e.message ? e.message : 'Could not save the settings');
    }
  };

  const edit = (patch: Partial<{ days: string; wait: string }>) => {
    setSaved(false);
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };

  return (
    <PageContainer width="narrow">
      <PageHeader
        title="Request history"
        subtitle="What agents ask your users (codes, sign-ins, approvals, choices) and how each request ended. Values such as passwords and codes are never kept, only that they were provided."
        back={{ to: '/admin/settings', label: 'Settings' }}
      />
      <ErrorBanner error={action.error} />
      {!draft && !action.error && <CardSkeleton />}
      {draft && (
        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
          <Stack spacing={2.5}>
            <TextField
              size="small"
              type="number"
              label="Keep history for (days)"
              value={draft.days}
              disabled={!canWrite}
              error={Boolean(daysError)}
              helperText={daysError ?? 'Answered, declined and expired requests are deleted this many days after they ended, from the Inbox history and from chats. A request that is still waiting is never deleted.'}
              onChange={(e) => edit({ days: e.target.value })}
              slotProps={{ htmlInput: { min: 1, max: HISTORY_MAX_DAYS, inputMode: 'numeric', 'aria-label': 'Days request history is kept' } }}
            />
            <TextField
              size="small"
              type="number"
              label="Wait for an answer (minutes)"
              value={draft.wait}
              disabled={!canWrite}
              error={Boolean(waitError)}
              helperText={waitError ?? 'How long a question waits when the agent set no time. Then it expires and the run goes on without the answer. Approvals for a connected account and the details to start a task wait 24 hours.'}
              onChange={(e) => edit({ wait: e.target.value })}
              slotProps={{ htmlInput: { min: 1, max: DEFAULT_WAIT_MAX_MINUTES, inputMode: 'numeric', 'aria-label': 'Minutes a question waits for an answer' } }}
            />
            {saved && <Alert severity="success">Saved. New questions use the wait time; the nightly cleanup uses the history limit.</Alert>}
            {canWrite && (
              <Box>
                <Button variant="contained" sx={{ minHeight: 44 }} disabled={!dirty} onClick={() => void save()}>
                  Save
                </Button>
              </Box>
            )}
          </Stack>
        </Paper>
      )}
    </PageContainer>
  );
}
