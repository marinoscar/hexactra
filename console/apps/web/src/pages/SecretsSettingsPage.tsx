import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { Alert, Box, Button, Chip, FormControlLabel, FormHelperText, Link, Paper, Radio, RadioGroup, Stack, Switch, TextField, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';

import {
  connect,
  disconnect,
  getActivity,
  getCards,
  getDefaultUseSavedLogins,
  getIdentity,
  getNeverSaveSites,
  getReach,
  getStatus,
  getStoreStatus,
  saveClient,
  setAgentUse,
  setDefaultUseSavedLogins,
  setNeverSaveSites,
  setProvider,
  type ActivityItem,
  type ActivityList,
  type CardListing,
  type IdentityListing,
  type Reach,
  type SecretsStatus,
  type StoreStatus,
  type VaultStatus,
} from '../secrets/api';
import { CONNECT_RESULT_WORDS, fieldsWords, hasCardsScope, hasIdentityScope, hasServiceKeyScope, hasWriteScope, outcomeWords, permissionWords, whatWords } from '../secrets/words';
import { ServiceKeysSection } from '../secrets/ServiceKeysSection';
import { limitsText, type ApprovalRule, type ApprovalRulesList } from '../approvals/types';
import { PasskeysSection } from '../secrets/PasskeysSection';
import { CardSkeleton, EmptyState, ErrorBanner, ListSkeleton, PageContainer, PageHeader, RelativeTime, ResponsiveList, useApiAction, useConfirm, type Column } from '../ui';

const TOUCH = { minHeight: { xs: 44, sm: 'auto' } } as const;

/** The host of the Vault, for a sentence. */
function hostOf(url: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A switch with its label and help, at least 44 px tall below `sm`, its help read with it. */
function SwitchRow({ label, help, checked, disabled, busy, onChange }: { label: string; help: ReactNode; checked: boolean; disabled?: boolean; busy?: boolean; onChange: (on: boolean) => void }) {
  const helpId = useId();
  return (
    <Box>
      <FormControlLabel
        sx={{ m: 0, minHeight: { xs: 44, sm: 'auto' }, alignItems: 'center' }}
        control={<Switch checked={checked} disabled={disabled || busy} onChange={(e) => onChange(e.target.checked)} slotProps={{ input: { 'aria-describedby': helpId } }} />}
        label={label}
      />
      <FormHelperText id={helpId} sx={{ mt: 0, ml: { xs: 0, sm: 6 } }}>
        {help}
      </FormHelperText>
    </Box>
  );
}

/** The address, client id and client secret form of a Vault that is not configured (or whose settings the owner changes). */
function ClientForm({ vault, busy, onSubmit, onCancel }: { vault: VaultStatus; busy: boolean; onSubmit: (v: { baseUrl: string; clientId: string; clientSecret?: string }) => void; onCancel?: () => void }) {
  const [baseUrl, setBaseUrl] = useState(vault.baseUrl ?? '');
  const [clientId, setClientId] = useState(vault.source === 'user' ? (vault.clientId ?? '') : '');
  const [clientSecret, setClientSecret] = useState('');
  const keepSecret = vault.source === 'user' && vault.hasClientSecret;
  const valid = baseUrl.trim() !== '' && clientId.trim() !== '' && (clientSecret !== '' || keepSecret);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) onSubmit({ baseUrl: baseUrl.trim(), clientId: clientId.trim(), ...(clientSecret ? { clientSecret } : {}) });
  };
  return (
    <Box component="form" onSubmit={submit} noValidate>
      <Stack spacing={2} sx={{ mt: 2 }}>
        <TextField label="Vault address" type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://vault.example.test" required fullWidth helperText="Where your Vault runs. Only https addresses on the public internet are accepted." />
        <TextField label="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} required fullWidth helperText="From the client your Vault administrator registered for Hexactra." />
        <TextField
          label="Client secret"
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          required={!keepSecret}
          fullWidth
          autoComplete="off"
          helperText={keepSecret ? 'A secret is stored. Leave this empty to keep it.' : 'Stored encrypted and never shown again.'}
        />
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button type="submit" variant="contained" disabled={!valid || busy} sx={TOUCH}>
            Save and connect
          </Button>
          {onCancel && (
            <Button onClick={onCancel} sx={TOUCH}>
              Cancel
            </Button>
          )}
        </Box>
      </Stack>
    </Box>
  );
}

/** The provider card, in each of its states. */
function ProviderCard({ vault, canWrite, busy, onConnect, onSaveAndConnect, onDisconnect }: { vault: VaultStatus; canWrite: boolean; busy: string | null; onConnect: () => void; onSaveAndConnect: (v: { baseUrl: string; clientId: string; clientSecret?: string }) => void; onDisconnect: () => void }) {
  const [editing, setEditing] = useState(false);
  const permissions = permissionWords(vault.scopes);
  const working = busy !== null;

  let body: ReactNode;
  if (vault.status === 'connected' || vault.status === 'needs_reconnect') {
    const needs = vault.status === 'needs_reconnect';
    body = (
      <>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
          <Typography variant="h6" component="h2">
            Vault
          </Typography>
          <Chip size="small" color={needs ? 'warning' : 'success'} label={needs ? 'Needs reconnecting' : 'Connected'} data-testid="provider-state" />
        </Stack>
        {needs && (
          <Alert severity="warning" sx={{ mt: 1.5 }}>
            Vault no longer accepts the saved connection (you may have removed Hexactra there, or the secret was changed). Until you reconnect, runs ask you to sign in by hand.
          </Alert>
        )}
        {vault.agentAccess === 'off' && !needs && (
          <Alert severity="info" sx={{ mt: 1.5 }}>
            Agent access is switched off in Vault. Ask its administrator to turn it on: until then nothing is released.
          </Alert>
        )}
        <Box component="dl" sx={{ m: 0, mt: 1.5, display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'max-content 1fr' }, columnGap: 3, rowGap: { xs: 0.25, sm: 0.75 }, '& dd': { m: 0, mb: { xs: 1, sm: 0 }, overflowWrap: 'anywhere' }, '& dt': { color: 'text.secondary' } }}>
          <dt>Vault address</dt>
          <dd data-testid="vault-address">{vault.baseUrl}</dd>
          <dt>Account</dt>
          <dd>{vault.vaultUserId ? `Your Vault account (${vault.vaultUserId.slice(0, 8)})` : 'Your Vault account'}</dd>
          <dt>Allowed to</dt>
          <dd>{permissions.length ? permissions.join(', ') : 'Nothing yet'}</dd>
          <dt>Last used</dt>
          <dd>{vault.lastUsedAt ? <RelativeTime iso={vault.lastUsedAt} /> : 'Never'}</dd>
        </Box>
        {canWrite && (
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 2 }}>
            {needs && (
              <Button variant="contained" onClick={onConnect} disabled={working} sx={TOUCH}>
                Reconnect
              </Button>
            )}
            <Button color="error" variant={needs ? 'text' : 'outlined'} onClick={onDisconnect} disabled={working} sx={TOUCH}>
              Disconnect
            </Button>
          </Box>
        )}
      </>
    );
  } else {
    const ready = vault.configured && !editing;
    body = (
      <>
        <Typography variant="h6" component="h2">
          Connect a secrets provider
        </Typography>
        <Typography sx={{ mt: 0.5 }} color="text.secondary">
          A secrets provider keeps your logins and one-time codes safe. Connect yours and the agent can sign in for you without ever seeing a password: Hexactra types it into the page and no one reads it on the way.
        </Typography>
        {vault.connecting && (
          <Alert severity="info" sx={{ mt: 1.5 }}>
            A connection was started and has not finished. Finish it in Vault, or start again.
          </Alert>
        )}
        {ready && (
          <Box sx={{ mt: 2 }}>
            <Typography variant="body2" color="text.secondary" data-testid="vault-address">
              Vault at {hostOf(vault.baseUrl)}
              {vault.source === 'deployment' ? ' (set by your administrator)' : ''}
            </Typography>
            {canWrite && (
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 1 }}>
                <Button variant="contained" onClick={onConnect} disabled={working} sx={TOUCH}>
                  Connect Vault
                </Button>
                <Button onClick={() => setEditing(true)} disabled={working} sx={TOUCH}>
                  Change Vault settings
                </Button>
              </Box>
            )}
          </Box>
        )}
        {!ready && canWrite && <ClientForm vault={vault} busy={working} onSubmit={onSaveAndConnect} onCancel={vault.configured ? () => setEditing(false) : undefined} />}
        {!ready && !canWrite && <Typography sx={{ mt: 2 }}>You can see this page but not change it.</Typography>}
      </>
    );
  }
  return (
    <Paper variant="outlined" component="section" aria-label="Secrets provider" sx={{ p: { xs: 2, sm: 3 } }}>
      {body}
    </Paper>
  );
}

const ACTIVITY_COLUMNS = (links: { runHref: (id: string) => string }): Column<ActivityItem>[] => [
  { key: 'at', header: 'When', width: 170, render: (i) => <RelativeTime iso={i.at} /> },
  { key: 'site', header: 'Login and site', render: (i) => <SiteCell item={i} /> },
  { key: 'what', header: 'What', hideBelow: 'lg', render: (i) => whatWords(i) },
  {
    key: 'run',
    header: 'Run',
    hideBelow: 'lg',
    render: (i) =>
      i.runId ? (
        <Link component={RouterLink} to={links.runHref(i.runId)}>
          Open run
        </Link>
      ) : (
        'n/a'
      ),
  },
  { key: 'outcome', header: 'Outcome', width: 270, render: (i) => <OutcomeChip item={i} /> },
];

/** The login's name when the run recorded it, with the site under it. */
function SiteCell({ item }: { item: ActivityItem }) {
  if (item.event === 'service_key') return <>{item.serviceKey ?? 'A key of an outside service'}</>;
  const site = item.site ?? 'Unknown site';
  if (!item.loginName) return <>{site}</>;
  return (
    <>
      <Box component="span" sx={{ display: 'block', fontWeight: 500 }}>
        {item.loginName}
      </Box>
      <Box component="span" sx={{ display: 'block', color: 'text.secondary', typography: 'body2' }}>
        {site}
      </Box>
    </>
  );
}

function OutcomeChip({ item }: { item: ActivityItem }) {
  const text = outcomeWords(item.outcome);
  return <Chip size="small" variant={item.refused ? 'filled' : 'outlined'} color={item.refused ? 'warning' : 'success'} label={text} sx={{ height: 'auto', '& .MuiChip-label': { whiteSpace: 'normal', py: 0.5 } }} />;
}

function ActivitySection({ activity }: { activity: ActivityList }) {
  const columns = ACTIVITY_COLUMNS({ runHref: (id) => `/runs/${id}` });
  return (
    <Box component="section" aria-labelledby="activity-title">
      <Typography id="activity-title" variant="h6" component="h2" sx={{ mb: 0.5 }}>
        Activity
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        The last {activity.items.length === 100 ? '100 ' : ''}times the agent used your saved logins, including the ones it was refused. It never shows what was typed.
        {activity.providerActivityUrl && (
          <>
            {' '}
            <Link href={activity.providerActivityUrl} target="_blank" rel="noopener noreferrer">
              See your provider&rsquo;s own activity
              <OpenInNewIcon aria-hidden sx={{ fontSize: 14, ml: 0.5, verticalAlign: 'text-bottom' }} />
            </Link>
          </>
        )}
      </Typography>
      {activity.items.length === 0 ? (
        <EmptyState Icon={KeyOutlinedIcon} title="Nothing yet" body="When the agent signs in with a saved login, it shows up here with the site and what it typed." />
      ) : (
        <ResponsiveList
          aria-label="Saved login activity"
          items={activity.items}
          columns={columns}
          getKey={(i) => i.id}
          renderCard={(i) => (
            <Paper variant="outlined" sx={{ p: 1.5 }} data-testid={`activity-${i.id}`}>
              <Stack spacing={0.5}>
                <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{i.event === 'service_key' ? (i.serviceKey ?? 'A key of an outside service') : i.loginName ? `${i.loginName} (${i.site ?? 'unknown site'})` : (i.site ?? 'Unknown site')}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {whatWords(i)} · <RelativeTime iso={i.at} />
                </Typography>
                <Box>
                  <OutcomeChip item={i} />
                </Box>
                {i.runId && (
                  <Link component={RouterLink} to={`/runs/${i.runId}`} sx={{ ...TOUCH, display: 'inline-flex', alignItems: 'center' }}>
                    Open run
                  </Link>
                )}
              </Stack>
            </Paper>
          )}
        />
      )}
    </Box>
  );
}

/** Where the logins are kept, when the deployment offers the built-in store too (E37.5): one is active at a time. */
function StoreChoice({ store, vault, canWrite, busy, onChoose }: { store: StoreStatus; vault: VaultStatus; canWrite: boolean; busy: boolean; onChoose: (p: 'vault' | 'builtin') => void }) {
  const VAULT_WORDS = { not_configured: 'Not set up yet', disconnected: 'Not connected', connected: 'Connected', needs_reconnect: 'Needs to be connected again' } as const;
  return (
    <Paper variant="outlined" component="section" aria-labelledby="where-title" sx={{ p: { xs: 2, sm: 3 } }}>
      <Typography id="where-title" variant="h6" component="h2" sx={{ mb: 1 }}>
        Where your logins are kept
      </Typography>
      <RadioGroup value={store.provider} onChange={(e) => onChoose(e.target.value === 'builtin' ? 'builtin' : 'vault')} aria-label="Secrets provider">
        <FormControlLabel
          value="builtin"
          disabled={!canWrite || busy}
          control={<Radio />}
          sx={{ alignItems: 'flex-start', mb: 1, minHeight: { xs: 44, sm: 'auto' } }}
          label={
            <Box>
              <Typography sx={{ fontWeight: 600 }}>Store in Hexactra</Typography>
              <Typography variant="body2" color="text.secondary">
                Saved logins live encrypted in this deployment&rsquo;s database. {store.logins} saved, {store.openToAgent} open to the agent.
              </Typography>
            </Box>
          }
        />
        <FormControlLabel
          value="vault"
          disabled={!canWrite || busy}
          control={<Radio />}
          sx={{ alignItems: 'flex-start', minHeight: { xs: 44, sm: 'auto' } }}
          label={
            <Box>
              <Typography sx={{ fontWeight: 600 }}>Connect Vault</Typography>
              <Typography variant="body2" color="text.secondary">
                Your own Vault keeps them; Hexactra never sees a value. {VAULT_WORDS[vault.status]}.
              </Typography>
            </Box>
          }
        />
      </RadioGroup>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
        One is active at a time. Switching does not move your logins.
      </Typography>
    </Paper>
  );
}

/** The card of the built-in store, when it is the chosen provider. */
function StoreCard({ store }: { store: StoreStatus }) {
  return (
    <Paper variant="outlined" component="section" aria-label="Secrets provider" sx={{ p: { xs: 2, sm: 3 } }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
        <Typography variant="h6" component="h2">
          Hexactra
        </Typography>
        <Chip size="small" color="success" label="In use" data-testid="provider-state" />
      </Stack>
      <Typography sx={{ mt: 1 }} color="text.secondary">
        {store.logins} saved, {store.openToAgent} open to the agent. You decide which logins the agent may use where you save them.
      </Typography>
      <Typography sx={{ mt: 1 }} color="text.secondary" data-testid="store-save-note">
        After you sign in yourself during a run, the agent offers to save that login here, on a card. You decide each time.
      </Typography>
      <Button component={RouterLink} to="/secrets" variant="outlined" sx={{ ...TOUCH, mt: 2 }}>
        My saved logins
      </Button>
    </Paper>
  );
}

/**
 * The sites the owner said "Never for this site" for on a "Save this login?" card (E37.4b). Shown only when there is one; removing a site is
 * how the owner is offered to save a login there again.
 */
function NeverSaveSection({ sites, canWrite, busy, onRemove }: { sites: string[]; canWrite: boolean; busy: boolean; onRemove: (site: string) => void }) {
  return (
    <Box component="section" aria-labelledby="never-title" data-testid="never-save-sites">
      <Typography id="never-title" variant="h6" component="h2" sx={{ mb: 0.5 }}>
        Sites where the agent will not offer to save a login
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        You chose &ldquo;Never for this site&rdquo; on these. Remove one to be offered again after you sign in there yourself.
      </Typography>
      <Stack spacing={1} component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }} aria-label="Sites never offered">
        {sites.map((site) => (
          <Paper key={site} component="li" variant="outlined" sx={{ p: 1.5, display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { sm: 'center' }, gap: 1 }}>
            <Typography sx={{ flexGrow: 1, minWidth: 0, fontWeight: 500, overflowWrap: 'anywhere' }}>{site}</Typography>
            <Button size="small" variant="outlined" disabled={!canWrite || busy} onClick={() => onRemove(site)} aria-label={`Offer to save logins again for ${site}`} sx={{ ...TOUCH, alignSelf: { xs: 'stretch', sm: 'center' } }}>
              Offer again
            </Button>
          </Paper>
        ))}
      </Stack>
    </Box>
  );
}

function ReachSection({ reach, manageUrl, store }: { reach: Reach; manageUrl: string | null; store?: StoreStatus | null }) {
  return (
    <Box component="section" aria-labelledby="reach-title">
      <Typography id="reach-title" variant="h6" component="h2" sx={{ mb: 0.5 }}>
        What the agent can reach
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {store?.provider === 'builtin' ? (
          <>
            {store.openToAgent} of your {store.logins} saved logins are open to the agent. Which ones is decided where you save them, not here. These are the ones the agent has used so far.
          </>
        ) : (
          'Which logins are open to the agent is decided in your provider, not here. Vault can look logins up only for the page on screen, so the full list is in Vault; these are the ones the agent has used so far.'
        )}
      </Typography>
      {reach.items.length === 0 ? (
        <Typography color="text.secondary">The agent has not used a saved login yet.</Typography>
      ) : (
        <Stack spacing={1} component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }} aria-label="Logins used so far">
          {reach.items.map((r, i) => (
            <Paper key={`${r.site}-${i}`} component="li" variant="outlined" sx={{ p: 1.5, display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { sm: 'center' }, gap: 1 }}>
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{r.site ?? 'Unknown site'}</Typography>
                <Typography variant="body2" color="text.secondary">
                  Typed: {fieldsWords(r.fields)} · used {r.uses === 1 ? 'once' : `${r.uses} times`}, last <RelativeTime iso={r.lastUsedAt} />
                </Typography>
              </Box>
              {store?.provider === 'builtin' ? (
                <Link component={RouterLink} to="/secrets" sx={{ ...TOUCH, display: 'inline-flex', alignItems: 'center' }} aria-label={`Manage ${r.site ?? 'this login'} in My saved logins`}>
                  Manage in My saved logins
                </Link>
              ) : (
                manageUrl && (
                  <Link href={manageUrl} target="_blank" rel="noopener noreferrer" sx={{ ...TOUCH, display: 'inline-flex', alignItems: 'center' }} aria-label={`Manage ${r.site ?? 'this login'} in Vault`}>
                    Manage in Vault
                  </Link>
                )
              )}
            </Paper>
          ))}
        </Stack>
      )}
    </Box>
  );
}

/**
 * The payment cards (E37.7): how paying works and what protects the owner, a check of ONE merchant (Vault lists a card only for a
 * merchant the owner granted it for, so there is no list of every card) and the merchants Hexactra itself remembers. Read-only:
 * the grants are made in the provider. Never a number, an expiry beyond MM/YYYY or a code.
 */
function CardsSection({ connected, hasScope, manageUrl, remembered }: { connected: boolean; hasScope: boolean; manageUrl: string | null; remembered: ApprovalRule[] }) {
  const { api } = usePlatformHost();
  const [merchant, setMerchant] = useState('');
  const [listing, setListing] = useState<CardListing | null>(null);
  const [busy, setBusy] = useState(false);
  const reasons: Record<string, string> = {
    switched_off: 'Turn on “Let the agent use saved logins” first.',
    not_connected: 'Connect your provider first.',
    needs_reconnect: 'Connect your provider again first.',
    needs_scope: 'Turn on “Let the agent pay with a saved card” above, then check again.',
    provider_off: 'Card payments are switched off in your provider.',
    unavailable: 'Your provider could not be reached. Try again later.',
    bad_merchant: 'Enter a shop, like shop.example.com.',
  };
  const check = async (e: FormEvent) => {
    e.preventDefault();
    if (!merchant.trim()) return;
    setBusy(true);
    try {
      setListing(await getCards(api, merchant.trim()));
    } catch {
      setListing({ available: false, reason: 'unavailable', merchant: null, cards: [], manageUrl });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Box component="section" aria-labelledby="cards-title" data-testid="cards-section">
      <Typography id="cards-title" variant="h6" component="h2" sx={{ mb: 0.5 }}>
        Payment cards
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        <strong>The safest way is no stored card at all:</strong> the browser profile the agent uses keeps the shops you are signed in to, so a shop where your card is already saved in your account there needs nothing here. Where it does, a card with its own spending limit from your bank or card issuer (a virtual card) is better than your main card.
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        A card works on any site, so a site binding cannot protect it. Instead you decide per shop: in your provider you allow a card at a shop with a maximum amount (and you may allow the security code), and Hexactra asks you the first time at each shop, with the amount. You can remember that with a required limit (Saved approvals). The agent never sees the number, the expiry or the code, and every use notifies you. This is for your own card on your own deployment; it is not a payment service.
      </Typography>
      {!connected || !hasScope ? (
        <Typography color="text.secondary">{!connected ? 'Connect your provider first.' : 'Turn on “Let the agent pay with a saved card” above to see which cards you allowed at a shop.'}</Typography>
      ) : (
        <Stack spacing={1.5}>
          <Box component="form" onSubmit={(e) => void check(e)} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <TextField size="small" label="Check a shop" value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="shop.example.com" slotProps={{ htmlInput: { 'aria-label': 'Shop to check', maxLength: 300 } }} sx={{ flexGrow: 1, minWidth: 220, maxWidth: 420 }} />
            <Button type="submit" variant="outlined" disabled={busy || !merchant.trim()} sx={{ ...TOUCH }}>
              Check
            </Button>
          </Box>
          {listing && (
            <Box aria-live="polite" data-testid="cards-result">
              {!listing.available ? (
                <Typography color="text.secondary">{reasons[listing.reason] ?? 'Cards are not available.'}</Typography>
              ) : listing.cards.length === 0 ? (
                <Typography color="text.secondary">No card is allowed at {listing.merchant?.replace(/^https:\/\//, '')}. Allow one for this shop in your provider; the agent cannot pay there until you do.</Typography>
              ) : (
                <Stack spacing={1} component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }} aria-label="Cards allowed at this shop">
                  {listing.cards.map((c, i) => (
                    <Paper key={`${c.name}-${i}`} component="li" variant="outlined" sx={{ p: 1.5, display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { sm: 'center' }, gap: 1 }}>
                      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                        <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{c.name}</Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                          {[c.brand ? c.brand.charAt(0).toUpperCase() + c.brand.slice(1) : 'Card', c.last4 ? `ending ${c.last4}` : null, c.expires ? `expires ${c.expires}` : null].filter(Boolean).join(' · ')}
                        </Typography>
                        <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
                          <Chip size="small" variant="outlined" label={`Up to ${c.limit.maxAmount} ${c.limit.currency}`} />
                          <Chip size="small" variant="outlined" color={c.limit.includesSecurityCode ? 'warning' : 'default'} label={c.limit.includesSecurityCode ? 'Security code allowed' : 'No security code'} />
                          {c.limit.expiresAt && <Chip size="small" variant="outlined" label={`Until ${new Date(c.limit.expiresAt).toLocaleDateString()}`} />}
                        </Stack>
                      </Box>
                      {(listing.manageUrl ?? manageUrl) && (
                        <Link href={listing.manageUrl ?? manageUrl ?? undefined} target="_blank" rel="noopener noreferrer" sx={{ ...TOUCH, display: 'inline-flex', alignItems: 'center' }} aria-label={`Manage ${c.name} and its shops in Vault`}>
                          Manage in Vault
                        </Link>
                      )}
                    </Paper>
                  ))}
                </Stack>
              )}
            </Box>
          )}
        </Stack>
      )}
      <Typography variant="subtitle1" component="h3" sx={{ mt: 2.5, mb: 0.5 }}>
        Shops Hexactra remembers
      </Typography>
      {remembered.length === 0 ? (
        <Typography color="text.secondary">None. The agent asks you the first time at each shop. You can choose “Don’t ask again” on that question, with a limit.</Typography>
      ) : (
        <Stack spacing={1} component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }} aria-label="Remembered card approvals">
          {remembered.map((r) => (
            <Paper key={r.id} component="li" variant="outlined" sx={{ p: 1.5, display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { sm: 'center' }, gap: 1, opacity: r.enabled ? 1 : 0.7 }}>
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{r.summary}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {limitsText(r)}
                  {!r.enabled ? ' · off' : ''}
                </Typography>
              </Box>
              <Link component={RouterLink} to={`/settings/approvals#rule-${r.id}`} sx={{ ...TOUCH, display: 'inline-flex', alignItems: 'center' }}>
                Open in Saved approvals
              </Link>
            </Paper>
          ))}
        </Stack>
      )}
    </Box>
  );
}

/**
 * The identity details the owner saved (E37.6): item names, field labels and which fields are sensitive, read-only, with a
 * link to the provider where the items and their allowed sites are managed. Never a value.
 */
function IdentitySection({ identity, manageUrl }: { identity: IdentityListing; manageUrl: string | null }) {
  const reasons: Record<string, string> = {
    switched_off: 'Turn on “Let the agent use saved logins” to let the agent use identity details.',
    not_connected: 'Connect your provider to see the identity details you saved.',
    needs_reconnect: 'Connect your provider again to see the identity details you saved.',
    needs_scope: 'Turn on “Let the agent fill identity details” above to let the agent see which details you saved.',
    provider_off: 'Identity details are switched off in your provider.',
    unavailable: 'Your provider could not be reached. Try again later.',
  };
  return (
    <Box component="section" aria-labelledby="identity-title" data-testid="identity-section">
      <Typography id="identity-title" variant="h6" component="h2" sx={{ mb: 0.5 }}>
        Identity details
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Things a form asks for that are not logins: an ID number, a date of birth, an address. The agent fills a field by its label and never sees the value. A sensitive field is typed only on the sites you listed for it in your provider. Hexactra does not edit them.
      </Typography>
      {!identity.available ? (
        <Typography color="text.secondary">{reasons[identity.reason] ?? 'Identity details are not available.'}</Typography>
      ) : identity.items.length === 0 ? (
        <Typography color="text.secondary">You have not opened any identity item to the agent yet.</Typography>
      ) : (
        <Stack spacing={1} component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }} aria-label="Identity details you saved">
          {identity.items.map((item, i) => (
            <Paper key={`${item.name}-${i}`} component="li" variant="outlined" sx={{ p: 1.5, display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { sm: 'center' }, gap: 1 }}>
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{item.name}</Typography>
                <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
                  {item.fields.map((f) => (
                    <Chip key={f.label} size="small" variant="outlined" color={f.sensitive ? 'warning' : 'default'} label={f.sensitive ? `${f.label} · sensitive` : f.label} />
                  ))}
                </Stack>
              </Box>
              {manageUrl && (
                <Link href={manageUrl} target="_blank" rel="noopener noreferrer" sx={{ ...TOUCH, display: 'inline-flex', alignItems: 'center' }} aria-label={`Manage ${item.name} and its allowed sites in Vault`}>
                  Manage in Vault
                </Link>
              )}
            </Paper>
          ))}
        </Stack>
      )}
    </Box>
  );
}

/**
 * `/settings/secrets` (E37.4, #593): the owner's view of saved secrets. The provider card (connect, reconnect,
 * disconnect), the switches that turn the agent's use off, what the agent can reach, and what it used. Nothing here
 * shows or edits a login: that is the provider's job.
 */
export function SecretsSettingsPage() {
  const { api, viewer } = usePlatformHost();
  const confirm = useConfirm();
  const canWrite = viewer.hasPermission('secrets:write');
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<SecretsStatus | null>(null);
  const [activity, setActivity] = useState<ActivityList | null>(null);
  const [reach, setReach] = useState<Reach | null>(null);
  const [identity, setIdentity] = useState<IdentityListing | null>(null);
  // The card approvals Hexactra remembers (E37.7): the saved approvals that are bound to a card.
  const [cardRules, setCardRules] = useState<ApprovalRule[]>([]);
  const [defaultOn, setDefaultOn] = useState(false);
  // The sites the owner chose "Never for this site" for on a "Save this login?" card (E37.4b).
  const [neverSites, setNeverSites] = useState<string[]>([]);
  // The built-in store (E37.5): null when this deployment does not offer it.
  const [store, setStore] = useState<StoreStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ severity: 'success' | 'info' | 'warning' | 'error'; text: string } | null>(null);
  const action = useApiAction('Could not change this');

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setStatus(await getStatus(api));
      // The lists are secondary: a failure of one does not hide the provider card.
      getActivity(api).then(setActivity, () => setActivity({ items: [], providerActivityUrl: null }));
      getReach(api).then(setReach, () => setReach({ listing: 'per_origin', items: [] }));
      getIdentity(api).then(setIdentity, () => setIdentity({ available: false, reason: 'unavailable', items: [], manageUrl: null }));
      api.get<ApprovalRulesList>('/approval-rules').then((l) => setCardRules(l.rules.filter((r) => Boolean(r.cardRef))), () => setCardRules([]));
      getDefaultUseSavedLogins(api).then(setDefaultOn, () => setDefaultOn(false));
      getNeverSaveSites(api).then(setNeverSites, () => setNeverSites([]));
      getStoreStatus(api).then(setStore);
    } catch (e) {
      setLoadError(e instanceof Error && e.message ? e.message : 'Could not load your secrets settings');
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  // Coming back from Vault's consent screen: say what happened once, then clean the address.
  const result = params.get('vault');
  useEffect(() => {
    if (!result) return;
    setMessage(CONNECT_RESULT_WORDS[result] ?? { severity: 'error', text: 'The connection did not finish.' });
    setParams(
      (p) => {
        p.delete('vault');
        return p;
      },
      { replace: true },
    );
  }, [result, setParams]);

  const vault = status?.providers.vault ?? null;

  // A new consent keeps every permission the owner already gave unless the call changes it (E50.3 adds the service keys one).
  const keepServiceKeys = vault ? hasServiceKeyScope(vault.scopes) : false;
  const startConnect = (allowWrite: boolean, allowIdentity = false, allowCards = false, allowServiceKeys = keepServiceKeys) =>
    action.run('connect', async () => {
      const r = await connect(api, { allowWrite, ...(allowIdentity ? { allowIdentity } : {}), ...(allowCards ? { allowCards } : {}), ...(allowServiceKeys ? { allowServiceKeys } : {}), returnTo: '/settings/secrets' });
      window.location.assign(r.authorizeUrl);
    });

  const saveAndConnect = (v: { baseUrl: string; clientId: string; clientSecret?: string }) =>
    action.run('connect', async () => {
      await saveClient(api, v);
      const r = await connect(api, { allowWrite: vault ? hasWriteScope(vault.scopes) : false, ...(vault && hasIdentityScope(vault.scopes) ? { allowIdentity: true } : {}), ...(vault && hasCardsScope(vault.scopes) ? { allowCards: true } : {}), ...(keepServiceKeys ? { allowServiceKeys: true } : {}), returnTo: '/settings/secrets' });
      window.location.assign(r.authorizeUrl);
    });

  const doDisconnect = async () => {
    const ok = await confirm({ title: 'Disconnect Vault?', body: 'Runs will ask you to sign in again.', confirmLabel: 'Disconnect', destructive: true });
    if (!ok) return;
    const r = await action.run('disconnect', () => disconnect(api));
    if (!r) return;
    setStatus(r.status);
    setMessage(r.revoked ? { severity: 'success', text: 'Vault is disconnected.' } : { severity: 'warning', text: 'Vault is disconnected here, but Vault could not be asked to forget Hexactra. Remove Hexactra in Vault under Connected apps.' });
  };

  const toggleUse = async (on: boolean) => {
    const saved = await action.run('use', () => setAgentUse(api, on));
    if (saved === undefined) return;
    setStatus((s) => (s ? { ...s, agentUse: { ...s.agentUse, user: saved, effective: s.agentUse.deployment && saved } } : s));
    setMessage({ severity: 'info', text: saved ? 'The agent may use your saved logins.' : 'The agent will not use your saved logins.' });
  };

  const chooseProvider = async (provider: 'vault' | 'builtin') => {
    const done = await action.run('provider', async () => {
      await setProvider(api, provider);
      setStore(await getStoreStatus(api));
      return true;
    });
    if (done) setMessage({ severity: 'info', text: provider === 'builtin' ? 'The agent now uses the logins saved in Hexactra.' : 'The agent now uses your Vault.' });
  };

  const toggleDefault = async (on: boolean) => {
    const saved = await action.run('default', () => setDefaultUseSavedLogins(api, on));
    if (saved === undefined) return;
    setDefaultOn(saved);
    setMessage({ severity: 'info', text: saved ? 'New tasks and chats will start with saved logins on.' : 'New tasks and chats will start with saved logins off.' });
  };

  const offerAgain = async (site: string) => {
    const saved = await action.run('never', () => setNeverSaveSites(api, neverSites.filter((s) => s !== site)));
    if (saved === undefined) return;
    setNeverSites(saved);
    setMessage({ severity: 'info', text: `The agent may offer to save a login for ${site} again.` });
  };

  const toggleWrite = async (on: boolean) => {
    if (!on) {
      const ok = await confirm({ title: 'Stop letting the agent save and change logins?', body: 'You will go to Vault to approve a connection without that permission.', confirmLabel: 'Continue' });
      if (!ok) return;
    }
    // A new consent keeps what the owner already allowed: only the write permission changes.
    await startConnect(on, vault ? hasIdentityScope(vault.scopes) : false, vault ? hasCardsScope(vault.scopes) : false);
  };

  const toggleIdentity = async (on: boolean) => {
    if (!on) {
      const ok = await confirm({ title: 'Stop letting the agent fill identity details?', body: 'You will go to Vault to approve a connection without that permission.', confirmLabel: 'Continue' });
      if (!ok) return;
    }
    await startConnect(vault ? hasWriteScope(vault.scopes) : false, on, vault ? hasCardsScope(vault.scopes) : false);
  };

  const toggleCards = async (on: boolean) => {
    if (!on) {
      const ok = await confirm({ title: 'Stop letting the agent pay with a saved card?', body: 'You will go to Vault to approve a connection without that permission. Your merchant permissions in Vault are untouched.', confirmLabel: 'Continue' });
      if (!ok) return;
    }
    await startConnect(vault ? hasWriteScope(vault.scopes) : false, vault ? hasIdentityScope(vault.scopes) : false, on);
  };

  const toggleServiceKeys = async (on: boolean) => {
    if (!on) {
      const ok = await confirm({ title: 'Stop letting Hexactra read your keys of outside services?', body: 'You will go to Vault to approve a connection without that permission. A key kept in your Vault is then not used; your organization’s or the deployment’s key is, if one is shared.', confirmLabel: 'Continue' });
      if (!ok) return;
    }
    await startConnect(vault ? hasWriteScope(vault.scopes) : false, vault ? hasIdentityScope(vault.scopes) : false, vault ? hasCardsScope(vault.scopes) : false, on);
  };

  const deploymentOff = status !== null && !status.agentUse.deployment;
  const connected = vault?.status === 'connected';
  const manageUrl = vault?.status === 'connected' && vault.baseUrl ? vault.baseUrl : null;

  return (
    <PageContainer>
      <PageHeader title="Secrets" subtitle="Let the agent sign in with the logins in your own provider, without it ever seeing them." back={{ to: '/settings', label: 'Settings' }} />
      <ErrorBanner error={loadError ?? action.error} onRetry={loadError ? () => void load() : undefined} onClose={loadError ? undefined : action.clearError} />
      {/* One polite live region: every outcome of a switch, connect or disconnect is announced here. */}
      <Box role="status" aria-live="polite" sx={{ mb: message ? 2 : 0 }}>
        {message && (
          <Alert severity={message.severity} onClose={() => setMessage(null)}>
            {message.text}
          </Alert>
        )}
      </Box>
      {deploymentOff && (
        <Alert severity="info" sx={{ mb: 2 }} data-testid="deployment-off">
          An administrator has turned off saved secrets for this deployment. The agent will not use your saved logins, whatever you choose here.
        </Alert>
      )}
      {!status && !loadError && (
        <Stack spacing={2}>
          <CardSkeleton />
          <ListSkeleton rows={3} />
        </Stack>
      )}
      {status && vault && (
        <Stack spacing={4}>
          {store && <StoreChoice store={store} vault={vault} canWrite={canWrite} busy={action.busy === 'provider'} onChoose={(p) => void chooseProvider(p)} />}
          {store?.provider === 'builtin' ? <StoreCard store={store} /> : <ProviderCard vault={vault} canWrite={canWrite} busy={action.busy} onConnect={() => void startConnect(hasWriteScope(vault.scopes), hasIdentityScope(vault.scopes), hasCardsScope(vault.scopes))} onSaveAndConnect={(v) => void saveAndConnect(v)} onDisconnect={() => void doDisconnect()} />}

          <Paper variant="outlined" component="section" aria-labelledby="switches-title" sx={{ p: { xs: 2, sm: 3 } }}>
            <Typography id="switches-title" variant="h6" component="h2" sx={{ mb: 1 }}>
              What the agent may do
            </Typography>
            <Stack spacing={1.5}>
              <SwitchRow
                label="Let the agent use saved logins"
                help={deploymentOff ? 'Turned off by an administrator for this deployment.' : 'When it reaches a sign-in page for a site you have a saved login for, it signs in and does not ask. It never sees the password or code. Off by default.'}
                checked={status.agentUse.user}
                disabled={!canWrite || deploymentOff}
                busy={action.busy === 'use'}
                onChange={(on) => void toggleUse(on)}
              />
              <SwitchRow
                label="Use saved logins in new tasks and chats"
                help="Each task and chat has its own switch, “Use my saved logins”. This sets where a new one starts and changes nothing that already exists. Off by default."
                checked={defaultOn}
                disabled={!canWrite}
                busy={action.busy === 'default'}
                onChange={(on) => void toggleDefault(on)}
              />
              {store?.provider !== 'builtin' && (
                <SwitchRow
                  label="Let the agent save and change logins"
                  help={
                    !connected
                      ? 'Connect your provider first.'
                      : 'Asks Vault for permission to save and change logins. You approve it in Vault. After you sign in yourself during a run, the agent offers to save that login on a card; you decide each time, and the password never passes through Hexactra.'
                  }
                  checked={connected && hasWriteScope(vault.scopes)}
                  disabled={!canWrite || !connected}
                  busy={action.busy === 'connect'}
                  onChange={(on) => void toggleWrite(on)}
                />
              )}
              {store?.provider !== 'builtin' && (
                <SwitchRow
                  label="Let the agent fill identity details"
                  help={
                    !connected
                      ? 'Connect your provider first.'
                      : 'Asks Vault for permission to fill a form with details you saved (a date of birth, an ID number, an address). The agent names the field and never sees the value. You approve it in Vault. Each task and chat has its own switch too. Off by default.'
                  }
                  checked={connected && hasIdentityScope(vault.scopes)}
                  disabled={!canWrite || !connected}
                  busy={action.busy === 'connect'}
                  onChange={(on) => void toggleIdentity(on)}
                />
              )}
              {store?.provider !== 'builtin' && (
                <SwitchRow
                  label="Let the agent pay with a saved card"
                  help={
                    !connected
                      ? 'Connect your provider first.'
                      : 'Asks Vault for permission to pay with a card you saved. A card works on any site, so in Vault you also allow each shop and set a limit, and Hexactra asks you the first time at each shop. The agent never sees the number, the expiry or the code. You approve it in Vault. Each task and chat has its own switch too. Off by default.'
                  }
                  checked={connected && hasCardsScope(vault.scopes)}
                  disabled={!canWrite || !connected}
                  busy={action.busy === 'connect'}
                  onChange={(on) => void toggleCards(on)}
                />
              )}
              {store?.provider !== 'builtin' && (
                <SwitchRow
                  label="Let Hexactra read your keys of outside services"
                  help={
                    !connected
                      ? 'Connect your provider first.'
                      : 'Asks Vault for permission for Hexactra’s server to read a key you keep there as a “Service key” (a web search provider’s, for example), only for its calls to that service. The agent never sees it. You approve it in Vault. Needs a Vault that supports service keys. Off by default.'
                  }
                  checked={connected && hasServiceKeyScope(vault.scopes)}
                  disabled={!canWrite || !connected}
                  busy={action.busy === 'connect'}
                  onChange={(on) => void toggleServiceKeys(on)}
                />
              )}
            </Stack>
          </Paper>

          {store?.provider === 'builtin' && <PasskeysSection canWrite={canWrite} />}
          {neverSites.length > 0 && <NeverSaveSection sites={neverSites} canWrite={canWrite} busy={action.busy === 'never'} onRemove={(site) => void offerAgain(site)} />}
          {reach && <ReachSection reach={reach} manageUrl={manageUrl} store={store} />}
          {store?.provider !== 'builtin' && <CardsSection connected={vault.status === 'connected'} hasScope={hasCardsScope(vault.scopes)} manageUrl={manageUrl} remembered={cardRules} />}
          {identity && store?.provider !== 'builtin' && <IdentitySection identity={identity} manageUrl={identity.manageUrl ?? manageUrl} />}
          <ServiceKeysSection canWrite={canWrite} />
          {activity ? <ActivitySection activity={activity} /> : <ListSkeleton rows={3} />}
        </Stack>
      )}
    </PageContainer>
  );
}
