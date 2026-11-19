import { FormControlLabel, FormHelperText, Link, Switch } from '@mui/material';
import { useId } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { useSavedLoginsAvailability, type SavedLoginsAvailability } from './useSavedLoginsAvailability';

export const SAVED_LOGINS_HELP = 'When a page asks you to sign in and you saved a login for exactly that site, the agent signs in without asking. It never sees the password or the code.';
export const SAVED_CARDS_HELP = 'The agent can pay with a card you saved, at a shop and an amount you approve. You are asked the first time at each shop, and it never sees the card number, the expiry or the code. A card with a spending limit from your bank is the safest.';
export const SAVED_IDENTITY_HELP = 'When a form asks for personal details you saved (a date of birth, an ID number, an address), the agent fills them in. It names the field; Hexactra types it. It never sees the value.';

/** The switches with their own availability check: for a dialog that mounts only while open (the chat settings). */
export function SavedLoginsToggle(props: { checked: boolean; onChange: (on: boolean) => void; identity?: { checked: boolean; onChange: (on: boolean) => void }; cards?: { checked: boolean; onChange: (on: boolean) => void }; disabled?: boolean; label?: string }) {
  const availability = useSavedLoginsAvailability();
  const { identity, cards, ...rest } = props;
  return (
    <>
      <SavedLoginsSwitch {...rest} availability={availability} />
      {identity && <SavedIdentitySwitch checked={identity.checked} onChange={identity.onChange} disabled={props.disabled} parentOn={props.checked} availability={availability} />}
      {cards && <SavedCardsSwitch checked={cards.checked} onChange={cards.onChange} disabled={props.disabled} parentOn={props.checked} availability={availability} />}
    </>
  );
}

/**
 * "Also pay with my saved cards" (E37.7, #596): the second sub-switch of the saved-logins one, off by default. Disabled, with the
 * reason as its description, while saved logins are off or the provider's card permissions were not granted.
 */
export function SavedCardsSwitch({ checked, onChange, disabled, parentOn, availability, label = 'Also pay with my saved cards' }: { checked: boolean; onChange: (on: boolean) => void; disabled?: boolean; parentOn: boolean; availability: SavedLoginsAvailability; label?: string }) {
  const helpId = useId();
  const blockedReason = !availability.loaded ? null : !parentOn || !availability.available ? 'Turn on saved logins first.' : availability.cardsReason;
  const blocked = blockedReason !== null;
  return (
    <div style={{ marginLeft: 0 }}>
      <FormControlLabel
        sx={{ minHeight: { xs: 44, sm: 'auto' }, ml: { xs: 2, sm: 3 } }}
        control={<Switch checked={checked && !blocked} disabled={disabled || blocked} onChange={(e) => onChange(e.target.checked)} slotProps={{ input: { 'aria-describedby': helpId } }} />}
        label={label}
      />
      <FormHelperText id={helpId} sx={{ mt: 0, ml: { xs: 2, sm: 9 } }} data-testid="saved-cards-help">
        {blocked ? (
          <>
            {blockedReason}
            {availability.fixTo && parentOn && (
              <>
                {' '}
                <Link component={RouterLink} to={availability.fixTo}>
                  Open Secrets
                </Link>
              </>
            )}
          </>
        ) : (
          SAVED_CARDS_HELP
        )}
      </FormHelperText>
    </div>
  );
}

/**
 * "Also fill my identity details" (E37.6, #595): the sub-switch of the saved-logins one, off by default. Disabled, with the
 * reason as its description, while saved logins are off or the provider's identity permissions were not granted.
 */
export function SavedIdentitySwitch({ checked, onChange, disabled, parentOn, availability, label = 'Also fill my saved identity details' }: { checked: boolean; onChange: (on: boolean) => void; disabled?: boolean; parentOn: boolean; availability: SavedLoginsAvailability; label?: string }) {
  const helpId = useId();
  const blockedReason = !availability.loaded ? null : !parentOn || !availability.available ? 'Turn on saved logins first.' : availability.identityReason;
  const blocked = blockedReason !== null;
  return (
    <div style={{ marginLeft: 0 }}>
      <FormControlLabel
        sx={{ minHeight: { xs: 44, sm: 'auto' }, ml: { xs: 2, sm: 3 } }}
        control={<Switch checked={checked && !blocked} disabled={disabled || blocked} onChange={(e) => onChange(e.target.checked)} slotProps={{ input: { 'aria-describedby': helpId } }} />}
        label={label}
      />
      <FormHelperText id={helpId} sx={{ mt: 0, ml: { xs: 2, sm: 9 } }} data-testid="saved-identity-help">
        {blocked ? (
          <>
            {blockedReason}
            {availability.fixTo && parentOn && (
              <>
                {' '}
                <Link component={RouterLink} to={availability.fixTo}>
                  Open Secrets
                </Link>
              </>
            )}
          </>
        ) : (
          SAVED_IDENTITY_HELP
        )}
      </FormHelperText>
    </div>
  );
}

/**
 * "Use my saved logins" (E37.4, #593): the per-task and per-chat opt-in. While saved logins cannot work for this
 * viewer (no provider, a switch off, no permission) the switch is disabled, off, and the reason is its description,
 * with a link to where it is fixed.
 */
export function SavedLoginsSwitch({ checked, onChange, disabled, availability, label = 'Use my saved logins and details' }: { checked: boolean; onChange: (on: boolean) => void; disabled?: boolean; availability: SavedLoginsAvailability; label?: string }) {
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
