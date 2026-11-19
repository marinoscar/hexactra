import { Box, Stack, Typography } from '@mui/material';

import { ParameterField } from './ParameterField';
import { valueError, type TaskParameter } from './model';

/** The parameters a schedule gives its own value for: those without a saved value, never a sensitive one. */
export function scheduleParameters(params: readonly TaskParameter[] | null | undefined): TaskParameter[] {
  return (params ?? []).filter((p) => !p.sensitive && !p.default);
}

/** The required values an active schedule would lack (the server answers `SCHEDULE_INPUTS_MISSING`). */
export function missingScheduleValues(params: readonly TaskParameter[] | null | undefined, inputs: Record<string, string> | undefined): TaskParameter[] {
  return scheduleParameters(params).filter((p) => p.required !== false && !(inputs?.[p.key] ?? '').trim());
}

/** Whether every preset value is valid and nothing required is missing while the schedule is active. */
export function scheduleValuesOk(params: readonly TaskParameter[] | null | undefined, inputs: Record<string, string> | undefined, enabled: boolean): boolean {
  const own = scheduleParameters(params);
  if (enabled && missingScheduleValues(params, inputs).length) return false;
  return own.every((p) => !(inputs?.[p.key] ?? '').trim() || valueError({ ...p, required: false }, inputs![p.key]!) === null);
}

export interface ScheduleValuesProps {
  parameters: readonly TaskParameter[];
  inputs: Record<string, string> | undefined;
  onChange: (inputs: Record<string, string>) => void;
  enabled: boolean;
  disabled?: boolean;
}

/**
 * "Values for this schedule" (#556): one field per parameter of the task that
 * has no saved value. An active schedule needs every required one; a
 * sensitive parameter is never preset, so its schedule waits for the owner.
 */
export function ScheduleValues({ parameters, inputs, onChange, enabled, disabled }: ScheduleValuesProps) {
  const own = scheduleParameters(parameters);
  const sensitive = parameters.filter((p) => p.sensitive);
  if (own.length === 0 && sensitive.length === 0) return null;
  const set = (key: string, v: string) => {
    const next = { ...(inputs ?? {}) };
    if (v === '') delete next[key];
    else next[key] = v;
    onChange(next);
  };
  return (
    <Box component="section" aria-label="Values for this schedule">
      <Typography variant="subtitle2" component="h3" sx={{ mb: 1 }}>
        Values for this schedule
      </Typography>
      <Stack spacing={1.5}>
        {own.map((p) => {
          const v = inputs?.[p.key] ?? '';
          const err = v.trim() ? valueError({ ...p, required: false }, v) : enabled && p.required !== false ? 'Needed while this schedule is active' : null;
          return <ParameterField key={p.key} def={p} value={v} onChange={(x) => set(p.key, x)} error={err} disabled={disabled} />;
        })}
        {sensitive.map((p) => (
          <Typography key={p.key} variant="body2" color="text.secondary">
            This task asks for {p.label} every time, so a schedule will wait for you.
          </Typography>
        ))}
      </Stack>
    </Box>
  );
}
