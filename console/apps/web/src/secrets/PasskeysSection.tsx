import { Alert, Box, Button, Paper, Stack, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';

import { ListSkeleton, RelativeTime, useConfirm } from '../ui';

/** One of the owner's Hexactra passkeys (E47.5): the site, the account, the dates. Never a key. */
export interface PasskeyItem {
  id: string;
  site: string;
  origin: string;
  account: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const TOUCH = { minHeight: { xs: 44, sm: 'auto' } } as const;

/**
 * Hexactra passkeys (E47.5, #943): the passkeys the owner added for Hexactra, kept in the built-in store, with Remove. Removing one stops
 * Hexactra using it at once; the site still lists it until the owner removes it there too, which the card says.
 */
export function PasskeysSection({ canWrite }: { canWrite: boolean }) {
  const { api } = usePlatformHost();
  const confirm = useConfirm();
  const [items, setItems] = useState<PasskeyItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.get<PasskeyItem[]>('/secrets/passkeys'));
    } catch {
      setError('Could not load your passkeys.');
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (p: PasskeyItem) => {
    const ok = await confirm({ title: `Remove the Hexactra passkey for ${p.site}?`, body: 'Hexactra stops signing in with it at once. Remove it on the site too: the site still lists it.', confirmLabel: 'Remove', destructive: true });
    if (!ok) return;
    setBusy(p.id);
    try {
      await api.delete(`/secrets/passkeys/${p.id}`);
      setRemoved(p.site);
      setItems((list) => (list ?? []).filter((x) => x.id !== p.id));
    } catch {
      setError('Could not remove the passkey.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Box component="section" aria-labelledby="passkeys-title" data-testid="passkeys">
      <Typography id="passkeys-title" variant="h6" component="h2" sx={{ mb: 0.5 }}>
        Passkeys for Hexactra
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Passkeys you added for Hexactra on a site, so runs that may use your saved sign-ins can sign in there without you. Your own passkeys are not here and are not touched.
      </Typography>
      {error && (
        <Alert severity="error" sx={{ mb: 1 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {removed && (
        <Alert severity="info" sx={{ mb: 1, overflowWrap: 'anywhere' }} onClose={() => setRemoved(null)}>
          Removed. Remove it on {removed} too: the site still lists it.
        </Alert>
      )}
      {items === null ? (
        error ? null : <ListSkeleton rows={2} />
      ) : items.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No passkeys yet. Ask the agent to add one on a site&apos;s security settings page; you approve each one.
        </Typography>
      ) : (
        <Stack spacing={1} component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }} aria-label="Passkeys for Hexactra">
          {items.map((p) => (
            <Paper key={p.id} component="li" variant="outlined" sx={{ p: 1.5, display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { sm: 'center' }, gap: 1 }}>
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{p.site}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                  {p.account ? `${p.account} · ` : ''}added <RelativeTime iso={p.createdAt} />
                  {p.lastUsedAt ? (
                    <>
                      {' · last used '}
                      <RelativeTime iso={p.lastUsedAt} />
                    </>
                  ) : (
                    ' · not used yet'
                  )}
                </Typography>
              </Box>
              <Button size="small" variant="outlined" color="error" disabled={!canWrite || busy === p.id} onClick={() => void remove(p)} aria-label={`Remove the Hexactra passkey for ${p.site}`} sx={{ ...TOUCH, alignSelf: { xs: 'stretch', sm: 'center' } }}>
                Remove
              </Button>
            </Paper>
          ))}
        </Stack>
      )}
    </Box>
  );
}
