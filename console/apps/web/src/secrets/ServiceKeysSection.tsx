// "Keys of outside services" on Settings → Secrets (E50.3, #973): the owner's own keys of services Hexactra calls for them (a web
// search provider), where each is kept (the console, their Vault or the built-in store) and when it was set, with Move and Remove.
// A key is SET on the screen of its service (Settings → Web search); this block links there. No value, nor any part of one, is
// ever shown: the API has no route that returns one.
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import { Alert, Box, Button, Chip, Link, Paper, Stack, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { EmptyState, ErrorBanner, ListSkeleton, RelativeTime, ResponsiveList, useApiAction, useConfirm, type Column } from '../ui';
import { getServiceKeys, moveServiceKey, removeServiceKey, type KeyBinding, type ServiceKeyView } from './api';

const TOUCH = { minHeight: { xs: 44, sm: 'auto' } } as const;

/** Where a key is kept, in words. */
export const BINDING_WORDS: Record<KeyBinding, string> = {
  credential_store: 'In the console',
  vault: 'In your Vault',
  builtin: 'In the built-in store',
};

const PROVIDER_WORDS = { vault: 'your Vault', builtin: 'the built-in store' } as const;

/** The screen where the key of a service is set (E50.14), or null when there is none yet. */
const setupHref = (k: ServiceKeyView): string | null => (k.service === 'web_search' ? '/settings/web-search' : null);

function WhereChip({ k }: { k: ServiceKeyView }) {
  if (!k.tiers.user.set) return <Chip size="small" variant="outlined" label="Not set" />;
  return <Chip size="small" color={k.userBinding === 'credential_store' ? 'default' : 'primary'} variant="outlined" label={BINDING_WORDS[k.userBinding]} data-testid={`where-${k.service}-${k.name}`} />;
}

function SetAt({ k }: { k: ServiceKeyView }) {
  if (!k.tiers.user.set) return <>n/a</>;
  if (!k.tiers.user.setAt) return <>{k.userBinding === 'vault' ? 'Kept by your Vault' : 'n/a'}</>;
  return <RelativeTime iso={k.tiers.user.setAt} />;
}

export function ServiceKeysSection({ canWrite }: { canWrite: boolean }) {
  const { api } = usePlatformHost();
  const confirm = useConfirm();
  const action = useApiAction('Could not change this key');
  const [keys, setKeys] = useState<ServiceKeyView[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const all = await getServiceKeys(api);
      setKeys(all.filter((k) => k.tiers.user.available));
    } catch {
      setKeys([]);
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  if (keys === null) return <ListSkeleton rows={2} />;

  const provider = keys.find((k) => k.secretsProvider)?.secretsProvider ?? null;

  const moveHere = async (k: ServiceKeyView) => {
    if (!provider) return;
    const where = PROVIDER_WORDS[provider.id];
    if (provider.id === 'vault') {
      const ok = await confirm({
        title: `Keep ${k.label} in your Vault?`,
        body: 'Hexactra cannot write into your Vault. Add the key there yourself as a “Service key” (service and key name as shown), open it to the agent, then continue: Hexactra checks that your Vault answers with it and removes its own copy.',
        confirmLabel: 'Check and move',
      });
      if (!ok) return;
    }
    const r = await action.run(`move:${k.service}.${k.name}`, () => moveServiceKey(api, k, 'secrets_provider'));
    if (!r) return;
    setMessage(`${k.label} is now kept in ${where}.`);
    await load();
  };

  const moveToConsole = async (k: ServiceKeyView) => {
    const r = await action.run(`move:${k.service}.${k.name}`, () => moveServiceKey(api, k, 'credential_store'));
    if (!r) return;
    setMessage(r.sourceRemoved || k.userBinding !== 'vault' ? `${k.label} is now kept in the console.` : `${k.label} is now kept in the console. The copy in your Vault is still there: remove it in Vault if you no longer want it.`);
    await load();
  };

  const remove = async (k: ServiceKeyView) => {
    const ok = await confirm({ title: `Remove your ${k.label}?`, body: k.userBinding === 'vault' ? 'Hexactra forgets it. The key stays in your Vault until you remove it there.' : 'Your requests then use your organization’s or the deployment’s key, if one is shared.', confirmLabel: 'Remove', destructive: true });
    if (!ok) return;
    const r = await action.run(`remove:${k.service}.${k.name}`, async () => {
      await removeServiceKey(api, k);
      return true;
    });
    if (!r) return;
    setMessage(`${k.label} is removed.`);
    await load();
  };

  const canMoveHere = (k: ServiceKeyView) => provider !== null && provider.ready && k.userBinding === 'credential_store' && (k.tiers.user.set || provider.id === 'vault');
  const busy = (k: ServiceKeyView) => action.busy !== null && action.busy.endsWith(`${k.service}.${k.name}`);

  const actions = (k: ServiceKeyView) => (
    <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
      {canWrite && canMoveHere(k) && (
        <Button size="small" variant="outlined" sx={TOUCH} disabled={busy(k)} onClick={() => void moveHere(k)}>
          Move here
        </Button>
      )}
      {canWrite && k.userBinding !== 'credential_store' && k.tiers.user.set && (
        <Button size="small" variant="outlined" sx={TOUCH} disabled={busy(k)} onClick={() => void moveToConsole(k)}>
          Move to the console
        </Button>
      )}
      {canWrite && k.tiers.user.set && (
        <Button size="small" color="error" sx={TOUCH} disabled={busy(k)} onClick={() => void remove(k)}>
          Remove
        </Button>
      )}
      {setupHref(k) && (
        <Link component={RouterLink} to={setupHref(k)!} sx={{ ...TOUCH, display: 'inline-flex', alignItems: 'center' }}>
          {k.tiers.user.set ? 'Change' : 'Set it'}
        </Link>
      )}
    </Stack>
  );

  const columns: Column<ServiceKeyView>[] = [
    { key: 'label', header: 'Key', render: (k) => k.label },
    { key: 'where', header: 'Where it is kept', width: 200, render: (k) => <WhereChip k={k} /> },
    { key: 'setAt', header: 'Set', width: 150, hideBelow: 'lg', render: (k) => <SetAt k={k} /> },
    { key: 'actions', header: 'Actions', render: (k) => actions(k) },
  ];

  return (
    <Paper variant="outlined" component="section" aria-labelledby="service-keys-title" sx={{ p: { xs: 2, sm: 3 } }} data-testid="service-keys">
      <Typography id="service-keys-title" variant="h6" component="h2" sx={{ mb: 0.5 }}>
        Keys of outside services
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Your own keys for services Hexactra calls for you, such as a web search provider. Keep each in the console or {provider ? PROVIDER_WORDS[provider.id] : 'your secrets provider'}, next to your saved logins. Hexactra&rsquo;s server reads a key only for a call to its service; the agent never sees it and it is never typed into a page.
      </Typography>
      <ErrorBanner error={action.error} onClose={action.clearError} />
      <Box role="status" aria-live="polite">
        {message && (
          <Alert severity="success" sx={{ mb: 1.5 }} onClose={() => setMessage(null)}>
            {message}
          </Alert>
        )}
      </Box>
      {provider && !provider.releasesEnabled && (
        <Alert severity="info" sx={{ mb: 1.5 }} data-testid="service-keys-off">
          An administrator has turned off reading secrets for this deployment. A key kept in {PROVIDER_WORDS[provider.id]} is not used until it is on again; your organization&rsquo;s or the deployment&rsquo;s key is used instead, if one is shared.
        </Alert>
      )}
      {provider?.id === 'vault' && !provider.ready && (
        <Alert severity="info" sx={{ mb: 1.5 }} data-testid="service-keys-scope">
          To keep keys in your Vault, switch on &ldquo;Let Hexactra read your keys of outside services&rdquo; above and approve it in Vault.
        </Alert>
      )}
      {keys.length === 0 ? (
        <EmptyState Icon={KeyOutlinedIcon} title="No outside services yet" body="When this deployment offers a service that needs your own key, such as web search, it shows up here." />
      ) : (
        <ResponsiveList
          aria-label="Keys of outside services"
          items={keys}
          columns={columns}
          getKey={(k) => `${k.service}.${k.name}`}
          renderCard={(k) => (
            <Paper variant="outlined" sx={{ p: 1.5 }} data-testid={`service-key-${k.service}-${k.name}`}>
              <Stack spacing={1}>
                <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{k.label}</Typography>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
                  <WhereChip k={k} />
                  <Typography variant="body2" color="text.secondary">
                    <SetAt k={k} />
                  </Typography>
                </Stack>
                {actions(k)}
              </Stack>
            </Paper>
          )}
        />
      )}
    </Paper>
  );
}
