import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Card, CardContent, Chip, CircularProgress, Container, Link, Stack, Typography } from '@mui/material';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { QuestionAnswerForm } from '../components/QuestionAnswerForm';
import { KIND_LABEL, answerText, askerText, remaining, type AnswerBody, type Question } from '../components/questions';
import { useOpenViewer } from '../components/useOpenViewer';

const STATUS_LABEL: Record<Question['status'], string> = { pending: 'Waiting for you', answered: 'Answered', cancelled: 'Declined', expired: 'Expired' };

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
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const openViewer = useOpenViewer(setError);

  const load = useCallback(async () => {
    try {
      setQuestion(await api.get<Question>(`/questions/${id}`));
    } catch (e) {
      if ((e as { status?: number }).status === 404 || (e as { statusCode?: number }).statusCode === 404) setMissing(true);
      else setError(e instanceof Error ? e.message : 'Could not load the question');
    }
  }, [api, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = question?.status === 'pending';
  useEffect(() => {
    if (!pending) return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    // Answered on another device meanwhile? Re-read now and then.
    const poll = setInterval(() => void load(), 5_000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [pending, load]);

  const respond = async (answer: AnswerBody) => {
    setBusy(true);
    setError(null);
    try {
      setQuestion(
        answer.outcome === 'cancelled'
          ? await api.post<Question>(`/questions/${id}/cancel`, { channel: 'web' })
          : await api.post<Question>(`/questions/${id}/answer`, { ...answer, channel: 'web' }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the answer');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const expiredNow = question && pending && new Date(question.expiresAt).getTime() <= now;

  return (
    <Container maxWidth="sm" sx={{ py: { xs: 2, sm: 4 } }}>
      <Typography variant="body2" sx={{ mb: 1 }}>
        <Link component={RouterLink} to="/inbox">
          ← Inbox
        </Link>
      </Typography>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {missing && <Alert severity="info">This question does not exist or is not yours.</Alert>}
      {!question && !missing && !error && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress aria-label="Loading" />
        </Box>
      )}
      {question && (
        <Card variant="outlined" aria-label={`Question: ${question.prompt}`}>
          <CardContent>
            <Stack direction="row" spacing={1} useFlexGap sx={{ mb: 1, alignItems: 'center', flexWrap: 'wrap' }}>
              <Chip size="small" color={pending ? 'warning' : 'default'} label={KIND_LABEL[question.kind] ?? question.kind} />
              <Chip size="small" variant="outlined" label={STATUS_LABEL[question.status]} />
              {question.risk === 'high' && <Chip size="small" color="error" variant="outlined" label="High risk" />}
              {pending && (
                <Typography variant="caption" color="text.secondary" aria-label="Time left">
                  {expiredNow ? 'expired' : `${remaining(question.expiresAt, now)} left`}
                </Typography>
              )}
            </Stack>
            <Typography variant="h6" component="h1" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {question.prompt}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1, overflowWrap: 'anywhere' }}>
              Asked by {askerText(question.askedBy)}
              {question.runId && (
                <>
                  {' · '}
                  <Link component={RouterLink} to={`/runs/${question.runId}`}>
                    its run
                  </Link>
                </>
              )}
              {question.pageTitle ? ` · on “${question.pageTitle}”` : ''}
            </Typography>
            {pending && !expiredNow ? (
              canAnswer ? (
                <QuestionAnswerForm
                  question={question}
                  disabled={busy}
                  onSubmit={respond}
                  onOpenBrowser={question.viewerUrl ? () => void openViewer(question.viewerUrl!) : undefined}
                />
              ) : (
                <Alert severity="info" sx={{ mt: 2 }}>
                  You can see this question but not answer it.
                </Alert>
              )
            ) : (
              <Alert severity={question.status === 'answered' ? 'success' : 'info'} sx={{ mt: 2 }}>
                {expiredNow ? 'This question expired before anyone answered.' : answerText(question)}
              </Alert>
            )}
          </CardContent>
        </Card>
      )}
    </Container>
  );
}
