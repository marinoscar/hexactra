import TaskAltIcon from '@mui/icons-material/TaskAlt';
import { Box, Button, Chip, Divider, Link, Paper, Stack, Typography } from '@mui/material';
import { keyframes } from '@mui/material/styles';

import { Link as RouterLink } from 'react-router-dom';

import type { ChatGuidanceState, ChatMessage, ChatRun, ChatTaskDraft } from '../types/chat';
import { formatTime, useProfileTimeZone } from '../ui';
import { BrowserCard, ResultCard } from './ChatBrowser';
import { clarifyOptions, type ThreadRow } from './chatThread';
import type { RunFrame } from './useRunFrame';
import { ChatRequestRecord } from './ChatRequestRecord';
import { MemoryProposalCard } from './MemoryProposalCard';
import { SaveLoginCard } from './SaveLoginCard';

const BUBBLE_MAX = { xs: '88%', sm: '76%' } as const;

/** A day separator: "Today", "Yesterday", or the date. */
function DayRow({ label }: { label: string }) {
  return (
    <Divider role="separator" aria-label={label} sx={{ my: 1.5, '&::before, &::after': { borderColor: 'divider' } }}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Divider>
  );
}

/** The time under a bubble. */
function Stamp({ iso, align }: { iso: string; align: 'left' | 'right' }) {
  const timeZone = useProfileTimeZone();
  return (
    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: align, mt: 0.25, px: 0.5 }}>
      {formatTime(iso, { timeZone })}
    </Typography>
  );
}

/** The task a `task_draft` message carries, when its `meta` is one. */
export function draftOf(message: Pick<ChatMessage, 'kind' | 'meta' | 'text'>): ChatTaskDraft | null {
  if (message.kind !== 'task_draft') return null;
  const meta = message.meta as Partial<ChatTaskDraft> | null;
  const goal = typeof meta?.goal === 'string' && meta.goal.trim() ? meta.goal : message.text;
  if (!goal.trim()) return null;
  return {
    name: typeof meta?.name === 'string' ? meta.name : '',
    goal,
    profile: typeof meta?.profile === 'string' ? meta.profile : 'default',
    hostId: typeof meta?.hostId === 'string' ? meta.hostId : null,
    hostFallback: meta?.hostFallback !== false,
    policyId: typeof meta?.policyId === 'string' ? meta.policyId : null,
    allowedDomains: Array.isArray(meta?.allowedDomains) ? meta.allowedDomains.filter((d): d is string => typeof d === 'string') : [],
    confirmRiskyActions: meta?.confirmRiskyActions === true,
  };
}

/** A task the assistant drafted from the chat (#489): its name, its goal, and the way to review and save it. */
function DraftCard({ message, onReview }: { message: ChatMessage; onReview?: (draft: ChatTaskDraft) => void }) {
  const draft = draftOf(message);
  return (
    <Paper variant="outlined" component="article" aria-label="Task draft" sx={{ p: 1.5, width: '100%', maxWidth: { xs: '100%', sm: 440 }, borderRadius: 3, bgcolor: 'background.paper' }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
        <TaskAltIcon fontSize="small" color="primary" aria-hidden />
        <Typography variant="subtitle2" component="p">
          {draft?.name || 'A task from this chat'}
        </Typography>
      </Stack>
      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {draft?.goal ?? message.text}
      </Typography>
      {draft && onReview && (
        <Button variant="contained" onClick={() => onReview(draft)} sx={{ mt: 1.5, minHeight: { xs: 44, sm: 36 }, borderRadius: 3 }}>
          Review and save
        </Button>
      )}
    </Paper>
  );
}

/** The line under an owner message that was passed to the working agent (#490). */
export const GUIDANCE_LABEL: Record<ChatGuidanceState, string> = {
  queued: 'Queued for the agent',
  delivered: 'Seen by the agent',
  missed: 'Not seen: the job had ended',
};

/** What the run and result cards of a thread need from the page (#487). */
export interface ThreadCards {
  /** The chat's newest run; the card of that run is live, every other run's card is settled. */
  run: ChatRun | null;
  frame: RunFrame;
  frameHidden: boolean;
  now: number;
  paneOpen: boolean;
  onOpenBrowser: () => void;
  onCardVisible: (visible: boolean) => void;
  /** Resume the chat's paused run (E38.2); undefined without `runs:write`. */
  onResumeRun?: () => void;
  /** Owner messages passed to a run as guidance, by `seq` (#490): each shows what became of it. */
  guidance?: ReadonlyMap<number, ChatGuidanceState>;
  /** Start the job of a finished run again; undefined when that is not possible now. */
  onRunAgain?: (result: ChatMessage) => void;
  /** Draft a task from the chat (the result card's button); undefined when the viewer cannot write tasks. */
  onSaveAsTask?: () => void;
  /** A draft is being written. */
  savingTask?: boolean;
  /** Open a drafted task in the task form; undefined when the viewer cannot write tasks. */
  onReviewDraft?: (draft: ChatTaskDraft) => void;
}

export interface MessageRowProps {
  message: ChatMessage;
  /** The suggested answers of a clarifying question can be tapped (the newest message of a chat the viewer may write to). */
  answerable: boolean;
  onAnswer: (text: string) => void;
  cards: ThreadCards;
}

/** One message of the thread: the owner's on the right, the assistant's on the left, a system line in the middle. */
export function MessageRow({ message, answerable, onAnswer, cards }: MessageRowProps) {
  if (message.role === 'system') {
    // "Saved as the task …" carries the task's id (#489): the line links to it.
    const taskId = (message.meta as { taskId?: unknown } | null)?.taskId;
    return (
      <Typography role="status" variant="body2" color="text.secondary" sx={{ textAlign: 'center', my: 1, px: 2, overflowWrap: 'anywhere' }}>
        {message.text}
        {typeof taskId === 'string' && (
          <>
            {' '}
            <Link component={RouterLink} to={`/tasks/${taskId}`}>
              Open the task
            </Link>
          </>
        )}
      </Typography>
    );
  }
  const mine = message.role === 'user';
  const options = clarifyOptions(message);
  const guided = mine ? cards.guidance?.get(message.seq) : undefined;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start', my: 0.75 }} data-seq={message.seq}>
      {message.kind === 'run' ? (
        <BrowserCard
          message={message}
          run={cards.run && cards.run.id === message.runId ? cards.run : null}
          frame={cards.frame}
          frameHidden={cards.frameHidden}
          now={cards.now}
          paneOpen={cards.paneOpen}
          onOpen={cards.onOpenBrowser}
          onResume={cards.onResumeRun}
          onVisible={cards.onCardVisible}
        />
      ) : message.kind === 'result' ? (
        <ResultCard message={message} onRunAgain={cards.onRunAgain ? () => cards.onRunAgain?.(message) : undefined} onSaveAsTask={cards.onSaveAsTask} saving={cards.savingTask} />
      ) : message.kind === 'task_draft' ? (
        <DraftCard message={message} onReview={cards.onReviewDraft} />
      ) : message.kind === 'request' ? (
        <ChatRequestRecord message={message} />
      ) : message.kind === 'memory' && typeof (message.meta as { questionId?: unknown } | null)?.questionId === 'string' ? (
        (message.meta as { card?: unknown }).card === 'save_login' ? (
          <SaveLoginCard questionId={(message.meta as { questionId: string }).questionId} />
        ) : (
          <MemoryProposalCard questionId={(message.meta as { questionId: string }).questionId} />
        )
      ) : (
        <Box
          sx={{
            maxWidth: BUBBLE_MAX,
            px: 1.75,
            py: 1,
            borderRadius: 3,
            // The tail corner: the owner's bubble points right, the assistant's left.
            ...(mine ? { borderBottomRightRadius: 6, bgcolor: 'primary.main', color: 'primary.contrastText' } : { borderBottomLeftRadius: 6, bgcolor: 'action.hover', color: 'text.primary' }),
          }}
        >
          <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {message.text}
          </Typography>
        </Box>
      )}
      {guided && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.25, mr: 0.5 }} data-guidance={guided}>
          {GUIDANCE_LABEL[guided]}
        </Typography>
      )}
      {options.length > 0 && (
        <Stack direction="row" role="group" aria-label="Suggested answers" sx={{ flexWrap: 'wrap', gap: 1, mt: 1, maxWidth: BUBBLE_MAX }}>
          {options.map((option) => (
            <Chip
              key={option}
              label={option}
              variant="outlined"
              color="primary"
              disabled={!answerable}
              onClick={answerable ? () => onAnswer(option) : undefined}
              sx={{ height: 'auto', minHeight: { xs: 44, sm: 32 }, '& .MuiChip-label': { whiteSpace: 'normal', py: 0.5 } }}
            />
          ))}
        </Stack>
      )}
      <Stamp iso={message.createdAt} align={mine ? 'right' : 'left'} />
    </Box>
  );
}

const bounce = keyframes`
  0%, 60%, 100% { transform: translateY(0); opacity: 0.45; }
  30% { transform: translateY(-4px); opacity: 1; }
`;

/** Three dots in an assistant bubble while the AI works. Still for anyone who asked for less motion. */
export function TypingIndicator() {
  return (
    <Box role="status" aria-label="The assistant is working" sx={{ display: 'flex', my: 0.75 }}>
      <Box sx={{ display: 'inline-flex', gap: 0.5, px: 1.75, py: 1.5, borderRadius: 3, borderBottomLeftRadius: 6, bgcolor: 'action.hover' }}>
        {[0, 1, 2].map((i) => (
          <Box
            key={i}
            sx={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              bgcolor: 'text.secondary',
              animation: `${bounce} 1.2s ${i * 0.15}s infinite ease-in-out`,
              '@media (prefers-reduced-motion: reduce)': { animation: 'none', opacity: 0.7 },
            }}
          />
        ))}
      </Box>
    </Box>
  );
}

/** The rows of a thread: day separators and messages. */
export function ThreadRows({ rows, answerableSeq, onAnswer, cards }: { rows: readonly ThreadRow[]; answerableSeq: number | null; onAnswer: (text: string) => void; cards: ThreadCards }) {
  return (
    <>
      {rows.map((row) =>
        row.type === 'day' ? <DayRow key={row.key} label={row.label} /> : <MessageRow key={row.key} message={row.message} answerable={row.message.seq === answerableSeq} onAnswer={onAnswer} cards={cards} />,
      )}
    </>
  );
}
