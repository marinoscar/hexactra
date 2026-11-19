import PsychologyOutlinedIcon from '@mui/icons-material/PsychologyOutlined';
import { Alert, Link, Paper, Stack, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { MemoryProposalForm } from './MemoryProposalForm';
import { isSettledError, type AnswerBody, type Question } from './questions';

const CARD_MAX = { xs: '100%', sm: 480 } as const;
const WRAP = { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 } as const;

/** What a settled proposal says: saved (with a link to Memories), not saved, or expired. */
export function proposalSettledText(q: Pick<Question, 'status' | 'response'>): string {
  if (q.status === 'expired') return 'This suggestion expired. Nothing was saved.';
  if (q.status === 'answered' && q.response?.outcome === 'completed') return 'Saved to Memories';
  return 'Not saved';
}

export interface MemoryProposalCardProps {
  questionId: string;
}

/**
 * "Remember this?" in a chat thread (#553): the memory the agent proposes,
 * loaded from the question broker and answered there as channel `web`. It
 * never pauses a run: the owner answers when they like, here or in the Inbox.
 * Viewers who may not answer (`runs:write`) see it read-only.
 */
export function MemoryProposalCard({ questionId }: MemoryProposalCardProps) {
  const { api, viewer } = usePlatformHost();
  const canAnswer = viewer.hasPermission('runs:write');
  const [q, setQ] = useState<Question | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setQ(await api.get<Question>(`/questions/${encodeURIComponent(questionId)}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the suggestion');
    }
  }, [api, questionId]);
  useEffect(() => {
    void load();
  }, [load]);

  const answer = async (a: AnswerBody) => {
    setBusy(true);
    setError(null);
    try {
      if (a.outcome === 'cancelled') setQ(await api.post<Question>(`/questions/${questionId}/cancel`, { channel: 'web' }));
      else setQ(await api.post<Question>(`/questions/${questionId}/answer`, { ...a, channel: 'web' }));
    } catch (e) {
      // Answered in the Inbox, or expired, meanwhile: show what it became.
      if (isSettledError(e)) await load();
      // The API's message (for example the secret check), shown on the card; what was typed stays.
      else setError(e instanceof Error && e.message ? e.message : 'Could not save the memory');
    } finally {
      setBusy(false);
    }
  };

  const pending = q?.status === 'pending' && new Date(q.expiresAt).getTime() > Date.now();
  const settled = q && !pending ? proposalSettledText(q.status === 'pending' ? { ...q, status: 'expired' } : q) : null;
  return (
    <Paper variant="outlined" component="article" aria-label="Remember this?" sx={{ p: 1.5, width: '100%', maxWidth: CARD_MAX, borderRadius: 3, my: 0.75 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <PsychologyOutlinedIcon color="primary" aria-hidden />
        <Typography variant="subtitle2" component="p" sx={{ flex: 1, minWidth: 0 }}>
          Remember this?
        </Typography>
      </Stack>
      {error && (
        <Alert severity="error" sx={{ mt: 1.5, ...WRAP }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {q?.proposal && pending && <MemoryProposalForm proposal={q.proposal} onSubmit={answer} disabled={!canAnswer} busy={busy} />}
      {q?.proposal && !pending && (
        <Typography variant="body2" sx={{ mt: 1, ...WRAP }}>
          {q.proposal.label}
        </Typography>
      )}
      {settled && (
        <Typography variant="body2" color="text.secondary" role="status" sx={{ mt: 1 }}>
          {settled === 'Saved to Memories' ? (
            <Link component={RouterLink} to="/settings/memories">
              Saved to Memories
            </Link>
          ) : (
            settled
          )}
        </Typography>
      )}
    </Paper>
  );
}
