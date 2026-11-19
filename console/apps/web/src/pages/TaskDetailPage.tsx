import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Alert, Box, Button, ButtonBase, Chip, Collapse, IconButton, Link, Paper, Stack, Tooltip, Typography } from '@mui/material';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link as RouterLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';

import { useFleetHosts } from '../components/MachinePicker';
import { describeActivity } from '../components/RunActivity';
import { RunList } from '../components/RunList';
import { getTaskDetail, getTaskRun, goalIsLong, nextSchedule, TASK_DETAIL_LIVE_REFRESH_MS, TASK_DETAIL_REFRESH_MS } from '../components/taskDetail';
import { ScheduledControl, TaskOverflowMenu, TaskRunButton } from '../components/TaskListItems';
import { taskPaths } from '../components/taskList';
import { TaskSchedulesSection } from '../components/TaskSchedulesSection';
import { TaskStats } from '../components/TaskStats';
import { useTaskActions } from '../components/useTaskActions';
import { useRunInputs } from '../taskParams/RunInputsDialog';
import { savedValueText } from '../taskParams/model';
import { policyLine, startModel } from '../policies/format';
import { usePolicyCatalog, type PolicyCatalog } from '../policies/usePolicyCatalog';
import { machineState, type FleetHost } from '../types/fleet';
import type { RunListItem } from '../types/runs';
import type { TaskWithSummary } from '../types/tasks';
import { CardSkeleton, EmptyState, ErrorBanner, PageContainer, PageHeader, RelativeTime, formatDateTime, isTerminal, toast, useBreakpoint } from '../ui';

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
const touch = { minHeight: { xs: 44, md: 'auto' } } as const;
const POLICIES_PATH = '/settings/agent-policies';

/** The header's subtitle: when the task runs next and on which schedule, or why it does not. */
function ScheduleSentence({ task }: { task: TaskWithSummary }) {
  const { summary } = task;
  if (summary.scheduleState === 'none') return <>Runs only when you start it</>;
  if (summary.scheduleState === 'paused') return <>Schedule paused</>;
  const next = nextSchedule(summary);
  if (!next) return <>Not scheduled yet</>;
  const more = summary.schedules.length - 1;
  return (
    <>
      <RelativeTime iso={next.nextRunAt} prefix="Next run " /> · {next.description || next.cron}
      {more > 0 && ` · +${more} more`}
      {summary.scheduleState === 'partial' && ' · partly paused'}
    </>
  );
}

/** What the live run is doing, with the way to it: Watch, or Answer when it waits for a person. */
function LiveBanner({ runId, run, fallbackStatus, canOpen }: { runId: string; run: RunListItem | null; fallbackStatus: string; canOpen: boolean }) {
  const status = run?.status ?? fallbackStatus;
  if (status === 'waiting_human') {
    return (
      <Alert
        severity="warning"
        data-testid="task-live-banner"
        sx={{ mb: 2, alignItems: 'center' }}
        action={
          <Button color="inherit" size="small" component={RouterLink} to={`/inbox?run=${runId}`} sx={touch}>
            Answer
          </Button>
        }
      >
        <strong>Needs you</strong>: the run is waiting for your answer.
      </Alert>
    );
  }
  const line = status === 'queued' ? 'waiting for a machine' : run?.activity ? describeActivity(run.activity) : 'working';
  return (
    <Alert
      severity="info"
      data-testid="task-live-banner"
      sx={{ mb: 2, alignItems: 'center', overflowWrap: 'anywhere' }}
      action={
        canOpen ? (
          <Button color="inherit" size="small" component={RouterLink} to={taskPaths.run(runId)} sx={touch}>
            Watch
          </Button>
        ) : undefined
      }
    >
      <strong>Running now</strong>: {line}
    </Alert>
  );
}

/** A titled part of the page. On a phone a `collapsible` one folds under its heading. */
function Section({ id, title, action, collapsible = false, startCollapsed = false, children }: { id?: string; title: string; action?: ReactNode; collapsible?: boolean; startCollapsed?: boolean; children: ReactNode }) {
  const { isPhone } = useBreakpoint();
  const [open, setOpen] = useState(!startCollapsed);
  const headingId = useId();
  const bodyId = useId();
  const folds = collapsible && isPhone;
  const heading = (
    <Typography variant="h6" component="h2" id={headingId}>
      {title}
    </Typography>
  );
  return (
    <Box component="section" id={id} aria-labelledby={headingId} sx={{ scrollMarginTop: '72px', minWidth: 0 }}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1, minHeight: folds ? 44 : undefined }}>
        {folds ? (
          <ButtonBase aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)} sx={{ flexGrow: 1, justifyContent: 'space-between', minHeight: 44, textAlign: 'left', borderRadius: 1 }}>
            {heading}
            <ExpandMoreIcon aria-hidden sx={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }} />
          </ButtonBase>
        ) : (
          heading
        )}
        {(!folds || open) && action}
      </Stack>
      {folds ? (
        <Collapse in={open} id={bodyId}>
          {children}
        </Collapse>
      ) : (
        children
      )}
    </Box>
  );
}

/** One line of the configuration: a term and its value. */
function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: '132px minmax(0, 1fr)', md: 'minmax(0, 1fr)', lg: '132px minmax(0, 1fr)' }, columnGap: 2, py: 0.75 }}>
      <Typography component="dt" variant="body2" color="text.secondary">
        {term}
      </Typography>
      <Typography component="dd" variant="body2" sx={{ m: 0, minWidth: 0, overflowWrap: 'anywhere' }}>
        {children}
      </Typography>
    </Box>
  );
}

/** The task's agent policy and the model its runs start on (ported from the task card's chips, #401). */
function PolicyRows({ task, catalog }: { task: TaskWithSummary; catalog: PolicyCatalog }) {
  if (catalog.error) {
    // The catalog could not be read: the reference itself, so the row is not empty.
    return (
      <Row term="Agent policy">
        {task.policyId ?? 'Default'} · <Box component="span" sx={{ color: 'text.secondary' }}>details unavailable</Box>
      </Row>
    );
  }
  if (catalog.loading) return <Row term="Agent policy">{task.summary.policy?.name ?? '…'}</Row>;
  const own = task.policyId ? catalog.byId(task.policyId) : undefined;
  const deleted = Boolean(task.policyId) && !own;
  const policy = own ?? catalog.byId(catalog.defaultId);
  if (!policy) return <Row term="Agent policy">{task.summary.policy?.name ?? 'Default'}</Row>;
  const { model } = startModel(policy.spec, catalog.effective);
  return (
    <>
      <Row term="Agent policy">
        <Link component={RouterLink} to={policy.builtin ? POLICIES_PATH : `${POLICIES_PATH}/${policy.id}`} underline="hover" data-testid="task-policy">
          {deleted ? `Default (${policy.name})` : own ? policy.name : `${policy.name} (default)`}
        </Link>
        {deleted && ": this task's policy was deleted."}
        <Box component="span" sx={{ display: 'block', color: 'text.secondary' }}>
          {policyLine(policy)}
        </Box>
      </Row>
      <Row term="Model">{model ? <Chip size="small" variant="outlined" label={model} data-testid="task-model" sx={{ maxWidth: '100%' }} /> : 'Not set'}</Row>
    </>
  );
}

function MachineRow({ task, hosts }: { task: TaskWithSummary; hosts: readonly FleetHost[] }) {
  if (!task.hostId) return <Row term="Machine">Any available machine</Row>;
  const host = hosts.find((h) => h.id === task.hostId);
  const name = host?.name ?? task.hostId.slice(0, 8);
  return (
    <Row term="Machine">
      {name}
      {task.hostFallback ? ', or another available machine when it is unavailable' : ' only'}
      {host && machineState(host) !== 'online' && (
        <Alert severity="warning" sx={{ mt: 1, py: 0 }}>
          {name} is {machineState(host)} right now. {task.hostFallback ? 'Runs will use another available machine until it is back.' : 'Runs will fail until it is back.'}
        </Alert>
      )}
    </Row>
  );
}

/**
 * `/tasks/:id`: a task's home (#428). What it does, how it is set up (its
 * agent policy and model included), when it runs next, how its runs went and
 * what they cost, with Run, "Run with…", the Scheduled switch, Edit, Duplicate
 * and Delete in the header. The sections are in-page anchors (`#runs`,
 * `#schedule`), not tabs: two columns from `md`, one below.
 */
export function TaskDetailPage() {
  const { api, viewer } = usePlatformHost();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const actions = useTaskActions();
  const runInputs = useRunInputs();
  const canWrite = viewer.hasPermission('tasks:write');
  const canRun = viewer.hasPermission('runs:write');
  const canReadRuns = viewer.hasPermission('runs:read');
  const canReadPolicies = viewer.hasPermission('agent_policies:read');
  const catalog = usePolicyCatalog();
  const hosts = useFleetHosts();

  const [task, setTask] = useState<TaskWithSummary | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The live run as the runs list serves it: its status and what it is doing. */
  const [liveRun, setLiveRun] = useState<RunListItem | null>(null);
  /** The last finished run, for why it stopped. */
  const [lastRun, setLastRun] = useState<RunListItem | null>(null);
  const lastRunRef = useRef<RunListItem | null>(null);
  lastRunRef.current = lastRun;
  /** Bumped by every local change, so an older refresh cannot overwrite it. */
  const epoch = useRef(0);

  const refresh = useCallback(
    async (first = false) => {
      const started = epoch.current;
      let next: TaskWithSummary;
      try {
        next = await getTaskDetail(api, id);
      } catch (e) {
        // A task that is not the viewer's answers 404 too; a malformed id is a 400.
        if (isPlatformApiError(e) && (e.status === 404 || e.status === 400)) setMissing(true);
        else if (first) setLoadError(e instanceof Error && e.message ? e.message : 'Could not load the task');
        return;
      }
      if (started !== epoch.current) return;
      setLoadError(null);
      setTask(next);
      if (!canReadRuns) return;
      const { liveRunId, lastRun: newest } = next.summary;
      // The run facts the summary leaves out; a failure only leaves them out of the page.
      if (liveRunId) {
        getTaskRun(api, id, true)
          .then((run) => setLiveRun(run && run.id === liveRunId ? run : null))
          .catch(() => undefined);
      } else setLiveRun(null);
      if (newest && isTerminal(newest.status) && lastRunRef.current?.id !== newest.id) {
        getTaskRun(api, id, false)
          .then((run) => setLastRun(run && run.id === newest.id ? run : null))
          .catch(() => undefined);
      }
    },
    [api, id, canReadRuns],
  );

  useEffect(() => {
    setTask(null);
    setMissing(false);
    setLiveRun(null);
    setLastRun(null);
    void refresh(true);
  }, [refresh]);

  // Every 15 s while the page is visible, every 5 s while a run is live, and when the window gets focus.
  const live = Boolean(task?.summary.liveRunId);
  const loaded = task !== null;
  useEffect(() => {
    if (!loaded || missing) return;
    const tick = () => {
      if (visible()) void refresh();
    };
    const timer = setInterval(tick, live ? TASK_DETAIL_LIVE_REFRESH_MS : TASK_DETAIL_REFRESH_MS);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }, [loaded, missing, live, refresh]);

  // `#runs` and `#schedule`: the section is on screen once the task has loaded.
  useEffect(() => {
    if (!loaded || !location.hash) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView?.({ block: 'start' });
  }, [loaded, location.hash]);

  if (missing) {
    return (
      <PageContainer width="wide">
        <EmptyState title="This task does not exist" body="It may have been deleted." action={{ key: 'tasks', label: 'Back to Tasks', to: taskPaths.list }} />
      </PageContainer>
    );
  }
  if (task === null) {
    return (
      <PageContainer width="wide">
        <PageHeader title="Task" back={{ to: taskPaths.list, label: 'Tasks' }} />
        <ErrorBanner error={loadError} onRetry={() => void refresh(true)} />
        {!loadError && <CardSkeleton />}
      </PageContainer>
    );
  }

  const failed = (e: unknown, fallback: string) => setError(e instanceof Error && e.message ? e.message : fallback);

  const setScheduled = async (on: boolean) => {
    setError(null);
    setBusy(true);
    epoch.current += 1;
    try {
      const { skipped, ...changed } = await actions.setScheduled(task, on);
      setTask(changed);
      if (skipped.length > 0) setError(`${skipped.length} schedule${skipped.length === 1 ? '' : 's'} stayed paused: the expression is no longer valid. Edit the schedule to fix it.`);
    } catch (e) {
      failed(e, 'Could not change the schedule');
    } finally {
      setBusy(false);
    }
  };

  const run = async (policyId?: string) => {
    if (task.summary.liveRunId && !(await actions.confirmRunAgain(task))) return;
    setError(null);
    setBusy(true);
    try {
      // Values still missing are asked for first (#556); Cancel starts nothing.
      const started = await runInputs.ask(task, (inputs) => actions.run(task, policyId, inputs));
      if (!started) return setBusy(false);
      // Unlike the list, the task page follows the run it started.
      navigate(taskPaths.run(started.id));
    } catch (e) {
      failed(e, 'Could not start the run');
      setBusy(false);
    }
  };

  const remove = async () => {
    setError(null);
    try {
      if (!(await actions.remove(task))) return;
      toast('Task deleted');
      navigate(taskPaths.list);
    } catch (e) {
      failed(e, 'Could not delete the task');
    }
  };

  const copyGoal = () => {
    const done = navigator.clipboard?.writeText(task.goal);
    if (!done) return toast('Copying is not available in this browser', 'error');
    done.then(
      () => toast('Goal copied'),
      () => toast('Could not copy the goal', 'error'),
    );
  };

  const { summary } = task;
  const policyCatalog = canReadPolicies && !catalog.error && !catalog.loading ? catalog : undefined;
  const foldGoal = goalIsLong(task.goal);
  const editLink = canWrite ? (
    <Link component={RouterLink} to={taskPaths.edit(task.id)} variant="body2" sx={{ display: 'inline-flex', alignItems: 'center', ...touch }}>
      Edit
    </Link>
  ) : undefined;

  return (
    <PageContainer width="wide">
      <PageHeader title={task.name} back={{ to: taskPaths.list, label: 'Tasks' }} subtitle={<ScheduleSentence task={task} />}>
        {/* The task's actions: the run control first, so it is on screen without scrolling on a phone. */}
        <Stack direction="row" useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', columnGap: 1.5, rowGap: 0.5 }}>
          {/* Without a readable catalog the run control is a plain button. */}
          {canRun && <TaskRunButton task={task} catalog={policyCatalog ?? { policies: [], defaultId: null }} onRun={(policyId) => void run(policyId)} disabled={busy} size="medium" />}
          {summary.scheduleState !== 'none' && <ScheduledControl task={task} canWrite={canWrite} onChange={(on) => void setScheduled(on)} disabled={busy} showLabel />}
          {canWrite && (
            <Button variant="outlined" component={RouterLink} to={taskPaths.edit(task.id)} sx={touch}>
              Edit
            </Button>
          )}
          {canWrite && <TaskOverflowMenu task={task} canWrite canReadRuns={canReadRuns} onDelete={() => void remove()} onTaskPage />}
        </Stack>
      </PageHeader>

      <ErrorBanner error={error} onClose={() => setError(null)} />
      {summary.liveRunId && (
        <LiveBanner runId={summary.liveRunId} run={liveRun} fallbackStatus={summary.lastRun?.id === summary.liveRunId ? summary.lastRun.status : 'running'} canOpen={canReadRuns} />
      )}

      {/* Two columns from `md` (the main one, and a 320 px side column: about 8/12 and 4/12 of the page's width, leaving the runs table its columns); below it one column, in reading order: statistics, runs, goal, schedules, configuration. */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 1fr) 320px' }, gap: 3, alignItems: 'start' }} data-testid="task-columns">
        {canReadRuns && (
          <Stack spacing={3} sx={{ minWidth: 0 }}>
            <TaskStats taskId={task.id} lastRun={summary.lastRun} lastStopReason={lastRun && lastRun.id === summary.lastRun?.id ? lastRun.stopReason : null} refreshKey={`${summary.lastRun?.id ?? ''}:${summary.lastRun?.status ?? ''}`} />
            <Section
              id="runs"
              title="Runs"
              action={
                <Link component={RouterLink} to={taskPaths.allRuns(task.id)} variant="body2" sx={{ display: 'inline-flex', alignItems: 'center', ...touch }}>
                  Open in Runs
                </Link>
              }
            >
              <RunList scope={{ taskId: task.id }} compact />
            </Section>
          </Stack>
        )}

        <Stack spacing={3} sx={{ minWidth: 0, gridColumn: canReadRuns ? undefined : '1 / -1' }}>
          <Section
            title="Goal"
            collapsible
            startCollapsed={foldGoal}
            action={
              <Tooltip title="Copy the goal">
                <IconButton aria-label="Copy the goal" onClick={copyGoal} sx={{ width: { xs: 44, md: 36 }, height: { xs: 44, md: 36 } }}>
                  <ContentCopyIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            }
          >
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography data-testid="task-goal" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {task.goal}
              </Typography>
            </Paper>
          </Section>

          <TaskSchedulesSection task={task} canWrite={canWrite} canReadRuns={canReadRuns} catalog={policyCatalog} onChanged={() => void refresh()} />

          <Section title="Configuration" collapsible startCollapsed={foldGoal} action={editLink}>
            <Paper variant="outlined" sx={{ px: 2, py: 1 }}>
              <Box component="dl" sx={{ m: 0 }}>
                {canReadPolicies && <PolicyRows task={task} catalog={catalog} />}
                <MachineRow task={task} hosts={hosts} />
                {(task.parameters?.length ?? 0) > 0 && (
                  <Row term="Parameters">
                    <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                      {task.parameters!.map((p) => (
                        <li key={p.key}>
                          {p.label}: {p.sensitive ? 'asked every time, never stored' : savedValueText(p)}
                        </li>
                      ))}
                    </Box>
                  </Row>
                )}
                <Row term="Browser profile">{task.profile}</Row>
                <Row term="Allowed sites">
                  {task.allowedDomains.length === 0 ? (
                    'Any site'
                  ) : (
                    <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                      {task.allowedDomains.map((site) => (
                        <Chip key={site} size="small" label={site} sx={{ maxWidth: '100%' }} />
                      ))}
                    </Stack>
                  )}
                </Row>
                <Row term="Ask before risky steps">{task.confirmRiskyActions ? 'Yes' : 'No'}</Row>
                {task.createdAt && <Row term="Created">{formatDateTime(task.createdAt)}</Row>}
                {task.updatedAt && <Row term="Last edited">{formatDateTime(task.updatedAt)}</Row>}
              </Box>
            </Paper>
          </Section>
        </Stack>
      </Box>
      {runInputs.dialog}
    </PageContainer>
  );
}
