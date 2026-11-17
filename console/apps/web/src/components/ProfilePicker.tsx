import { Alert, Link, MenuItem, TextField } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

import { DEFAULT_PROFILE } from '../taskForm/values';
import type { FleetHost } from '../types/fleet';

export interface ProfilePickerProps {
  /** The fleet's machines; null when they are not known (no `fleet:read`, or the request failed): a text field then. */
  hosts: readonly FleetHost[] | null;
  /** The task's machine; null is any available one. */
  hostId: string | null;
  value: string;
  onChange: (profile: string) => void;
  disabled?: boolean;
  error?: string;
  id?: string;
}

export interface ProfileOption {
  name: string;
  label: string;
}

/**
 * The profiles to offer: the chosen machine's, or with "Any available
 * machine" every profile name in the fleet with how many machines have it.
 * `default` is always first; the current value is always present.
 */
export function profileOptions(hosts: readonly FleetHost[], hostId: string | null, value: string): ProfileOption[] {
  const host = hostId ? hosts.find((h) => h.id === hostId) : undefined;
  const names = new Set<string>([DEFAULT_PROFILE]);
  const counts = new Map<string, number>();
  for (const h of host ? [host] : hosts) {
    for (const p of h.profiles) {
      names.add(p.name);
      counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
    }
  }
  if (value) names.add(value);
  const rest = [...names].filter((n) => n !== DEFAULT_PROFILE).sort((a, b) => a.localeCompare(b));
  return [DEFAULT_PROFILE, ...rest].map((name) => {
    const count = counts.get(name);
    const label = !host && hosts.length > 0 && count !== undefined ? `${name} · on ${count} of ${hosts.length} ${hosts.length === 1 ? 'machine' : 'machines'}` : name;
    return { name, label };
  });
}

/** The chosen machine when it does not have `profile` (`default` exists everywhere), else null. */
export function profileMissingOn(hosts: readonly FleetHost[], hostId: string | null, profile: string): FleetHost | null {
  if (!hostId || profile === DEFAULT_PROFILE) return null;
  const host = hosts.find((h) => h.id === hostId);
  if (!host) return null;
  return host.profiles.some((p) => p.name === profile) ? null : host;
}

/**
 * The browser profile of a task: a select of the profiles the machine has
 * (so a typo cannot create a run that fails later), or a text field checked
 * against the server's rule when the fleet is not known.
 */
export function ProfilePicker({ hosts, hostId, value, onChange, disabled, error, id }: ProfilePickerProps) {
  if (hosts === null) {
    return (
      <TextField
        id={id}
        label="Browser profile"
        value={value}
        disabled={disabled}
        error={Boolean(error)}
        helperText={error ?? 'The name of a browser profile on the machine, e.g. default.'}
        onChange={(e) => onChange(e.target.value)}
        slotProps={{ htmlInput: { maxLength: 32, autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } }}
        fullWidth
      />
    );
  }
  const missing = profileMissingOn(hosts, hostId, value);
  return (
    <>
      <TextField select id={id} label="Browser profile" value={value} disabled={disabled} error={Boolean(error)} helperText={error} onChange={(e) => onChange(e.target.value)} fullWidth>
        {profileOptions(hosts, hostId, value).map((o) => (
          <MenuItem key={o.name} value={o.name}>
            {o.label}
          </MenuItem>
        ))}
      </TextField>
      {missing && (
        <Alert severity="warning">
          “{value}” does not exist on {missing.name}. The run will fail unless you create it in{' '}
          <Link component={RouterLink} to="/fleet">
            Fleet
          </Link>
          .
        </Alert>
      )}
    </>
  );
}
