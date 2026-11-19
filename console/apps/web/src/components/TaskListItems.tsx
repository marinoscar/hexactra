// The pieces of a task row (#426): the Scheduled switch, the run control, the
// overflow menu, the cells and the phone card. The Tasks list composes them;
// the task page (#428) reuses the switch, the run control and the menu.
import { TaskChips } from '../taskConnections/TaskChips';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { Box, Card, CardContent, Chip, Divider, IconButton, Link, ListItemText, Menu, MenuItem, Stack, Switch, Tooltip, Typography } from '@mui/material';
import { useId, useState, type MouseEvent, type ReactNode } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';

import { ScheduleSummary } from './ScheduleSummary';
import { outcomeStrip, spendCell, taskPaths } from './taskList';
import { taskPolicyChips } from '../policies/format';
import { RunWithButton } from '../policies/RunWithButton';
import type { PolicyCatalog } from '../policies/usePolicyCatalog';
import type { TaskWithSummary } from '../types/tasks';
import { RelativeTime, StatusChip } from '../ui';

/** What the Scheduled switch means, as its tooltip. */
export const SCHEDULED_HELP = 'On: runs on its schedule. Off: only runs when you start it.';

const DASH = '—';
const muted = { color: 'text.secondary' } as const;

export interface ScheduledControlProps {
  task: TaskWithSummary;
  /** `tasks:write`: without it the state is a read-only chip. */
  canWrite: boolean;
  /** Turn the task's schedules on (resume) or off (pause). */
  onChange: (on: boolean) => void;
  disabled?: boolean;
  /** Show the word next to the switch ("Scheduled", "Paused"); "Partly paused" always shows. */
  showLabel?: boolean;
}

/**
 * Whether the task runs on its schedule. A switch for someone who may change
 * tasks (off pauses every schedule, on resumes them), a chip otherwise, and a
 * link to add a schedule when the task has none. The word is "Scheduled",
 * never "Enabled": a paused task still runs when started by hand, API or MCP.
 */
export function ScheduledControl({ task, canWrite, onChange, disabled, showLabel = false }: ScheduledControlProps) {
  const state = task.summary.scheduleState;
  if (state === 'none') {
    if (!canWrite) return <Box component="span" sx={muted}>{DASH}</Box>;
    return (
      <Link component={RouterLink} to={taskPaths.editSchedule(task.id)} variant="body2" sx={{ display: 'inline-flex', alignItems: 'center', minHeight: { xs: 44, md: 'auto' }, whiteSpace: 'nowrap' }}>
        Add schedule
      </Link>
    );
  }
  const word = state === 'active' ? 'Scheduled' : state === 'partial' ? 'Partly paused' : 'Paused';
  if (!canWrite) return <Chip size="small" variant="outlined" color={state === 'active' ? 'primary' : 'default'} label={word} />;
  const partial = state === 'partial';
  return (
    <Tooltip title={SCHEDULED_HELP}>
      {/* The label is the tap target: 44 px high on every width. */}
      <Box component="label" sx={{ display: 'inline-flex', flexDirection: showLabel ? 'row' : 'column', alignItems: showLabel ? 'center' : 'flex-start', justifyContent: 'center', minHeight: 44, minWidth: 58, cursor: disabled ? 'default' : 'pointer' }}>
        <Switch
          checked={state === 'active'}
          disabled={disabled}
          onChange={(e) => onChange(partial ? true : e.target.checked)}
          slotProps={{ input: { 'aria-label': `Scheduled: ${task.name}`, ...(partial ? { 'aria-checked': 'mixed' as const } : {}) } }}
          // Partly paused: the thumb sits in the middle, in the primary colour.
          sx={partial ? { '& .MuiSwitch-switchBase': { transform: 'translateX(10px)', color: 'primary.light' }, '& .MuiSwitch-track': { bgcolor: 'primary.main', opacity: 0.3 } } : undefined}
        />
        {(showLabel || partial) && (
          <Typography variant="caption" sx={{ ...muted, whiteSpace: 'nowrap', lineHeight: 1.2, ...(showLabel ? {} : { pl: 1.5, mt: -0.5 }) }}>
            {word}
          </Typography>
        )}
      </Box>
    </Tooltip>
  );
}

export interface TaskRunButtonProps {
  task: TaskWithSummary;
  /** The policies "Run with…" offers; an empty catalog leaves a plain button. */
  catalog: Pick<PolicyCatalog, 'policies' | 'defaultId'>;
  /** Start a run; `policyId` is set when another policy was picked for this run. */
  onRun: (policyId?: string) => void;
  disabled?: boolean;
  size?: 'small' | 'medium';
}

/** "Run now" with "Run with…"; "Run again" while the task has a live run. */
export function TaskRunButton({ task, catalog, onRun, disabled, size = 'small' }: TaskRunButtonProps) {
  return <RunWithButton catalog={catalog} taskPolicyId={task.policyId} onRun={onRun} label={task.summary.liveRunId ? 'Run again' : 'Run now'} disabled={disabled} size={size} />;
}

export interface TaskOverflowMenuProps {
  task: TaskWithSummary;
  canWrite: boolean;
  /** `runs:read`: "View runs". */
  canReadRuns: boolean;
  onDelete: () => void;
  /** On the task's own page: only Duplicate and Delete (Open, Edit and the runs are on the page itself). */
  onTaskPage?: boolean;
}

/** A row's other actions: Open, Edit, Duplicate, View runs, Delete. */
export function TaskOverflowMenu({ task, canWrite, canReadRuns, onDelete, onTaskPage = false }: TaskOverflowMenuProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const menuId = useId();
  const close = () => setAnchor(null);
  const link = (to: string, label: string) => (
    <MenuItem component={RouterLink} to={to} onClick={close} sx={{ minHeight: 44 }}>
      <ListItemText>{label}</ListItemText>
    </MenuItem>
  );
  return (
    <>
      <IconButton
        aria-label={`More actions: ${task.name}`}
        aria-haspopup="menu"
        aria-controls={anchor ? menuId : undefined}
        aria-expanded={anchor ? 'true' : undefined}
        onClick={(e) => setAnchor(e.currentTarget)}
        sx={{ width: { xs: 44, md: 36 }, height: { xs: 44, md: 36 } }}
      >
        <MoreVertIcon />
      </IconButton>
      <Menu id={menuId} anchorEl={anchor} open={Boolean(anchor)} onClose={close}>
        {!onTaskPage && link(taskPaths.detail(task.id), 'Open')}
        {!onTaskPage && canWrite && link(taskPaths.edit(task.id), 'Edit')}
        {canWrite && link(taskPaths.duplicate(task.id), 'Duplicate')}
        {!onTaskPage && canReadRuns && link(taskPaths.runs(task.id), 'View runs')}
        {canWrite && <Divider />}
        {canWrite && (
          <MenuItem
            onClick={() => {
              close();
              onDelete();
            }}
            sx={{ minHeight: 44, color: 'error.main' }}
          >
            <ListItemText>Delete</ListItemText>
          </MenuItem>
        )}
      </Menu>
    </>
  );
}

/** The task's name, linking to the task; plain text when the viewer cannot open it. */
export function TaskName({ task, canOpen }: { task: TaskWithSummary; canOpen: boolean }) {
  const sx = { fontWeight: 600, overflowWrap: 'anywhere' } as const;
  if (!canOpen) return <Box component="span" sx={sx}>{task.name}</Box>;
  return (
    <Link component={RouterLink} to={taskPaths.detail(task.id)} underline="hover" color="text.primary" sx={sx}>
      {task.name}
    </Link>
  );
}

/** The first schedule in words ("Monday to Friday at 09:00"), "+2 more", or "Not scheduled"; `after` joins the small line under it (the card's next run). */
export function TaskScheduleCell({ task, catalog, after }: { task: TaskWithSummary; catalog?: Pick<PolicyCatalog, 'byId'>; after?: ReactNode }) {
  const [first, ...rest] = task.summary.schedules;
  if (!first) return <Typography variant="body2" sx={muted}>Not scheduled</Typography>;
  return (
    <Box sx={{ minWidth: 0, whiteSpace: 'normal' }}>
      <ScheduleSummary schedule={first} catalog={catalog} showNext={false} />
      {(rest.length > 0 || after) && (
        <Typography variant="caption" component="div" sx={muted}>
          {rest.length > 0 && <span title={rest.map((s) => s.description || s.cron).join('\n')}>+{rest.length} more</span>}
          {rest.length > 0 && after && ' · '}
          {after}
        </Typography>
      )}
    </Box>
  );
}

/** When the task runs next: "in 3 h", "Paused", or a dash. */
export function TaskNextRun({ task, prefix }: { task: TaskWithSummary; prefix?: string }) {
  const { scheduleState, nextRunAt } = task.summary;
  if (scheduleState === 'paused') return <Box component="span" sx={muted}>Paused</Box>;
  if (!nextRunAt) return <Box component="span" sx={muted} aria-label="No next run">{DASH}</Box>;
  return <RelativeTime iso={nextRunAt} prefix={prefix} />;
}

/** The last run's status and time, linking to the run; the live run while there is one; "Never run". */
export function TaskLastRun({ task, canReadRuns, stacked = false }: { task: TaskWithSummary; canReadRuns: boolean; stacked?: boolean }) {
  const { lastRun, liveRunId } = task.summary;
  // Stacked (the table): the time sits under the chip, so the column stays narrow.
  const layout = stacked ? ({ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0.25 } as const) : ({ display: 'inline-flex', alignItems: 'center', gap: 0.75 } as const);
  const wrap = (runId: string, label: string, children: ReactNode) =>
    canReadRuns ? (
      <Link component={RouterLink} to={taskPaths.run(runId)} underline="none" color="inherit" aria-label={label} sx={{ ...layout, minHeight: { xs: 32, md: 'auto' } }}>
        {children}
      </Link>
    ) : (
      <Box component="span" sx={layout}>{children}</Box>
    );
  if (liveRunId) {
    // The live run is normally the newest one: its own status ("needs you") says more than "running".
    const status = lastRun && lastRun.id === liveRunId ? lastRun.status : 'running';
    return wrap(liveRunId, `Live run of ${task.name}`, <StatusChip status={status} />);
  }
  if (!lastRun) return <Typography variant="body2" component="span" sx={muted}>Never run</Typography>;
  return wrap(
    lastRun.id,
    `Last run of ${task.name}: ${lastRun.status}`,
    <>
      <StatusChip status={lastRun.status} />
      <Typography variant={stacked ? 'caption' : 'body2'} component="span" sx={muted}>
        <RelativeTime iso={lastRun.finishedAt ?? lastRun.createdAt} />
      </Typography>
    </>,
  );
}

/** The last 7 days by outcome: "12 ✓ · 1 ✗". */
export function TaskOutcomeStrip({ task }: { task: TaskWithSummary }) {
  const { text, label } = outcomeStrip(task.summary.runCounts.last7d);
  return (
    <Box component="span" role="img" aria-label={label} title={label} sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', ...(text ? {} : muted) }}>
      {text ?? DASH}
    </Box>
  );
}

/** The policy a run of the task would use ("Balanced (default)") with its start model under it. */
export function TaskPolicyCell({ task, catalog }: { task: TaskWithSummary; catalog: Pick<PolicyCatalog, 'byId' | 'defaultId' | 'effective'> }) {
  const chips = taskPolicyChips(task, catalog);
  if (!chips) return <Box component="span" sx={muted}>{DASH}</Box>;
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="body2">{chips.policy}</Typography>
      {chips.model && (
        <Typography variant="caption" component="div" sx={{ ...muted, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }} title={chips.model}>
          {chips.model}
        </Typography>
      )}
    </Box>
  );
}

/** The policy and its start model on one muted line ("Balanced (default) · model"), where the Policy column is hidden. */
export function TaskPolicyLine({ task, catalog }: { task: TaskWithSummary; catalog: Pick<PolicyCatalog, 'byId' | 'defaultId' | 'effective'> }) {
  const chips = taskPolicyChips(task, catalog);
  if (!chips) return null;
  const text = [chips.policy, chips.model].filter(Boolean).join(' · ');
  return (
    <Typography variant="caption" component="div" title={text} sx={{ ...muted, display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>
      {text}
    </Typography>
  );
}

/** What the task's runs cost in the last 30 days: "$4.20", "≥ $4.20", or a dash. */
export function TaskSpendCell({ task }: { task: TaskWithSummary }) {
  const { text, detail } = spendCell(task.spend30d);
  return (
    <Tooltip title={detail}>
      <Box component="span" aria-label={text ? `${text} in the last 30 days: ${detail}` : detail} sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', ...(text ? {} : muted) }}>
        {text ?? DASH}
      </Box>
    </Tooltip>
  );
}

/** The machine the task runs on ("Any" by default), with its profile and allowed sites in the tooltip. */
export function TaskMachineCell({ task, hostName }: { task: TaskWithSummary; hostName: (id: string) => string }) {
  const sites = task.allowedDomains.length ? task.allowedDomains.join(', ') : 'any site';
  return (
    <Tooltip title={`Profile: ${task.profile} · Sites: ${sites}`}>
      <Box component="span" sx={{ whiteSpace: 'nowrap' }}>
        {task.hostId ? `${hostName(task.hostId)}${task.hostFallback ? '' : ' only'}` : 'Any'}
      </Box>
    </Tooltip>
  );
}

export interface TaskCardProps {
  task: TaskWithSummary;
  /** The policy catalog, when the viewer may read policies and it loaded. */
  catalog?: Pick<PolicyCatalog, 'byId' | 'defaultId' | 'effective'>;
  /** Whether the name and the card body open the task. */
  canOpen: boolean;
  canReadRuns: boolean;
  /** The footer's left side: the Scheduled switch. */
  scheduled: ReactNode;
  /** The footer's right side: the run control and the overflow menu. */
  actions: ReactNode;
}

/** A task below `md`: what it does, its schedule, its last run, its policy and spend, and its controls. */
export function TaskCard({ task, catalog, canOpen, canReadRuns, scheduled, actions }: TaskCardProps) {
  const navigate = useNavigate();
  const chips = catalog ? taskPolicyChips(task, catalog) : null;
  const spend = spendCell(task.spend30d).text;
  const line = [chips?.policy, chips?.model, spend ? `${spend} in 30 days` : null].filter(Boolean).join(' · ');
  // The card body opens the task; a link or a control inside it handles its own click.
  const open = (e: MouseEvent<HTMLElement>) => {
    if (canOpen && !(e.target as Element).closest('a, button, input, label, [role="button"]')) navigate(taskPaths.detail(task.id));
  };
  return (
    <Card variant="outlined" aria-label={`Task ${task.name}`}>
      <CardContent onClick={open} sx={{ cursor: canOpen ? 'pointer' : undefined, pb: 1.5, minWidth: 0 }}>
        <Typography variant="subtitle1" component="h2" sx={{ lineHeight: 1.3 }}>
          <TaskName task={task} canOpen={canOpen} />
        </Typography>
        <Typography variant="body2" title={task.goal} sx={{ ...muted, mt: 0.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>
          {task.goal}
        </Typography>
        <TaskChips task={task} mt={1} />
        <Box sx={{ mt: 1 }}>
          <TaskScheduleCell task={task} catalog={catalog} after={<TaskNextRun task={task} prefix="next " />} />
        </Box>
        <Stack direction="row" useFlexGap sx={{ mt: 1, flexWrap: 'wrap', columnGap: 1.5, rowGap: 0.5, alignItems: 'center' }}>
          <TaskLastRun task={task} canReadRuns={canReadRuns} />
          <Typography variant="body2" component="span">
            <TaskOutcomeStrip task={task} />
          </Typography>
        </Stack>
        {line && (
          <Typography variant="body2" data-testid="task-policy-line" sx={{ ...muted, mt: 1, overflowWrap: 'anywhere' }}>
            {line}
          </Typography>
        )}
      </CardContent>
      <Divider />
      <Stack direction="row" useFlexGap sx={{ pl: 0.5, pr: 1, py: 0.5, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', columnGap: 0.5, minHeight: 52 }}>
        <Box sx={{ minWidth: 0 }}>{scheduled}</Box>
        <Stack direction="row" sx={{ alignItems: 'center', ml: 'auto' }}>{actions}</Stack>
      </Stack>
    </Card>
  );
}

/** A one-line excerpt of a task's goal, with the whole goal as its tooltip. */
export function TaskGoalExcerpt({ goal }: { goal: string }) {
  return (
    <Typography variant="body2" title={goal} sx={{ ...muted, display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>
      {goal}
    </Typography>
  );
}
