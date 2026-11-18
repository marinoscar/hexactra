import HelpOutlineIcon from '@mui/icons-material/HelpOutlineOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import PanToolOutlinedIcon from '@mui/icons-material/PanToolOutlined';
import VerifiedUserOutlinedIcon from '@mui/icons-material/VerifiedUserOutlined';
import { Alert, Box, Button, Chip, Paper, Stack, Typography } from '@mui/material';
import { useEffect, useRef, useState } from 'react';

import { useConfirm } from '../ui';
import { BrowserFrame } from './ChatBrowser';
import { QuestionAnswerForm } from './QuestionAnswerForm';
import { remaining, secretLabel, type AnswerBody, type Question } from './questions';
import type { RunFrame } from './useRunFrame';

const CARD_MAX = { xs: '100%', sm: 480 } as const;
const WRAP = { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 } as const;

/** What a request is, in a few words, and its icon. */
export function requestTitle(q: Pick<Question, 'input' | 'kind'>): string {
  if (q.input === 'confirm' || q.kind === 'confirmation') return 'Approval needed';
  if (q.input === 'secret') return `${secretLabel(q.kind)} needed`;
  if (q.input === 'takeover') return 'Your help is needed in the browser';
  // A sign-in the agent does itself (#524, #527).
  if (q.input === 'credentials' || (q.input === 'text' && q.kind === 'login')) return 'Sign-in needed';
  return 'A question for you';
}
function RequestIcon({ q }: { q: Pick<Question, 'input' | 'kind'> }) {
  if (q.input === 'confirm' || q.kind === 'confirmation') return <VerifiedUserOutlinedIcon color="primary" aria-hidden />;
  if (q.input === 'secret') return <KeyOutlinedIcon color="primary" aria-hidden />;
  if (q.input === 'takeover') return <PanToolOutlinedIcon color="primary" aria-hidden />;
  if (q.input === 'credentials' || (q.input === 'text' && q.kind === 'login')) return <KeyOutlinedIcon color="primary" aria-hidden />;
  return <HelpOutlineIcon color="primary" aria-hidden />;
}

/**
 * What the thread says once a request was answered here: never the answer of
 * a secret, only that it was provided.
 */
export function settledText(q: Pick<Question, 'input'>, answer: AnswerBody): string {
  if (answer.outcome === 'cancelled') return 'Declined';
  // Never the value; whether the site was asked to remember it, when that was offered.
  if (q.input === 'secret' || q.input === 'credentials') return answer.remember ? 'Provided · Remembered on this device' : 'Provided';
  if (q.input === 'confirm') return answer.value === 'approve' ? 'Allowed' : 'Denied';
  if (q.input === 'takeover' || q.input === 'none') return 'Done';
  return 'Sent';
}

/** `gone`: the API said the request was already settled (answered elsewhere, expired). */
export type RequestResult = void | 'gone';

export interface ChatRequestCardProps {
  question: Question;
  /** The page's shared clock, for the countdown. */
  now: number;
  /** Whether the viewer may answer (`runs:write`). */
  canAnswer: boolean;
  /** Sends the answer. Rejects when it failed: the card shows the message and keeps what was typed. */
  onAnswer: (answer: AnswerBody) => Promise<RequestResult>;
  /** The page being approved, for a confirmation; never passed for a secret. */
  frame?: RunFrame;
  /** Opens the browser large (the pane), from the picture of a confirmation. */
  onReview?: () => void;
  /** Opens the machine's desktop to do the step by hand ("Enter it in the browser myself"). */
  onOpenBrowser?: () => void;
}

/**
 * A request of the chat's run, in the thread (#488): an approval with the page
 * it is about and Deny / Allow, a code or a password with its masked field, a
 * choice, or a takeover. The form is the Inbox's (`QuestionAnswerForm`), so
 * every rule of an answer is the same; a secret is passed on once and never
 * kept here. The answer goes out as channel `web`.
 */
export function ChatRequestCard({ question: q, now, canAnswer, onAnswer, frame, onReview, onOpenBrowser }: ChatRequestCardProps) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const msLeft = new Date(q.expiresAt).getTime() - now;
  const expired = !(msLeft > 0);
  const isConfirm = q.input === 'confirm' || q.kind === 'confirmation';

  // A request needs its person: bring it into view when it arrives, and when they come back to the tab.
  useEffect(() => {
    const show = () => {
      if (document.visibilityState !== 'hidden') root.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    };
    show();
    document.addEventListener('visibilitychange', show);
    return () => document.removeEventListener('visibilitychange', show);
  }, [q.id]);

  const answer = async (a: AnswerBody) => {
    // The same check as the Inbox: a run cannot continue past a step its person declined.
    if (a.outcome === 'cancelled' && q.browserBound) {
      const sure = await confirm({ title: 'Decline?', body: 'The agent will be told you said no. Its run cannot continue past this step without an answer.', confirmLabel: 'Decline', cancelLabel: 'Keep it', destructive: true });
      if (!sure) return;
    }
    setBusy(true);
    setError(null);
    try {
      await onAnswer(a);
    } catch (e) {
      // The API's message; it never carries the answer.
      setError(e instanceof Error && e.message ? e.message : 'Could not send the answer');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Paper ref={root} variant="outlined" component="article" aria-label={`Request: ${q.prompt}`} sx={{ p: 1.5, width: '100%', maxWidth: CARD_MAX, borderRadius: 3, bgcolor: 'background.paper', borderColor: 'warning.main', scrollMarginBlock: 16, my: 0.75 }}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 1 }}>
        <RequestIcon q={q} />
        <Typography variant="subtitle2" component="p" sx={{ flex: 1, minWidth: 0 }}>
          {requestTitle(q)}
        </Typography>
        {q.risk === 'high' && <Chip size="small" color="error" variant="outlined" label="High risk" />}
        <Typography variant="caption" aria-label="Time left" sx={{ color: !expired && msLeft < 60_000 ? 'warning.main' : 'text.secondary', fontWeight: !expired && msLeft < 60_000 ? 600 : undefined, fontVariantNumeric: 'tabular-nums' }}>
          {expired ? 'expired' : `${remaining(q.expiresAt, now)} left`}
        </Typography>
      </Stack>
      <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap', ...WRAP }}>
        {q.prompt}
      </Typography>
      {q.pageTitle && (
        <Typography variant="body2" color="text.secondary" title={q.pageTitle} sx={{ ...WRAP, mt: 0.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          on “{q.pageTitle}”
        </Typography>
      )}
      {/* What is being approved: the page as it is now, and a way to look closer. */}
      {isConfirm && frame && !expired && (
        <Box sx={{ position: 'relative', mt: 1.5 }}>
          <BrowserFrame frame={frame} activity={null} hidden={false} now={now} />
          {onReview && (
            <Button size="small" variant="contained" color="inherit" startIcon={<OpenInFullIcon />} onClick={onReview} sx={{ position: 'absolute', right: 8, top: 8, minHeight: { xs: 44, sm: 32 }, bgcolor: 'background.paper', color: 'text.primary', '&:hover': { bgcolor: 'background.paper' } }}>
              Review
            </Button>
          )}
        </Box>
      )}
      {error && (
        <Alert severity="error" sx={{ mt: 2, ...WRAP }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {expired ? (
        <Alert severity="info" sx={{ mt: 2 }}>
          This request expired.
        </Alert>
      ) : canAnswer ? (
        <QuestionAnswerForm question={q} busy={busy} onSubmit={answer} onOpenBrowser={onOpenBrowser} />
      ) : (
        <Alert severity="info" sx={{ mt: 2 }}>
          You can see this request but not answer it.
        </Alert>
      )}
    </Paper>
  );
}

/** A request that is over, in one line where its card was: "Provided", "Allowed", or that it was closed elsewhere. */
export function RequestSettled({ text, tone = 'success' }: { text: string; tone?: 'success' | 'info' }) {
  return (
    <Alert severity={tone} role="status" variant="outlined" sx={{ width: '100%', maxWidth: CARD_MAX, borderRadius: 3, my: 0.75, py: 0 }}>
      {text}
    </Alert>
  );
}
