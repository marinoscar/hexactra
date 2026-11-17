import { Alert, FormControlLabel, MenuItem, Stack, Switch, TextField } from '@mui/material';

import { machineState, type FleetHost } from '../types/fleet';

export interface MachinePickerProps {
  /** The machines to choose from; empty without `fleet:read` (the picker then offers "Any available machine" only). */
  hosts: readonly FleetHost[];
  /** The chosen machine; null is any available one. */
  hostId: string | null;
  hostFallback: boolean;
  onChange: (change: { hostId?: string | null; hostFallback?: boolean }) => void;
  disabled?: boolean;
  error?: string;
  id?: string;
}

/**
 * Which computer runs a task (#384): any available one, or a named machine
 * with its state, the "use another machine when it is unavailable" switch and
 * a warning while that machine is not online.
 */
export function MachinePicker({ hosts, hostId, hostFallback, onChange, disabled, error, id }: MachinePickerProps) {
  const chosen = hostId ? hosts.find((h) => h.id === hostId) : undefined;
  const name = chosen?.name ?? hostId?.slice(0, 8);
  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: { sm: 'center' } }}>
        <TextField
          select
          id={id}
          label="Machine"
          value={hostId ?? ''}
          disabled={disabled}
          error={Boolean(error)}
          onChange={(e) => onChange({ hostId: e.target.value || null })}
          helperText={error ?? 'Which computer runs it; any available one by default (home machines first).'}
          sx={{ minWidth: { sm: 260 }, flex: { sm: '0 1 320px' } }}
          fullWidth
        >
          <MenuItem value="">Any available machine</MenuItem>
          {hosts.map((h) => (
            <MenuItem key={h.id} value={h.id}>
              {h.name} ({machineState(h)})
            </MenuItem>
          ))}
          {hostId && !chosen && <MenuItem value={hostId}>{hostId.slice(0, 8)}</MenuItem>}
        </TextField>
        {hostId && (
          <FormControlLabel
            control={<Switch checked={hostFallback} disabled={disabled} onChange={(e) => onChange({ hostFallback: e.target.checked })} />}
            label="If it is unavailable, use another available machine"
          />
        )}
      </Stack>
      {chosen && machineState(chosen) !== 'online' && (
        <Alert severity="warning">
          {name} is {machineState(chosen)} right now. {hostFallback ? 'Runs will use another available machine until it is back.' : 'Runs will fail until it is back.'}
        </Alert>
      )}
    </Stack>
  );
}
