import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControl, FormControlLabel, FormHelperText, FormLabel, Radio, RadioGroup, Stack, TextField, Typography } from '@mui/material';
import { useEffect, useId, useState } from 'react';

import { useBreakpoint } from '../ui';
import { authorize, type Capability, type Provider, type ProviderAvailability } from './api';
import { CapabilityPicker } from './CapabilityPicker';
import { PROVIDER_NAME } from './words';

const REASON_WORDS: Record<NonNullable<ProviderAvailability['reason']>, string> = {
  not_installed: 'Not available on this deployment yet.',
  disabled: 'Your administrator has not turned this on.',
  not_configured: 'Your administrator has not finished setting this up.',
};

/**
 * "Connect an account": choose the provider, tick what the agent may do, name it. The provider's consent opens in this same tab
 * and returns to the page with a result banner. The kinds of account that work (and the ones that do not) are explained BEFORE
 * the owner starts.
 */
export function ConnectDialog({ open, providers, api, returnTo, onClose, onError }: { open: boolean; providers: ProviderAvailability[]; api: Parameters<typeof authorize>[0]; returnTo: string; onClose: () => void; onError: (message: string) => void }) {
  const { isPhone } = useBreakpoint();
  const titleId = useId();
  const firstReady = providers.find((p) => p.ready)?.provider ?? providers[0]?.provider ?? 'google';
  const [provider, setProvider] = useState<Provider>(firstReady);
  const [capabilities, setCapabilities] = useState<Capability[]>(['mail_read']);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setProvider(providers.find((p) => p.ready)?.provider ?? providers[0]?.provider ?? 'google');
      setCapabilities(['mail_read']);
      setLabel('');
      setBusy(false);
    }
  }, [open, providers]);

  const chosen = providers.find((p) => p.provider === provider);
  const canStart = Boolean(chosen?.ready) && capabilities.length > 0 && !busy;

  const start = async () => {
    setBusy(true);
    try {
      const r = await authorize(api, { provider, capabilities, ...(label.trim() ? { label: label.trim() } : {}), returnTo });
      window.location.assign(r.authorizeUrl);
    } catch (e) {
      setBusy(false);
      onError(e instanceof Error && e.message ? e.message : 'Could not start the connection');
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm" fullScreen={isPhone} aria-labelledby={titleId}>
      <DialogTitle id={titleId}>Connect an account</DialogTitle>
      <DialogContent>
        <Stack spacing={3} sx={{ pt: 1 }}>
          <FormControl>
            <FormLabel id={`${titleId}-provider`}>Provider</FormLabel>
            <RadioGroup aria-labelledby={`${titleId}-provider`} value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
              {providers.map((p) => (
                <FormControlLabel
                  key={p.provider}
                  value={p.provider}
                  disabled={!p.ready}
                  sx={{ minHeight: { xs: 44, sm: 'auto' } }}
                  control={<Radio />}
                  label={
                    <>
                      {p.displayName}
                      {!p.ready && p.reason && (
                        <Typography component="span" variant="body2" color="text.secondary">
                          {' '}
                          · {REASON_WORDS[p.reason]}
                        </Typography>
                      )}
                    </>
                  }
                />
              ))}
            </RadioGroup>
          </FormControl>

          {chosen && (
            <Alert severity="info" icon={false} aria-label={`Accounts that work with ${PROVIDER_NAME[chosen.provider]}`}>
              <Typography variant="subtitle2" component="p">
                Accounts that work with {chosen.displayName}
              </Typography>
              <Stack component="ul" spacing={0.5} sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
                {chosen.accountTypes.map((t) => (
                  <li key={t.id}>
                    <strong>{t.label}</strong>
                    {t.supported ? '' : ' (not supported)'}: {t.note}
                  </li>
                ))}
              </Stack>
            </Alert>
          )}

          <div>
            <Typography variant="subtitle1" component="h2" sx={{ mb: 1 }}>
              What the agent may do with it
            </Typography>
            <CapabilityPicker value={capabilities} onChange={setCapabilities} />
            <FormHelperText>Only what you tick is asked of {chosen?.displayName ?? 'the provider'}. You can change it later. A new chat can use it straight away (you choose that under New chats); a task has to be told to.</FormHelperText>
          </div>

          <TextField label="Name (optional)" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Work, Personal" helperText="What you call this account. Tasks and chats can name it." slotProps={{ htmlInput: { maxLength: 60 } }} />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ flexDirection: { xs: 'column-reverse', sm: 'row' }, gap: 1, '& > :not(style)': { m: 0 } }}>
        <Button onClick={onClose} disabled={busy} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
          Cancel
        </Button>
        <Button variant="contained" onClick={start} disabled={!canStart} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
          {busy ? 'Opening…' : `Continue to ${chosen?.displayName ?? 'the provider'}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
