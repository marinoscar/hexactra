// Deleting benchmarks with their runs (#873): the body of the confirmation, with "Also delete the runs" ticked by default, and the call
// that deletes one or several. The choice is kept in a ref the caller reads once the dialog is confirmed.
import { Checkbox, FormControlLabel, Stack, Typography } from '@mui/material';
import type { PlatformApiClient } from '@marinoscar/platform-web/core';
import { useState, type MutableRefObject } from 'react';

import type { Confirm } from '../ui';
import { deleteBenchmark, deleteBenchmarks, type BenchmarksDeleted } from './api';

function DeleteRunsChoice({ choice, runs, canDeleteRuns, many }: { choice: MutableRefObject<boolean>; runs: number | null; canDeleteRuns: boolean; many: boolean }) {
  const [checked, setChecked] = useState(choice.current);
  const which = runs === null ? (many ? 'their runs' : 'its runs') : `${many ? 'their' : 'its'} ${runs.toLocaleString('en-US')} run${runs === 1 ? '' : 's'}`;
  return (
    <Stack spacing={1}>
      <Typography variant="body2">
        {many ? 'Their' : 'Its'} trials and scorecard are deleted. This cannot be undone.
      </Typography>
      {canDeleteRuns ? (
        <FormControlLabel
          sx={{ alignItems: 'flex-start', m: 0, minHeight: 44 }}
          control={
            <Checkbox
              checked={checked}
              onChange={(e) => {
                choice.current = e.target.checked;
                setChecked(e.target.checked);
              }}
              sx={{ mt: -0.75 }}
            />
          }
          label={
            <span>
              Also delete {which}
              <Typography variant="caption" color="text.secondary" component="span" sx={{ display: 'block' }}>
                Their steps, screenshots and recordings go too. Untick to keep them in the run history.
              </Typography>
            </span>
          }
        />
      ) : (
        <Typography variant="body2" color="text.secondary">
          The runs {many ? 'they' : 'it'} started stay in the run history (deleting runs needs the runs:delete permission).
        </Typography>
      )}
    </Stack>
  );
}

export interface DeleteBenchmarksRequest {
  api: PlatformApiClient;
  confirm: Confirm;
  /** One benchmark (its id and name) or several. */
  items: { id: string; name: string }[];
  /** The number of runs, when known (the benchmark page counts its trials' runs). */
  runs?: number | null;
  canDeleteRuns: boolean;
}

/**
 * Asks, then deletes. Null when the person cancelled; otherwise what was deleted. One benchmark goes through `DELETE /benchmarks/{id}`,
 * several through `POST /benchmarks/delete`.
 */
export async function confirmAndDeleteBenchmarks({ api, confirm, items, runs = null, canDeleteRuns }: DeleteBenchmarksRequest): Promise<BenchmarksDeleted | null> {
  const many = items.length > 1;
  const choice = { current: canDeleteRuns };
  const ok = await confirm({
    title: many ? `Delete ${items.length} benchmarks?` : `Delete “${items[0]!.name}”?`,
    body: <DeleteRunsChoice choice={choice} runs={runs} canDeleteRuns={canDeleteRuns} many={many} />,
    confirmLabel: 'Delete',
    destructive: true,
  });
  if (!ok) return null;
  const deleteRuns = canDeleteRuns && choice.current;
  if (!many) {
    await deleteBenchmark(api, items[0]!.id, { deleteRuns });
    return { deleted: [items[0]!.id], skippedRunning: [], notFound: [], runsDeleted: -1 };
  }
  return deleteBenchmarks(api, items.map((i) => i.id), { deleteRuns });
}
