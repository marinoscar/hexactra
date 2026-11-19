// "Accounts the agent may use" (E39.10, #607): which of the owner's connected accounts this task or chat may use, and how. Off until
// switched on. Hidden without `connections:read`; read-only without write access.
import { Alert, FormControl, FormHelperText, InputLabel, Link, MenuItem, Select, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

import { AccountChoices } from '../connections/AccountChoices';
import type { Connection } from '../connections/api';
import { ACCOUNTS_HELP, looksBrowserless, type ConnectionSelection, type NeedsBrowser } from './model';

export interface AccountsSectionProps {
  /** `null` while loading. */
  connections: readonly Connection[] | null;
  failed?: boolean;
  selections: readonly ConnectionSelection[];
  onChange: (next: ConnectionSelection[]) => void;
  disabled?: boolean;
  /** A task also chooses whether its runs open a browser; a chat does not. */
  browser?: { value: NeedsBrowser; onChange: (v: NeedsBrowser) => void; goal: string };
}

const BROWSER_WORDS: Record<NeedsBrowser, string> = {
  auto: 'Only when it needs one (recommended)',
  always: 'Always open a browser',
  never: 'Never open a browser',
};

export function AccountsSection({ connections, failed = false, selections, onChange, disabled = false, browser }: AccountsSectionProps) {
  if (connections === null) return <Typography color="text.secondary">Loading your accounts…</Typography>;
  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        {ACCOUNTS_HELP}
      </Typography>
      {failed && <Alert severity="warning">Your accounts could not be loaded. Saving keeps the accounts this already has.</Alert>}
      {connections.length === 0 && !failed ? (
        <Typography color="text.secondary">
          You have not connected an account yet.{' '}
          <Link component={RouterLink} to="/settings/connections">
            Connect one
          </Link>{' '}
          to let the agent read your mail or calendar, or add a row to a spreadsheet.
        </Typography>
      ) : (
        <AccountChoices connections={connections} selections={selections} onChange={onChange} disabled={disabled} />
      )}
      {browser && (
        <FormControl size="small" disabled={disabled} sx={{ maxWidth: 420 }}>
          <InputLabel id="needs-browser-label">Does this task use a browser?</InputLabel>
          <Select labelId="needs-browser-label" label="Does this task use a browser?" value={browser.value} onChange={(e) => browser.onChange(e.target.value as NeedsBrowser)}>
            {(Object.keys(BROWSER_WORDS) as NeedsBrowser[]).map((k) => (
              <MenuItem key={k} value={k}>
                {BROWSER_WORDS[k]}
              </MenuItem>
            ))}
          </Select>
          {looksBrowserless(browser.goal, selections, browser.value) && (
            <FormHelperText data-testid="browserless-hint">Runs without a browser: this looks like a job for your accounts alone, so no machine is used unless the agent needs one.</FormHelperText>
          )}
        </FormControl>
      )}
    </Stack>
  );
}
