import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { Box, Link, ListSubheader, MenuItem, TextField, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

import { policyLine } from './format';
import type { PolicyCatalog } from './usePolicyCatalog';

export interface PolicySelectProps {
  catalog: Pick<PolicyCatalog, 'policies' | 'defaultId' | 'byId'>;
  /** The chosen policy id; `null` follows `nullLabel`'s policy. */
  value: string | null;
  onChange: (policyId: string | null) => void;
  label?: string;
  /**
   * What `null` means, e.g. "Default" (the user's default) or "Task's policy".
   * The policy it resolves to is named after it.
   */
  nullLabel?: string;
  /** The policy `null` resolves to; the user's default when omitted. */
  nullPolicyId?: string | null;
  /** Show the "Manage policies" link. */
  manageLink?: boolean;
  disabled?: boolean;
  size?: 'small' | 'medium';
}

const NULL_VALUE = '__inherit__';

/**
 * The policy picker of the task form and the schedule editor: "Default
 * (<name>)", then the built-ins, then the user's own policies, with a one-line
 * summary of the chosen one under it.
 */
export function PolicySelect({ catalog, value, onChange, label = 'Policy', nullLabel = 'Default', nullPolicyId, manageLink, disabled, size }: PolicySelectProps) {
  const inherited = catalog.byId(nullPolicyId === undefined ? catalog.defaultId : nullPolicyId);
  const chosen = value ? catalog.byId(value) : inherited;
  const builtins = catalog.policies.filter((p) => p.builtin);
  const own = catalog.policies.filter((p) => !p.builtin);
  const unknown = value && !catalog.byId(value);

  return (
    <Box>
      <TextField
        select
        fullWidth
        size={size}
        label={label}
        value={value ?? NULL_VALUE}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === NULL_VALUE ? null : e.target.value)}
        helperText={
          <>
            {chosen ? policyLine(chosen) : unknown ? 'This policy is no longer available: runs fall back to your default.' : ' '}
            {manageLink && (
              <>
                {' '}
                <Link component={RouterLink} to="/settings/agent-policies">
                  Manage policies
                </Link>
              </>
            )}
          </>
        }
      >
        <MenuItem value={NULL_VALUE}>
          {nullLabel}
          {inherited ? ` (${inherited.name})` : ''}
        </MenuItem>
        {builtins.length > 0 && <ListSubheader>Built-in</ListSubheader>}
        {builtins.map((p) => (
          <MenuItem key={p.id} value={p.id}>
            <LockOutlinedIcon fontSize="inherit" sx={{ mr: 1, color: 'text.secondary' }} aria-hidden />
            {p.name}
          </MenuItem>
        ))}
        {own.length > 0 && <ListSubheader>Your policies</ListSubheader>}
        {own.map((p) => (
          <MenuItem key={p.id} value={p.id}>
            {p.name}
          </MenuItem>
        ))}
        {unknown && (
          <MenuItem value={value}>
            <Typography color="text.secondary">Unavailable policy</Typography>
          </MenuItem>
        )}
      </TextField>
    </Box>
  );
}
