import { Alert, Box, Button, Link, Paper, Skeleton, Stack, Typography } from '@mui/material';
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { ResponsiveList, StatusChip, formatDateTime, type Column } from '../ui';
import { MASKED_OUTPUT, outputValueText, type RunOutput, type TaskOutputsPage } from './model';

type Item = TaskOutputsPage['items'][number];

const PAGE = 10;

/** One value of a run in the table: the value as text; "Not found" in the warning colour; a sensitive one hidden. */
function Cell({ output }: { output: RunOutput | undefined }) {
  if (!output) return <>—</>;
  const notFound = output.value === null && !output.ok;
  return (
    <Box component="span" sx={{ overflowWrap: 'anywhere', ...(notFound ? { color: 'warning.main' } : output.value === MASKED_OUTPUT ? { color: 'text.secondary' } : {}) }}>
      {outputValueText(output)}
    </Box>
  );
}

/**
 * The history of what a task's finished runs returned (E39.5, #600): a row per run, newest first, a column per output (the
 * labels the task has now, then any an older run reported), so the owner sees amounts and confirmation numbers without opening
 * each run. A table from `md`, a card per run below it. `refreshKey` changes when a run finished.
 */
export function TaskOutputsTable({ taskId, refreshKey }: { taskId: string; refreshKey?: string }) {
  const { api } = usePlatformHost();
  const [page, setPage] = useState<TaskOutputsPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setPage(await api.get<TaskOutputsPage>(`/tasks/${taskId}/outputs?limit=${PAGE}`));
    } catch {
      setFailed(true);
    }
  }, [api, taskId]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const loadMore = async () => {
    if (!page?.nextCursor || more) return;
    setMore(true);
    try {
      const next = await api.get<TaskOutputsPage>(`/tasks/${taskId}/outputs?limit=${PAGE}&cursor=${encodeURIComponent(page.nextCursor)}`);
      setPage((p) => (p ? { columns: [...p.columns, ...next.columns.filter((c) => !p.columns.some((x) => x.key === c.key))], items: [...p.items, ...next.items], nextCursor: next.nextCursor } : next));
    } catch {
      setFailed(true);
    } finally {
      setMore(false);
    }
  };

  if (failed && !page) {
    return (
      <Alert severity="warning" action={<Button color="inherit" size="small" onClick={() => void load()}>Retry</Button>}>
        Could not load the outputs.
      </Alert>
    );
  }
  if (!page) return <Skeleton variant="rounded" height={96} aria-label="Loading the outputs" />;
  if (page.items.length === 0) {
    return (
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="body2" color="text.secondary">
          No finished run has returned outputs yet.
        </Typography>
      </Paper>
    );
  }

  const when = (i: Item) => formatDateTime(i.finishedAt ?? i.createdAt, { month: 'short', day: 'numeric', year: 'numeric' });
  const columns: Column<Item>[] = [
    {
      key: 'run',
      header: 'Run',
      render: (i) => (
        <Stack spacing={0.5} sx={{ alignItems: 'flex-start' }}>
          <Link component={RouterLink} to={`/runs/${i.runId}`} underline="hover">
            {when(i)}
          </Link>
          {i.status !== 'succeeded' && <StatusChip status={i.status} size="small" />}
        </Stack>
      ),
    },
    // The first value column takes the spare width; the others keep their text on one line (the table scrolls inside its box when there are many).
    ...page.columns.map((c, n) => ({ key: c.key, header: c.label, grow: n === 0, render: (i: Item) => <Cell output={i.values[c.key]} /> })),
  ];

  return (
    <Box data-testid="task-outputs">
      <ResponsiveList
        aria-label="Outputs of the last runs"
        items={page.items}
        columns={columns}
        getKey={(i) => i.runId}
        getLabel={(i) => `run of ${when(i)}`}
        renderCard={(i) => (
          <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1, gap: 1, flexWrap: 'wrap' }}>
              <Link component={RouterLink} to={`/runs/${i.runId}`} underline="hover" sx={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>
                {when(i)}
              </Link>
              {i.status !== 'succeeded' && <StatusChip status={i.status} size="small" />}
            </Stack>
            <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: '1fr', rowGap: 0.5 }}>
              {page.columns.map((c) => (
                <Box key={c.key}>
                  <Typography component="dt" variant="caption" color="text.secondary">
                    {c.label}
                  </Typography>
                  <Typography component="dd" variant="body2" sx={{ m: 0 }}>
                    <Cell output={i.values[c.key]} />
                  </Typography>
                </Box>
              ))}
            </Box>
          </Paper>
        )}
        footer={
          page.nextCursor ? (
            <Box sx={{ pt: 1 }}>
              <Button onClick={() => void loadMore()} disabled={more} sx={{ minHeight: 44 }}>
                {more ? 'Loading…' : 'Show older runs'}
              </Button>
            </Box>
          ) : undefined
        }
      />
      {failed && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          Could not load more.
        </Alert>
      )}
    </Box>
  );
}
