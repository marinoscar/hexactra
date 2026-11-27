import { Alert, Box, Button, Checkbox, Chip, FormControlLabel, Link, Paper, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';

import { getKgStatus } from '../kgraph/api';
import { dismissImprovement, getImprovement, startImprovement, improvementPath, useGoalPath, type Evidence, type Improvement } from '../taskImprover/api';
import { wordDiff } from '../taskImprover/wordDiff';
import { CardSkeleton, EmptyState, ErrorBanner, PageContainer, PageHeader, formatDateTime, toast } from '../ui';

/** Poll a proposal being made every 2 s, for 3 minutes at most. */
const POLL_MS = 2_000;
const POLL_FOR_MS = 3 * 60_000;

const STATUS_WORDS: Record<Improvement['status'], string> = {
  queued: 'Waiting to start',
  running: 'Reading the runs',
  ready: 'Ready',
  failed: 'Failed',
  applied: 'Applied',
  dismissed: 'Dismissed',
};

/** `{{Name}}` as a chip, the rest as text. */
function withChips(text: string, keyPrefix: string): ReactNode[] {
  return text.split(/(\{\{\s*[^{}]+?\s*\}\})/g).map((part, i) =>
    /^\{\{.*\}\}$/.test(part) ? <Chip key={`${keyPrefix}-${i}`} size="small" variant="outlined" label={part.replace(/[{}\s]/g, '')} sx={{ mx: 0.25, height: 20 }} /> : <Fragment key={`${keyPrefix}-${i}`}>{part}</Fragment>,
  );
}

/** The goal before and after, word by word: removed struck through, added highlighted, each also named for a screen reader. */
export function GoalDiff({ before, after }: { before: string; after: string }) {
  const parts = wordDiff(before, after);
  return (
    <Typography component="div" variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.8 }} data-testid="goal-diff">
      {parts.map((p, i) =>
        p.op === 'same' ? (
          <Fragment key={i}>{withChips(p.text, `s${i}`)}</Fragment>
        ) : p.op === 'removed' ? (
          <Box key={i} component="del" sx={{ color: 'error.main', textDecorationThickness: 2 }} aria-label={`removed: ${p.text.trim()}`}>
            {withChips(p.text, `r${i}`)}
          </Box>
        ) : (
          <Box key={i} component="ins" sx={{ bgcolor: 'success.light', color: 'success.contrastText', textDecoration: 'none', borderRadius: 0.5, px: 0.25 }} aria-label={`added: ${p.text.trim()}`}>
            {withChips(p.text, `a${i}`)}
          </Box>
        ),
      )}
    </Typography>
  );
}

/** "Run 2, steps 53–110": a link to the run's step. */
function EvidenceLinks({ evidence, runIds }: { evidence: Evidence[]; runIds: string[] }) {
  return (
    <>
      {evidence.map((e, i) => {
        const n = runIds.indexOf(e.runId) + 1;
        const steps = e.seqFrom === e.seqTo ? `step ${e.seqFrom}` : `steps ${e.seqFrom}–${e.seqTo}`;
        return (
          <Fragment key={`${e.runId}-${e.seqFrom}-${i}`}>
            {i > 0 && ', '}
            <Link component={RouterLink} to={`/runs/${e.runId}#step-${e.seqFrom}`}>
              {n > 0 ? `Run ${n}, ${steps}` : steps}
            </Link>
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * `/tasks/:taskId/improvements/:id` (E52.9, #1024): a proposal for a better goal. While it is being made, it says so and polls; when
 * ready, it shows what the runs showed, the goal as a diff, why each change, the site facts to keep (only while the Knowledge Graph is
 * on, unticked), and two actions. **Use this goal** opens the task form prefilled: nothing changes until the owner saves there.
 */
export function TaskImprovementPage() {
  const { api, viewer } = usePlatformHost();
  const navigate = useNavigate();
  const { taskId = '', id = '' } = useParams();
  const [item, setItem] = useState<Improvement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [view, setView] = useState<'diff' | 'text'>('diff');
  const [facts, setFacts] = useState<number[]>([]);
  const [kgOn, setKgOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const started = useRef(Date.now());
  const heading = useRef<HTMLHeadingElement | null>(null);
  const canWrite = viewer.hasPermission('tasks:write');

  const load = useCallback(async () => {
    try {
      setItem(await getImprovement(api, id));
      setError(null);
    } catch (e) {
      if (isPlatformApiError(e) && (e.status === 404 || e.status === 400)) setMissing(true);
      else setError(e instanceof Error && e.message ? e.message : 'Could not load the proposal');
    }
  }, [api, id]);

  useEffect(() => {
    started.current = Date.now();
    setGaveUp(false);
    void load();
  }, [load]);

  useEffect(() => {
    heading.current?.focus();
  }, [item?.status]);

  // Poll while it is being made.
  useEffect(() => {
    if (!item || (item.status !== 'queued' && item.status !== 'running')) return;
    if (Date.now() - started.current > POLL_FOR_MS) return setGaveUp(true);
    const t = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(t);
  }, [item, load]);

  useEffect(() => {
    if (!viewer.hasPermission('kgraph:read')) return;
    getKgStatus(api)
      .then((s) => setKgOn(s.available))
      .catch(() => setKgOn(false));
  }, [api, viewer]);

  const retry = async () => {
    setBusy(true);
    try {
      const next = await startImprovement(api, taskId, item?.runIds);
      navigate(improvementPath(taskId, next));
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : 'Could not ask again', 'error');
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async () => {
    setBusy(true);
    try {
      setItem(await dismissImprovement(api, id));
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : 'Could not dismiss it', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (missing) {
    return (
      <PageContainer width="default">
        <EmptyState title="This proposal does not exist" body="It may have been deleted with its task." action={{ key: 'task', label: 'Back to the task', to: `/tasks/${taskId}` }} />
      </PageContainer>
    );
  }

  const changes = item?.changes ?? [];
  const siteFacts = item?.siteFacts ?? [];
  const unchanged = item?.status === 'ready' && (item.proposedGoal ?? '').trim() === item.goalBefore.trim();

  return (
    <PageContainer width="default">
      <PageHeader title="Improve this task" back={{ to: `/tasks/${taskId}`, label: 'Task' }} />
      <ErrorBanner error={error} onRetry={() => void load()} />
      {!item ? (
        !error && <CardSkeleton />
      ) : (
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="h6" component="h2" tabIndex={-1} ref={heading} sx={{ outline: 'none' }}>
              {STATUS_WORDS[item.status]}
            </Typography>
            {item.confidence && item.status !== 'failed' && <Chip size="small" variant="outlined" label={`Confidence: ${item.confidence}`} />}
            <Typography variant="body2" color="text.secondary">
              {item.runIds.length} {item.runIds.length === 1 ? 'run' : 'runs'} read · {formatDateTime(item.createdAt)}
            </Typography>
          </Stack>

          {(item.status === 'queued' || item.status === 'running') &&
            (gaveUp ? (
              <Alert severity="info">Still working: come back later. You can leave this page; the proposal keeps going.</Alert>
            ) : (
              <Alert severity="info">
                Reading {item.runIds.length} {item.runIds.length === 1 ? 'run' : 'runs'}… This takes a minute or two.
              </Alert>
            ))}

          {item.status === 'failed' && (
            <Alert severity="error" action={canWrite ? <Button color="inherit" size="small" disabled={busy} onClick={() => void retry()}>Try again</Button> : undefined}>
              {item.error ?? 'The proposal could not be made.'}
            </Alert>
          )}

          {item.summary && (
            <Paper variant="outlined" sx={{ p: 1.5 }} component="section" aria-label="What the runs showed">
              <Typography variant="subtitle2" component="h3" gutterBottom>
                What the runs showed
              </Typography>
              <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                {item.summary}
              </Typography>
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mt: 1 }}>
                {item.runIds.map((r, i) => (
                  <Link key={r} component={RouterLink} to={`/runs/${r}`} variant="body2">
                    Run {i + 1}
                  </Link>
                ))}
              </Stack>
            </Paper>
          )}

          {item.proposedGoal && (item.status === 'ready' || item.status === 'applied' || item.status === 'dismissed') && (
            <Paper variant="outlined" sx={{ p: 1.5 }} component="section" aria-label="Proposed goal">
              <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', mb: 1 }}>
                <Typography variant="subtitle2" component="h3">
                  Proposed goal
                </Typography>
                {!unchanged && (
                  <ToggleButtonGroup size="small" exclusive value={view} onChange={(_, v) => v && setView(v)} aria-label="How to show the goal">
                    <ToggleButton value="diff">Changes</ToggleButton>
                    <ToggleButton value="text">New text</ToggleButton>
                  </ToggleButtonGroup>
                )}
              </Stack>
              {unchanged ? (
                <Typography variant="body2">The runs show nothing to improve in the goal.</Typography>
              ) : view === 'diff' ? (
                <GoalDiff before={item.goalBefore} after={item.proposedGoal} />
              ) : (
                <Typography component="div" variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.8 }}>
                  {withChips(item.proposedGoal, 'n')}
                </Typography>
              )}
            </Paper>
          )}

          {changes.length > 0 && (
            <Paper variant="outlined" sx={{ p: 1.5 }} component="section" aria-label="Why">
              <Typography variant="subtitle2" component="h3" gutterBottom>
                Why
              </Typography>
              <Stack component="ul" spacing={1} sx={{ pl: 2.5, m: 0 }}>
                {changes.map((c, i) => (
                  <Box component="li" key={i}>
                    <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                      <strong>{c.text}</strong> {c.why} <EvidenceLinks evidence={c.evidence} runIds={item.runIds} />
                    </Typography>
                  </Box>
                ))}
              </Stack>
            </Paper>
          )}

          {kgOn && siteFacts.length > 0 && item.status === 'ready' && (
            <Paper variant="outlined" sx={{ p: 1.5 }} component="section" aria-label="Site facts to keep">
              <Typography variant="subtitle2" component="h3">
                Site facts to keep
              </Typography>
              <Typography variant="body2" color="text.secondary" gutterBottom>
                Tick the ones you want runs to read. They are saved as yours when you save the goal.
              </Typography>
              {siteFacts.map((f, i) => (
                <Box key={i}>
                  <FormControlLabel
                    control={<Checkbox checked={facts.includes(i)} onChange={(e) => setFacts((all) => (e.target.checked ? [...all, i] : all.filter((x) => x !== i)))} />}
                    label={
                      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                        <strong>{f.site}</strong> ({f.kind}): {f.text} <EvidenceLinks evidence={f.evidence} runIds={item.runIds} />
                      </Typography>
                    }
                  />
                </Box>
              ))}
            </Paper>
          )}

          {item.status === 'applied' && (
            <Alert severity="success">
              Applied {item.decidedAt ? formatDateTime(item.decidedAt) : ''}. <Link component={RouterLink} to={`/tasks/${taskId}`}>Open the task</Link>
            </Alert>
          )}
          {item.status === 'dismissed' && <Alert severity="info">Dismissed {item.decidedAt ? formatDateTime(item.decidedAt) : ''}.</Alert>}

          {item.status === 'ready' && canWrite && (
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
              {!unchanged && (
                <Button variant="contained" disabled={busy} onClick={() => navigate(useGoalPath(taskId, id, facts))}>
                  Use this goal
                </Button>
              )}
              <Button variant="outlined" disabled={busy} onClick={() => void dismiss()}>
                Dismiss
              </Button>
            </Stack>
          )}
        </Stack>
      )}
    </PageContainer>
  );
}
