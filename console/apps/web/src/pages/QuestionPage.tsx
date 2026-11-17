import { Alert } from '@mui/material';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { QuestionCard, type AnswerResult } from '../components/QuestionCard';
import { isSettledError, type AnswerBody, type Question } from '../components/questions';
import { useNow } from '../components/RunActivity';
import { useOpenViewer } from '../components/useOpenViewer';
import { CardSkeleton, ErrorBanner, PageContainer, PageHeader } from '../ui';

/**
 * `/inbox/q/:id`: one question, where a notification's link lands. Shows
 * who asked, its run and page, the time left and the answer form; once
 * settled (here or on another device), its final state.
 */
export function QuestionPage() {
  const { id = '' } = useParams<{ id: string }>();
  const { api, viewer } = usePlatformHost();
  const canAnswer = viewer.hasPermission('runs:write');
  const [question, setQuestion] = useState<Question | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const openViewer = useOpenViewer(setError);

  const load = useCallback(async () => {
    try {
      setQuestion(await api.get<Question>(`/questions/${id}`));
      setError(null);
    } catch (e) {
      if ((e as { status?: number }).status === 404 || (e as { statusCode?: number }).statusCode === 404) setMissing(true);
      else setError(e instanceof Error ? e.message : 'Could not load the question');
    }
  }, [api, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = question?.status === 'pending';
  const now = useNow(pending);
  useEffect(() => {
    if (!pending) return;
    // Answered on another device meanwhile? Re-read now and then.
    const poll = setInterval(() => void load(), 5_000);
    return () => clearInterval(poll);
  }, [pending, load]);

  const respond = async (answer: AnswerBody): Promise<AnswerResult> => {
    try {
      setQuestion(
        answer.outcome === 'cancelled'
          ? await api.post<Question>(`/questions/${id}/cancel`, { channel: 'web' })
          : await api.post<Question>(`/questions/${id}/answer`, { ...answer, channel: 'web' }),
      );
    } catch (e) {
      // Either way the question may have moved on: show what it is now.
      await load();
      // Answered elsewhere or expired: the reload shows its final state, not an error.
      if (isSettledError(e)) return 'gone';
      throw e;
    }
  };

  return (
    <PageContainer width="narrow">
      <PageHeader variant="h5" title="Question" back={{ to: '/inbox', label: 'Inbox' }} />
      <ErrorBanner error={error} />
      {missing && <Alert severity="info">This question does not exist or is not yours.</Alert>}
      {!question && !missing && !error && <CardSkeleton rows={1} />}
      {question && <QuestionCard variant="page" question={question} now={now} canAnswer={canAnswer} onAnswer={respond} onOpenBrowser={(url) => void openViewer(url)} />}
    </PageContainer>
  );
}
