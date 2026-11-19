import { FormControl, FormControlLabel, FormLabel, Radio, RadioGroup, Stack, TextField, Typography } from '@mui/material';
import { useCallback, useState } from 'react';

import type { McpAuthInput, McpAuthKind } from './api';
import { AUTH_WORDS } from './mcpWords';

const AUTH_HELP: Record<McpAuthKind, string> = {
  none: 'The server needs no sign-in.',
  bearer: 'You have a token for it. It is stored encrypted and sent only to this server.',
  header: 'The server reads a key from a header you name (for example X-Api-Key).',
  oauth: "You sign in at the server's own page and Hexactra keeps the sign-in it is given. Hexactra registers itself with the server, or you give it the client id of an app you registered.",
};

/** The state of the sign-in fields and the request body it makes (null while a required field is empty). Secrets live only here, in memory. */
export function useMcpAuthForm(initial: McpAuthKind = 'none') {
  const [kind, setKind] = useState<McpAuthKind>(initial);
  const [token, setToken] = useState('');
  const [header, setHeader] = useState('');
  const [value, setValue] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const reset = useCallback((k: McpAuthKind = 'none') => {
    setKind(k);
    setToken('');
    setHeader('');
    setValue('');
    setClientId('');
    setClientSecret('');
  }, []);
  let input: McpAuthInput | null;
  if (kind === 'none') input = { kind };
  else if (kind === 'bearer') input = token.trim() ? { kind, token: token.trim() } : null;
  else if (kind === 'header') input = header.trim() && value ? { kind, header: header.trim(), value } : null;
  else input = { kind, ...(clientId.trim() ? { clientId: clientId.trim() } : {}), ...(clientSecret ? { clientSecret } : {}) };
  return { kind, setKind, token, setToken, header, setHeader, value, setValue, clientId, setClientId, clientSecret, setClientSecret, input, reset };
}

export type McpAuthForm = ReturnType<typeof useMcpAuthForm>;

/** "How does it sign you in?": none, a bearer token, a header or OAuth, with the fields each needs. Secrets are write-only password fields. */
export function McpAuthFields({ form, labelId }: { form: McpAuthForm; labelId: string }) {
  const { kind } = form;
  return (
    <>
      <FormControl>
        <FormLabel id={labelId}>How does it sign you in?</FormLabel>
        <RadioGroup aria-labelledby={labelId} value={kind} onChange={(e) => form.setKind(e.target.value as McpAuthKind)}>
          {(Object.keys(AUTH_WORDS) as McpAuthKind[]).map((k) => (
            <FormControlLabel key={k} value={k} control={<Radio />} label={AUTH_WORDS[k]} sx={{ minHeight: { xs: 44, sm: 'auto' } }} />
          ))}
        </RadioGroup>
        <Typography variant="body2" color="text.secondary">
          {AUTH_HELP[kind]}
        </Typography>
      </FormControl>
      {kind === 'bearer' && <TextField label="Bearer token" type="password" value={form.token} onChange={(e) => form.setToken(e.target.value)} fullWidth autoComplete="new-password" helperText="Write-only: it is never shown again." />}
      {kind === 'header' && (
        <Stack spacing={2}>
          <TextField label="Header name" value={form.header} onChange={(e) => form.setHeader(e.target.value)} placeholder="X-Api-Key" fullWidth autoComplete="off" />
          <TextField label="Header value" type="password" value={form.value} onChange={(e) => form.setValue(e.target.value)} fullWidth autoComplete="new-password" helperText="Write-only: it is never shown again." />
        </Stack>
      )}
      {kind === 'oauth' && (
        <Stack spacing={2}>
          <TextField label="Client ID (optional)" value={form.clientId} onChange={(e) => form.setClientId(e.target.value)} fullWidth autoComplete="off" helperText="Only if the server does not register Hexactra itself: the client id of an app you registered with it." />
          {form.clientId.trim() && <TextField label="Client secret (optional)" type="password" value={form.clientSecret} onChange={(e) => form.setClientSecret(e.target.value)} fullWidth autoComplete="new-password" helperText="Write-only. Leave it blank for a public client." />}
        </Stack>
      )}
    </>
  );
}
