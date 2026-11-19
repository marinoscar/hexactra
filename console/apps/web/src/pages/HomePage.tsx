// `/`: the page a person opens first (#430). One request, `GET /home/summary`,
// answers: is an agent waiting for me, what is running, what runs next, how
// did the recent runs go, are my machines up. Each block renders from its part
// of the response; a block the viewer may not see is null and is not rendered.
import AddIcon from '@mui/icons-material/Add';
import { Box, Button, Card, CardContent, Chip, Link, Stack, TextField, Typography } from '@mui/material';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useOptionalAuth } from '@marinoscar/platform-web/identity/headless';

import { NeedsReconnectBlock } from '../connections/NeedsReconnectBlock';
import { useInboxCount } from '../components/InboxCountProvider';
import { useNow } from '../components/RunActivity';
import { BlockSkeleton, GetStartedBlock, MachinesBlock, NeedsYouBlock, RecentRunsBlock, RunningNowBlock, ThisWeekBlock, UpNextBlock } from '../components/home/blocks';
import { NEW_RUN_LINK, checklistSteps, firstName, greeting, needsChecklist, recentTasks, statusSentence } from '../components/home/homeText';
import { runTaskWith } from '../policies/api';
import type { HomeQuestion, HomeSummary } from '../types/home';
import { ErrorBanner, PageContainer, RelativeTime, useApiAction, useProfileTimeZone } from '../ui';

/** How often the summary is read again while the tab is visible. */
export const HOME_POLL_MS = 10_000;
/** ... and while an agent is running or waiting for the viewer. */
export const HOME_POLL_LIVE_MS = 5_000;
/** Once the first-run checklist has been completed in this browser it never returns. */
export const HOME_ONBOARDED_KEY = 'hexactra.home.onboarded';

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

function readOnboarded(): boolean {
  try {
    return window.localStorage.getItem(HOME_ONBOARDED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The summary, read on mount, when the window gets the focus or the tab
 * becomes visible, and on an interval while the tab is visible: 5 s while
 * something is live, 10 s otherwise. A failed read keeps the last good data.
 */
function useHomeSummary() {
  const { api } = usePlatformHost();
  const [summary, setSummary] = useState<HomeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setSummary(await api.get<HomeSummary>('/home/summary'));
      setLoadedAt(Date.now());
      setError(null);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not load your home page');
    } finally {
      inFlight.current = false;
    }
  }, [api]);

  const live = (summary?.liveRuns?.count ?? 0) > 0 || (summary?.needsYou?.count ?? 0) > 0;
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const period = live ? HOME_POLL_LIVE_MS : HOME_POLL_MS;
    const timer = setInterval(() => {
      if (visible()) void load();
    }, period);
    const wake = () => {
      if (visible()) void load();
    };
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [live, load]);

  return { summary, error, loadedAt, reload: load };
}

/** "What should your agent do?": one field, one button, and the tasks run most recently as chips. */
/**
 * Whether the viewer may connect AI apps and has none yet (#464): Home then
 * links to the "Connect an AI app" guide. False while unknown.
 */
function useNoConnectedApps(): boolean {
  const { api, viewer } = usePlatformHost();
  const canRead = viewer.hasPermission('connected_apps:read');
  const [none, setNone] = useState(false);
  useEffect(() => {
    if (!canRead) return;
    let stale = false;
    api
      .get<unknown[]>('/connected-apps')
      .then((apps) => {
        if (!stale) setNone(Array.isArray(apps) && apps.length === 0);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [api, canRead]);
  return none;
}

function QuickStart({ tasks, inputRef, connectApp = false }: { tasks: { id: string; name: string }[]; inputRef: React.RefObject<HTMLInputElement | null>; connectApp?: boolean }) {
  const { api } = usePlatformHost();
  const navigate = useNavigate();
  const [goal, setGoal] = useState('');
  const { run, busy, error, clearError } = useApiAction('Could not start the run');

  const start = async (e: FormEvent) => {
    e.preventDefault();
    if (!goal.trim()) return;
    // The default profile and the default policy: the full form is one link away.
    const created = await run('goal', () => api.post<{ id: string }>('/runs', { goal: goal.trim(), profile: 'default' }));
    if (created) navigate(`/runs/${created.id}`);
  };
  const runTask = async (id: string) => {
    const created = await run(id, () => runTaskWith(api, id));
    if (created) navigate(`/runs/${created.id}`);
  };

  return (
    <Card variant="outlined" component="section" aria-label="Quick start" data-testid="home-quick-start" sx={{ minWidth: 0 }}>
      <CardContent sx={{ p: { xs: 2, sm: 3 }, '&:last-child': { pb: { xs: 2, sm: 3 } } }}>
        <ErrorBanner error={error} onClose={clearError} />
        <Stack component="form" onSubmit={start} direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <TextField
            inputRef={inputRef}
            fullWidth
            size="small"
            label="What should your agent do?"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            slotProps={{ htmlInput: { maxLength: 4000 } }}
          />
          <Button type="submit" variant="contained" disabled={busy !== null || !goal.trim()} sx={{ minHeight: { xs: 44, sm: 40 }, px: 3 }}>
            Run
          </Button>
        </Stack>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', mt: 1.5 }}>
          {tasks.map((t) => (
            <Chip key={t.id} label={`Run: ${t.name}`} variant="outlined" disabled={busy !== null} onClick={() => void runTask(t.id)} sx={{ maxWidth: '100%', minHeight: { xs: 36, sm: 32 } }} />
          ))}
          <Link component={RouterLink} to={NEW_RUN_LINK} underline="hover" variant="body2" sx={{ ml: tasks.length > 0 ? 'auto' : 0, minHeight: { xs: 44, sm: 'auto' }, display: 'inline-flex', alignItems: 'center' }}>
            More options
          </Link>
          {connectApp && (
            <Link component={RouterLink} to="/settings/ai-apps/connect" underline="hover" variant="body2" data-testid="home-connect-ai-app" sx={{ minHeight: { xs: 44, sm: 'auto' }, display: 'inline-flex', alignItems: 'center' }}>
              Use it from ChatGPT or Claude
            </Link>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}

/** A slot of the page: its place in the single column of a phone. */
function Slot({ order, children }: { order: number; children: ReactNode }) {
  return <Box sx={{ order: { xs: order, md: 0 }, minWidth: 0 }}>{children}</Box>;
}

const COLUMN = { display: { xs: 'contents', md: 'flex' }, flexDirection: 'column', gap: 3, minWidth: 0 } as const;

export function HomePage() {
  const { api, viewer } = usePlatformHost();
  const name = firstName(useOptionalAuth()?.user?.displayName);
  const timeZone = useProfileTimeZone();
  const { summary, error, loadedAt, reload } = useHomeSummary();
  const noApps = useNoConnectedApps();
  const goalInput = useRef<HTMLInputElement | null>(null);
  const answer = useApiAction('Could not send the answer');
  const [onboarded, setOnboarded] = useState(readOnboarded);

  const hasLive = (summary?.liveRuns?.count ?? 0) > 0;
  // The navigation badge and this page count the same questions. The page's number comes with its summary (one
  // request); when it differs from the badge's, the badge re-reads at once instead of waiting for its own poll.
  const inbox = useInboxCount();
  const pending = summary?.needsYou?.count;
  const badge = useRef(inbox);
  badge.current = inbox;
  useEffect(() => {
    if (pending !== undefined && pending !== badge.current.count) badge.current.refresh();
  }, [pending]);
  const hasQuestions = (summary?.needsYou?.count ?? 0) > 0;
  // Only the countdown and the live cards move: a tick every second while there is one, every half minute otherwise.
  const now = useNow(true, hasLive || hasQuestions ? 1_000 : 30_000);

  const canRun = viewer.hasPermission('runs:write');
  const steps = summary ? checklistSteps(summary, viewer.hasPermission) : [];
  const complete = steps.length > 0 && steps.every((s) => s.done);
  useEffect(() => {
    if (!complete || onboarded) return;
    setOnboarded(true);
    try {
      window.localStorage.setItem(HOME_ONBOARDED_KEY, '1');
    } catch {
      // Private mode: the checklist is then derived from the data alone.
    }
  }, [complete, onboarded]);
  const checklist = !onboarded && needsChecklist(steps);

  const onAnswer = (q: HomeQuestion, value: 'approve' | 'deny') =>
    void answer.run(q.questionId, async () => {
      await api.post(`/questions/${q.questionId}/answer`, { outcome: 'completed', value, channel: 'web' });
      await reload();
    });

  const stale = error !== null && summary !== null;
  // What each column holds; an empty column (or an empty grid) is not rendered at all.
  const main = summary !== null && !checklist && (canRun || summary.recentRuns !== null);
  const side = summary !== null && ((!checklist && (summary.upcoming !== null || summary.week !== null)) || summary.fleet !== null);
  const dim = stale ? { opacity: 0.6 } : {};

  return (
    <PageContainer width="wide">
      {/* 1. The greeting, the status sentence and the primary action. */}
      <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start', justifyContent: 'space-between', mb: 3 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h4" component="h1" sx={{ overflowWrap: 'anywhere' }}>
            {greeting(now, timeZone)}
            {name ? `, ${name}` : ''}
          </Typography>
          <Typography color="text.secondary" sx={{ mt: 0.5 }} data-testid="home-status" aria-live="polite">
            {summary ? statusSentence(summary, now, timeZone) : ' '}
          </Typography>
        </Box>
        {canRun && !checklist && (
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => goalInput.current?.focus()} sx={{ display: { xs: 'none', sm: 'inline-flex' }, flexShrink: 0 }}>
            New run
          </Button>
        )}
      </Stack>

      {error && (
        <Box data-testid="home-error">
          <ErrorBanner error={error} onRetry={() => void reload()} />
          {stale && loadedAt !== null && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: -1, mb: 2 }}>
              Updated <RelativeTime iso={loadedAt} />
            </Typography>
          )}
        </Box>
      )}

      {summary === null && !error && (
        <Stack spacing={3} role="status" aria-label="Loading" aria-busy="true">
          <BlockSkeleton rows={2} testId="running" />
          <Box sx={{ display: 'grid', gap: 3, gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 7fr) minmax(0, 5fr)' } }}>
            <Stack spacing={3}>
              <BlockSkeleton rows={2} testId="quick-start" />
              <BlockSkeleton rows={6} testId="recent-runs" />
            </Stack>
            <Stack spacing={3}>
              <BlockSkeleton rows={4} testId="up-next" />
              <BlockSkeleton rows={5} testId="week" />
            </Stack>
          </Box>
        </Stack>
      )}

      {/* The Quick start box stays usable when the first read failed. */}
      {summary === null && error && canRun && <QuickStart tasks={[]} inputRef={goalInput} />}

      {summary !== null && (
        <Stack spacing={3}>
          <NeedsReconnectBlock />

          {/* 2. Needs you: always first. */}
          {summary.needsYou && summary.needsYou.count > 0 && (
            <Box sx={dim}>
              <NeedsYouBlock needsYou={summary.needsYou} now={now} canAnswer={canRun} busy={answer.busy} error={answer.error} onAnswer={onAnswer} />
            </Box>
          )}

          {/* 3. Running now: with the checklist, only when something is running. */}
          {summary.liveRuns && (!checklist || summary.liveRuns.count > 0) && (
            <Box sx={dim}>
              <RunningNowBlock liveRuns={summary.liveRuns} now={now} />
            </Box>
          )}

          {checklist && (
            <Box sx={dim}>
              <GetStartedBlock steps={steps} />
            </Box>
          )}

          {/* One column on a phone, in the order of `Slot`; two from `md` (7fr / 5fr). */}
          {(main || side) && (
            <Box
              sx={{ display: { xs: 'flex', md: 'grid' }, flexDirection: 'column', gap: 3, gridTemplateColumns: main && side ? 'minmax(0, 7fr) minmax(0, 5fr)' : 'minmax(0, 1fr)', alignItems: { xs: 'stretch', md: 'start' } }}
              data-testid="home-columns"
            >
              {main && (
                <Box sx={COLUMN}>
                  {canRun && (
                    <Slot order={1}>
                      <QuickStart tasks={recentTasks(summary)} inputRef={goalInput} connectApp={noApps} />
                    </Slot>
                  )}
                  {summary.recentRuns && (
                    <Slot order={3}>
                      <Box sx={dim}>
                        <RecentRunsBlock recentRuns={summary.recentRuns} />
                      </Box>
                    </Slot>
                  )}
                </Box>
              )}
              {side && (
                <Box sx={{ ...COLUMN, ...dim }}>
                  {!checklist && summary.upcoming && (
                    <Slot order={2}>
                      <UpNextBlock upcoming={summary.upcoming} now={now} timeZone={timeZone} />
                    </Slot>
                  )}
                  {!checklist && summary.week && (
                    <Slot order={4}>
                      <ThisWeekBlock week={summary.week} />
                    </Slot>
                  )}
                  {summary.fleet && (
                    <Slot order={5}>
                      <MachinesBlock fleet={summary.fleet} />
                    </Slot>
                  )}
                </Box>
              )}
            </Box>
          )}
        </Stack>
      )}
    </PageContainer>
  );
}
