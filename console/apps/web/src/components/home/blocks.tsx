// The blocks of the Home page (#430). Each renders from its part of
// `GET /home/summary`; the page decides which to show and where.
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import { Alert, Box, Button, Card, CardContent, Chip, LinearProgress, Link, Skeleton, Stack, Typography } from '@mui/material';
import type { SxProps, Theme } from '@mui/material';
import { Suspense, lazy, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import type { HomeFleet, HomeLiveRun, HomeQuestion, HomeRecentRun, HomeSummary, HomeWeek } from '../../types/home';
import { RelativeTime, StatusChip, formatCost } from '../../ui';
import { StartedByChip } from '../StartedByChip';
import { KIND_LABEL } from '../questions';
import { taskPaths } from '../taskList';
import { budgetColor, escalated, liveLine, progressLine, runDuration, successRate, timeLeft, upNextWhen, weekRunsLink, type ChecklistStep } from './homeText';

const HomeWeekChart = lazy(() => import('./HomeWeekChart'));

const TABULAR = { fontVariantNumeric: 'tabular-nums' } as const;
/** One line, cut with an ellipsis. */
const ONE_LINE = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 } as const;
const clamp = (lines: number) => ({ display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }) as const;
/** A touch target of 44 px on a phone. */
const TOUCH = { minHeight: { xs: 44, sm: 'auto' } } as const;

/** A titled, outlined card: the frame of every block. */
export function Block({ title, count, children, footer, sx, testId }: { title: string; count?: number; children: ReactNode; footer?: ReactNode; sx?: SxProps<Theme>; testId: string }) {
  const id = `home-${testId}-title`;
  return (
    <Card variant="outlined" component="section" aria-labelledby={id} data-testid={`home-${testId}`} sx={{ minWidth: 0, ...sx }}>
      <CardContent sx={{ p: { xs: 2, sm: 3 }, '&:last-child': { pb: { xs: 2, sm: 3 } } }}>
        <Typography id={id} variant="h6" component="h2" sx={{ mb: 2 }}>
          {title}
          {count !== undefined && (
            <Typography component="span" color="text.secondary" sx={{ ml: 1, ...TABULAR }}>
              {count}
            </Typography>
          )}
        </Typography>
        {children}
        {footer && <Box sx={{ mt: 2 }}>{footer}</Box>}
      </CardContent>
    </Card>
  );
}

/** The one link a block ends with. */
export function BlockLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link component={RouterLink} to={to} underline="hover" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, typography: 'body2', minHeight: { xs: 44, sm: 'auto' } }}>
      {children}
      <ArrowForwardIcon aria-hidden sx={{ fontSize: 16 }} />
    </Link>
  );
}

/** A block's placeholder on the first load, about the height of its content. */
export function BlockSkeleton({ rows = 3, testId }: { rows?: number; testId: string }) {
  return (
    <Card variant="outlined" data-testid={`home-skeleton-${testId}`} aria-hidden>
      <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
        <Skeleton variant="text" width="35%" sx={{ fontSize: '1.25rem', mb: 1 }} />
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} variant="text" width={i % 2 === 0 ? '90%' : '65%'} height={28} />
        ))}
      </CardContent>
    </Card>
  );
}

// ---- 2. Needs you ----

export interface NeedsYouProps {
  needsYou: NonNullable<HomeSummary['needsYou']>;
  now: number;
  /** The viewer may answer (`runs:write`). */
  canAnswer: boolean;
  /** The question being answered, or null. */
  busy: string | null;
  error: string | null;
  onAnswer: (question: HomeQuestion, value: 'approve' | 'deny') => void;
}

/** A confirmation that can be answered here: high-risk ones need the Inbox's second step. */
export function answersInline(q: HomeQuestion): boolean {
  return q.input === 'confirm' && q.risk !== 'high';
}

export function NeedsYouBlock({ needsYou, now, canAnswer, busy, error, onAnswer }: NeedsYouProps) {
  return (
    <Block title="Needs you" count={needsYou.count} testId="needs-you" sx={{ borderLeft: 4, borderLeftColor: 'warning.main' }}>
      {error && (
        <Alert severity="error" role="alert" sx={{ mb: 2, overflowWrap: 'anywhere' }}>
          {error}
        </Alert>
      )}
      <Stack spacing={2} divider={<Box sx={{ borderTop: 1, borderColor: 'divider' }} />}>
        {needsYou.items.map((q) => (
          <Box key={q.questionId} data-testid={`home-question-${q.questionId}`} sx={{ minWidth: 0 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
              <Chip size="small" variant="outlined" label={KIND_LABEL[q.kind] ?? 'Question'} />
              <Typography variant="body2" color="text.secondary" role="timer" aria-live="off" sx={TABULAR}>
                {timeLeft(q.expiresAt, now)}
              </Typography>
            </Stack>
            <Typography sx={clamp(2)}>{q.prompt}</Typography>
            {q.goal && (
              <Typography variant="body2" color="text.secondary" sx={ONE_LINE}>
                {q.goal}
              </Typography>
            )}
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mt: 1 }}>
              {canAnswer && answersInline(q) && (
                <>
                  <Button variant="contained" size="small" disabled={busy !== null} onClick={() => onAnswer(q, 'approve')} sx={TOUCH}>
                    Approve
                  </Button>
                  <Button variant="outlined" size="small" disabled={busy !== null} onClick={() => onAnswer(q, 'deny')} sx={TOUCH}>
                    Deny
                  </Button>
                </>
              )}
              <Button
                component={RouterLink}
                to={`/inbox?q=${q.questionId}`}
                size="small"
                variant={canAnswer && answersInline(q) ? 'text' : 'contained'}
                sx={TOUCH}
                aria-label={`${canAnswer ? 'Answer' : 'Open'}: ${q.prompt.slice(0, 80)}`}
              >
                {canAnswer ? 'Answer' : 'Open'}
              </Button>
            </Stack>
          </Box>
        ))}
      </Stack>
      <Box sx={{ mt: 2 }}>
        <BlockLink to="/inbox">View all ({needsYou.count})</BlockLink>
      </Box>
    </Block>
  );
}

// ---- 3. Running now ----

function LiveRunCard({ run, now }: { run: HomeLiveRun; now: number }) {
  const percent = run.budgetPercent;
  return (
    <Card variant="outlined" data-testid={`home-live-${run.id}`} sx={{ minWidth: 0 }}>
      <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
          <StatusChip status={run.status} />
          {escalated(run) && (
            <Typography variant="caption" color="text.secondary" data-testid="home-live-tier" sx={{ textTransform: 'capitalize' }}>
              {run.currentTier} tier
            </Typography>
          )}
          <Box sx={{ flexGrow: 1 }} />
          <Button component={RouterLink} to={`/runs/${run.id}`} size="small" sx={TOUCH} aria-label={`Watch: ${run.taskName ?? run.goal.slice(0, 80)}`}>
            Watch
          </Button>
        </Stack>
        <Typography variant="subtitle1" component="h3" sx={ONE_LINE} title={run.taskName ?? run.goal}>
          {run.taskName ?? run.goal}
        </Typography>
        <Typography variant="body2" role="status" sx={{ ...ONE_LINE, '@media (prefers-reduced-motion: no-preference)': { transition: 'opacity 150ms' } }} data-testid="home-live-activity">
          {liveLine(run)}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ ...ONE_LINE, ...TABULAR }}>
          {progressLine(run, now)}
          {run.hostName ? ` · ${run.hostName}` : ''}
        </Typography>
        {percent !== null && (
          <Box sx={{ mt: 1 }} data-testid="home-live-budget">
            <LinearProgress variant="determinate" value={Math.min(100, percent)} color={budgetColor(percent, run.budgetWarnPercent)} aria-label="Budget used" sx={{ height: 4, borderRadius: 2 }} />
            <Typography variant="caption" color="text.secondary" sx={TABULAR}>
              {Math.round(percent)} % of budget
            </Typography>
          </Box>
        )}
      </CardContent>
    </Card>
  );
}

export function RunningNowBlock({ liveRuns, now }: { liveRuns: NonNullable<HomeSummary['liveRuns']>; now: number }) {
  if (liveRuns.count === 0) {
    return (
      <Typography color="text.secondary" data-testid="home-running-empty">
        No agent is running right now.
      </Typography>
    );
  }
  const more = liveRuns.count - liveRuns.items.length;
  return (
    <Box component="section" aria-labelledby="home-running-title" data-testid="home-running" sx={{ minWidth: 0 }}>
      <Typography id="home-running-title" variant="h6" component="h2" sx={{ mb: 2 }}>
        Running now
        <Typography component="span" color="text.secondary" sx={{ ml: 1, ...TABULAR }}>
          {liveRuns.count}
        </Typography>
      </Typography>
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(3, minmax(0, 1fr))' } }}>
        {liveRuns.items.map((run) => (
          <LiveRunCard key={run.id} run={run} now={now} />
        ))}
      </Box>
      {more > 0 && (
        <Box sx={{ mt: 1 }}>
          <BlockLink to="/runs">{more} more running</BlockLink>
        </Box>
      )}
    </Box>
  );
}

// ---- 5. Up next ----

export function UpNextBlock({ upcoming, now, timeZone }: { upcoming: NonNullable<HomeSummary['upcoming']>; now: number; timeZone: string }) {
  const notes: ReactNode[] = [];
  if (upcoming.pausedCount > 0) {
    notes.push(
      <Link key="paused" component={RouterLink} to={`${taskPaths.list}?filter=paused`} underline="hover">
        {upcoming.pausedCount} paused
      </Link>,
    );
  }
  if (upcoming.failingCount > 0) {
    notes.push(
      <Link key="failing" component={RouterLink} to={`${taskPaths.list}?filter=failing`} underline="hover" color="error">
        {upcoming.failingCount} failing
      </Link>,
    );
  }
  const footer = (
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
      <BlockLink to={taskPaths.list}>{upcoming.items.length === 0 ? 'Schedule a task' : 'All tasks'}</BlockLink>
      {notes.length > 0 && (
        <Typography variant="body2" sx={TABULAR} data-testid="home-upnext-notes">
          {notes.flatMap((n, i) => (i === 0 ? [n] : [' · ', n]))}
        </Typography>
      )}
    </Stack>
  );
  return (
    <Block title="Up next" testId="up-next" footer={footer}>
      {upcoming.items.length === 0 ? (
        <Typography color="text.secondary">Nothing is scheduled.</Typography>
      ) : (
        <Stack component="ul" spacing={1.5} sx={{ listStyle: 'none', p: 0, m: 0 }}>
          {upcoming.items.map((u) => (
            <Box component="li" key={u.scheduleId} sx={{ minWidth: 0 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
                <Link component={RouterLink} to={taskPaths.detail(u.taskId)} underline="hover" color="text.primary" sx={{ ...ONE_LINE, fontWeight: 500 }}>
                  {u.taskName}
                </Link>
                <Typography variant="body2" sx={{ whiteSpace: 'nowrap', ...TABULAR }}>
                  <time dateTime={u.nextRunAt}>{upNextWhen(u.nextRunAt, now, timeZone)}</time>
                </Typography>
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={ONE_LINE}>
                {u.description}
              </Typography>
            </Box>
          ))}
        </Stack>
      )}
    </Block>
  );
}

// ---- 6. Recent runs ----

function RecentRunRow({ run }: { run: HomeRecentRun }) {
  const duration = runDuration(run);
  const cost = formatCost(run.costUsd, run.costKnown);
  return (
    <Box
      component="li"
      sx={{ borderBottom: 1, borderColor: 'divider', '&:last-of-type': { borderBottom: 0 } }}
    >
      <Box
        component={RouterLink}
        to={`/runs/${run.id}`}
        data-testid={`home-recent-${run.id}`}
        sx={{
          display: 'grid',
          // A phone: the chip and the time on one line, the name on its own line under them.
          gridTemplateColumns: { xs: 'minmax(0, 1fr) auto', sm: 'auto minmax(0, 1fr) auto' },
          gridTemplateAreas: { xs: '"chip meta" "name name"', sm: '"chip name meta"' },
          justifyItems: 'start',
          columnGap: 1.5,
          rowGap: 0.5,
          alignItems: 'center',
          py: 1,
          minHeight: 44,
          color: 'text.primary',
          textDecoration: 'none',
          borderRadius: 1,
          '&:hover': { bgcolor: 'action.hover' },
          '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: 2 },
        }}
      >
        <Stack direction="row" spacing={0.5} useFlexGap sx={{ gridArea: 'chip', minWidth: 0, maxWidth: '100%', flexWrap: 'wrap' }}>
          <StatusChip status={run.status} stopReason={run.stopReason} />
          {/* Who started it (#464), when it was not the console itself. */}
          {(run.client || (run.origin && run.origin !== 'web')) && <StartedByChip run={run} />}
        </Stack>
        <Box sx={{ gridArea: 'name', minWidth: 0, maxWidth: '100%' }}>
          <Typography sx={ONE_LINE}>{run.taskName ?? run.goal}</Typography>
          {run.error && (
            <Typography variant="body2" color="error" sx={ONE_LINE}>
              {run.error}
            </Typography>
          )}
        </Box>
        <Stack direction="row" spacing={1.5} sx={{ gridArea: 'meta', justifySelf: 'end', alignItems: 'baseline', whiteSpace: 'nowrap', color: 'text.secondary', typography: 'body2', ...TABULAR }}>
          {duration && <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>{duration}</Box>}
          {cost && (
            <Box component="span" data-testid="home-recent-cost" sx={{ display: { xs: 'none', md: 'inline' } }}>
              {cost}
            </Box>
          )}
          <RelativeTime iso={run.finishedAt ?? run.createdAt} />
        </Stack>
      </Box>
    </Box>
  );
}

export function RecentRunsBlock({ recentRuns }: { recentRuns: NonNullable<HomeSummary['recentRuns']> }) {
  return (
    <Block title="Recent runs" testId="recent-runs" footer={<BlockLink to="/runs">All runs</BlockLink>}>
      {recentRuns.items.length === 0 ? (
        <Typography color="text.secondary">No run has finished yet.</Typography>
      ) : (
        <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }}>
          {recentRuns.items.map((run) => (
            <RecentRunRow key={run.id} run={run} />
          ))}
        </Box>
      )}
    </Block>
  );
}

// ---- 7. This week ----

function Figure({ label, value, to, testId }: { label: string; value: string; to?: string; testId: string }) {
  const body = (
    <>
      <Typography variant="h5" component="span" sx={{ display: 'block', ...TABULAR }} data-testid={`home-week-${testId}`}>
        {value}
      </Typography>
      <Typography variant="body2" color="text.secondary" component="span">
        {label}
      </Typography>
    </>
  );
  if (!to) return <Box sx={{ minWidth: 0 }}>{body}</Box>;
  return (
    <Link component={RouterLink} to={to} underline="hover" color="inherit" aria-label={`${label}: ${value}`} sx={{ minWidth: 0, display: 'block' }}>
      {body}
    </Link>
  );
}

const SR_ONLY = { position: 'absolute', width: '1px', height: '1px', p: 0, m: '-1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 } as const;

export function ThisWeekBlock({ week }: { week: HomeWeek }) {
  const t = week.totals;
  const runs = t.succeeded + t.failed + t.cancelled;
  const from = week.series[0]?.date ?? '';
  const spend = formatCost(t.costUsd, t.costKnown);
  const stops: ReactNode[] = [];
  if (t.budgetStops > 0) {
    stops.push(
      <Link key="budget" component={RouterLink} to={weekRunsLink(from, 'budget')} underline="hover">
        {t.budgetStops} stopped by budget
      </Link>,
    );
  }
  if (t.stalled > 0) {
    stops.push(
      <Link key="stalled" component={RouterLink} to={weekRunsLink(from, 'stalled')} underline="hover">
        {t.stalled} stalled
      </Link>,
    );
  }
  return (
    <Block title="This week" testId="week" footer={<BlockLink to="/runs">All runs</BlockLink>}>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: `repeat(${spend ? 4 : 3}, minmax(0, 1fr))` }, gap: 2, mb: 1 }}>
        <Figure label="Runs" value={String(runs)} testId="runs" />
        <Figure label="Success rate" value={successRate(t.successRate)} testId="rate" />
        <Figure label="Failed" value={String(t.failed)} to={weekRunsLink(from)} testId="failed" />
        {spend && <Figure label="Spend" value={spend} testId="spend" />}
      </Box>
      {runs > 0 && (
        <>
          <Box aria-hidden sx={{ height: 160, minWidth: 0 }}>
            <Suspense fallback={<Skeleton variant="rounded" height={160} />}>
              <HomeWeekChart series={week.series} />
            </Suspense>
          </Box>
          <Stack direction="row" spacing={2} aria-hidden sx={{ typography: 'caption', color: 'text.secondary', mt: 0.5 }}>
            {(
              [
                ['Succeeded', 'success.main'],
                ['Failed', 'error.main'],
                ['Cancelled', 'text.disabled'],
              ] as const
            ).map(([label, color]) => (
              <Box key={label} component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                <Box component="span" sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: color }} />
                {label}
              </Box>
            ))}
          </Stack>
        </>
      )}
      {/* The same numbers for a screen reader: the chart itself is hidden from it. */}
      <Box sx={SR_ONLY}>
        <table data-testid="home-week-table">
          <caption>Runs per day over the last 7 days</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Succeeded</th>
              <th scope="col">Failed</th>
              <th scope="col">Cancelled</th>
            </tr>
          </thead>
          <tbody>
            {week.series.map((d) => (
              <tr key={d.date}>
                <th scope="row">{d.date}</th>
                <td>{d.succeeded}</td>
                <td>{d.failed}</td>
                <td>{d.cancelled}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Box>
      {stops.length > 0 && (
        <Typography variant="body2" sx={{ mt: 1, ...TABULAR }} data-testid="home-week-stops">
          {stops.flatMap((n, i) => (i === 0 ? [n] : [' · ', n]))}
        </Typography>
      )}
    </Block>
  );
}

// ---- 8. Machines ----

function hostState(h: HomeFleet['hosts'][number]): { text: string; color: string } {
  if (!h.online) return { text: 'offline', color: 'text.disabled' };
  if (h.draining) return { text: 'disabled', color: 'warning.main' };
  return { text: 'online', color: 'success.main' };
}

export function MachinesBlock({ fleet }: { fleet: HomeFleet }) {
  const none = fleet.total === 0;
  return (
    <Block title="Machines" testId="machines" footer={<BlockLink to="/fleet">{none ? 'Connect a machine' : 'Manage machines'}</BlockLink>}>
      {none ? (
        <Typography color="text.secondary">{fleet.stale ? 'The machines could not be read.' : 'No machine is connected.'}</Typography>
      ) : (
        <>
          <Typography sx={{ mb: 1, ...TABULAR }}>
            {fleet.online} of {fleet.total} online
            {fleet.disabled > 0 ? ` · ${fleet.disabled} disabled` : ''}
          </Typography>
          <Stack component="ul" spacing={0.5} sx={{ listStyle: 'none', p: 0, m: 0 }}>
            {fleet.hosts.map((h) => {
              const state = hostState(h);
              return (
                <Box component="li" key={h.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                  <Box aria-hidden sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: state.color, flexShrink: 0 }} />
                  <Typography variant="body2" sx={{ ...ONE_LINE, flexGrow: 1 }}>
                    {h.name}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {state.text}
                  </Typography>
                </Box>
              );
            })}
          </Stack>
          {fleet.total > fleet.hosts.length && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              and {fleet.total - fleet.hosts.length} more
            </Typography>
          )}
        </>
      )}
      {fleet.stale && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }} data-testid="home-machines-stale">
          Status may be out of date.
        </Typography>
      )}
    </Block>
  );
}

// ---- The first-run checklist ----

export function GetStartedBlock({ steps }: { steps: ChecklistStep[] }) {
  return (
    <Block title="Get started" testId="get-started">
      <Stack component="ol" spacing={1} sx={{ listStyle: 'none', p: 0, m: 0 }}>
        {steps.map((step, i) => (
          <Box component="li" key={step.key} data-testid={`home-step-${step.key}`} data-done={step.done} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minHeight: 44 }}>
            {step.done ? <CheckCircleIcon color="success" aria-hidden /> : <RadioButtonUncheckedIcon color="disabled" aria-hidden />}
            {step.done ? (
              <Typography color="text.secondary">
                {i + 1}. {step.label} <Box component="span" sx={SR_ONLY}>(done)</Box>
              </Typography>
            ) : (
              <Link component={RouterLink} to={step.to} underline="hover" sx={{ fontWeight: 500 }}>
                {i + 1}. {step.label}
              </Link>
            )}
          </Box>
        ))}
      </Stack>
    </Block>
  );
}
