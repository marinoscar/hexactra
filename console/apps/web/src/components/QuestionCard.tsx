import { Alert, Box, Card, CardContent, Chip, Collapse, Link, Stack, Typography } from '@mui/material';
import { keyframes } from '@mui/material/styles';
import { useEffect, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { savedApprovalHref } from '../approvals/types';
import { useConfirm } from '../ui';
import { QuestionAnswerForm } from './QuestionAnswerForm';
import { KIND_LABEL, SAVE_TOO_LATE_TEXT, answerText, askerText, remaining, type AnswerBody, type AskedQuestion, type InboxItem, type Question, type QuestionResponse } from './questions';
import { RunThumbnail } from './RunThumbnail';

/** The first word of the prompt the runner asks with after a saved login was refused on a page that is not its site (`mismatchPrompt`). */
export const SAVED_LOGIN_WARNING_PREFIX = 'Warning:';

/** What a card shows of a question: the same for an Inbox item and for `GET /api/questions/:id`. */
export interface CardQuestion extends AskedQuestion {
  id: string;
  prompt: string;
  askedBy: string;
  /** Null for a free-standing question (no browser run). */
  runId: string | null;
  /** The run's goal, where the caller knows it (the Inbox does). */
  goal?: string;
  /** The chat whose run asks (#488): the request can be answered in its thread. */
  conversationId?: string | null;
  /** Asked through a browser handoff: declining it leaves its run without an answer. */
  browserBound: boolean;
  pageTitle: string | null;
  expiresAt: string;
  status: Question['status'];
  response: QuestionResponse | null;
}

/** An Inbox item (always pending) as a card's question. */
export function inboxItemToCard(item: InboxItem): CardQuestion {
  return { ...item, id: item.questionId, browserBound: item.handoffId !== null, status: 'pending', response: null };
}

/** `gone`: the API said the question was already settled (answered elsewhere, expired). */
export type AnswerResult = void | 'gone';

export interface QuestionCardProps {
  question: CardQuestion;
  /** The page's shared clock (one timer for every card), for the countdown. */
  now: number;
  /** Whether the viewer may answer (`runs:write`). */
  canAnswer: boolean;
  /** Sends the answer. Rejects when it failed: the card shows the message and keeps what was typed. */
  onAnswer: (answer: AnswerBody) => Promise<AnswerResult>;
  onOpenBrowser?: (viewerUrl: string) => void;
  /**
   * `list` (the Inbox): a link to the question's page, and after an answer the
   * card says "Sent." for two seconds, collapses and calls `onLeft`.
   * `page` (the question's own page): a status chip and the final state.
   */
  variant: 'list' | 'page';
  /** After the card has collapsed (list only). */
  onLeft?: () => void;
  /** The request a notification's link points at: marked, and scrolled into view once. */
  focused?: boolean;
  /** Arrived while the page was open: a brief highlight. */
  isNew?: boolean;
}

/** How long "Sent." stays before the card leaves. */
export const CONFIRMATION_MS = 2_000;

const STATUS_LABEL: Record<Question['status'], string> = { pending: 'Waiting for you', answered: 'Answered', cancelled: 'Declined', expired: 'Expired' };

const arrive = keyframes({ from: { boxShadow: '0 0 0 3px rgba(237, 108, 2, 0.55)' }, to: { boxShadow: '0 0 0 3px rgba(237, 108, 2, 0)' } });

/** Any text a user or a page wrote: it wraps anywhere, so one long URL never widens the card. */
const WRAP = { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 } as const;

/**
 * One question, as the Inbox and the question page both show it: chips
 * (kind, High risk, status), a live countdown, the prompt, a context line,
 * a thumbnail of the run's browser, then the answer form or the final
 * state. It owns the answer's progress, its error (shown inside the card)
 * and the confirmation of a decline that would leave a browser run stuck.
 */
export function QuestionCard({ question: q, now, canAnswer, onAnswer, onOpenBrowser, variant, onLeft, focused, isNew }: QuestionCardProps) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<'Sent.' | 'Declined.' | 'gone' | null>(null);
  const [leaving, setLeaving] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  const pending = q.status === 'pending';
  const msLeft = new Date(q.expiresAt).getTime() - now;
  const expiredNow = pending && !(msLeft > 0);
  const live = pending && !expiredNow && done === null;

  // A notification's link: bring its request into view, once.
  useEffect(() => {
    if (focused) root.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    // On mount only: later refreshes must not pull the page back to it.
  }, []);

  // The one-line confirmation stays two seconds, then the card collapses.
  useEffect(() => {
    if (done === null || variant !== 'list') return;
    const t = setTimeout(() => setLeaving(true), CONFIRMATION_MS);
    return () => clearTimeout(t);
  }, [done, variant]);

  const answer = async (a: AnswerBody) => {
    if (a.outcome === 'cancelled' && q.browserBound) {
      const sure = await confirm({ title: 'Decline?', body: 'The agent will be told you said no. Its run cannot continue past this step without an answer.', confirmLabel: 'Decline', cancelLabel: 'Keep it', destructive: true });
      if (!sure) return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await onAnswer(a);
      if (variant === 'list') setDone(result === 'gone' ? 'gone' : a.outcome === 'cancelled' ? 'Declined.' : 'Sent.');
    } catch (e) {
      // The API's message; it never carries the answer.
      setError(e instanceof Error && e.message ? e.message : 'Could not send the answer');
    } finally {
      setBusy(false);
    }
  };

  // "Save this login?" (E37.4b): the card says which site, in words the signed-in owner reads; the stored prompt names nothing.
  const prompt = q.input === 'save_login' && q.saveLogin ? `Save this sign-in for ${q.saveLogin.site}?` : q.prompt;
  const card = (
    <Card
      ref={root}
      variant="outlined"
      aria-label={`${variant === 'list' ? 'Request' : 'Question'}: ${prompt}`}
      aria-current={focused ? 'true' : undefined}
      data-new={isNew ? 'true' : undefined}
      sx={{
        // The card can be the narrowest thing on the page: nothing inside may widen it.
        minWidth: 0,
        scrollMarginTop: 80,
        ...(focused ? { borderColor: 'warning.main', borderWidth: 2 } : {}),
        ...(isNew ? { animation: `${arrive} 2.5s ease-out 1` } : {}),
      }}
    >
      <CardContent sx={{ minWidth: 0 }}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ mb: 1, alignItems: 'center', flexWrap: 'wrap' }}>
          <Chip size="small" color={pending ? 'warning' : 'default'} label={KIND_LABEL[q.kind] ?? q.kind} />
          {variant === 'page' && <Chip size="small" variant="outlined" label={expiredNow ? STATUS_LABEL.expired : STATUS_LABEL[q.status]} />}
          {q.risk === 'high' && <Chip size="small" color="error" variant="outlined" label="High risk" />}
          {pending && done === null && (
            <Typography
              variant="caption"
              aria-label="Time left"
              sx={{ color: expiredNow ? 'text.secondary' : msLeft < 60_000 ? 'warning.main' : 'text.secondary', fontWeight: !expiredNow && msLeft < 60_000 ? 600 : undefined, fontVariantNumeric: 'tabular-nums' }}
            >
              {expiredNow ? 'expired' : `${remaining(q.expiresAt, now)} left`}
            </Typography>
          )}
        </Stack>
        {/* A saved login was refused on the wrong site (E37.3, #593): the prompt says "Warning: ..." with both addresses, so it is a warning card. */}
        {q.kind === 'login' && q.prompt.startsWith(SAVED_LOGIN_WARNING_PREFIX) ? (
          <Alert severity="warning" data-testid="saved-login-warning" sx={{ whiteSpace: 'pre-wrap', ...WRAP }}>
            {q.prompt.slice(SAVED_LOGIN_WARNING_PREFIX.length).trim()}
          </Alert>
        ) : (
          <Typography variant={variant === 'page' ? 'h6' : 'body1'} component={variant === 'page' ? 'h2' : 'p'} sx={{ whiteSpace: 'pre-wrap', ...WRAP }}>
            {prompt}
          </Typography>
        )}
        <Box sx={{ mt: 1, color: 'text.secondary', ...WRAP }}>
          <Typography variant="body2" sx={WRAP}>
            {q.runId && q.goal ? (
              <>
                For:{' '}
                <Link component={RouterLink} to={`/runs/${q.runId}`} sx={WRAP}>
                  {q.goal}
                </Link>
              </>
            ) : (
              <>
                Asked by {askerText(q.askedBy)}
                {q.runId && (
                  <>
                    {' · '}
                    <Link component={RouterLink} to={`/runs/${q.runId}`}>
                      its run
                    </Link>
                  </>
                )}
              </>
            )}
            {variant === 'list' && (
              <>
                {' · '}
                <Link component={RouterLink} to={`/inbox/q/${q.id}`}>
                  Details
                </Link>
              </>
            )}
            {q.conversationId && (
              <>
                {' · '}
                <Link component={RouterLink} to={`/chat/${q.conversationId}`}>
                  Answer in chat
                </Link>
              </>
            )}
          </Typography>
          {q.pageTitle && (
            <Typography variant="body2" title={q.pageTitle} sx={{ ...WRAP, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              on “{q.pageTitle}”
            </Typography>
          )}
        </Box>
        {live && q.runId && <RunThumbnail runId={q.runId} />}
        {error && (
          <Alert severity="error" sx={{ mt: 2, ...WRAP }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        {done !== null ? (
          <Alert severity={done === 'Sent.' ? 'success' : 'info'} role="status" sx={{ mt: 2 }}>
            {done === 'gone' ? (q.input === 'save_login' ? `This offer is no longer open: it was answered, or it is too late to save it. ${SAVE_TOO_LATE_TEXT}` : 'This request was already answered or expired.') : done}
          </Alert>
        ) : expiredNow ? (
          <Alert severity="info" sx={{ mt: 2 }}>
            {q.input === 'save_login' ? SAVE_TOO_LATE_TEXT : 'This request expired.'}
          </Alert>
        ) : !pending ? (
          <Alert severity={q.status === 'answered' ? 'success' : 'info'} sx={{ mt: 2, ...WRAP }}>
            {answerText(q)}
            {q.response?.ruleId && (
              <>
                {' '}
                <Link component={RouterLink} to={savedApprovalHref(q.response.ruleId)}>
                  See the saved approval
                </Link>
              </>
            )}
          </Alert>
        ) : canAnswer ? (
          <QuestionAnswerForm question={q} busy={busy} onSubmit={answer} onOpenBrowser={q.viewerUrl && onOpenBrowser ? () => onOpenBrowser(q.viewerUrl!) : undefined} />
        ) : (
          <Alert severity="info" sx={{ mt: 2 }}>
            You can see this question but not answer it.
          </Alert>
        )}
      </CardContent>
    </Card>
  );

  if (variant === 'page') return card;
  // The space under the card collapses with it, so the cards below slide up instead of jumping.
  return (
    <Collapse in={!leaving} onExited={onLeft} unmountOnExit>
      <Box sx={{ pb: 2 }}>{card}</Box>
    </Collapse>
  );
}
