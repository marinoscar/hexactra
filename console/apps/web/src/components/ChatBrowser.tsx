import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import LanguageIcon from '@mui/icons-material/Language';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import { Accordion, AccordionDetails, AccordionSummary, Box, Button, IconButton, Link, Paper, Stack, Typography } from '@mui/material';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { subscribeRun } from '../live';
import type { ChatMessage, ChatRun } from '../types/chat';
import type { RunStep } from '../types/runs';
import { StatusChip, formatCost, isLive, stopReasonLabel } from '../ui';
import { ActionOverlay, describeActivity, frameCaption, type RunActivity } from './RunActivity';
import { RunTimeline } from './RunTimeline';
import { softBudgetNotice } from './runBudget';
import type { RunFrame } from './useRunFrame';

const CARD_MAX = { xs: '100%', sm: 440 } as const;

/** What the Browser card and the pane say the run is doing, in a few words. */
export function browserStatusLine(run: Pick<ChatRun, 'status' | 'activity' | 'cancelRequested'>): string {
  if (run.cancelRequested && isLive(run.status)) return 'Stopping…';
  if (run.status === 'queued') return 'Starting the browser…';
  if (run.status === 'waiting_human') return 'Waiting for you';
  if (run.status === 'running') return run.activity ? `${describeActivity(run.activity)}…` : 'Working…';
  return '';
}

/**
 * The browser as a picture, on a neutral backdrop with a hairline border so a
 * white page does not glare in the dark theme. `hidden` replaces it with a
 * note (a secret is being asked for: what is on screen may show it).
 */
export function BrowserFrame({ frame, activity, hidden, now, fit = 'cover' }: { frame: RunFrame; activity: RunActivity | null; hidden: boolean; now: number; fit?: 'cover' | 'contain' }) {
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const backdrop = { borderRadius: 2, border: 1, borderColor: 'divider', bgcolor: 'action.hover', overflow: 'hidden' } as const;
  if (hidden) {
    return (
      <Stack role="status" spacing={1} sx={{ ...backdrop, alignItems: 'center', justifyContent: 'center', aspectRatio: '16 / 10', px: 2, textAlign: 'center', color: 'text.secondary' }}>
        <VisibilityOffOutlinedIcon aria-hidden />
        <Typography variant="body2">The browser is hidden while it waits for a secret.</Typography>
      </Stack>
    );
  }
  const caption = frameCaption(frame.shotAt, frame.failing, now);
  return (
    <Box>
      <Box sx={{ ...backdrop, position: 'relative', lineHeight: 0, ...(fit === 'cover' ? { aspectRatio: '16 / 10' } : {}) }}>
        {frame.src ? (
          <Box sx={{ position: 'relative', width: '100%', height: fit === 'cover' ? '100%' : 'auto' }}>
            <Box
              component="img"
              src={frame.src}
              alt="The browser right now"
              onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
              sx={{ display: 'block', width: '100%', height: fit === 'cover' ? '100%' : 'auto', objectFit: fit === 'cover' ? 'cover' : 'contain', objectPosition: 'top left' }}
            />
            {/* The marker is placed in the picture's own coordinates, so only where the whole picture shows. */}
            {fit === 'contain' && activity && <ActionOverlay activity={activity} natural={natural} />}
          </Box>
        ) : (
          <Box sx={{ aspectRatio: '16 / 10' }} />
        )}
      </Box>
      <Typography variant="caption" color={caption.stale ? 'warning.main' : 'text.secondary'} sx={{ display: 'block', mt: 0.5 }}>
        {caption.text}
      </Typography>
    </Box>
  );
}

/** The steps of a run, read from its own stream once the reader asks for them. */
function RunSteps({ runId, live }: { runId: string; live: boolean }) {
  const [steps, setSteps] = useState<RunStep[]>([]);
  useEffect(() => {
    setSteps([]);
    // The run's stream replays every step when it opens, then sends each new one.
    return subscribeRun(runId, (e) => {
      if (e.type !== 'step') return;
      const step = e.data as RunStep;
      setSteps((prev) => (prev.some((s) => s.seq === step.seq) ? prev : [...prev, step].sort((a, b) => a.seq - b.seq)));
    });
  }, [runId]);
  return steps.length === 0 ? (
    <Typography variant="body2" color="text.secondary">
      No steps yet.
    </Typography>
  ) : (
    <RunTimeline steps={steps} live={live} />
  );
}

function CardShell({ title, status, children, label }: { title: string; status?: ReactNode; children: ReactNode; label: string }) {
  return (
    <Paper variant="outlined" component="article" aria-label={label} sx={{ p: 1.5, width: '100%', maxWidth: CARD_MAX, borderRadius: 3, bgcolor: 'background.paper' }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
        <LanguageIcon color="primary" aria-hidden />
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="subtitle2" component="p">
            {title}
          </Typography>
          {status}
        </Box>
      </Stack>
      {children}
    </Paper>
  );
}

/** Near or over a chat's usual limit (#537): one line under the activity. A chat run is never stopped by its budget. */
export function SoftBudgetLine({ run }: { run: Pick<ChatRun, 'budget'> }) {
  const notice = softBudgetNotice(run.budget);
  if (!notice) return null;
  return (
    <Typography
      variant="body2"
      role="status"
      color={notice.tone === 'over' ? 'warning.main' : 'text.secondary'}
      sx={{ mt: 1, overflowWrap: 'anywhere' }}
      data-testid="soft-budget-line"
      data-tone={notice.tone}
    >
      {notice.text}
    </Typography>
  );
}

export interface BrowserCardProps {
  message: ChatMessage;
  /** The chat's newest run, when this card is about it; null for an earlier run of the chat. */
  run: ChatRun | null;
  frame: RunFrame;
  /** A secret is being asked for: no picture. */
  frameHidden: boolean;
  now: number;
  paneOpen: boolean;
  onOpen: () => void;
  /** Tells the page whether the card is on screen, so frames are only fetched for a picture someone can see. */
  onVisible: (visible: boolean) => void;
}

/**
 * The card of a run in the thread (#487): what the browser is doing, its
 * picture, and one button that opens the browser. One card per run: it
 * updates in place while the run is live and settles into a status line when
 * the run ends.
 */
export function BrowserCard({ message, run, frame, frameHidden, now, paneOpen, onOpen, onVisible }: BrowserCardProps) {
  const anchor = useRef<HTMLDivElement | null>(null);
  const live = run !== null && isLive(run.status);
  useEffect(() => {
    if (!live) return;
    // Where the browser cannot say (an old one, jsdom), the card counts as on screen.
    if (typeof IntersectionObserver === 'undefined' || !anchor.current) {
      onVisible(true);
      return () => onVisible(false);
    }
    const observer = new IntersectionObserver((entries) => onVisible(entries.some((e) => e.isIntersecting)));
    observer.observe(anchor.current);
    return () => {
      observer.disconnect();
      onVisible(false);
    };
  }, [live, onVisible]);

  const goal = (
    <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', mb: 1 }}>
      {message.text}
    </Typography>
  );
  const steps = message.runId && (
    <Accordion disableGutters elevation={0} slotProps={{ transition: { unmountOnExit: true } }} sx={{ mt: 1, bgcolor: 'transparent', '&::before': { display: 'none' } }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0, minHeight: 44, '& .MuiAccordionSummary-content': { my: 0 } }}>
        <Typography variant="body2">Steps{run ? ` (${run.stepCount})` : ''}</Typography>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 0, pt: 0 }}>
        <RunSteps runId={message.runId} live={live} />
      </AccordionDetails>
    </Accordion>
  );
  const openRun = message.runId && (
    <Link component={RouterLink} to={`/runs/${message.runId}`} variant="body2" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, minHeight: { xs: 44, sm: 'auto' } }}>
      Open run <OpenInNewIcon sx={{ fontSize: 16 }} aria-hidden />
    </Link>
  );

  if (!live) {
    return (
      <CardShell title="Browser" label="Browser run" status={run ? <StatusChip status={run.status} stopReason={run.stopReason} size="small" /> : undefined}>
        {goal}
        {!message.runId && (
          <Typography variant="body2" color="text.secondary">
            This run was deleted.
          </Typography>
        )}
        {steps}
        {openRun}
      </CardShell>
    );
  }

  return (
    <CardShell
      title="Browser"
      label="Browser run"
      status={
        <Typography variant="body2" color="text.secondary" role="status" aria-live="polite" noWrap>
          {browserStatusLine(run)}
        </Typography>
      }
    >
      <Box ref={anchor}>
        {/* Open: the picture is in the browser pane, one fetch feeds both. */}
        {!paneOpen && <BrowserFrame frame={frame} activity={run.activity} hidden={frameHidden} now={now} />}
      </Box>
      <SoftBudgetLine run={run} />
      <Button fullWidth variant="outlined" onClick={onOpen} disabled={paneOpen} sx={{ mt: 1, minHeight: 44, borderRadius: 3 }}>
        {paneOpen ? 'Browser is open' : 'Open browser'}
      </Button>
      {steps}
    </CardShell>
  );
}

export interface BrowserPaneProps {
  run: ChatRun;
  frame: RunFrame;
  frameHidden: boolean;
  now: number;
  canStop: boolean;
  onStop: () => void;
  /** Where "Take over" goes; null hides it (no desktop to open, or no permission). */
  takeOver: { to: string; label: string } | null;
  onClose: () => void;
}

/**
 * The browser, large (#487): the picture with a marker where the agent acts,
 * Stop, Take over and a link to the run. The page puts it beside the thread
 * on a wide window, above it on a tablet and in a full-screen sheet on a
 * phone.
 */
export function BrowserPane({ run, frame, frameHidden, now, canStop, onStop, takeOver, onClose }: BrowserPaneProps) {
  return (
    <Box component="section" aria-label="Browser" sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: 1.5, minHeight: 56, borderBottom: 1, borderColor: 'divider', flex: 'none' }}>
        <LanguageIcon color="primary" aria-hidden />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle2" component="h2">
            Browser
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap component="p" role="status" aria-live="polite">
            {browserStatusLine(run)}
          </Typography>
        </Box>
        <IconButton aria-label="Close the browser" onClick={onClose} sx={{ width: 44, height: 44 }}>
          <CloseIcon />
        </IconButton>
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', p: 1.5 }}>
        <BrowserFrame frame={frame} activity={run.status === 'running' ? run.activity : null} hidden={frameHidden} now={now} fit="contain" />
      </Box>
      <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 1, p: 1.5, borderTop: 1, borderColor: 'divider', flex: 'none', alignItems: 'center' }}>
        {canStop && (
          <Button color="error" variant="outlined" onClick={onStop} disabled={run.cancelRequested} sx={{ minHeight: 44 }}>
            {run.cancelRequested ? 'Stopping…' : 'Stop'}
          </Button>
        )}
        {takeOver && (
          <Button component={RouterLink} to={takeOver.to} variant="outlined" sx={{ minHeight: 44 }}>
            {takeOver.label}
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        <Link component={RouterLink} to={`/runs/${run.id}`} variant="body2" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, minHeight: 44 }}>
          Open run <OpenInNewIcon sx={{ fontSize: 16 }} aria-hidden />
        </Link>
      </Stack>
    </Box>
  );
}

interface ResultMeta {
  status?: string;
  stopReason?: string | null;
  costUsd?: number;
  costKnown?: boolean;
  stepCount?: number;
  /** Steps the owner confirmed that the run carried out (#540). */
  confirmedActions?: number;
}

/** The step a result's lead sentence names (#540), for the "Run again" question; null when it names none. */
export function confirmedPromptOf(text: string): string | null {
  return /^The step you confirmed was carried out \(step \d+: '(.+?)'\)/.exec(text)?.[1] ?? null;
}

/** A run that carried out a confirmed step and did not succeed (#540): never "Could not finish". */
export function endedAfterConfirmed(meta: { status?: string; confirmedActions?: number }): boolean {
  return (meta.confirmedActions ?? 0) > 0 && meta.status !== 'succeeded';
}

const RESULT_TITLE: Record<string, string> = { succeeded: 'Done', failed: 'Could not finish', cancelled: 'Stopped' };

export interface ResultCardProps {
  message: ChatMessage;
  /** Start the same job again; undefined hides the button (nothing to repeat, a run is live, or the viewer cannot write). */
  onRunAgain?: () => void;
  /** Draft a task from the chat and open it for review (#489); undefined hides the button (the viewer cannot write tasks). */
  onSaveAsTask?: () => void;
  /** The draft is being written: the button shows it and cannot be pressed twice. */
  saving?: boolean;
}

/** How a run ended, in the thread (#487): the result or the reason, what it cost, and what to do next. */
export function ResultCard({ message, onRunAgain, onSaveAsTask, saving = false }: ResultCardProps) {
  const meta = (message.meta ?? {}) as ResultMeta;
  const status = meta.status ?? '';
  const cost = formatCost(meta.costUsd, meta.costKnown ?? true);
  const reason = status !== 'succeeded' && meta.stopReason && meta.stopReason !== 'finished' && meta.stopReason !== 'cancelled' && meta.stopReason !== 'error' ? stopReasonLabel(meta.stopReason) : null;
  const confirmedEnd = endedAfterConfirmed(meta);
  const facts = [reason ? `Stopped: ${reason}` : null, typeof meta.stepCount === 'number' && meta.stepCount > 0 ? `${meta.stepCount} ${meta.stepCount === 1 ? 'step' : 'steps'}` : null, cost].filter(Boolean);
  return (
    <Paper
      variant="outlined"
      component="article"
      aria-label="Result"
      data-tone={confirmedEnd ? 'warning' : undefined}
      sx={{ p: 1.5, width: '100%', maxWidth: CARD_MAX, borderRadius: 3, bgcolor: 'background.paper', ...(confirmedEnd ? { border: 1, borderColor: 'warning.main', borderLeftWidth: 4 } : {}) }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1, flexWrap: 'wrap', rowGap: 0.5 }}>
        <Typography variant="subtitle2" component="p" sx={{ flex: 1, minWidth: 0, ...(confirmedEnd ? { color: 'warning.main' } : {}) }}>
          {confirmedEnd ? 'Ended after a confirmed step' : (RESULT_TITLE[status] ?? 'Finished')}
        </Typography>
        {status && <StatusChip status={status} size="small" />}
      </Stack>
      <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {message.text}
      </Typography>
      {facts.length > 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          {facts.join(' · ')}
        </Typography>
      )}
      {(onRunAgain || onSaveAsTask || message.runId) && (
        <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 1, mt: 1.5, alignItems: 'center' }}>
          {onSaveAsTask && status === 'succeeded' && (
            <Button variant="contained" onClick={onSaveAsTask} disabled={saving} sx={{ minHeight: { xs: 44, sm: 36 }, borderRadius: 3 }}>
              {saving ? 'Drafting…' : 'Save as task'}
            </Button>
          )}
          {onRunAgain && (
            <Button variant="outlined" onClick={onRunAgain} sx={{ minHeight: { xs: 44, sm: 36 }, borderRadius: 3 }}>
              Run again
            </Button>
          )}
          {message.runId && (
            <Link component={RouterLink} to={`/runs/${message.runId}`} variant="body2" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, minHeight: { xs: 44, sm: 'auto' } }}>
              Open run <OpenInNewIcon sx={{ fontSize: 16 }} aria-hidden />
            </Link>
          )}
        </Stack>
      )}
    </Paper>
  );
}
