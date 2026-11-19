import { FormControlLabel, FormHelperText, Link, Switch } from '@mui/material';
import { useId } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { useSavedLoginsAvailability, type SavedLoginsAvailability } from './useSavedLoginsAvailability';

export const SAVED_LOGINS_HELP = 'When a page asks you to sign in and you saved a login for exactly that site, the agent signs in without asking. It never sees the password or the code.';

/** The switch with its own availability check: for a dialog that mounts only while open (the chat settings). */
export function SavedLoginsToggle(props: { checked: boolean; onChange: (on: boolean) => void; disabled?: boolean; label?: string }) {
  const availability = useSavedLoginsAvailability();
  return <SavedLoginsSwitch {...props} availability={availability} />;
}

/**
 * "Use my saved logins" (E37.4, #593): the per-task and per-chat opt-in. While saved logins cannot work for this
 * viewer (no provider, a switch off, no permission) the switch is disabled, off, and the reason is its description,
 * with a link to where it is fixed.
 */
export function SavedLoginsSwitch({ checked, onChange, disabled, availability, label = 'Use my saved logins' }: { checked: boolean; onChange: (on: boolean) => void; disabled?: boolean; availability: SavedLoginsAvailability; label?: string }) {
  const helpId = useId();
  const blocked = !availability.available;
  return (
    <div>
      <FormControlLabel
        sx={{ minHeight: { xs: 44, sm: 'auto' } }}
        control={<Switch checked={checked && !blocked} disabled={disabled || blocked} onChange={(e) => onChange(e.target.checked)} slotProps={{ input: { 'aria-describedby': helpId } }} />}
        label={label}
      />
      <FormHelperText id={helpId} sx={{ mt: 0, ml: { xs: 0, sm: 6 } }} data-testid="saved-logins-help">
        {blocked && availability.loaded ? (
          <>
            {availability.reason}
            {availability.fixTo && (
              <>
                {' '}
                <Link component={RouterLink} to={availability.fixTo}>
                  Open Secrets
                </Link>
              </>
            )}
          </>
        ) : (
          SAVED_LOGINS_HELP
        )}
      </FormHelperText>
    </div>
  );
}
