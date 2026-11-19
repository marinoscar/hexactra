// What a task is wired to (E39.10, #607), as chips: "2 accounts", "3 deliveries", "Starts from email". Nothing for a task that has none.
import { Chip, Stack } from '@mui/material';

import type { TaskWithSummary } from '../types/tasks';

export function taskChipLabels(task: Pick<TaskWithSummary, 'connections' | 'summary'>): string[] {
  const out: string[] = [];
  const accounts = task.connections?.length ?? 0;
  if (accounts > 0) out.push(accounts === 1 ? '1 account' : `${accounts} accounts`);
  const deliveries = task.summary?.deliveries ?? 0;
  if (deliveries > 0) out.push(deliveries === 1 ? '1 delivery' : `${deliveries} deliveries`);
  if ((task.summary?.mailTriggers ?? 0) > 0) out.push('Starts from email');
  return out;
}

export function TaskChips({ task, mt = 0.5 }: { task: Pick<TaskWithSummary, 'connections' | 'summary'>; mt?: number }) {
  const labels = taskChipLabels(task);
  if (labels.length === 0) return null;
  return (
    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', mt }} data-testid="task-chips" aria-label="What this task is connected to">
      {labels.map((l) => (
        <Chip key={l} size="small" variant="outlined" label={l} />
      ))}
    </Stack>
  );
}
