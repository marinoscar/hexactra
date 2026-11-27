import { Box, Chip, Link, Paper, Stack, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useEffect, useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { formatCost } from '../ui';
import { durationWords } from './taskDetail';

interface Spread {
  min: number;
  median: number;
  p90: number;
  max: number;
  ratio: number;
}

/** `GET /tasks/{id}/consistency` (E52.7, #1022). */
export interface TaskConsistencyData {
  taskId: string;
  runs: number;
  succeeded: number;
  successRate: number;
  steps: Spread | null;
  modelCalls: Spread | null;
  activeMs: Spread | null;
  costUsd: Spread | null;
  label: 'not_enough_runs' | 'steady' | 'varies' | 'erratic';
  since: string | null;
  perRun: { runId: string; status: string; createdAt: string; stepCount: number; costUsd: number | null; activeMs: number; findings: { code: string; severity: string }[] }[];
}

export const CONSISTENCY_LABEL: Record<TaskConsistencyData['label'], { text: string; color: 'success' | 'warning' | 'error' | 'default' }> = {
  steady: { text: 'Steady', color: 'success' },
  varies: { text: 'Varies', color: 'warning' },
  erratic: { text: 'Erratic', color: 'error' },
  not_enough_runs: { text: 'Not enough runs yet', color: 'default' },
};

const FINDING_WORDS: Record<string, string> = {
  loop: 'Loop',
  selector_miss: 'Selector missed',
  repeated_click: 'Repeated click',
  budget_pressure: 'Near a budget',
  unknown_outcome: 'Unknown outcome',
};

/** "Usually 31 steps; the longest of the last 12 took 124." */
export function consistencySentence(c: TaskConsistencyData): string {
  if (!c.steps || c.runs === 0) return 'No finished runs yet.';
  const usual = Math.round(c.steps.median);
  if (c.runs < 3) return `${c.runs} finished ${c.runs === 1 ? 'run' : 'runs'} so far, ${usual} steps at the median.`;
  return c.steps.max > c.steps.median ? `Usually ${usual} steps; the longest of the last ${c.runs} took ${c.steps.max}.` : `Every one of the last ${c.runs} runs took about ${usual} steps.`;
}

function Range({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" component="div">
        {label}
      </Typography>
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
        {children}
      </Typography>
    </Box>
  );
}

/** The card, from the data: the label, one sentence, median and range for steps, cost and working time, and a bar per run. */
export function TaskConsistencyCard({ data, improveLink }: { data: TaskConsistencyData; improveLink?: ReactNode }) {
  const label = CONSISTENCY_LABEL[data.label];
  const maxSteps = Math.max(1, ...data.perRun.map((r) => r.stepCount));
  const cost = (n: number) => formatCost(n) ?? `$${n.toFixed(2)}`;
  return (
    <Paper variant="outlined" component="section" aria-label="Consistency" sx={{ p: 1.5, minWidth: 0 }} data-testid="task-consistency">
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 1 }}>
        <Typography variant="subtitle2" component="h2">
          Consistency
        </Typography>
        <Chip size="small" color={label.color} variant="outlined" label={label.text} data-label={data.label} />
        {improveLink}
      </Stack>
      <Typography variant="body2" sx={{ mb: 1 }}>
        {consistencySentence(data)}
      </Typography>
      {data.steps && (
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 1, mb: 1 }}>
          <Range label="Steps">
            {Math.round(data.steps.median)} ({data.steps.min}–{data.steps.max})
          </Range>
          {data.costUsd && (
            <Range label="Cost">
              {cost(data.costUsd.median)} ({cost(data.costUsd.min)}–{cost(data.costUsd.max)})
            </Range>
          )}
          {data.activeMs && (
            <Range label="Working time">
              {durationWords(data.activeMs.median / 1000)} ({durationWords(data.activeMs.min / 1000)}–{durationWords(data.activeMs.max / 1000)})
            </Range>
          )}
          <Range label="Succeeded">
            {data.succeeded} of {data.runs}
          </Range>
        </Box>
      )}
      {data.perRun.length > 0 && (
        <Box
          component="ol"
          aria-label="Runs by steps"
          // One grid for every row, so the bars share one column and compare: link, bar, warnings.
          sx={{ listStyle: 'none', p: 0, m: 0, display: 'grid', gridTemplateColumns: '64px minmax(40px, 1fr) auto', columnGap: 1, rowGap: 0.5, alignItems: 'center' }}
        >
          {data.perRun.map((r) => (
            <Box component="li" key={r.runId} sx={{ display: 'contents' }}>
              <Link component={RouterLink} to={`/runs/${r.runId}`} variant="caption" aria-label={`Run with ${r.stepCount} steps, ${r.status}`}>
                {r.stepCount} steps
              </Link>
              <Box aria-hidden sx={{ minWidth: 0, height: 8, borderRadius: 1, bgcolor: 'action.hover' }}>
                <Box sx={{ width: `${Math.max(2, (r.stepCount / maxSteps) * 100)}%`, height: '100%', borderRadius: 1, bgcolor: r.status === 'succeeded' ? 'primary.main' : 'error.main' }} />
              </Box>
              <Stack direction="row" spacing={0.5} sx={{ justifyContent: 'flex-end', flexWrap: 'wrap', rowGap: 0.5 }}>
                {r.findings
                  .filter((f) => f.severity === 'warn')
                  // The first warning only: the bar keeps its room on a phone, and the run page lists them all.
                  .slice(0, 1)
                  .map((f) => (
                    <Chip key={f.code} size="small" variant="outlined" color="warning" label={FINDING_WORDS[f.code] ?? f.code} />
                  ))}
              </Stack>
            </Box>
          ))}
        </Box>
      )}
    </Paper>
  );
}

/** The task page's "Consistency" card (E52.7): fetched for the task, refreshed when its last run changes. Nothing when it cannot be read. */
export function TaskConsistency({ taskId, refreshKey, since, improveLink }: { taskId: string; refreshKey?: string; since?: string | null; improveLink?: ReactNode }) {
  const { api } = usePlatformHost();
  const [data, setData] = useState<TaskConsistencyData | null>(null);
  useEffect(() => {
    let live = true;
    const query = since ? `?since=${encodeURIComponent(since)}` : '';
    api
      .get<TaskConsistencyData>(`/tasks/${taskId}/consistency${query}`)
      .then((d) => live && setData(d))
      .catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, [api, taskId, refreshKey, since]);
  if (!data) return null;
  return <TaskConsistencyCard data={data} improveLink={improveLink} />;
}
