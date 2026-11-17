import { useCallback, useEffect, useState } from 'react';
import InboxOutlinedIcon from '@mui/icons-material/InboxOutlined';
import { Alert, Card, CardContent, Chip, Link, Stack, Typography } from '@mui/material';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { QuestionAnswerForm } from '../components/QuestionAnswerForm';
import { KIND_LABEL, askerText, type AnswerBody, type AskedQuestion } from '../components/questions';
import { useOpenViewer } from '../components/useOpenViewer';
import { CardSkeleton, EmptyState, ErrorBanner, PageContainer, PageHeader, formatTime, useApiAction, useProfileTimeZone } from '../ui';

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
  const { run, busy, error, setError } = useApiAction('Could not send the answer');
  useProfileTimeZone();
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
  }, [api, setError]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [load]);

  const respond = async (item: InboxItem, answer: AnswerBody) => {
    await run(item.questionId, async () => {
      if (answer.outcome === 'cancelled') await api.post(`/questions/${item.questionId}/cancel`, { channel: 'web' });
      else await api.post(`/questions/${item.questionId}/answer`, { ...answer, channel: 'web' });
      await load();
    });
  };

  return (
    <PageContainer width="narrow">
      <PageHeader title="Inbox" />
      <ErrorBanner error={error} />
      {items === null && !error && <CardSkeleton rows={2} />}
      {items?.length === 0 && <EmptyState Icon={InboxOutlinedIcon} title="Nothing is waiting for you." />}
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
                  expires {formatTime(item.expiresAt)}
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
    </PageContainer>
  );
}
