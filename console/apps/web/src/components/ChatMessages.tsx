import TaskAltIcon from '@mui/icons-material/TaskAlt';
import { Box, Chip, Divider, Paper, Stack, Typography } from '@mui/material';
import { keyframes } from '@mui/material/styles';

import type { ChatMessage, ChatRun } from '../types/chat';
import { formatTime, useProfileTimeZone } from '../ui';
import { BrowserCard, ResultCard } from './ChatBrowser';
import { clarifyOptions, type ThreadRow } from './chatThread';
import type { RunFrame } from './useRunFrame';

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

/** A task the AI drafted, until its own card (#489): what it is. */
function DraftRow({ message }: { message: ChatMessage }) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, maxWidth: BUBBLE_MAX, borderRadius: 3, bgcolor: 'background.paper' }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
        <TaskAltIcon fontSize="small" color="primary" aria-hidden />
        <Typography variant="subtitle2" component="p">
          Drafted a task
        </Typography>
      </Stack>
      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {message.text}
      </Typography>
    </Paper>
  );
}

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
  /** Start the job of a finished run again; undefined when that is not possible now. */
  onRunAgain?: (result: ChatMessage) => void;
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
    return (
      <Typography role="status" variant="body2" color="text.secondary" sx={{ textAlign: 'center', my: 1, px: 2, overflowWrap: 'anywhere' }}>
        {message.text}
      </Typography>
    );
  }
  const mine = message.role === 'user';
  const options = clarifyOptions(message);
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
          onVisible={cards.onCardVisible}
        />
      ) : message.kind === 'result' ? (
        <ResultCard message={message} onRunAgain={cards.onRunAgain ? () => cards.onRunAgain?.(message) : undefined} />
      ) : message.kind === 'task_draft' ? (
        <DraftRow message={message} />
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
