import { Autocomplete, Checkbox, ListItemText, MenuItem, Stack, TextField } from '@mui/material';

import type { PolicyCatalog } from '../policies/usePolicyCatalog';
import { RUN_TRIGGERS } from '../types/runs';
import {
  DATE_PRESETS,
  STOP_FILTERS,
  STOP_FILTER_LABEL,
  TRIGGER_LABEL,
  presetFrom,
  presetOf,
  showsStopFilter,
  today,
  type DatePresetKey,
  type RunFilters,
  type StopFilter,
} from './runFilters';

/** A task the Task filter offers. */
export interface TaskOption {
  id: string;
  name: string;
}

/** Runs without a task: ad-hoc goals and external sessions. */
export const ONE_OFF: TaskOption = { id: 'none', name: 'One-off goals' };

export interface RunFilterControlsProps {
  value: RunFilters;
  onChange: (next: RunFilters) => void;
  /** The list is fixed to one task: no Task filter. */
  scoped: boolean;
  /** The user's tasks; null hides the Task filter (no `tasks:read`) unless one is already set. */
  tasks: readonly TaskOption[] | null;
  /** The policies to filter by; null hides the Policy filter (no `agent_policies:read`). */
  policies: PolicyCatalog['policies'] | null;
  /** The profile time zone: the days of the date range are its calendar days. */
  timeZone: string;
  /** `row`: side by side above the list; `column`: stacked, in the phone's filter drawer. */
  layout: 'row' | 'column';
}

function multi<T extends string>(raw: unknown, allowed: readonly T[]): T[] {
  const picked = new Set(Array.isArray(raw) ? raw.map(String) : String(raw).split(','));
  return allowed.filter((v) => picked.has(v));
}

/** The filters beside Search: task, trigger, date range, "Stopped by" and policy. */
export function RunFilterControls({ value, onChange, scoped, tasks, policies, timeZone, layout }: RunFilterControlsProps) {
  const row = layout === 'row';
  const field = { size: 'small' as const, sx: row ? { minWidth: 150, flex: '1 1 150px', maxWidth: 240 } : undefined, fullWidth: !row };
  const options = [ONE_OFF, ...(tasks ?? [])];
  const chosenTask = value.taskId ? (options.find((t) => t.id === value.taskId) ?? { id: value.taskId, name: 'Task' }) : null;
  const preset = presetOf(value, timeZone);

  return (
    <Stack direction={row ? 'row' : 'column'} spacing={row ? 1 : 2} useFlexGap sx={{ flexWrap: row ? 'wrap' : 'nowrap', flexGrow: 1, minWidth: 0 }}>
      {!scoped && (tasks !== null || chosenTask) && (
        <Autocomplete
          size="small"
          options={options}
          value={chosenTask}
          getOptionLabel={(t) => t.name}
          isOptionEqualToValue={(a, b) => a.id === b.id}
          onChange={(_, task) => onChange({ ...value, taskId: task?.id ?? null })}
          renderInput={(params) => <TextField {...params} label="Task" fullWidth />}
          sx={row ? { minWidth: 200, flex: '1 1 200px', maxWidth: 280 } : undefined}
          fullWidth={!row}
        />
      )}
      <TextField
        select
        label="Trigger"
        {...field}
        value={value.trigger}
        onChange={(e) => onChange({ ...value, trigger: multi(e.target.value, RUN_TRIGGERS) })}
        slotProps={{ select: { multiple: true, renderValue: (v) => (v as string[]).map((t) => TRIGGER_LABEL[t as keyof typeof TRIGGER_LABEL]).join(', ') } }}
      >
        {RUN_TRIGGERS.map((t) => (
          <MenuItem key={t} value={t}>
            <Checkbox size="small" checked={value.trigger.includes(t)} sx={{ py: 0 }} />
            <ListItemText primary={TRIGGER_LABEL[t]} />
          </MenuItem>
        ))}
      </TextField>
      <TextField
        select
        label="Date"
        {...field}
        value={preset ?? ''}
        onChange={(e) => {
          const key = e.target.value as DatePresetKey | 'custom' | '';
          if (key === '') onChange({ ...value, from: null, to: null });
          else if (key === 'custom') onChange({ ...value, from: value.from ?? presetFrom('7d', timeZone), to: value.to ?? today(timeZone) });
          else onChange({ ...value, from: presetFrom(key, timeZone), to: null });
        }}
      >
        <MenuItem value="">Any time</MenuItem>
        {DATE_PRESETS.map((p) => (
          <MenuItem key={p.key} value={p.key}>
            {p.label}
          </MenuItem>
        ))}
        <MenuItem value="custom">Custom…</MenuItem>
      </TextField>
      {preset === 'custom' && (
        <>
          <TextField
            type="date"
            label="From"
            {...field}
            value={value.from ?? ''}
            onChange={(e) => onChange({ ...value, from: e.target.value || null })}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { max: value.to ?? undefined } }}
          />
          <TextField
            type="date"
            label="To"
            {...field}
            value={value.to ?? ''}
            onChange={(e) => onChange({ ...value, to: e.target.value || null })}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: value.from ?? undefined } }}
          />
        </>
      )}
      {showsStopFilter(value.view) && (
        <TextField
          select
          label="Stopped by"
          {...field}
          value={value.stopReason}
          onChange={(e) => onChange({ ...value, stopReason: multi<StopFilter>(e.target.value, STOP_FILTERS) })}
          slotProps={{ select: { multiple: true, renderValue: (v) => (v as StopFilter[]).map((r) => STOP_FILTER_LABEL[r]).join(', ') } }}
        >
          {STOP_FILTERS.map((r) => (
            <MenuItem key={r} value={r}>
              <Checkbox size="small" checked={value.stopReason.includes(r)} sx={{ py: 0 }} />
              <ListItemText primary={STOP_FILTER_LABEL[r]} />
            </MenuItem>
          ))}
        </TextField>
      )}
      {policies !== null && (
        <TextField select label="Policy" {...field} value={value.policyId ?? ''} onChange={(e) => onChange({ ...value, policyId: e.target.value || null })}>
          <MenuItem value="">Any policy</MenuItem>
          {policies.map((p) => (
            <MenuItem key={p.id} value={p.id}>
              {p.name}
            </MenuItem>
          ))}
          {value.policyId && !policies.some((p) => p.id === value.policyId) && <MenuItem value={value.policyId}>Unavailable policy</MenuItem>}
        </TextField>
      )}
    </Stack>
  );
}
