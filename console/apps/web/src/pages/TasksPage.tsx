import AddIcon from '@mui/icons-material/Add';
import ClearIcon from '@mui/icons-material/Clear';
import SearchIcon from '@mui/icons-material/Search';
import SortIcon from '@mui/icons-material/Sort';
import { Alert, Box, Button, Card, CardActionArea, Chip, Fab, IconButton, InputAdornment, Menu, MenuItem, Snackbar, Stack, TextField, Typography } from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import {
  ScheduledControl,
  TaskCard,
  TaskGoalExcerpt,
  TaskLastRun,
  TaskMachineCell,
  TaskName,
  TaskNextRun,
  TaskOutcomeStrip,
  TaskOverflowMenu,
  TaskPolicyCell,
  TaskPolicyLine,
  TaskRunButton,
  TaskScheduleCell,
  TaskSpendCell,
} from '../components/TaskListItems';
import { EXAMPLE_GOALS, TASK_FILTERS, TASK_SORTS, isFiltered, parseTaskListQuery, taskListSearchParams, taskPaths, type TaskListQuery } from '../components/taskList';
import { TaskActionError, useTaskActions } from '../components/useTaskActions';
import { useRunInputs } from '../taskParams/RunInputsDialog';
import { useTaskList } from '../components/useTaskList';
import { usePolicyCatalog } from '../policies/usePolicyCatalog';
import type { FleetHost } from '../types/fleet';
import type { TaskListSort, TaskScheduleState, TaskWithSummary } from '../types/tasks';
import { EmptyState, ErrorBanner, ListSkeleton, PageContainer, PageHeader, ResponsiveList, aboveBottomBar, useBreakpoint, type Column } from '../ui';

/** How long typing rests before the search is sent. */
export const SEARCH_DEBOUNCE_MS = 300;

const ANY_POLICY = '__any__';
/** What a notice clears on a phone: the "New task" button (56 px) and the 16 px on either side of it. */
const FAB_CLEARANCE = 16 + 56 + 16;

/** `/tasks`: every task at a glance (schedule, next run, last run, spend), with run, pause and open. */
export function TasksPage() {
  const { api, viewer } = usePlatformHost();
  const { isPhone } = useBreakpoint();
  const canWrite = viewer.hasPermission('tasks:write');
  const canRun = viewer.hasPermission('runs:write');
  const canReadRuns = viewer.hasPermission('runs:read');
  const canReadPolicies = viewer.hasPermission('agent_policies:read');
  // Reading tasks is what the page needs, so everyone here may open a task.
  const canOpen = true;

  const [params, setParams] = useSearchParams();
  const query = useMemo(() => parseTaskListQuery(params), [params]);
  const setQuery = useCallback((change: Partial<TaskListQuery>) => setParams((prev) => taskListSearchParams({ ...parseTaskListQuery(prev), ...change }), { replace: true }), [setParams]);

  const list = useTaskList(query);
  const actions = useTaskActions();
  const runInputs = useRunInputs();
  // One catalog for the page (it loads nothing without `agent_policies:read`); a failed load hides the policy parts.
  const catalog = usePolicyCatalog();
  const policiesShown = canReadPolicies && !catalog.error;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; runId?: string } | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [sortAnchor, setSortAnchor] = useState<HTMLElement | null>(null);

  // Search: typed text, sent 300 ms after the last key.
  const [text, setText] = useState(query.q);
  const sent = useRef(query.q);
  useEffect(() => {
    // The URL changed elsewhere ("Clear filters", back): the field follows it.
    if (query.q !== sent.current) {
      sent.current = query.q;
      setText(query.q);
    }
  }, [query.q]);
  useEffect(() => {
    if (text.trim() === sent.current) return;
    const timer = setTimeout(() => {
      sent.current = text.trim();
      setQuery({ q: text });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, setQuery]);

  // Machine names; without `fleet:read` a pinned machine shows the start of its id.
  const [hosts, setHosts] = useState<FleetHost[]>([]);
  useEffect(() => {
    if (!viewer.hasPermission('fleet:read')) return;
    api
      .get<FleetHost[]>('/fleet/hosts')
      .then(setHosts)
      .catch(() => setHosts([]));
  }, [api, viewer]);
  const hostName = useCallback((id: string) => hosts.find((h) => h.id === id)?.name ?? id.slice(0, 8), [hosts]);

  /** A failed action: its message (which names the task) shows, and a task that is gone leaves the list. */
  const failed = useCallback(
    (e: unknown, task: TaskWithSummary) => {
      setError(e instanceof Error ? e.message : `The change to “${task.name}” failed`);
      if (e instanceof TaskActionError && e.gone) list.remove(task.id);
    },
    [list],
  );

  const setScheduled = async (task: TaskWithSummary, on: boolean) => {
    setError(null);
    // Optimistic: the switch moves now and goes back if the request fails.
    const scheduleState: TaskScheduleState = on ? 'active' : 'paused';
    list.patch(task.id, (t) => ({ ...t, summary: { ...t.summary, scheduleState, nextRunAt: on ? t.summary.nextRunAt : null } }));
    setBusy((b) => ({ ...b, [task.id]: true }));
    try {
      const { skipped, ...changed } = await actions.setScheduled(task, on);
      list.replace(changed);
      if (skipped.length > 0) setError(`${skipped.length} schedule${skipped.length === 1 ? '' : 's'} of “${task.name}” stayed paused: the expression is no longer valid. Edit the task to fix it.`);
    } catch (e) {
      list.patch(task.id, () => task);
      failed(e, task);
    } finally {
      setBusy((b) => ({ ...b, [task.id]: false }));
    }
  };

  const run = async (task: TaskWithSummary, policyId?: string) => {
    if (task.summary.liveRunId && !(await actions.confirmRunAgain(task))) return;
    setError(null);
    setBusy((b) => ({ ...b, [task.id]: true }));
    try {
      // Values still missing are asked for first (#556); Cancel starts nothing.
      const started = await runInputs.ask(task, (inputs) => actions.run(task, policyId, inputs));
      if (!started) return;
      // The row shows the run at once; its 5 s refresh takes over from here. The page stays, so several tasks can be started.
      list.patch(task.id, (t) => ({
        ...t,
        summary: { ...t.summary, liveRunId: started.id, lastRun: { id: started.id, status: 'queued', trigger: 'manual', createdAt: new Date().toISOString(), finishedAt: null } },
      }));
      setNotice({ text: 'Run started', runId: started.id });
    } catch (e) {
      failed(e, task);
    } finally {
      setBusy((b) => ({ ...b, [task.id]: false }));
    }
  };

  const remove = async (task: TaskWithSummary) => {
    setError(null);
    try {
      if (!(await actions.remove(task))) return;
      list.remove(task.id);
      setNotice({ text: 'Task deleted' });
    } catch (e) {
      failed(e, task);
    }
  };

  const scheduled = (task: TaskWithSummary, showLabel: boolean) => (
    <ScheduledControl task={task} canWrite={canWrite} disabled={busy[task.id]} onChange={(on) => void setScheduled(task, on)} showLabel={showLabel} />
  );
  const rowActions = (task: TaskWithSummary) => (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', justifyContent: 'flex-end' }}>
      {canRun && <TaskRunButton task={task} catalog={policiesShown ? catalog : { policies: [], defaultId: null }} disabled={busy[task.id]} onRun={(policyId) => void run(task, policyId)} />}
      <TaskOverflowMenu task={task} canWrite={canWrite} canReadRuns={canReadRuns} onDelete={() => void remove(task)} />
    </Stack>
  );

  const columns: Column<TaskWithSummary>[] = [
    {
      key: 'task',
      header: 'Task',
      render: (t) => (
        <Box sx={{ minWidth: 120 }}>
          <TaskName task={t} canOpen={canOpen} />
          <TaskGoalExcerpt goal={t.goal} />
          {/* Below `xl` the Policy column is hidden: the policy and model stay on the row, here. */}
          {policiesShown && (
            <Box sx={{ display: { xl: 'none' } }} data-testid="task-policy-line">
              <TaskPolicyLine task={t} catalog={catalog} />
            </Box>
          )}
        </Box>
      ),
    },
    { key: 'schedule', header: 'Schedule', render: (t) => <Box sx={{ minWidth: 110, maxWidth: 220 }}><TaskScheduleCell task={t} catalog={policiesShown ? catalog : undefined} /></Box> },
    { key: 'next', header: 'Next run', render: (t) => <Box sx={{ maxWidth: 96, whiteSpace: 'normal' }}><TaskNextRun task={t} /></Box> },
    { key: 'last', header: 'Last run', render: (t) => <TaskLastRun task={t} canReadRuns={canReadRuns} stacked /> },
    { key: 'week', header: '7 days', hideBelow: 'lg', render: (t) => <TaskOutcomeStrip task={t} /> },
    ...(policiesShown ? [{ key: 'policy', header: 'Policy', hideBelow: 'xl', render: (t) => <TaskPolicyCell task={t} catalog={catalog} /> } satisfies Column<TaskWithSummary>] : []),
    { key: 'spend', header: 'Spend 30 d', hideBelow: 'lg', align: 'right', render: (t) => <TaskSpendCell task={t} /> },
    { key: 'machine', header: 'Machine', hideBelow: 'xl', render: (t) => <TaskMachineCell task={t} hostName={hostName} /> },
    { key: 'scheduled', header: 'Scheduled', render: (t) => scheduled(t, false) },
    { key: 'actions', header: <Box component="span" sx={visuallyHidden}>Actions</Box>, align: 'right', render: rowActions },
  ];

  // The Policy filter: once the tasks on screen use more than one policy (or one is chosen), and from then on.
  const policyFilterSeen = useRef(false);
  const policiesInUse = new Set((list.items ?? []).map((t) => t.summary.policy?.id).filter(Boolean)).size;
  if (policiesShown && catalog.policies.length > 0 && (policiesInUse > 1 || query.policyId !== null)) policyFilterSeen.current = true;
  const showPolicyFilter = policiesShown && catalog.policies.length > 0 && policyFilterSeen.current;

  const items = list.items;
  const filtered = isFiltered(query);
  const sortLabel = TASK_SORTS.find((s) => s.value === query.sort)?.label ?? 'Newest';
  const noTasks = items !== null && items.length === 0 && !list.loading && !list.error;

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Tasks"
        subtitle="What your agents do, and when."
        // On a phone the primary action is the floating button below.
        primary={{ key: 'new', label: 'New task', Icon: AddIcon, to: taskPaths.create, hidden: !canWrite || isPhone }}
      />
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <ErrorBanner error={list.error} onRetry={list.reload} />

      {/* The toolbar; hidden only when there is nothing to search (no task at all). */}
      {!(noTasks && !filtered) && (
        <Stack spacing={1.5} sx={{ mb: 2 }} role="search" aria-label="Find tasks">
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <TextField
              size="small"
              fullWidth
              placeholder="Search tasks"
              value={text}
              onChange={(e) => setText(e.target.value)}
              sx={{ maxWidth: { sm: 360 } }}
              slotProps={{
                htmlInput: { 'aria-label': 'Search tasks' },
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" />
                    </InputAdornment>
                  ),
                  endAdornment: text ? (
                    <InputAdornment position="end">
                      <IconButton
                        aria-label="Clear search"
                        edge="end"
                        size="small"
                        sx={{ width: { xs: 44, md: 32 }, height: { xs: 44, md: 32 }, mr: { xs: -1.5, md: -0.5 } }}
                        onClick={() => {
                          sent.current = '';
                          setText('');
                          setQuery({ q: '' });
                        }}
                      >
                        <ClearIcon fontSize="small" />
                      </IconButton>
                    </InputAdornment>
                  ) : undefined,
                },
              }}
            />
            <Box sx={{ flexGrow: 1, display: { xs: 'none', sm: 'block' } }} />
            {showPolicyFilter && !isPhone && policyFilter(query.policyId, (policyId) => setQuery({ policyId }), catalog.policies)}
            {isPhone ? (
              <>
                <IconButton aria-label={`Sort: ${sortLabel}`} aria-haspopup="menu" sx={{ width: 44, height: 44, flexShrink: 0 }} onClick={(e) => setSortAnchor(e.currentTarget)}>
                  <SortIcon />
                </IconButton>
                <Menu anchorEl={sortAnchor} open={Boolean(sortAnchor)} onClose={() => setSortAnchor(null)}>
                  {TASK_SORTS.map((s) => (
                    <MenuItem
                      key={s.value}
                      selected={s.value === query.sort}
                      sx={{ minHeight: 44 }}
                      onClick={() => {
                        setSortAnchor(null);
                        setQuery({ sort: s.value });
                      }}
                    >
                      {s.label}
                    </MenuItem>
                  ))}
                </Menu>
              </>
            ) : (
              <TextField select size="small" label="Sort" value={query.sort} onChange={(e) => setQuery({ sort: e.target.value as TaskListSort })} sx={{ minWidth: 140, flexShrink: 0 }}>
                {TASK_SORTS.map((s) => (
                  <MenuItem key={s.value} value={s.value}>
                    {s.label}
                  </MenuItem>
                ))}
              </TextField>
            )}
          </Stack>
          {showPolicyFilter && isPhone && policyFilter(query.policyId, (policyId) => setQuery({ policyId }), catalog.policies)}
          {/* One row; on a phone it scrolls sideways inside itself, never the page. */}
          <Stack direction="row" spacing={1} role="group" aria-label="Filter" sx={{ overflowX: 'auto', flexWrap: { xs: 'nowrap', sm: 'wrap' }, rowGap: 1, pb: { xs: 0.5, sm: 0 }, mx: { xs: -0.5, sm: 0 }, px: { xs: 0.5, sm: 0 } }}>
            {TASK_FILTERS.map((f) => {
              const selected = query.filter === f.value;
              return (
                <Chip
                  key={f.label}
                  label={f.label}
                  clickable
                  color={selected ? 'primary' : 'default'}
                  variant={selected ? 'filled' : 'outlined'}
                  aria-pressed={selected}
                  onClick={() => setQuery({ filter: f.value })}
                  sx={{ flexShrink: 0, height: { xs: 36, md: 32 } }}
                />
              );
            })}
          </Stack>
        </Stack>
      )}

      {items === null && !list.error && <ListSkeleton rows={6} />}

      {noTasks && !filtered && (
        <Box>
          <EmptyState
            title="Create your first task"
            body="A task is a goal your agent can run on demand or on a schedule."
            action={{ key: 'new', label: 'New task', Icon: AddIcon, to: taskPaths.create, hidden: !canWrite }}
          />
          {canWrite && (
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} component="ul" aria-label="Example tasks" sx={{ listStyle: 'none', p: 0, m: 0 }}>
              {EXAMPLE_GOALS.map((goal) => (
                <Card key={goal} variant="outlined" component="li" sx={{ flex: 1, minWidth: 0 }}>
                  <CardActionArea component={RouterLink} to={taskPaths.createFromGoal(goal)} sx={{ p: 2, minHeight: 64, height: '100%' }}>
                    <Typography variant="caption" color="text.secondary" component="div">
                      Example
                    </Typography>
                    <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                      {goal}
                    </Typography>
                  </CardActionArea>
                </Card>
              ))}
            </Stack>
          )}
        </Box>
      )}

      {noTasks && filtered && (
        <EmptyState
          title="No tasks match"
          body="Try another search or filter."
          action={{
            key: 'clear',
            label: 'Clear filters',
            onClick: () => {
              sent.current = '';
              setText('');
              setQuery({ q: '', filter: null, policyId: null });
            },
          }}
        />
      )}

      {items !== null && items.length > 0 && (
        // Tighter cells than the kit's default, so the columns fit beside the navigation rail.
        <Box sx={{ opacity: list.loading ? 0.6 : 1, transition: 'opacity 120ms', pb: { xs: 9, sm: 0 }, '& .MuiTableCell-root': { px: 0.75 } }} aria-busy={list.loading}>
          <ResponsiveList
            aria-label="Tasks"
            items={items}
            columns={columns}
            getKey={(t) => t.id}
            getLabel={(t) => t.name}
            renderCard={(t) => (
              <TaskCard task={t} catalog={policiesShown ? catalog : undefined} canOpen={canOpen} canReadRuns={canReadRuns} scheduled={scheduled(t, true)} actions={rowActions(t)} />
            )}
            footer={
              <Stack direction="row" spacing={2} sx={{ mt: 2, alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', rowGap: 1 }}>
                <Typography variant="body2" color="text.secondary" role="status">
                  {items.length === list.total ? `${list.total} ${list.total === 1 ? 'task' : 'tasks'}` : `${items.length} of ${list.total} tasks`}
                </Typography>
                {list.hasMore && (
                  <Button variant="outlined" onClick={list.loadMore} disabled={list.loadingMore} sx={{ minHeight: { xs: 44, md: 'auto' } }}>
                    {list.loadingMore ? 'Loading…' : 'Load more'}
                  </Button>
                )}
              </Stack>
            }
          />
        </Box>
      )}

      {isPhone && canWrite && (
        <Fab
          color="primary"
          aria-label="New task"
          component={RouterLink}
          to={taskPaths.create}
          // Above the phone's bottom navigation.
          sx={{ position: 'fixed', right: 16, bottom: aboveBottomBar(16).xs, zIndex: 'speedDial' }}
        >
          <AddIcon />
        </Fab>
      )}

      <Snackbar open={notice !== null} autoHideDuration={6000} onClose={(_e, reason) => reason !== 'clickaway' && setNotice(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} sx={{ bottom: { xs: aboveBottomBar(FAB_CLEARANCE).xs, sm: aboveBottomBar(24).sm } }}>
        <Alert
          severity="success"
          variant="filled"
          role="status"
          onClose={() => setNotice(null)}
          action={
            notice?.runId ? (
              <Button color="inherit" size="small" component={RouterLink} to={taskPaths.run(notice.runId)}>
                View
              </Button>
            ) : undefined
          }
        >
          {notice?.text}
        </Alert>
      </Snackbar>
      {runInputs.dialog}
    </PageContainer>
  );
}

/** Read by assistive technology, not shown; not absolutely positioned, which would widen the table's scroll area. */
const visuallyHidden = { display: 'inline-block', width: 0, height: 0, overflow: 'hidden', whiteSpace: 'nowrap', verticalAlign: 'top' } as const;

/** The Policy filter: every policy, the default, or one policy (`policyId` on the request). */
function policyFilter(value: string | null, onChange: (policyId: string | null) => void, policies: ReadonlyArray<{ id: string; name: string }>) {
  return (
    <TextField select size="small" label="Policy" value={value ?? ANY_POLICY} onChange={(e) => onChange(e.target.value === ANY_POLICY ? null : e.target.value)} sx={{ minWidth: 170, flexShrink: 0 }}>
      <MenuItem value={ANY_POLICY}>Any policy</MenuItem>
      <MenuItem value="default">Default</MenuItem>
      {policies.map((p) => (
        <MenuItem key={p.id} value={p.id}>
          {p.name}
        </MenuItem>
      ))}
      {value && value !== 'default' && !policies.some((p) => p.id === value) && <MenuItem value={value}>Unavailable policy</MenuItem>}
    </TextField>
  );
}
