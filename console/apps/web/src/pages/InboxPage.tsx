import InboxOutlinedIcon from '@mui/icons-material/InboxOutlined';
import { Alert, Box, Tab, Tabs, Typography } from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { InboxHistory } from '../components/InboxHistory';
import { QuestionCard, inboxItemToCard, type AnswerResult } from '../components/QuestionCard';
import { answerRequest, isSettledError, type AnswerBody, type InboxItem } from '../components/questions';
import { useNow } from '../components/RunActivity';
import { useOpenViewer } from '../components/useOpenViewer';
import { CardSkeleton, EmptyState, ErrorBanner, PageContainer, PageHeader } from '../ui';

export type { InboxItem } from '../components/questions';

/**
 * The list after a refresh. Cards the person already sees keep their place
 * (nothing re-sorts under a thumb, and a card keyed on its question id is
 * never unmounted while its question is pending, so what is typed in it
 * survives); requests that are new go on top; a request answered here stays
 * until its card has said "Sent." and left (`keep`).
 */
export function mergeInbox(prev: InboxItem[] | null, server: InboxItem[], keep: ReadonlySet<string>): InboxItem[] {
  if (prev === null) return server;
  const byId = new Map(server.map((i) => [i.questionId, i]));
  const seen = new Set(prev.map((i) => i.questionId));
  const kept = prev.flatMap((i) => (byId.has(i.questionId) ? [byId.get(i.questionId)!] : keep.has(i.questionId) ? [i] : []));
  return [...server.filter((i) => !seen.has(i.questionId)), ...kept];
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
  /** Requests that arrived after the first load: highlighted. */
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  /** Requests answered here, kept on the page until their card has left. */
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set());
  const itemsRef = useRef<InboxItem[] | null>(null);
  const settledRef = useRef<Set<string>>(new Set());
  const openViewer = useOpenViewer(setError);
  // `/inbox?run=<id>` (or `?q=<question id>`): the deep link of a "needs you" notification.
  const [params, setParams] = useSearchParams();
  // Two views of one destination (E40.3): what waits, and what is over (`?tab=history`).
  const tab = params.get('tab') === 'history' ? 'history' : 'waiting';
  const setTab = (next: 'waiting' | 'history') => {
    const p = new URLSearchParams(params);
    if (next === 'history') p.set('tab', 'history');
    else p.delete('tab');
    setParams(p, { replace: true });
  };
  const focusRun = params.get('run');
  const focusQuestion = params.get('q');
  const focused = useCallback((i: InboxItem) => (focusRun !== null && i.runId === focusRun) || (focusQuestion !== null && i.questionId === focusQuestion), [focusRun, focusQuestion]);

  const load = useCallback(async () => {
    try {
      const server = await api.get<InboxItem[]>('/inbox');
      const prev = itemsRef.current;
      const next = mergeInbox(prev, server, settledRef.current);
      if (prev) {
        const seen = new Set(prev.map((i) => i.questionId));
        const added = server.filter((i) => !seen.has(i.questionId)).map((i) => i.questionId);
        if (added.length) setFresh((f) => new Set([...f, ...added]));
      }
      itemsRef.current = next;
      setItems(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the inbox');
    }
  }, [api]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [load]);

  const settle = (id: string) => {
    settledRef.current.add(id);
    setSettled(new Set(settledRef.current));
    void load();
  };

  const respond = async (item: InboxItem, answer: AnswerBody): Promise<AnswerResult> => {
    try {
      const { path, body } = answerRequest(item.questionId, answer);
      await api.post(path, body);
    } catch (e) {
      // Answered on another device, or expired, in the meantime: that is its final state, not an error.
      if (!isSettledError(e)) throw e;
      settle(item.questionId);
      return 'gone';
    }
    settle(item.questionId);
  };

  const left = (id: string) => {
    settledRef.current.delete(id);
    setSettled(new Set(settledRef.current));
    const next = (itemsRef.current ?? []).filter((i) => i.questionId !== id);
    itemsRef.current = next;
    setItems(next);
  };

  // The focused request first; everything else in the order the person already sees.
  const ordered = useMemo(() => [...(items ?? [])].sort((a, b) => Number(focused(b)) - Number(focused(a))), [items, focused]);
  // Requests a run waits on first; the agent's memory suggestions (#553) below, in their own quiet group.
  const blocking = ordered.filter((i) => i.blocking !== false);
  // Calls through the owner's accounts that wait on them (E39.10): in their own group, so an unattended run's send or change is easy to find.
  const requests = blocking.filter((i) => !i.action);
  const accountApprovals = blocking.filter((i) => Boolean(i.action));
  const suggestions = ordered.filter((i) => i.blocking === false);
  const waiting = blocking.filter((i) => !settled.has(i.questionId)).length;
  // One clock for every card's countdown.
  const now = useNow(ordered.length > 0);

  return (
    <PageContainer width="narrow">
      <PageHeader title="Inbox" subtitle={waiting > 0 ? `${waiting} waiting for you` : undefined} />
      <Tabs value={tab} onChange={(_, v: 'waiting' | 'history') => setTab(v)} aria-label="Inbox views" sx={{ mb: 2, minHeight: 0 }}>
        <Tab value="waiting" label={waiting > 0 ? `Waiting (${waiting})` : 'Waiting'} sx={{ minHeight: 44 }} />
        <Tab value="history" label="History" sx={{ minHeight: 44 }} />
      </Tabs>
      {tab === 'history' ? (
        <InboxHistory />
      ) : (
        <>
          <ErrorBanner error={error} />
          {items === null && !error && <CardSkeleton rows={2} />}
          {items?.length === 0 && (
            <EmptyState Icon={InboxOutlinedIcon} title="Nothing is waiting for you" body="When an agent needs a code, a choice or your approval, it shows up here." />
          )}
          {(focusRun || focusQuestion) && items && items.length > 0 && !items.some(focused) && (
            <Alert severity="info" sx={{ mb: 2 }}>
              That request was already answered or expired.
            </Alert>
          )}
          <Box aria-label="Requests" sx={{ minWidth: 0 }}>
            {requests.map((item) => (
              <QuestionCard
                key={item.questionId}
                variant="list"
                question={inboxItemToCard(item)}
                now={now}
                canAnswer={canAnswer}
                focused={focused(item)}
                isNew={fresh.has(item.questionId)}
                onAnswer={(answer) => respond(item, answer)}
                onOpenBrowser={(url) => void openViewer(url)}
                onLeft={() => left(item.questionId)}
              />
            ))}
          </Box>
          {accountApprovals.length > 0 && (
            <Box component="section" aria-label="Account approvals" sx={{ minWidth: 0, mt: requests.length ? 3 : 0 }}>
              <Typography variant="overline" component="h2" color="text.secondary">
                Waiting for your approval
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                A task or chat wants to send, create or change something with one of your accounts. Nothing happens until you answer.
              </Typography>
              {accountApprovals.map((item) => (
                <QuestionCard
                  key={item.questionId}
                  variant="list"
                  question={inboxItemToCard(item)}
                  now={now}
                  canAnswer={canAnswer}
                  focused={focused(item)}
                  isNew={fresh.has(item.questionId)}
                  onAnswer={(answer) => respond(item, answer)}
                  onLeft={() => left(item.questionId)}
                />
              ))}
            </Box>
          )}
          {suggestions.length > 0 && (
            <Box component="section" aria-label="Suggestions" sx={{ minWidth: 0, mt: requests.length ? 3 : 0 }}>
              <Typography variant="overline" component="h2" color="text.secondary">
                Suggestions
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                Things the agent offers to remember or to save, such as a login you just typed. Nothing waits on them: answer when you like.
              </Typography>
              {suggestions.map((item) => (
                <QuestionCard
                  key={item.questionId}
                  variant="list"
                  question={inboxItemToCard(item)}
                  now={now}
                  canAnswer={canAnswer}
                  focused={focused(item)}
                  isNew={fresh.has(item.questionId)}
                  onAnswer={(answer) => respond(item, answer)}
                  onLeft={() => left(item.questionId)}
                />
              ))}
            </Box>
          )}
        </>
      )}
    </PageContainer>
  );
}
