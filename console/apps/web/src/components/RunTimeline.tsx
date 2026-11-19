import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutlineOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import HelpOutlineIcon from '@mui/icons-material/HelpOutlineOutlined';
import PhotoLibraryOutlinedIcon from '@mui/icons-material/PhotoLibraryOutlined';
import ReplyIcon from '@mui/icons-material/Reply';
import SwapVertIcon from '@mui/icons-material/SwapVert';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import { Box, Chip, Collapse, Link, List, ListItem, ListItemButton, ListItemIcon, ListItemText, Paper, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { Link as RouterLink, useInRouterContext } from 'react-router-dom';

import { savedApprovalHref } from '../approvals/types';
import type { RunStep } from '../types/runs';
import { ConnectionStepBody, isConnectionStep } from './connectionSteps';
import { RunPictures, StepThumbnail } from './RunPictures';
import { routingRow } from './runRouting';
import { formatStepDuration, groupSteps, type TimelineOrder, type TimelineStep } from './runTimeline';
import { answerLine, guidanceText, isAnswerStep, isGuidanceStep, isQuestionStep, questionKindLabel } from './runTrace';

/** A run step as the run page has it, with the trace fields of #541 when the API sends them. */
export interface RunTimelineStep
  extends TimelineStep,
    Partial<Pick<RunStep, 'screenshotMoment' | 'screenshotMasked' | 'screenshotNote' | 'questionId' | 'question' | 'createdAt'>> {
  args: Record<string, unknown> | null;
  reasoning: string | null;
}

const ORDER_KEY = 'hexactra.runs.stepOrder';

/** The viewer's remembered order, if any (storage can be unavailable). */
function savedOrder(): TimelineOrder | null {
  try {
    const v = localStorage.getItem(ORDER_KEY);
    return v === 'newest' || v === 'oldest' ? v : null;
  } catch {
    return null;
  }
}

function saveOrder(o: TimelineOrder) {
  try {
    localStorage.setItem(ORDER_KEY, o);
  } catch {
    // a convenience only
  }
}

function label(s: RunTimelineStep): string {
  return `${s.seq}. ${s.action ?? s.kind}${s.ok ? '' : ' (failed)'}: ${s.summary}`;
}

function detail(s: RunTimelineStep): string | undefined {
  const why = s.reasoning ?? (s.args ? JSON.stringify(s.args) : undefined);
  const took = formatStepDuration(s.durationMs);
  return [why, took].filter(Boolean).join(' · ') || undefined;
}

/** An escalation, de-escalation or model fallback (#405), as its own kind of row (#408). */
function RoutingStepRow({ step, label, direction }: { step: RunTimelineStep; label: string; direction: 'up' | 'down' | 'fallback' }) {
  return (
    <ListItem divider sx={{ pl: 2, bgcolor: 'action.hover' }} data-testid={`routing-${step.seq}`}>
      {/* The row wraps in a narrow pane; the arrow keeps its width and is never clipped. */}
      <ListItemIcon sx={{ minWidth: 32, flexShrink: 0 }}>
        <SwapVertIcon fontSize="small" color={direction === 'up' ? 'warning' : 'action'} />
      </ListItemIcon>
      <ListItemText primary={label} secondary={formatStepDuration(step.durationMs) ?? undefined} slotProps={{ primary: { sx: { fontWeight: 500, overflowWrap: 'anywhere' }, color: direction === 'up' ? 'warning.main' : undefined } }} sx={{ minWidth: 0 }} />
    </ListItem>
  );
}

/** What the rows share: the steps the owner confirmed (#540), when each question was answered, and whether the run is a chat's. */
interface TraceContextValue {
  confirmed: ReadonlySet<number>;
  /** The answer step's time, by question id: the fallback for an answer without `answeredAt`. */
  answeredAt: ReadonlyMap<string, string>;
  fromChat: boolean;
}
const TraceContext = createContext<TraceContextValue>({ confirmed: new Set(), answeredAt: new Map(), fromChat: false });

/** A link to a pending question's card, a router link inside the app. */
function QuestionLink({ id, children }: { id: string; children: ReactNode }) {
  const inRouter = useInRouterContext();
  const to = `/inbox/q/${id}`;
  return inRouter ? (
    <Link component={RouterLink} to={to} underline="hover">
      {children}
    </Link>
  ) : (
    <Link href={to} underline="hover">
      {children}
    </Link>
  );
}

/** A question the agent asked: the full prompt, its kind, and the answer (#544). */
function QuestionBody({ step }: { step: RunTimelineStep }) {
  const { answeredAt, fromChat } = useContext(TraceContext);
  const q = step.question!;
  const line = answerLine(q, { askedAt: step.createdAt, answeredAt: answeredAt.get(q.id) ?? null, fromChat });
  return (
    <>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {step.seq}. The agent asked
        </Typography>
        <Chip size="small" variant="outlined" label={questionKindLabel(q)} data-testid={`question-kind-${step.seq}`} />
      </Stack>
      <Typography variant="body2" sx={{ mt: 0.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }} data-testid={`question-prompt-${step.seq}`}>
        {q.prompt}
      </Typography>
      <Typography
        variant="body2"
        data-testid={`answer-${step.seq}`}
        color={line.state === 'declined' || line.state === 'expired' || line.state === 'cancelled' ? 'text.secondary' : line.state === 'pending' ? 'warning.main' : 'success.main'}
        sx={{ mt: 0.5, fontWeight: 500, overflowWrap: 'anywhere' }}
      >
        {line.state === 'pending' ? <QuestionLink id={q.id}>{line.text}</QuestionLink> : line.text}
      </Typography>
    </>
  );
}

/** The saved approval that let a step go ahead (#555 records `args.approval.ruleId`), or null. */
export function approvalRuleOf(step: Pick<RunTimelineStep, 'args'>): string | null {
  const approval = step.args?.approval;
  const id = approval && typeof approval === 'object' ? (approval as { ruleId?: unknown }).ruleId : null;
  return typeof id === 'string' && id ? id : null;
}

function StepRow({ step, repeats, nested }: { step: RunTimelineStep; repeats: number; nested?: boolean }) {
  const confirmed = useContext(TraceContext).confirmed.has(step.seq);
  const ruleId = approvalRuleOf(step);
  const routing = routingRow(step);
  if (routing) return <RoutingStepRow step={step} label={routing.label} direction={routing.direction} />;
  const question = isQuestionStep(step);
  const guidance = isGuidanceStep(step);
  const answer = isAnswerStep(step);
  const account = !question && !guidance && !answer && isConnectionStep(step);
  const Icon = !step.ok && !answer ? ErrorOutlineIcon : question ? HelpOutlineIcon : guidance ? ChatBubbleOutlineIcon : answer ? ReplyIcon : null;
  return (
    <ListItem divider sx={{ pl: nested ? 6 : 2, alignItems: 'flex-start' }} data-testid={`step-${step.seq}`} data-kind={question ? 'question' : guidance ? 'guidance' : answer ? 'answer' : step.kind}>
      {Icon && (
        <ListItemIcon sx={{ minWidth: 32, mt: 0.5, flexShrink: 0 }}>
          <Icon color={!step.ok && !answer ? 'error' : 'action'} fontSize="small" aria-label={!step.ok && !answer ? 'failed' : undefined} aria-hidden={!step.ok && !answer ? undefined : true} />
        </ListItemIcon>
      )}
      <Box sx={{ flex: '1 1 auto', minWidth: 0, py: 0.5 }}>
        {question ? (
          <QuestionBody step={step} />
        ) : guidance ? (
          <ListItemText primary={guidanceText(step.summary)} slotProps={{ primary: { sx: { overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' } } }} sx={{ m: 0 }} />
        ) : answer ? (
          <ListItemText primary={`${step.seq}. ${step.summary}`} slotProps={{ primary: { color: 'text.secondary', sx: { overflowWrap: 'anywhere' } } }} sx={{ m: 0 }} />
        ) : account ? (
          <ConnectionStepBody seq={step.seq} step={{ action: step.action, kind: step.kind, args: step.args, summary: step.summary, ok: step.ok }} />
        ) : (
          <ListItemText
            primary={`${label(step)}${repeats > 1 ? ` (×${repeats} in a row)` : ''}`}
            secondary={detail(step)}
            slotProps={{ primary: { color: step.ok ? undefined : 'error', sx: { overflowWrap: 'anywhere' } }, secondary: { sx: { overflowWrap: 'anywhere' } } }}
            sx={{ m: 0 }}
          />
        )}
        <StepThumbnail step={{ seq: step.seq, hasScreenshot: step.hasScreenshot, screenshotMoment: step.screenshotMoment ?? null, screenshotMasked: step.screenshotMasked ?? null }} />
      </Box>
      {confirmed && <Chip size="small" color="warning" variant="outlined" label="Confirmed by you" data-testid={`confirmed-${step.seq}`} sx={{ ml: 1, mt: 0.5, flexShrink: 0 }} />}
      {ruleId && (
        <Chip
          size="small"
          color="warning"
          variant="outlined"
          clickable
          component={RouterLink}
          to={savedApprovalHref(ruleId)}
          label="Allowed by a saved approval"
          data-testid={`saved-approval-${step.seq}`}
          sx={{ ml: 1, mt: 0.5, flexShrink: 0 }}
        />
      )}
    </ListItem>
  );
}

function ObservedRow({ steps }: { steps: RunTimelineStep[] }) {
  const [open, setOpen] = useState(false);
  const seqs = steps.map((s) => s.seq);
  const range = `${Math.min(...seqs)}–${Math.max(...seqs)}`;
  return (
    <>
      <ListItemButton divider onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ListItemIcon sx={{ minWidth: 32 }}>
          <VisibilityOutlinedIcon fontSize="small" color="action" />
        </ListItemIcon>
        <ListItemText
          primary={`${range}. Observed the page (${steps.length} steps)`}
          secondary={steps.map((s) => s.summary).join(' · ')}
          slotProps={{ primary: { color: 'text.secondary' }, secondary: { noWrap: true } }}
          sx={{ minWidth: 0 }}
        />
        {open ? <ExpandLessIcon /> : <ExpandMoreIcon />}
      </ListItemButton>
      <Collapse in={open} unmountOnExit>
        <List disablePadding dense>
          {steps.map((s) => (
            <StepRow key={s.id} step={s} repeats={1} nested />
          ))}
        </List>
      </Collapse>
    </>
  );
}

export interface RunTimelineProps {
  steps: RunTimelineStep[];
  live: boolean;
  /** The steps the owner confirmed (#540): marked "Confirmed by you". */
  confirmedSeqs?: readonly number[];
  /** The run's id: with it the rows show the run's pictures (#544), fetched with the session. */
  runId?: string;
  /** A chat's run: an answer given in the console reads "from the chat". */
  fromChat?: boolean;
}

/**
 * The run's steps, readable (#380): newest first while the run is live (a
 * toggle, remembered per viewer, flips it), page reads folded together, and
 * failures marked. With `runId` it is the run's trace (#544): each question
 * with its answer, the owner's guidance, the key-moment pictures with a
 * lightbox, and a "Pictures" filter.
 */
export function RunTimeline({ steps, live, confirmedSeqs = [], runId, fromChat = false }: RunTimelineProps) {
  const confirmed = useMemo(() => new Set(confirmedSeqs), [confirmedSeqs]);
  const answeredAt = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of steps) if (isAnswerStep(s) && s.questionId && s.createdAt) m.set(s.questionId, s.createdAt);
    return m;
  }, [steps]);
  const trace = useMemo(() => ({ confirmed, answeredAt, fromChat }), [confirmed, answeredAt, fromChat]);
  const [chosen, setChosen] = useState<TimelineOrder | null>(savedOrder);
  const [picturesOnly, setPicturesOnly] = useState(false);
  const order: TimelineOrder = chosen ?? (live ? 'newest' : 'oldest');
  const withPictures = runId !== undefined && steps.some((s) => s.hasScreenshot);
  const filtering = picturesOnly && withPictures;
  const rows = groupSteps(filtering ? steps.filter((s) => s.hasScreenshot) : steps, order);
  const list = (
    <Paper variant="outlined">
      <TraceContext.Provider value={trace}>
        <List aria-label="Steps" dense disablePadding>
          {rows.map((r) => (r.kind === 'observed' ? <ObservedRow key={r.key} steps={r.steps} /> : <StepRow key={r.key} step={r.step} repeats={r.steps.length} />))}
        </List>
      </TraceContext.Provider>
    </Paper>
  );
  return (
    <Box>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', mb: 1, flexWrap: 'wrap', rowGap: 1 }}>
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          Steps
        </Typography>
        {withPictures && (
          <ToggleButton size="small" value="pictures" selected={picturesOnly} onChange={() => setPicturesOnly((p) => !p)} sx={{ minHeight: { xs: 44, sm: 'auto' }, gap: 0.5 }}>
            <PhotoLibraryOutlinedIcon fontSize="small" aria-hidden />
            Pictures
          </ToggleButton>
        )}
        <ToggleButtonGroup
          size="small"
          exclusive
          value={order}
          aria-label="Step order"
          onChange={(_, v: TimelineOrder | null) => {
            if (!v) return;
            setChosen(v);
            saveOrder(v);
          }}
          sx={{ '& .MuiToggleButton-root': { minHeight: { xs: 44, sm: 'auto' } } }}
        >
          <ToggleButton value="newest">Newest first</ToggleButton>
          <ToggleButton value="oldest">Oldest first</ToggleButton>
        </ToggleButtonGroup>
      </Stack>
      {runId !== undefined && !live && steps.length > 0 && !withPictures && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }} data-testid="no-pictures">
          This run has no stored pictures.
        </Typography>
      )}
      {runId !== undefined ? (
        <RunPictures runId={runId} steps={steps}>
          {list}
        </RunPictures>
      ) : (
        list
      )}
    </Box>
  );
}
