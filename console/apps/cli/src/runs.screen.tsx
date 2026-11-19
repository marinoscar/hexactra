import { textColor, useTuiTheme, type TuiScreenProps } from '@marinoscar/platform-cli/tui';
import { Box, Text, useInput } from 'ink';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { consoleApi } from './console-api.js';
import { costText, runPolicyLines, type RunPolicyFields } from './policies.js';
import { mergeRunPages, type RunPage } from './runs.js';

interface Step {
  seq: number;
  kind: string;
  action: string | null;
  ok: boolean;
  summary: string;
}
export interface Run extends RunPolicyFields {
  id: string;
  status: string;
  goal: string;
  stepCount: number;
  result?: string | null;
  error?: string | null;
  steps?: Step[];
}

const label = (s: string) => (s === 'waiting_human' ? 'needs you' : s);
const live = (s: string) => s === 'queued' || s === 'running' || s === 'waiting_human' || s === 'paused';

/** How many runs one page holds: the first one, and each "more". */
export const RUNS_PAGE_SIZE = 30;

/**
 * Runs, newest first; the first page is refreshed every 2 s. Up/down selects;
 * Enter shows the run's steps (live); `p` pauses it and `u` resumes a paused one (E38.2); `c` cancels it; `m` loads the next page
 * of older runs (`GET /runs?envelope=1&cursor=…`); `r` refreshes; Esc goes
 * back (to the list, then the menu).
 */
export function RunsScreen({ onDone }: TuiScreenProps): ReactNode {
  const theme = useTuiTheme();
  /** The first page, re-read on every refresh. */
  const [head, setHead] = useState<Run[] | null>(null);
  /** The pages loaded with `m`, and where the next one starts (null: the list ends). */
  const [older, setOlder] = useState<Run[]>([]);
  const [headCursor, setHeadCursor] = useState<string | null>(null);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const runs = head ? mergeRunPages(head, older) : null;
  // Until "more" has been used the list continues after the first page.
  const nextCursor = olderCursor === undefined ? headCursor : olderCursor;
  const [selected, setSelected] = useState(0);
  const [open, setOpen] = useState<Run | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const api = consoleApi();
      const page = await api.get<RunPage<Run>>('/runs', { query: { envelope: 1, limit: RUNS_PAGE_SIZE } });
      setHead(page.items);
      setHeadCursor(page.nextCursor);
      setError(null);
      setOpen((o) => o);
      if (open) setOpen(await api.get<Run>(`/runs/${open.id}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [open]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 2_000);
    return () => clearInterval(t);
  }, [load]);

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      if (open) return setOpen(null);
      return onDone();
    }
    if (input === 'r') return void load();
    if (input === 'm' && !open && nextCursor && !loadingMore) {
      setLoadingMore(true);
      void consoleApi()
        .get<RunPage<Run>>('/runs', { query: { envelope: 1, limit: RUNS_PAGE_SIZE, cursor: nextCursor } })
        .then((page) => {
          setOlder((rows) => [...rows, ...page.items]);
          setOlderCursor(page.nextCursor);
          setStatus(null);
        })
        .catch((e: unknown) => setStatus(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoadingMore(false));
      return;
    }
    const list = runs ?? [];
    if (!open && key.upArrow) setSelected((i) => Math.max(0, i - 1));
    if (!open && key.downArrow) setSelected((i) => Math.min(Math.max(0, list.length - 1), i + 1));
    const current = open ?? list[selected];
    if (!current) return;
    if (key.return && !open) {
      void consoleApi()
        .get<Run>(`/runs/${current.id}`)
        .then(setOpen)
        .catch((e: unknown) => setStatus(e instanceof Error ? e.message : String(e)));
    }
    if (input === 'p' && (current.status === 'queued' || current.status === 'running' || current.status === 'waiting_human')) {
      void consoleApi()
        .post(`/runs/${current.id}/pause`, {})
        .then(() => setStatus('pause requested'))
        .catch((e: unknown) => setStatus(e instanceof Error ? e.message : String(e)));
    }
    if (input === 'u' && current.status === 'paused') {
      void consoleApi()
        .post(`/runs/${current.id}/resume`, {})
        .then(() => setStatus('resumed'))
        .catch((e: unknown) => setStatus(e instanceof Error ? e.message : String(e)));
    }
    if (input === 'c' && live(current.status)) {
      void consoleApi()
        .post(`/runs/${current.id}/cancel`, {})
        .then(() => setStatus('cancel requested'))
        .catch((e: unknown) => setStatus(e instanceof Error ? e.message : String(e)));
    }
  });

  if (open) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold wrap="truncate">
          {open.goal}
        </Text>
        <Text>[{label(open.status)}] {open.stepCount} steps</Text>
        {runPolicyLines(open).map((l) => (
          <Text key={l} dimColor wrap="truncate">
            {l}
          </Text>
        ))}
        <Box flexDirection="column">
          {(open.steps ?? []).slice(-15).map((s) => (
            <Text key={s.seq} wrap="truncate" dimColor={!s.ok}>
              {s.seq}. {s.action ?? s.kind}: {s.summary}
            </Text>
          ))}
        </Box>
        {open.result && <Text>result: {open.result}</Text>}
        {open.error && <Text {...textColor(theme.error)}>error: {open.error}</Text>}
        {status && <Text>{status}</Text>}
        <Text dimColor>p pause · u resume · c cancel · esc back</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold {...textColor(theme.primary)}>Runs</Text>
      {error && <Text {...textColor(theme.error)}>{error}</Text>}
      {!runs && !error && <Text dimColor>Loading…</Text>}
      {runs?.length === 0 && <Text>No runs yet. Start one with `hexactra tasks run`.</Text>}
      <Box flexDirection="column">
        {runs?.map((r, i) => (
          <Text key={r.id} inverse={i === selected} wrap="truncate">
            {i === selected ? '› ' : '  '}
            {label(r.status).padEnd(10)} {String(r.stepCount).padStart(3)} steps  {(r.policy?.name ?? '-').slice(0, 12).padEnd(12)} {(r.currentTier ?? '').padEnd(8)} {(costText(r) ?? '-').padEnd(8)}  {r.goal}
          </Text>
        ))}
      </Box>
      {status && <Text>{status}</Text>}
      {runs && runs.length > 0 && <Text dimColor>{loadingMore ? 'Loading older runs…' : nextCursor ? `${runs.length} runs shown · m for older runs` : `${runs.length} runs shown · that is all of them`}</Text>}
      <Text dimColor>↑/↓ select · enter steps · p pause · u resume · c cancel · m more · r refresh · esc back</Text>
    </Box>
  );
}
