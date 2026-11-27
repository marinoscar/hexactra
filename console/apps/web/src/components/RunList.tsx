import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ClearIcon from '@mui/icons-material/Clear';
import FilterListIcon from '@mui/icons-material/FilterList';
import ListAltOutlinedIcon from '@mui/icons-material/ListAltOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import SearchIcon from '@mui/icons-material/Search';
import SearchOffIcon from '@mui/icons-material/SearchOff';
import {
  Alert,
  Badge,
  Box,
  Button,
  CardActionArea,
  Chip,
  CircularProgress,
  Drawer,
  IconButton,
  InputAdornment,
  Link,
  Menu,
  MenuItem,
  Paper,
  Snackbar,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router-dom';
import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';

import { RunWithMenu } from '../policies/RunWithButton';
import { usePolicyCatalog } from '../policies/usePolicyCatalog';
import type { RunListItem, RunsDeleted, RunsDeleteQueued } from '../types/runs';
import {
  EmptyState,
  ErrorBanner,
  ListSkeleton,
  RelativeTime,
  ResponsiveList,
  StatusChip,
  formatCost,
  formatDateTime,
  isLive,
  useApiAction,
  aboveBottomBar,
  useBreakpoint,
  useConfirm,
  useProfileTimeZone,
  type Column,
} from '../ui';
import { describeActivity, useNow } from './RunActivity';
import { ONE_OFF, RunFilterControls, type TaskOption } from './RunFilterControls';
import { TIER_LABEL } from './runBudget';
import {
  DATE_PRESETS,
  NO_FILTERS,
  RUN_VIEWS,
  RUN_VIEW_LABEL,
  STOP_FILTER_LABEL,
  TRIGGER_LABEL,
  activeFilterCount,
  deleteFilter,
  filtersFromParams,
  filtersToParams,
  finishedCount,
  presetOf,
  showsStopFilter,
  startOfDay,
  viewCount,
  type RunFilters,
  type RunListScope,
  type RunView,
} from './runFilters';
import { ORIGIN_LABEL, StartedByChip, appDisplayName } from './StartedByChip';
import { useRunExport } from './RunExport';
import { RUN_MENU_LABEL, rowCost, runAgain, runAgainQuestionFor, runDuration, runMenuActions, triggerWords, type RunMenuAction } from './runRow';
import { useRunList } from './useRunList';

/** The most ids one `POST /runs/delete` takes. */
export const DELETE_IDS_CHUNK = 500;
/** Deleting more runs than this asks the user to type "delete". */
export const DELETE_TYPE_TO_CONFIRM = 100;
/** Past this many rows the list is windowed. */
export const WINDOW_AFTER = 300;
/** How often a background delete's progress is read. */
export const BACKGROUND_POLL_MS = 3_000;
const SEARCH_DEBOUNCE_MS = 300;

export interface RunListProps {
  /** Fixes the list to one task (the task page): no Task filter, and the task name is not repeated on each row. */
  scope?: RunListScope;
  /** Show each run's task name above its goal, as a link to the task. */
  showTaskColumn?: boolean;
  /** For a list inside another page: 25 rows a page, no counts strip, no Profile and Policy columns; with a `scope`, no Goal column either (the table only: a card keeps the goal). */
  compact?: boolean;
  /** "New run", offered by the empty state when the user has no run at all. */
  onNewRun?: () => void;
}

const n = (value: number) => value.toLocaleString('en-US');
const runs = (count: number) => `${n(count)} run${count === 1 ? '' : 's'}`;
const clamp = (lines: number) => ({ display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden', overflowWrap: 'anywhere' as const });

function isQueued(res: RunsDeleted | RunsDeleteQueued): res is RunsDeleteQueued {
  return 'jobId' in res;
}

/**
 * The runs list (#423): status tabs with counts, search and filters kept in
 * the URL, a paged list (a table at `md` and up, cards below) with a live
 * refresh, a menu per run, and select with bulk delete. `RunsPage` is this
 * under a header; the task page embeds it with `scope={{ taskId }}`.
 */
export function RunList({ scope, showTaskColumn = false, compact = false, onNewRun }: RunListProps) {
  const { api, viewer } = usePlatformHost();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { isDesktop } = useBreakpoint();
  const timeZone = useProfileTimeZone();
  const canWrite = viewer.hasPermission('runs:write');
  const canDelete = viewer.hasPermission('runs:delete');
  const canReadPolicies = viewer.hasPermission('agent_policies:read');
  const canReadTasks = viewer.hasPermission('tasks:read');
  const catalog = usePolicyCatalog({ withTiers: false });
  const scoped = scope?.taskId !== undefined;
  /** The list of one AI app's runs (its page, #464): no "Started by" filter or column. */
  const scopedApp = scope?.clientId !== undefined;
  const canReadApps = viewer.hasPermission('connected_apps:read');

  // ---- Filters, in the URL ----
  const [params, setParams] = useSearchParams();
  const paramText = params.toString();
  // The text is the identity of the parameters: `params` is a new object on every render.
  const filters = useMemo(() => filtersFromParams(params), [paramText]);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const setFilters = useCallback(
    (next: RunFilters) => {
      const cleaned = showsStopFilter(next.view) ? next : { ...next, stopReason: [] };
      setParams((prev) => filtersToParams(cleaned, prev), { replace: true });
    },
    [setParams],
  );

  const list = useRunList({ scope, filters, pageSize: compact ? 25 : undefined });
  const { items, counts, nextCursor, loadMore, reload, refreshCounts, removeRuns, updateRun } = list;
  const action = useApiAction();
  const [toast, setToast] = useState<string | null>(null);
  const now = useNow(items.some((r) => isLive(r.status)), 30_000);

  // ---- Search, debounced ----
  const [search, setSearch] = useState(filters.q);
  useEffect(() => setSearch(filters.q), [filters.q]);
  useEffect(() => {
    if (search.trim() === filtersRef.current.q.trim()) return;
    const timer = setTimeout(() => setFilters({ ...filtersRef.current, q: search }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, setFilters]);

  // ---- The Task filter's options ----
  const [tasks, setTasks] = useState<TaskOption[] | null>(null);
  useEffect(() => {
    if (scoped || !canReadTasks) return;
    let stale = false;
    api
      .get<TaskOption[]>('/tasks')
      .then((all) => {
        if (!stale) setTasks(all.map((t) => ({ id: t.id, name: t.name })));
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [api, scoped, canReadTasks]);

  // ---- The "Started by" filter's apps (#464) ----
  const [apps, setApps] = useState<{ clientId: string; displayName: string }[] | null>(null);
  useEffect(() => {
    if (scopedApp || !canReadApps) return;
    let stale = false;
    api
      .get<{ clientId: string; displayName: string }[]>('/connected-apps')
      .then((all) => {
        if (!stale) setApps(all.map((a) => ({ clientId: a.clientId, displayName: a.displayName })));
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [api, scopedApp, canReadApps]);

  // ---- The batch filter (E51.1): its size, for the "2 of 5" chips, and its task, for the filter's chip ----
  const [batchInfo, setBatchInfo] = useState<{ id: string; total: number; taskName: string | null } | null>(null);
  useEffect(() => {
    const id = filters.batchId;
    if (!id) return setBatchInfo(null);
    let stale = false;
    api
      .get<{ id: string; total: number; taskName: string | null }>(`/batches/${encodeURIComponent(id)}`)
      .then((b) => {
        if (!stale) setBatchInfo({ id: b.id, total: b.total, taskName: b.taskName });
      })
      .catch(() => {
        if (!stale) setBatchInfo(null);
      });
    return () => {
      stale = true;
    };
  }, [api, filters.batchId]);
  /** A batch run's row: "2 of 5" when the batch's size is known (its filter is on), "Row 2" otherwise. */
  const batchChip = (r: RunListItem) =>
    r.batchId && r.batchSeq ? (
      <Chip
        size="small"
        variant="outlined"
        label={batchInfo && batchInfo.id === r.batchId ? `${r.batchSeq} of ${batchInfo.total}` : `Row ${r.batchSeq}`}
        title="A row of a batch"
        data-testid="run-batch-seq"
        sx={{ flexShrink: 0 }}
      />
    ) : null;

  // ---- The phone's filter drawer ----
  const [drawer, setDrawer] = useState(false);
  const [draft, setDraft] = useState(filters);
  const activeCount = activeFilterCount(filters, scoped, scopedApp);

  // ---- Selection ----
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  /** "Select all N finished runs that match": the delete goes by filter, not by ids. */
  const [allMatching, setAllMatching] = useState(false);
  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setAllMatching(false);
  }, []);
  useEffect(clearSelection, [paramText, clearSelection]);
  const selecting = canDelete && (isDesktop || selectMode);
  const selectable = useMemo(() => items.filter((r) => !isLive(r.status)), [items]);
  // A row that left the list (deleted elsewhere, a reload) is no longer selected.
  const selected = useMemo(() => new Set(items.filter((r) => selectedIds.has(r.id) && !isLive(r.status)).map((r) => r.id)), [items, selectedIds]);
  const allLoadedSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.id));
  const matching = finishedCount(counts, filters.view);
  const selectedCount = allMatching ? matching : selected.size;

  // ---- A delete that runs in the background (202) ----
  // `before` is the list's total when the delete was accepted: a job that finishes before the first read
  // (a few hundred runs take under a second) is then seen as done on that read, not after 30 s without a change.
  const [background, setBackground] = useState<{ matched: number; before: number | null } | null>(null);
  useEffect(() => {
    if (!background) return;
    const { before, matched } = background;
    let last: number | null = before;
    let dropped = false;
    let polls = 0;
    const timer = setInterval(() => {
      void refreshCounts().then((c) => {
        polls++;
        const total = c?.total ?? last;
        if (last !== null && total !== null && total < last) dropped = true;
        // Done when the number stopped changing after it went down (or it never moved for 30 s).
        const allGone = before !== null && total !== null && before - total >= matched;
        const settled = allGone || (total !== null && total === last && (dropped || polls >= 10));
        last = total;
        if (settled || polls >= 100) {
          clearInterval(timer);
          setBackground(null);
          reload();
        }
      });
    }, BACKGROUND_POLL_MS);
    return () => clearInterval(timer);
  }, [background, refreshCounts, reload]);

  // ---- Actions ----
  const deleteBody = (count: number) =>
    `${count === 1 ? 'Its' : 'Their'} steps and answers are deleted too. ${count === 1 ? 'Its' : 'Their'} cost and stop-reason history is removed from task spend and alerts. This cannot be undone.`;
  const spend = (usd: number | null) => {
    const text = formatCost(usd);
    return text ? ` (${text} of recorded spend)` : '';
  };

  const deleteOne = async (run: RunListItem) => {
    if (!(await confirm({ title: 'Delete this run?', body: deleteBody(1), confirmLabel: 'Delete', destructive: true }))) return;
    const done = await action.run(
      'delete',
      async () => {
        await api.delete(`/runs/${run.id}`);
        return true;
      },
      'Could not delete the run',
    );
    if (!done) return;
    removeRuns([run.id]);
    void refreshCounts();
    setToast('Run deleted');
  };

  const deleteSelected = async () => {
    const count = selectedCount;
    if (count === 0) return;
    const ok = await confirm({
      title: `Delete ${runs(count)}?`,
      body: deleteBody(count),
      confirmLabel: 'Delete',
      destructive: true,
      ...(count > DELETE_TYPE_TO_CONFIRM ? { requireText: 'delete' } : {}),
    });
    if (!ok) return;
    const done = await action.run(
      'bulk-delete',
      async () => {
        try {
          if (allMatching) {
            const res = await api.post<RunsDeleted | RunsDeleteQueued>('/runs/delete', { filter: deleteFilter(filters, scope ?? {}, timeZone), expectedCount: count });
            if (isQueued(res)) {
              setBackground({ matched: res.matched, before: counts?.total ?? null });
              return true;
            }
            reload();
            setToast(`Deleted ${runs(res.deleted)}${spend(res.costUsd)}`);
            return true;
          }
          const ids = [...selected];
          const total = { deleted: 0, costUsd: null as number | null, skippedLive: [] as string[] };
          for (let i = 0; i < ids.length; i += DELETE_IDS_CHUNK) {
            const res = await api.post<RunsDeleted>('/runs/delete', { ids: ids.slice(i, i + DELETE_IDS_CHUNK) });
            total.deleted += res.deleted;
            if (res.costUsd !== null) total.costUsd = (total.costUsd ?? 0) + res.costUsd;
            total.skippedLive.push(...res.skippedLive);
          }
          const kept = new Set(total.skippedLive);
          removeRuns(ids.filter((id) => !kept.has(id)));
          void refreshCounts();
          const skipped = total.skippedLive.length;
          setToast(`Deleted ${runs(total.deleted)}${spend(total.costUsd)}${skipped ? `. ${skipped} ${skipped === 1 ? 'is' : 'are'} still running and ${skipped === 1 ? 'was' : 'were'} skipped` : ''}`);
          return true;
        } catch (e) {
          if (isPlatformApiError(e) && e.code === 'COUNT_CHANGED') {
            reload();
            throw new Error('The list changed. Review it and try again.');
          }
          throw e;
        }
      },
      'Could not delete the runs',
    );
    // A failed delete leaves the selection as it was.
    if (done) {
      clearSelection();
      setSelectMode(false);
    }
  };

  const again = async (run: RunListItem, policyId?: string) => {
    // A run that carried out a step its owner confirmed asks first (#540).
    const question = runAgainQuestionFor(run);
    if (question && !(await confirm(question))) return;
    const started = await action.run('again', () => runAgain(api, run, policyId), 'Could not start the run');
    if (started) navigate(`/runs/${started.id}`);
  };

  const cancel = async (run: RunListItem) => {
    const res = await action.run('cancel', () => api.post<Partial<RunListItem> | null>(`/runs/${run.id}/cancel`, {}), 'Could not cancel the run');
    if (res === undefined) return;
    updateRun({ ...run, cancelRequested: true, ...(res ?? {}) });
    void refreshCounts();
  };

  // ---- The row menu ----
  const [menu, setMenu] = useState<{ anchor: HTMLElement; run: RunListItem } | null>(null);
  const [withMenu, setWithMenu] = useState<{ anchor: HTMLElement; run: RunListItem } | null>(null);
  // Export PDF and Export JSON (#544), with the "Include screenshots" choice remembered from the run page's menu.
  const exporter = useRunExport();
  const menuPermissions = { canWrite, canDelete, canPickPolicy: canReadPolicies && catalog.policies.length > 0, canExport: exporter.canExport };
  const pick = (kind: RunMenuAction) => {
    if (!menu) return;
    const { run, anchor } = menu;
    setMenu(null);
    if (kind === 'open') navigate(`/runs/${run.id}`);
    else if (kind === 'again') void again(run);
    else if (kind === 'againWith') setWithMenu({ anchor, run });
    else if (kind === 'exportPdf' || kind === 'exportJson') void exporter.start(run.id, kind === 'exportPdf' ? 'pdf' : 'json');
    else if (kind === 'cancel') void cancel(run);
    else void deleteOne(run);
  };
  const menuButton = (run: RunListItem) => (
    <IconButton
      aria-label={`Actions for ${run.goal.slice(0, 80)}`}
      aria-haspopup="menu"
      sx={{ width: 44, height: 44, flexShrink: 0 }}
      onClick={(e) => {
        e.stopPropagation();
        setMenu({ anchor: e.currentTarget, run });
      }}
    >
      <MoreVertIcon />
    </IconButton>
  );

  // ---- Rows ----
  const showTask = showTaskColumn && !scoped;
  const hasCost = items.some((r) => rowCost(r) !== null);
  const taskLine = (run: RunListItem) =>
    showTask && run.taskId && run.taskName ? (
      <Link component={RouterLink} to={`/tasks/${run.taskId}`} variant="caption" underline="hover" sx={{ display: 'block', overflowWrap: 'anywhere' }}>
        {run.taskName}
      </Link>
    ) : null;
  const activityLine = (run: RunListItem) =>
    run.status === 'running' && run.activity ? (
      <Typography variant="caption" color="info.main" sx={{ ...clamp(1), mt: 0.25 }} data-testid="run-activity">
        {run.cancelRequested ? 'Stopping…' : describeActivity(run.activity)}
      </Typography>
    ) : null;

  const columns: Column<RunListItem>[] = [
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <>
          <Stack direction="row" spacing={0.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
            <StatusChip status={r.status} stopReason={r.stopReason} />
            {batchChip(r)}
          </Stack>
          {/* Without the Goal column, what a running run is doing sits under its status. */}
          {compact && scoped && <Box sx={{ maxWidth: 200 }}>{activityLine(r)}</Box>}
        </>
      ),
    },
    // On a task's page every run has the task's goal, which the page shows:
    // the column would only push Duration and Cost out of a narrower list.
    ...(compact && scoped
      ? []
      : [
          {
            key: 'goal',
            header: 'Goal',
            grow: true,
            render: (r) => (
              <Box sx={{ minWidth: 160 }} data-testid={`run-row-${r.id}`}>
                {taskLine(r)}
                <Typography variant="body2" sx={clamp(2)}>
                  {r.goal}
                </Typography>
                {activityLine(r)}
              </Box>
            ),
          } satisfies Column<RunListItem>,
        ]),
    ...(scopedApp ? [] : [{ key: 'startedBy', header: 'Started by', render: (r: RunListItem) => <StartedByChip run={r} /> }]),
    { key: 'trigger', header: 'Trigger', hideBelow: 'lg' as const, render: triggerWords },
    { key: 'steps', header: 'Steps', align: 'right', render: (r) => n(r.stepCount) },
    { key: 'started', header: 'Started', render: (r) => <RelativeTime iso={r.startedAt ?? r.createdAt} /> },
    { key: 'duration', header: 'Duration', render: (r) => runDuration(r, now) ?? '—' },
    ...(hasCost
      ? [
          {
            key: 'cost',
            header: 'Cost',
            align: 'right' as const,
            hideBelow: 'lg' as const,
            render: (r: RunListItem) => (
              <Box component="span" sx={{ fontVariantNumeric: 'tabular-nums' }} data-testid="run-cost">
                {rowCost(r) ?? '—'}
              </Box>
            ),
          },
        ]
      : []),
    ...(compact ? [] : [{ key: 'profile', header: 'Profile', hideBelow: 'lg' as const, render: (r: RunListItem) => r.profile }]),
    ...(canReadPolicies && !compact
      ? [
          {
            key: 'policy',
            header: 'Policy',
            hideBelow: 'xl' as const,
            render: (r: RunListItem) =>
              r.policy ? (
                <Tooltip title={r.currentTier ? `Tier: ${TIER_LABEL[r.currentTier]}` : 'The run has not started on a tier'}>
                  <span data-testid="run-policy">{r.policy.name}</span>
                </Tooltip>
              ) : (
                '—'
              ),
          },
        ]
      : []),
    { key: 'menu', header: <Box component="span" sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Actions</Box>, width: 48, render: menuButton },
  ];

  const card = (r: RunListItem) => {
    const cost = rowCost(r);
    const meta = [showTask ? r.taskName : null, triggerWords(r), `${n(r.stepCount)} steps`, runDuration(r, now)].filter(Boolean).join(' · ');
    return (
      <Paper variant="outlined" sx={{ display: 'flex', alignItems: 'flex-start', minWidth: 0 }} data-testid={`run-row-${r.id}`}>
        <CardActionArea component={RouterLink} to={`/runs/${r.id}`} sx={{ p: 1.5, flexGrow: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 0.5, minWidth: 0 }}>
            <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', minWidth: 0 }}>
              <StatusChip status={r.status} stopReason={r.stopReason} />
              {batchChip(r)}
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
              <RelativeTime iso={r.startedAt ?? r.createdAt} />
            </Typography>
          </Stack>
          <Typography variant="body2" sx={clamp(3)}>
            {r.goal}
          </Typography>
          {activityLine(r)}
          {!scopedApp && (r.client || (r.origin && r.origin !== 'web')) && (
            <Box sx={{ mt: 0.5 }}>
              <StartedByChip run={r} />
            </Box>
          )}
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, overflowWrap: 'anywhere' }}>
            {meta}
            {cost && (
              <>
                {' · '}
                <span data-testid="run-cost">{cost}</span>
              </>
            )}
          </Typography>
        </CardActionArea>
        {menuButton(r)}
      </Paper>
    );
  };

  // ---- Load more when the end of the list comes into view ----
  const sentinel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !nextCursor || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadMore(), { rootMargin: '400px 0px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [nextCursor, loadMore, items.length]);

  // ---- The active filters, as chips ----
  const day = (key: string) => formatDateTime(startOfDay(key, timeZone), { month: 'short', day: 'numeric', year: 'numeric' });
  const preset = presetOf(filters, timeZone);
  const chips: { key: string; label: string; clear: RunFilters }[] = [
    ...(filters.q.trim() ? [{ key: 'q', label: `Search: ${filters.q.trim()}`, clear: { ...filters, q: '' } }] : []),
    ...(filters.taskId && !scoped
      ? [{ key: 'task', label: filters.taskId === 'none' ? ONE_OFF.name : `Task: ${tasks?.find((t) => t.id === filters.taskId)?.name ?? items.find((r) => r.taskId === filters.taskId)?.taskName ?? 'one task'}`, clear: { ...filters, taskId: null } }]
      : []),
    ...(filters.batchId ? [{ key: 'batch', label: `Batch${batchInfo?.id === filters.batchId ? `: ${batchInfo.taskName ?? 'a deleted task'}, ${batchInfo.total} rows` : ''}`, clear: { ...filters, batchId: null } }] : []),
    ...(filters.trigger.length ? [{ key: 'trigger', label: `Trigger: ${filters.trigger.map((t) => TRIGGER_LABEL[t]).join(', ')}`, clear: { ...filters, trigger: [] } }] : []),
    ...(preset
      ? [
          {
            key: 'date',
            label:
              preset !== 'custom'
                ? preset === 'today'
                  ? 'Today'
                  : `Last ${DATE_PRESETS.find((p) => p.key === preset)!.label}`
                : filters.from && filters.to
                  ? `${day(filters.from)} to ${day(filters.to)}`
                  : filters.from
                    ? `From ${day(filters.from)}`
                    : `Until ${day(filters.to!)}`,
            clear: { ...filters, from: null, to: null },
          },
        ]
      : []),
    ...(filters.stopReason.length && showsStopFilter(filters.view)
      ? [{ key: 'stop', label: `Stopped by: ${filters.stopReason.map((r) => STOP_FILTER_LABEL[r]).join(', ')}`, clear: { ...filters, stopReason: [] } }]
      : []),
    ...(filters.policyId ? [{ key: 'policy', label: `Policy: ${catalog.byId(filters.policyId)?.name ?? filters.policyId}`, clear: { ...filters, policyId: null } }] : []),
    ...(!scopedApp && (filters.origin.length || filters.clientId)
      ? [
          {
            key: 'startedBy',
            label: `Started by: ${filters.clientId ? (apps?.find((a) => a.clientId === filters.clientId)?.displayName ?? appDisplayName(items.find((r) => r.client?.id === filters.clientId)?.client?.name ?? 'one AI app')) : filters.origin.map((o) => (o === 'mcp' ? 'Any AI app' : ORIGIN_LABEL[o])).join(', ')}`,
            clear: { ...filters, origin: [], clientId: null },
          },
        ]
      : []),
  ];
  const clearAll = () => {
    setSearch('');
    setFilters({ ...NO_FILTERS, view: filters.view, taskId: scoped ? filters.taskId : null });
  };
  const unfiltered = chips.length === 0 && filters.view === 'all';

  const controls = (value: RunFilters, onChange: (next: RunFilters) => void, layout: 'row' | 'column') => (
    <RunFilterControls value={value} onChange={onChange} scoped={scoped} scopedApp={scopedApp} apps={canReadApps ? apps : null} tasks={canReadTasks ? (tasks ?? []) : null} policies={canReadPolicies ? catalog.policies : null} timeZone={timeZone} layout={layout} />
  );
  const total = viewCount(counts, filters.view);
  const countsCost = counts ? formatCost(counts.costUsd, counts.costKnown) : null;

  return (
    <Box sx={{ minWidth: 0 }}>
      <Stack direction={{ xs: 'column', md: 'row' }} sx={{ alignItems: { md: 'center' }, borderBottom: 1, borderColor: 'divider', mb: 2 }}>
        <Tabs
          value={filters.view}
          onChange={(_, view: RunView) => setFilters({ ...filters, view })}
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
          aria-label="Run status"
          sx={{ flexGrow: 1, minWidth: 0 }}
        >
          {RUN_VIEWS.map((view) => {
            const count = viewCount(counts, view);
            return <Tab key={view} value={view} label={count === null ? RUN_VIEW_LABEL[view] : `${RUN_VIEW_LABEL[view]} ${n(count)}`} sx={{ minHeight: 48 }} />;
          })}
        </Tabs>
        {!compact && counts && (
          <Typography variant="body2" color="text.secondary" sx={{ px: { xs: 0, md: 2 }, py: { xs: 1, md: 0 }, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }} data-testid="run-counts">
            {runs(counts.total)}
            {countsCost ? ` · ${countsCost}` : ''}
          </Typography>
        )}
      </Stack>

      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'flex-start', flexWrap: { md: 'wrap' }, mb: 1.5 }}>
        <TextField
          size="small"
          label="Search goals"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          sx={{ flex: { xs: '1 1 auto', md: '1 1 220px' }, maxWidth: { md: 320 }, minWidth: 0 }}
          slotProps={{
            htmlInput: { maxLength: 200 },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
              endAdornment: search ? (
                <InputAdornment position="end">
                  <IconButton
                    aria-label="Clear search"
                    edge="end"
                    size="small"
                    onClick={() => {
                      setSearch('');
                      setFilters({ ...filtersRef.current, q: '' });
                    }}
                  >
                    <ClearIcon fontSize="small" />
                  </IconButton>
                </InputAdornment>
              ) : undefined,
            },
          }}
        />
        {isDesktop ? (
          controls(filters, setFilters, 'row')
        ) : (
          <>
            <Badge badgeContent={activeCount - (filters.q.trim() ? 1 : 0)} color="primary">
              <Button
                variant="outlined"
                startIcon={<FilterListIcon />}
                sx={{ minHeight: 44, whiteSpace: 'nowrap' }}
                aria-label={activeCount - (filters.q.trim() ? 1 : 0) > 0 ? `Filters, ${activeCount - (filters.q.trim() ? 1 : 0)} active` : 'Filters'}
                onClick={() => {
                  setDraft(filters);
                  setDrawer(true);
                }}
              >
                Filters
              </Button>
            </Badge>
            {canDelete && (
              <Button
                variant={selectMode ? 'contained' : 'text'}
                sx={{ minHeight: 44 }}
                aria-pressed={selectMode}
                onClick={() => {
                  if (selectMode) clearSelection();
                  setSelectMode(!selectMode);
                }}
              >
                Select
              </Button>
            )}
          </>
        )}
      </Stack>

      {chips.length > 0 && (
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', mb: 1.5 }} aria-label="Active filters">
          {chips.map((c) => (
            <Chip key={c.key} size="small" label={c.label} onDelete={() => (c.key === 'q' ? (setSearch(''), setFilters(c.clear)) : setFilters(c.clear))} sx={{ maxWidth: '100%' }} />
          ))}
          <Button size="small" onClick={clearAll}>
            Clear all
          </Button>
        </Stack>
      )}

      <ErrorBanner error={action.error} onClose={action.clearError} />
      <ErrorBanner error={exporter.error} onClose={exporter.clearError} />
      {exporter.busy && (
        <Typography variant="body2" color="text.secondary" role="status" sx={{ mb: 1 }}>
          Preparing the {exporter.busy === 'pdf' ? 'PDF report' : 'JSON trace'}…
        </Typography>
      )}
      <ErrorBanner error={list.error} onRetry={reload} />
      {background && (
        <Alert severity="info" icon={<CircularProgress size={18} />} sx={{ mb: 2 }} role="status">
          Deleting {runs(background.matched)} in the background…
        </Alert>
      )}

      {selecting && allLoadedSelected && nextCursor && !allMatching && matching > selected.size && (
        <Alert severity="info" sx={{ mb: 1.5 }} role="status">
          All {n(selected.size)} loaded runs are selected.{' '}
          <Link component="button" type="button" onClick={() => setAllMatching(true)} sx={{ fontWeight: 600, verticalAlign: 'baseline' }}>
            Select all {n(matching)} finished runs that match
          </Link>
        </Alert>
      )}
      {selecting && allMatching && (
        <Alert severity="info" sx={{ mb: 1.5 }} role="status">
          All {n(matching)} finished runs that match are selected.
        </Alert>
      )}

      {list.loading && <ListSkeleton />}
      {!list.loading && !list.error && items.length === 0 && (
        unfiltered ? (
          <EmptyState
            Icon={ListAltOutlinedIcon}
            title="No runs yet"
            body={scoped ? 'This task has not run yet.' : 'Start a one-off goal here, or run a saved task from Tasks.'}
            action={onNewRun && canWrite ? { key: 'new', label: 'New run', onClick: onNewRun } : undefined}
          />
        ) : (
          <EmptyState
            Icon={SearchOffIcon}
            title="No runs match these filters"
            action={{
              key: 'clear',
              label: 'Clear filters',
              onClick: () => {
                setSearch('');
                setFilters({ ...NO_FILTERS, taskId: scoped ? filters.taskId : null });
              },
            }}
          />
        )
      )}
      {items.length > 0 && (
        <ResponsiveList
          aria-label="Runs"
          items={items}
          columns={columns}
          renderCard={card}
          getKey={(r) => r.id}
          getLabel={(r) => r.goal.slice(0, 80)}
          onRowClick={(r) => navigate(`/runs/${r.id}`)}
          windowAfter={WINDOW_AFTER}
          selection={
            selecting
              ? {
                  selected: allMatching ? new Set(selectable.map((r) => r.id)) : selected,
                  onToggle: (id) => {
                    // Unticking one row leaves "all that match": the selection is the loaded rows again, minus that one.
                    const base = allMatching ? new Set(selectable.map((r) => r.id)) : new Set(selected);
                    if (base.has(id)) base.delete(id);
                    else base.add(id);
                    setAllMatching(false);
                    setSelectedIds(base);
                  },
                  onToggleAll: () => {
                    setAllMatching(false);
                    setSelectedIds(allLoadedSelected || allMatching ? new Set() : new Set(selectable.map((r) => r.id)));
                  },
                  disabledReason: (id) => (isLive(items.find((r) => r.id === id)?.status ?? '') ? 'Cancel it first' : null),
                }
              : undefined
          }
          footer={
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', rowGap: 1, mt: 2 }}>
              <Typography variant="body2" color="text.secondary" data-testid="run-showing">
                Showing {n(items.length)}
                {total !== null ? ` of ${n(Math.max(total, items.length))}` : ''}
              </Typography>
              {nextCursor && (
                <Button variant="outlined" onClick={loadMore} disabled={list.loadingMore} sx={{ minHeight: { xs: 44, md: 'auto' } }}>
                  {list.loadingMore ? 'Loading…' : 'Load more'}
                </Button>
              )}
              <Box ref={sentinel} aria-hidden sx={{ width: '100%', height: 1 }} />
            </Stack>
          }
        />
      )}

      {selecting && selectedCount > 0 && (
        <Paper
          elevation={6}
          role="region"
          aria-label="Selection"
          sx={{ position: 'sticky', bottom: aboveBottomBar(16), zIndex: 3, mt: 2, px: 2, py: 1, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}
        >
          <Typography sx={{ flexGrow: 1, fontVariantNumeric: 'tabular-nums' }}>{n(selectedCount)} selected</Typography>
          <Button color="error" variant="contained" disabled={action.busy !== null} onClick={() => void deleteSelected()} sx={{ minHeight: { xs: 44, md: 'auto' } }}>
            Delete
          </Button>
          <Button
            onClick={() => {
              clearSelection();
              setSelectMode(false);
            }}
            sx={{ minHeight: { xs: 44, md: 'auto' } }}
          >
            Cancel selection
          </Button>
        </Paper>
      )}

      <Menu anchorEl={menu?.anchor ?? null} open={menu !== null} onClose={() => setMenu(null)}>
        {menu &&
          runMenuActions(menu.run, menuPermissions).map((kind) => (
            <MenuItem key={kind} onClick={() => pick(kind)} disabled={(kind === 'exportPdf' || kind === 'exportJson') && exporter.busy !== null} sx={{ minHeight: 44, color: kind === 'delete' ? 'error.main' : undefined }}>
              {RUN_MENU_LABEL[kind]}
            </MenuItem>
          ))}
      </Menu>
      <RunWithMenu
        anchorEl={withMenu?.anchor ?? null}
        onClose={() => setWithMenu(null)}
        onChoose={(policyId) => withMenu && void again(withMenu.run, policyId)}
        catalog={catalog}
        usualId={withMenu?.run.policy?.id}
      />

      <Drawer anchor="bottom" open={drawer && !isDesktop} onClose={() => setDrawer(false)} slotProps={{ paper: { sx: { borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '85vh' }, 'aria-label': 'Filters', role: 'dialog' } }}>
        <Box sx={{ p: 2, overflowY: 'auto' }}>
          <Typography variant="h6" component="h2" sx={{ mb: 2 }}>
            Filters
          </Typography>
          {controls(draft, setDraft, 'column')}
          <Stack direction="row" spacing={1} sx={{ mt: 3 }}>
            <Button fullWidth sx={{ minHeight: 44 }} onClick={() => setDraft({ ...NO_FILTERS, view: draft.view, q: draft.q, taskId: scoped ? draft.taskId : null })}>
              Reset
            </Button>
            <Button
              fullWidth
              variant="contained"
              sx={{ minHeight: 44 }}
              onClick={() => {
                setFilters({ ...draft, q: filtersRef.current.q });
                setDrawer(false);
              }}
            >
              Apply
            </Button>
          </Stack>
        </Box>
      </Drawer>

      <Snackbar open={toast !== null} autoHideDuration={6000} onClose={() => setToast(null)} message={toast} sx={{ bottom: aboveBottomBar(24) }} />
    </Box>
  );
}
