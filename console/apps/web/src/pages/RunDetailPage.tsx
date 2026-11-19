import { RunInputs } from '../taskParams/RunInputs';
import { RunOutputs } from '../taskOutputs/RunOutputs';
import { RunDeliveries } from '../deliveries/RunDeliveries';
import { useCallback, useEffect, useId, useRef, useState, type ElementType, type MouseEvent } from 'react';
import { Alert, Box, Button, Collapse, IconButton, Link, Paper, Stack, Typography, useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import PanToolOutlinedIcon from '@mui/icons-material/PanToolOutlined';
import PauseCircleOutlinedIcon from '@mui/icons-material/PauseCircleOutlined';
import PlayCircleOutlinedIcon from '@mui/icons-material/PlayCircleOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';

import { maskText } from '@app/shared/sensitive-patterns';

import { fetchRunScreenshot, subscribeRun } from '../live';
import { ActionOverlay, frameCaption, RunActivityBar, useNow } from '../components/RunActivity';
import { RunBudgetMeter, RunHeaderChips, RunStopReason } from '../components/RunBudgetMeter';
import { runCost } from '../components/runBudget';
import { runAgain, runAgainQuestionFor } from '../components/runRow';
import { RunExportButton, RunExportMenu, useRunExport } from '../components/RunExport';
import { PausedBanner, canPauseRun, isPausing } from '../components/RunPause';
import { UsedSavedLogins } from '../components/UsedSavedLogins';
import { UsedSavedIdentity } from '../components/UsedSavedIdentity';
import { UsedSavedCards } from '../components/UsedSavedCards';
import { RunTimeline } from '../components/RunTimeline';
import { RunTraceId } from '../components/RunTraceId';
import { withStreamedSteps } from '../components/runTimeline';
import type { Run, RunStep } from '../types/runs';
import { StartedByChip } from '../components/StartedByChip';
import { APP_BAR_HEIGHT, EmptyState, ErrorBanner, ListSkeleton, PageContainer, PageHeader, StatusChip, aboveBottomBar, formatDateTime, isLive as isLiveStatus, useBreakpoint, useConfirm, useProfileTimeZone } from '../ui';

/** Where a person can watch and take over the run's browser. */
interface RunViewer {
  hostId: string | null;
  hostName: string | null;
  /** The host's desktop can be opened in the console. */
  desktop: boolean;
}

/** The space the two panes leave to the top bar and the page's own padding, in pixels. */
const PANE_OFFSET = APP_BAR_HEIGHT + 32;

/** `calc(100dvh - px)` with the `100vh` fallback, as an `sx` fragment for `prop`. */
function viewportMinus(prop: 'maxHeight', px: number) {
  return { [prop]: `calc(100vh - ${px}px)`, '@supports (height: 100dvh)': { [prop]: `calc(100dvh - ${px}px)` } };
}

/** One action of the phone's sticky bar: an icon over a short label, the full label as its accessible name. */
function BarAction({ label, short, Icon, color, disabled, onClick, menu }: { label: string; short: string; Icon: ElementType; color?: 'error' | 'primary'; disabled?: boolean; onClick: (e: MouseEvent<HTMLElement>) => void; menu?: { id: string; open: boolean } }) {
  return (
    <Button
      aria-label={label}
      {...(menu ? { 'aria-haspopup': 'menu' as const, 'aria-controls': menu.open ? menu.id : undefined, 'aria-expanded': menu.open ? ('true' as const) : undefined } : {})}
      color={color ?? 'primary'}
      disabled={disabled}
      onClick={onClick}
      sx={{ flex: '1 1 0', minWidth: 0, minHeight: 52, flexDirection: 'column', gap: 0.25, px: 0.5, fontSize: '0.75rem', lineHeight: 1.2, textTransform: 'none' }}
    >
      <Icon fontSize="small" />
      {short}
    </Button>
  );
}

/**
 * `/runs/:id`: one run, live. The layout follows the window (#431): two panes
 * from `lg` up while the run is live (the browser's frame on the left, sticky;
 * the status, budget and timeline on the right, the timeline scrolling under
 * the budget meter), one column below that, and below `md` a sticky bar keeps
 * Cancel, Watch and Take over in reach. A finished run has no frame: its
 * result takes that place and the timeline the full width.
 *
 * Steps and status arrive over the run's event
 * stream, with what it is doing right now (#379); while the run is live, the browser's screenshot refreshes every
 * 2 s and the viewer link lets a person take over.
 */
/** "Used: My wife, Checking account" (#553): the owner's memories the run's goal used, each a link to Memories. */
export function UsedMemories({ memories }: { memories: Run['memories'] }) {
  if (!memories?.length) return null;
  return (
    <Typography variant="body2" color="text.secondary" sx={{ mb: 1, overflowWrap: 'anywhere' }} data-testid="used-memories">
      Used:{' '}
      {memories.map((m, i) => (
        <span key={m.id}>
          {i > 0 && ', '}
          <Link component={RouterLink} to={`/settings/memories?memory=${m.id}`} underline="hover">
            {m.label}
          </Link>
        </span>
      ))}
    </Typography>
  );
}

export { UsedSavedLogins };

export function RunDetailPage() {
  const { api, viewer } = usePlatformHost();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The run is gone (404): deleted, here or on another device. */
  const [missing, setMissing] = useState(false);
  /** A failed Delete or Run again; the page stays as it is. */
  const [actionError, setActionError] = useState<string | null>(null);
  const confirm = useConfirm();
  const [shot, setShot] = useState<string | null>(null);
  /** When the shown frame was taken, and whether the latest fetch failed (#379). */
  const [shotAt, setShotAt] = useState<number | null>(null);
  const [shotFailing, setShotFailing] = useState(false);
  /** The frame's pixel size, to place where the agent acts on it (#381). */
  const [shotSize, setShotSize] = useState<{ width: number; height: number } | null>(null);
  const [watch, setWatch] = useState(true);
  // Stop was pressed here (E38.1): shown at once, before the server says so.
  const [stopRequested, setStopRequested] = useState(false);
  // Pause and Resume were pressed here (E38.2): "Pausing…" and "Resuming…" at once, before the server says so.
  const [pauseSent, setPauseSent] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [where, setWhere] = useState<RunViewer | null>(null);
  useProfileTimeZone();
  /** Export (#544): the header's menu from `md` up, the sticky bar's below. */
  const exporter = useRunExport();
  const [exportAnchor, setExportAnchor] = useState<HTMLElement | null>(null);
  const exportMenuId = useId();
  const isWide = useMediaQuery(useTheme().breakpoints.up('lg'));
  const compact = !useBreakpoint().isDesktop;

  const load = useCallback(async () => {
    try {
      const fetched = await api.get<Run>(`/runs/${id}`);
      // A load can finish after the stream delivered newer steps: keep them.
      setRun((prev) => withStreamedSteps(fetched, prev));
    } catch (e) {
      if (isPlatformApiError(e) && e.status === 404) return setMissing(true);
      setError(e instanceof Error ? e.message : 'Could not load the run');
    }
  }, [api, id]);

  // The task's name, for the link to it (#423).
  const taskId = run?.taskId ?? null;
  const [taskName, setTaskName] = useState<string | null>(null);
  useEffect(() => {
    if (!taskId || !viewer.hasPermission('tasks:read')) return setTaskName(null);
    let stale = false;
    api
      .get<{ name: string }>(`/tasks/${taskId}`)
      .then((task) => {
        if (!stale) setTaskName(task.name);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [api, taskId, viewer]);

  /** Delete (#423): asks first, then goes back to the list, which says so. */
  const remove = async () => {
    const ok = await confirm({
      title: 'Delete this run?',
      body: 'Its steps and answers are deleted too. Its cost and stop-reason history is removed from task spend and alerts. This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok || !run) return;
    try {
      await api.delete(`/runs/${run.id}`);
      navigate('/runs', { state: { toast: 'Run deleted' } });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not delete the run');
    }
  };

  /** Run again (#423): the same task or goal; the policy only when it was chosen for this run. */
  const again = async () => {
    if (!run) return;
    // A run that carried out a step its owner confirmed asks first (#540): it may do it twice.
    const question = runAgainQuestionFor(run);
    if (question && !(await confirm(question))) return;
    try {
      const started = await runAgain(api, run);
      navigate(`/runs/${started.id}`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not start the run');
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  const isLive = run ? isLiveStatus(run.status) : false;
  // The pause took effect: the page's own "Pausing…" is over (a later pause from elsewhere shows through the run's own flag).
  const runStatus = run?.status ?? null;
  useEffect(() => {
    if (runStatus === 'paused') setPauseSent(false);
  }, [runStatus]);
  const now = useNow(isLive);
  // The live stream does not carry the run's outputs: when the run ends, read them (E39.5).
  const wasLive = useRef(false);
  useEffect(() => {
    if (wasLive.current && !isLive && run) void load();
    wasLive.current = isLive;
  }, [isLive, run, load]);

  // Live updates over SSE: a reconnect refetches, a step appends, a run event merges.
  useEffect(() => {
    if (!id || !isLive) return;
    return subscribeRun(id, (e) => {
      if (e.type === 'open') return void load();
      if (e.type === 'step') {
        const step = e.data as RunStep;
        setRun((r) => (r && !(r.steps ?? []).some((s) => s.seq === step.seq) ? { ...r, steps: [...(r.steps ?? []), step], stepCount: Math.max(r.stepCount, step.seq) } : r));
      }
      if (e.type === 'run') setRun((r) => (r ? { ...r, ...(e.data as Partial<Run>) } : r));
    });
  }, [id, isLive, load]);

  // The browser, every 2 s while watching a live run.
  useEffect(() => {
    if (!id || !isLive || !watch) return;
    let stopped = false;
    let current: string | null = null;
    const next = async () => {
      const url = await fetchRunScreenshot(id).catch(() => null);
      if (stopped) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      if (url) {
        if (current) URL.revokeObjectURL(current);
        current = url;
        setShot(url);
        setShotAt(Date.now());
      }
      // A failed fetch keeps the last frame, but the page says how old it is.
      setShotFailing(!url);
      timer = setTimeout(() => void next(), 2_000);
    };
    let timer = setTimeout(() => void next(), 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
      if (current) URL.revokeObjectURL(current);
    };
  }, [id, isLive, watch]);

  useEffect(() => {
    if (!id || !isLive) return;
    void api.get<RunViewer>(`/runs/${id}/viewer`).then(setWhere).catch(() => setWhere(null));
  }, [api, id, isLive]);

  const back = { to: '/runs', label: 'Runs' };
  if (missing) {
    return (
      <PageContainer>
        <PageHeader title="Run" back={back} />
        <EmptyState title="This run does not exist any more." body="It may have been deleted." action={{ key: 'runs', label: 'Go to Runs', to: '/runs' }} />
      </PageContainer>
    );
  }
  if (error) {
    return (
      <PageContainer>
        <PageHeader title="Run" back={back} />
        <ErrorBanner error={error} />
      </PageContainer>
    );
  }
  if (!run) {
    return (
      <PageContainer>
        <ListSkeleton />
      </PageContainer>
    );
  }
  const finished = !isLive;
  const canCancel = viewer.hasPermission('runs:write');
  const stopping = run.cancelRequested || stopRequested;
  const cancel = () => {
    if (stopping) return;
    setStopRequested(true);
    api
      .post(`/runs/${run.id}/cancel`, {})
      .then(load)
      .catch((e: unknown) => {
        setStopRequested(false);
        setActionError(e instanceof Error ? e.message : 'Could not stop the run');
      });
  };
  const paused = run.status === 'paused';
  const pausing = isPausing(run, pauseSent);
  const pause = () => {
    if (pausing) return;
    setPauseSent(true);
    api
      .post(`/runs/${run.id}/pause`, {})
      .then(load)
      .catch((e: unknown) => {
        setPauseSent(false);
        setActionError(e instanceof Error ? e.message : 'Could not pause the run');
      });
  };
  const resume = () => {
    if (resuming) return;
    setResuming(true);
    setPauseSent(false);
    api
      .post(`/runs/${run.id}/resume`, {})
      .then(load)
      .catch((e: unknown) => setActionError(e instanceof Error ? e.message : 'Could not resume the run'))
      .finally(() => setResuming(false));
  };
  const takeOverHost = where?.desktop && where.hostId && viewer.hasPermission('fleet:desktop') ? where.hostId : null;
  const takeOver = () => navigate(`/fleet/hosts/${takeOverHost}/desktop`);
  const takeOverLabel = `Take over${where?.hostName ? ` on ${where.hostName}` : ''}`;
  // Two panes need a live frame; a finished run is one column at every width.
  const twoPane = isWide && isLive;

  const header = (
    <PageHeader
      variant="h5"
      // The goal as a person reads it here: masked (#553), so a remembered phone or account number is not shown in full.
      title={maskText(run.goal).text}
      back={run.taskId ? { to: `/tasks/${run.taskId}`, label: taskName ?? 'Task' } : back}
      actions={[
        { key: 'again', label: 'Run again', onClick: () => void again(), hidden: !finished || run.trigger === 'external' || !viewer.hasPermission('runs:write') },
        { key: 'delete', label: 'Delete', color: 'error', onClick: () => void remove(), hidden: !finished || !viewer.hasPermission('runs:delete') },
      ]}
      subtitle={
        <>
          Profile {run.profile} · {run.stepCount} steps{runCost(run) ? ` · ${runCost(run)}` : ''} · started {formatDateTime(run.createdAt)}
        </>
      }
    >
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <StatusChip status={run.status} size="medium" />
        {/* Who started it (#464): the console, the CLI, a schedule, or an AI app by name. */}
        <StartedByChip run={run} size="medium" />
        {!compact && (
          <Box sx={{ ml: 'auto' }}>
            <RunExportButton runId={run.id} live={isLive} exporter={exporter} />
          </Box>
        )}
      </Stack>
    </PageHeader>
  );
  // The action error and the way back to the task sit under the header in every layout.
  const chips = (
    <>
      <ErrorBanner error={actionError} onClose={() => setActionError(null)} />
      <ErrorBanner error={exporter.error} onClose={exporter.clearError} />
      {run.taskId && (
        <Typography variant="body2" sx={{ mb: 1 }}>
          <Link component={RouterLink} to={`/tasks/${run.taskId}`} underline="hover">
            Task{taskName ? `: ${taskName}` : ''}
          </Link>
          {' · '}
          <Link component={RouterLink} to="/runs" underline="hover">
            All runs
          </Link>
        </Typography>
      )}
      <RunHeaderChips policy={run.policy} tier={run.tier} />
      <RunInputs inputs={run.inputs} />
      <UsedMemories memories={run.memories} />
      <UsedSavedLogins logins={run.usedSavedLogins} />
      <UsedSavedIdentity details={run.usedSavedIdentity} />
      <UsedSavedCards cards={run.usedSavedCards} />
      <RunTraceId traceId={run.traceId} />
    </>
  );
  // A typed stop reason (#404) says why in one line; older runs keep the plain result and error.
  const outcome =
    !isLive && run.stopReason ? (
      <RunStopReason run={run} />
    ) : (
      <>
        {run.result && <Alert severity={run.status === 'succeeded' ? 'success' : 'info'} sx={{ my: 2 }}>{run.result}</Alert>}
        {run.error && <Alert severity="error" sx={{ my: 2 }}>{run.error}</Alert>}
      </>
    );
  // What the run returned (E39.5): once it has ended; a live run has nothing to show yet.
  const outputs = !isLive && <RunOutputs outputs={run.outputs} complete={run.outputsComplete} />;
  // What was sent when the run ended (E39.6): an email, a row, files, a webhook. Only a run of a task has any.
  const deliveries = !isLive && run.taskId && viewer.hasPermission('runs:read') ? <RunDeliveries runId={run.id} canRetryDelivery={viewer.hasPermission('runs:write')} /> : null;
  // Paused: nothing happens until the owner resumes or stops. The browser stays in view, and takeover stays available.
  const pausedBanner = paused && <PausedBanner onResume={canCancel ? resume : undefined} onStop={canCancel ? cancel : undefined} resuming={resuming} stopping={stopping} />;
  const waiting = run.status === 'waiting_human' && <Alert severity="warning" sx={{ my: 2 }}>The agent is waiting for you. Answer its request in the Inbox.</Alert>;
  // Below `md` these live in the sticky bar at the bottom instead.
  const actions = isLive && !compact && (
    <Stack direction="row" spacing={1} useFlexGap sx={{ mb: 2, flexWrap: 'wrap', rowGap: 1 }}>
      {canCancel && !paused && (
        <Button color="error" variant="outlined" disabled={stopping} onClick={cancel}>
          {stopping ? 'Stopping…' : 'Cancel run'}
        </Button>
      )}
      {canCancel && canPauseRun(run) && !stopping && (
        <Button variant="outlined" disabled={pausing} onClick={pause}>
          {pausing ? 'Pausing…' : 'Pause'}
        </Button>
      )}
      <Button variant="outlined" onClick={() => setWatch((w) => !w)}>
        {watch ? 'Stop watching' : 'Watch the browser'}
      </Button>
      {takeOverHost && (
        <Button variant="outlined" onClick={takeOver}>
          {takeOverLabel}
        </Button>
      )}
    </Stack>
  );
  // A phone shows the budget closest to its limit and expands to the rest; the narrower right pane takes two bars a row.
  const meter = run.budget && <RunBudgetMeter budget={run.budget} ticking={run.status === 'running'} now={now} collapsible={compact} maxColumns={twoPane ? 2 : 3} />;
  const activity = run.status === 'running' && run.activity && <RunActivityBar activity={run.activity} now={now} stopping={stopping} />;
  const caption = frameCaption(shotAt, shotFailing, now);
  const frameBody = (shot || shotFailing) && (
    <Box sx={{ mb: 2 }}>
      {shot && (
        // The wrapper is exactly the image's rendered box at every pane width, so the
        // overlay's percentages (of the frame's own pixels, #381) land on the same spot.
        <Box data-testid="frame" sx={{ position: 'relative', display: 'inline-block', maxWidth: '100%', verticalAlign: 'top', lineHeight: 0 }}>
          <Box
            component="img"
            src={shot}
            alt="The run's browser, live"
            onLoad={(e: React.SyntheticEvent<HTMLImageElement>) => setShotSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
            sx={{
              display: 'block',
              boxSizing: 'border-box',
              width: 'auto',
              height: 'auto',
              maxWidth: '100%',
              // The frame never pushes the steps off the window: capped to the pane on a wide screen, to 60% of the window's height below.
              ...(twoPane ? viewportMinus('maxHeight', PANE_OFFSET + 96) : { maxHeight: '60vh' }),
              borderRadius: 1,
              border: 1,
              borderColor: 'divider',
            }}
          />
          {run.status === 'running' && run.activity?.phase === 'acting' && <ActionOverlay activity={run.activity} natural={shotSize} />}
        </Box>
      )}
      <Typography variant="caption" component="p" color={caption.stale ? 'warning.main' : 'text.secondary'} data-testid="frame-age">
        {caption.text}
      </Typography>
    </Box>
  );
  const frame =
    isLive &&
    (compact ? (
      // Collapsible on a phone or tablet, open while watching: closing it also stops fetching frames.
      <Box sx={{ mb: 1 }}>
        <Stack direction="row" sx={{ alignItems: 'center' }}>
          <Typography variant="subtitle2" component="h2" sx={{ flexGrow: 1 }}>
            Browser
          </Typography>
          <IconButton aria-label={watch ? 'Hide the browser' : 'Show the browser'} aria-expanded={watch} onClick={() => setWatch((w) => !w)} sx={{ width: 44, height: 44 }}>
            {watch ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          </IconButton>
        </Stack>
        <Collapse in={watch} unmountOnExit>
          {frameBody || (
            <Typography variant="caption" component="p" color="text.secondary" sx={{ mb: 2 }}>
              {caption.text}
            </Typography>
          )}
        </Collapse>
      </Box>
    ) : (
      watch && frameBody
    ));
  const timeline = (
    <RunTimeline steps={run.steps ?? []} live={isLive} runId={run.id} fromChat={run.trigger === 'chat'} confirmedSeqs={Array.isArray(run.confirmedActions) ? run.confirmedActions.map((c) => c.seq) : []} />
  );
  // Below `md` the sticky bar carries the run's actions and, in its menu, Export.
  const exportBusy = exporter.busy !== null;
  const bar = compact && (isLive || exporter.canExport) && (
    <Paper
      elevation={6}
      role="toolbar"
      aria-label="Run actions"
      // Sticks above the phone's bottom bar (and the safe area) while the page scrolls; it is the page's last element, so at the end it rests in place.
      sx={{ position: 'sticky', bottom: aboveBottomBar(8), zIndex: 'speedDial', mt: 2, p: 0.5, display: 'flex', gap: 0.5, borderRadius: 2 }}
    >
      {isLive && canCancel && !paused && <BarAction label={stopping ? 'Stopping…' : 'Cancel run'} short={stopping ? 'Stopping…' : 'Cancel'} Icon={CancelOutlinedIcon} color="error" disabled={stopping} onClick={cancel} />}
      {canCancel && canPauseRun(run) && !stopping && <BarAction label={pausing ? 'Pausing…' : 'Pause'} short={pausing ? 'Pausing…' : 'Pause'} Icon={PauseCircleOutlinedIcon} disabled={pausing} onClick={pause} />}
      {paused && canCancel && <BarAction label={resuming ? 'Resuming…' : 'Resume'} short={resuming ? 'Resuming…' : 'Resume'} Icon={PlayCircleOutlinedIcon} disabled={resuming} onClick={resume} />}
      {isLive && <BarAction label={watch ? 'Stop watching' : 'Watch the browser'} short={watch ? 'Stop watching' : 'Watch'} Icon={watch ? VisibilityOffOutlinedIcon : VisibilityOutlinedIcon} onClick={() => setWatch((w) => !w)} />}
      {isLive && takeOverHost && <BarAction label={takeOverLabel} short="Take over" Icon={PanToolOutlinedIcon} onClick={takeOver} />}
      {exporter.canExport && (
        <BarAction
          label={exportBusy ? 'Preparing the export…' : 'Export'}
          short={exportBusy ? 'Preparing…' : 'Export'}
          Icon={FileDownloadOutlinedIcon}
          disabled={exportBusy}
          menu={{ id: exportMenuId, open: Boolean(exportAnchor) }}
          onClick={(e) => setExportAnchor(e.currentTarget)}
        />
      )}
    </Paper>
  );
  const exportMenu = compact && <RunExportMenu id={exportMenuId} anchorEl={exportAnchor} onClose={() => setExportAnchor(null)} exporter={exporter} runId={run.id} live={isLive} />;

  if (twoPane) {
    return (
      <PageContainer width="wide">
        {header}
        <Box data-testid="run-panes" sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 7fr) minmax(0, 5fr)', columnGap: 3, alignItems: 'start' }}>
          {/* Left: the browser, in view while the right pane scrolls. */}
          <Box data-testid="run-frame-pane" sx={{ position: 'sticky', top: PANE_OFFSET - 16, minWidth: 0 }}>
            {actions}
            {frame}
          </Box>
          {/* Right: what the run is doing and what it costs stay put; only the timeline scrolls under them. */}
          <Box
            data-testid="run-side-pane"
            sx={{ position: 'sticky', top: PANE_OFFSET - 16, display: 'flex', flexDirection: 'column', minWidth: 0, overflowY: 'auto', ...viewportMinus('maxHeight', PANE_OFFSET) }}
          >
            <Box sx={{ flexShrink: 0 }}>
              {chips}
              {waiting}
              {pausedBanner}
              {activity}
              {meter}
              {outcome}
              {outputs}
              {deliveries}
            </Box>
            <Box data-testid="run-timeline-scroll" tabIndex={0} role="region" aria-label="Timeline" sx={{ flex: '1 1 auto', minHeight: 240, overflowY: 'auto' }}>
              {timeline}
            </Box>
          </Box>
        </Box>
      </PageContainer>
    );
  }

  return (
    <PageContainer width="wide">
      {header}
      {chips}
      {outcome}
      {outputs}
      {deliveries}
      {waiting}
      {pausedBanner}
      {compact ? (
        <>
          {activity}
          {meter}
        </>
      ) : (
        <>
          {actions}
          {meter}
          {activity}
        </>
      )}
      {frame}
      {timeline}
      {bar}
      {exportMenu}
    </PageContainer>
  );
}
