import { textColor, useTuiTheme, type TuiScreenProps } from '@marinoscar/platform-cli/tui';
import { Box, Text, useInput } from 'ink';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { consoleApi } from './console-api.js';
import { costText, runPolicyLines, type RunPolicyFields } from './policies.js';

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
const live = (s: string) => s === 'queued' || s === 'running' || s === 'waiting_human';

/**
 * Runs, refreshed every 2 s. Up/down selects; Enter shows the run's steps
 * (live); `c` cancels it; `r` refreshes; Esc goes back (to the list, then
 * the menu).
 */
export function RunsScreen({ onDone }: TuiScreenProps): ReactNode {
  const theme = useTuiTheme();
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [open, setOpen] = useState<Run | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const api = consoleApi();
      const list = await api.get<Run[]>('/runs', { query: { limit: 30 } });
      setRuns(list);
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
        <Text dimColor>c cancel · esc back</Text>
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
      <Text dimColor>↑/↓ select · enter steps · c cancel · r refresh · esc back</Text>
    </Box>
  );
}
