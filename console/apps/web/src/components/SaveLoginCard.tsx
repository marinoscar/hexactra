import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import { Alert, Paper, Stack, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';

import { SaveLoginForm } from './SaveLoginForm';
import { SAVE_TOO_LATE_TEXT, answerRequest, answerText, isSettledError, type AnswerBody, type Question } from './questions';

const CARD_MAX = { xs: '100%', sm: 480 } as const;
const WRAP = { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 } as const;

export interface SaveLoginCardProps {
  questionId: string;
}

/**
 * "Save this login?" in a chat thread (E37.4b): the sign-in the agent just used, loaded from the question broker and answered there as
 * channel `web`. It never pauses the run: the owner answers when they like, here or in the Inbox, within ten minutes of typing the
 * password (the fabric stops holding it after that and the card says it is too late). Viewers who may not answer (`runs:write`) see it
 * read-only.
 */
export function SaveLoginCard({ questionId }: SaveLoginCardProps) {
  const { api, viewer } = usePlatformHost();
  const canAnswer = viewer.hasPermission('runs:write');
  const [q, setQ] = useState<Question | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setQ(await api.get<Question>(`/questions/${encodeURIComponent(questionId)}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the offer');
    }
  }, [api, questionId]);
  useEffect(() => {
    void load();
  }, [load]);

  const answer = async (a: AnswerBody) => {
    setBusy(true);
    setError(null);
    try {
      const { path, body } = answerRequest(questionId, a);
      setQ(await api.post<Question>(path, body));
    } catch (e) {
      // Answered in the Inbox, or too late, meanwhile: show what it became.
      if (isSettledError(e)) await load();
      // The API's words (the name is taken, the vault needs reconnecting): shown on the card; the name stays.
      else setError(e instanceof Error && e.message ? e.message : 'Could not save the login');
    } finally {
      setBusy(false);
    }
  };

  const pending = q?.status === 'pending' && new Date(q.expiresAt).getTime() > Date.now();
  const settled = q && !pending ? (q.status === 'pending' ? SAVE_TOO_LATE_TEXT : answerText(q)) : null;
  return (
    <Paper variant="outlined" component="article" aria-label="Save this login?" sx={{ p: 1.5, width: '100%', maxWidth: CARD_MAX, borderRadius: 3, my: 0.75 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <KeyOutlinedIcon color="primary" aria-hidden />
        <Typography variant="subtitle2" component="p" sx={{ flex: 1, ...WRAP }}>
          {q?.saveLogin ? `Save this sign-in for ${q.saveLogin.site}?` : 'Save this login?'}
        </Typography>
      </Stack>
      {error && (
        <Alert severity="error" sx={{ mt: 1.5, ...WRAP }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {q?.saveLogin && pending && <SaveLoginForm card={q.saveLogin} onSubmit={answer} disabled={!canAnswer} busy={busy} />}
      {q?.saveLogin && !pending && (
        <Typography variant="body2" sx={{ mt: 1, ...WRAP }}>
          {q.saveLogin.username} on {q.saveLogin.site}
        </Typography>
      )}
      {settled && (
        <Typography variant="body2" color="text.secondary" role="status" sx={{ mt: 1, ...WRAP }}>
          {settled}
        </Typography>
      )}
    </Paper>
  );
}
