import { useEffect, useState } from 'react';
import { Alert, FormControlLabel, MenuItem, Stack, Switch, TextField } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { machineState, type FleetHost } from '../types/fleet';

/** The machines to choose from; without `fleet:read` none (the picker then offers "Any available machine" only). */
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
  /** The chosen machine's id; `''` is any available machine. */
  hostId: string;
  /** When the chosen machine cannot take the run, use another available one. */
  hostFallback: boolean;
}

export interface MachinePickerProps extends MachineChoice {
  hosts: readonly FleetHost[];
  onChange: (choice: MachineChoice) => void;
}

/**
 * Which computer runs it (#384): the machine select with each machine's
 * state, the fallback switch once one is chosen, and a warning while the
 * chosen machine is not online. The same controls as the task form.
 */
export function MachinePicker({ hosts, hostId, hostFallback, onChange }: MachinePickerProps) {
  const chosen = hosts.find((h) => h.id === hostId);
  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: { sm: 'center' } }}>
        <TextField
          select
          label="Machine"
          value={hostId}
          onChange={(e) => onChange({ hostId: e.target.value, hostFallback })}
          helperText="Which computer runs it; any available one by default (home machines first)."
          sx={{ minWidth: { sm: 260 } }}
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
            control={<Switch checked={hostFallback} onChange={(e) => onChange({ hostId, hostFallback: e.target.checked })} />}
            label="If it is unavailable, use another available machine"
          />
        )}
      </Stack>
      {chosen && machineState(chosen) !== 'online' && (
        <Alert severity="warning">
          {chosen.name} is {machineState(chosen)} right now. {hostFallback ? 'Runs will use another available machine until it is back.' : 'Runs will fail until it is back.'}
        </Alert>
      )}
    </Stack>
  );
}
