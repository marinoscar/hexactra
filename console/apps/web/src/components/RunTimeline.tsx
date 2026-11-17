import { useState } from 'react';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import { Box, Collapse, List, ListItem, ListItemButton, ListItemIcon, ListItemText, Paper, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';

import { formatStepDuration, groupSteps, type TimelineOrder, type TimelineStep } from './runTimeline';

/** A run step as the run page has it. */
export interface RunTimelineStep extends TimelineStep {
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

function StepRow({ step, repeats, nested }: { step: RunTimelineStep; repeats: number; nested?: boolean }) {
  return (
    <ListItem divider sx={{ pl: nested ? 6 : 2, alignItems: 'flex-start' }} data-testid={`step-${step.seq}`}>
      {!step.ok && (
        <ListItemIcon sx={{ minWidth: 32, mt: 0.5 }}>
          <ErrorOutlineIcon color="error" fontSize="small" aria-label="failed" />
        </ListItemIcon>
      )}
      <ListItemText
        primary={`${label(step)}${repeats > 1 ? ` (×${repeats} in a row)` : ''}`}
        secondary={detail(step)}
        slotProps={{ primary: { color: step.ok ? undefined : 'error' }, secondary: { sx: { wordBreak: 'break-word' } } }}
      />
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

/**
 * The run's steps, readable (#380): newest first while the run is live (a
 * toggle, remembered per viewer, flips it), page reads folded together, and
 * failures marked.
 */
export function RunTimeline({ steps, live }: { steps: RunTimelineStep[]; live: boolean }) {
  const [chosen, setChosen] = useState<TimelineOrder | null>(savedOrder);
  const order: TimelineOrder = chosen ?? (live ? 'newest' : 'oldest');
  const rows = groupSteps(steps, order);
  return (
    <Box>
      <Stack direction="row" sx={{ alignItems: 'center', mb: 1 }}>
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          Steps
        </Typography>
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
        >
          <ToggleButton value="newest">Newest first</ToggleButton>
          <ToggleButton value="oldest">Oldest first</ToggleButton>
        </ToggleButtonGroup>
      </Stack>
      <Paper variant="outlined">
        <List aria-label="Steps" dense disablePadding>
          {rows.map((r) => (r.kind === 'observed' ? <ObservedRow key={r.key} steps={r.steps} /> : <StepRow key={r.key} step={r.step} repeats={r.steps.length} />))}
        </List>
      </Paper>
    </Box>
  );
}
