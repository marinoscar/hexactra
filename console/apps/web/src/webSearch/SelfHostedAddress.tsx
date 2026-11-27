// A self-hosted search provider's address (SearXNG, E50.8; screens E50.14, #984): a provider with no fixed host of its own is reached at
// the address the administrator sets here. "This instance is on my private network" (allowPrivate, off by default) lets the console
// reach that one host on a private address or over http; the warning says what that opens.
import { Alert, Button, Checkbox, FormControlLabel, Stack, TextField } from '@mui/material';
import { useEffect, useState } from 'react';

export interface SelfHostedAddressProps {
  label: string;
  baseUrl: string | null;
  allowPrivate: boolean;
  canWrite: boolean;
  busy: boolean;
  onSave: (patch: { baseUrl?: string | null; allowPrivate?: boolean }) => Promise<void>;
}

/** An http(s) address with no user name, password, query or fragment (what the API accepts), or empty. */
export function addressProblem(v: string): string | null {
  if (v.trim() === '') return null;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'An http or https address';
    if (u.username || u.password || u.search || u.hash) return 'No user name, password, query or fragment';
    return null;
  } catch {
    return 'An address such as https://search.example.test';
  }
}

export function SelfHostedAddress({ label, baseUrl, allowPrivate, canWrite, busy, onSave }: SelfHostedAddressProps) {
  const [value, setValue] = useState(baseUrl ?? '');
  useEffect(() => setValue(baseUrl ?? ''), [baseUrl]);
  const problem = addressProblem(value);
  const next = value.trim() === '' ? null : value.trim();
  return (
    <Stack spacing={1}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'flex-start' } }}>
        <TextField
          size="small"
          label={`${label} address`}
          value={value}
          disabled={!canWrite}
          error={problem !== null}
          helperText={problem ?? 'Your own instance, such as https://search.example.test. Empty: not used.'}
          onChange={(e) => setValue(e.target.value)}
          slotProps={{ htmlInput: { inputMode: 'url', autoComplete: 'off', spellCheck: false } }}
          sx={{ flex: 1 }}
        />
        {canWrite && (
          <Button variant="outlined" sx={{ minHeight: 40 }} disabled={busy || problem !== null || next === baseUrl} onClick={() => void onSave({ baseUrl: next })}>
            Save address
          </Button>
        )}
      </Stack>
      <FormControlLabel
        control={<Checkbox checked={allowPrivate} disabled={!canWrite || busy} onChange={(e) => void onSave({ allowPrivate: e.target.checked })} />}
        label="This instance is on my private network"
        sx={{ minHeight: 44 }}
      />
      {(allowPrivate || (next !== null && next.startsWith('http:'))) && (
        <Alert severity="warning" data-testid="allow-private-warning">
          With this ticked, the console sends searches to this one address on your private network, also over plain http. Tick it only for an instance you run; no other private address is opened.
        </Alert>
      )}
    </Stack>
  );
}
