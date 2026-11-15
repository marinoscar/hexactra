import { useCallback, useEffect, useState } from 'react';
import { Alert, Card, CardContent, Chip, Container, Link, Stack, Typography } from '@mui/material';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { QuestionAnswerForm } from '../components/QuestionAnswerForm';
import { KIND_LABEL, askerText, type AnswerBody, type AskedQuestion } from '../components/questions';
import { useOpenViewer } from '../components/useOpenViewer';

/** `GET /api/inbox`: one pending question. */
export interface InboxItem extends AskedQuestion {
  questionId: string;
  /** Null for a free-standing question (no browser run). */
  runId: string | null;
  goal: string;
  handoffId: string | null;
  askedBy: string;
  prompt: string;
  /** Option ids (older clients); `options` carries the labels. */
  choices: string[];
  pageTitle: string | null;
  createdAt: string;
  expiresAt: string;
}

/**
 * `/inbox`: what your agents are waiting for, free-standing questions too.
 * Every answer goes through the question broker (`POST
 * /api/questions/:id/answer`), which forwards a browser-bound one to its run.
 */
export function InboxPage() {
  const { api, viewer } = usePlatformHost();
  const canAnswer = viewer.hasPermission('runs:write');
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const openViewer = useOpenViewer(setError);
  // `/inbox?run=<id>` (or `?q=<question id>`): the deep link of a "needs you" notification.
  const [params] = useSearchParams();
  const focusRun = params.get('run');
  const focusQuestion = params.get('q');
  const focused = (i: InboxItem) => (focusRun !== null && i.runId === focusRun) || (focusQuestion !== null && i.questionId === focusQuestion);

  const load = useCallback(async () => {
    try {
      setItems(await api.get<InboxItem[]>('/inbox'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the inbox');
    }
  }, [api]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [load]);

  const respond = async (item: InboxItem, answer: AnswerBody) => {
    setBusy(item.questionId);
    setError(null);
    try {
      if (answer.outcome === 'cancelled') await api.post(`/questions/${item.questionId}/cancel`, { channel: 'web' });
      else await api.post(`/questions/${item.questionId}/answer`, { ...answer, channel: 'web' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the answer');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Container maxWidth="sm" sx={{ py: { xs: 2, sm: 4 } }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Inbox
      </Typography>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {items?.length === 0 && <Alert severity="success">Nothing is waiting for you.</Alert>}
      {(focusRun || focusQuestion) && items && items.length > 0 && !items.some(focused) && (
        <Alert severity="info" sx={{ mb: 2 }}>
          That request was already answered or expired.
        </Alert>
      )}
      <Stack spacing={2} aria-label="Requests">
        {[...(items ?? [])].sort((a, b) => Number(focused(b)) - Number(focused(a))).map((item) => (
          <Card
            key={item.questionId}
            variant="outlined"
            aria-label={`Request: ${item.prompt}`}
            aria-current={focused(item) ? 'true' : undefined}
            sx={focused(item) ? { borderColor: 'warning.main', borderWidth: 2 } : undefined}
          >
            <CardContent>
              <Stack direction="row" spacing={1} useFlexGap sx={{ mb: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                <Chip size="small" color="warning" label={KIND_LABEL[item.kind] ?? item.kind} />
                {item.risk === 'high' && <Chip size="small" color="error" variant="outlined" label="High risk" />}
                <Typography variant="caption" color="text.secondary">
                  expires {new Date(item.expiresAt).toLocaleTimeString()}
                </Typography>
              </Stack>
              <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.prompt}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1, overflowWrap: 'anywhere' }}>
                {item.runId ? (
                  <>
                    For:{' '}
                    <Link component={RouterLink} to={`/runs/${item.runId}`}>
                      {item.goal}
                    </Link>
                    {item.pageTitle ? ` · on “${item.pageTitle}”` : ''}
                  </>
                ) : (
                  <>Asked by {askerText(item.askedBy)}</>
                )}
                {' · '}
                <Link component={RouterLink} to={`/inbox/q/${item.questionId}`}>
                  Details
                </Link>
              </Typography>
              <QuestionAnswerForm
                question={item}
                disabled={!canAnswer || busy === item.questionId}
                onSubmit={(answer) => respond(item, answer)}
                onOpenBrowser={item.viewerUrl ? () => void openViewer(item.viewerUrl!) : undefined}
              />
            </CardContent>
          </Card>
        ))}
      </Stack>
    </Container>
  );
}
