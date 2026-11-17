import { useEffect, useState } from 'react';
import { Alert, FormControlLabel, MenuItem, Stack, Switch, TextField } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { machineState, type FleetHost } from '../types/fleet';

/**
 * The machines to choose from, for a caller that does not load the fleet itself (the "New run" dialog);
 * without `fleet:read` none (the picker then offers "Any available machine" only).
 */
export function useFleetHosts(): FleetHost[] {
  const { api, viewer } = usePlatformHost();
  const [hosts, setHosts] = useState<FleetHost[]>([]);
  const canRead = viewer.hasPermission('fleet:read');
  useEffect(() => {
    if (!canRead) return;
    let stale = false;
    api
      .get<FleetHost[]>('/fleet/hosts')
      .then((list) => {
        if (!stale) setHosts(list);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [api, canRead]);
  return hosts;
}

export interface MachineChoice {
  /** The chosen machine; null is any available one. */
  hostId: string | null;
  /** When the chosen machine cannot take the run, use another available one. */
  hostFallback: boolean;
}

export interface MachinePickerProps extends MachineChoice {
  /** The machines to choose from; empty without `fleet:read` (the picker then offers "Any available machine" only). */
  hosts: readonly FleetHost[];
  /** Only what changed: the machine or the fallback switch. */
  onChange: (change: Partial<MachineChoice>) => void;
  disabled?: boolean;
  error?: string;
  id?: string;
}

/**
 * Which computer runs a task or a one-off run (#384): any available one, or a
 * named machine with its state, the "use another machine when it is
 * unavailable" switch and a warning while that machine is not online. The task
 * form and the "New run" dialog share it.
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
          slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}
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
