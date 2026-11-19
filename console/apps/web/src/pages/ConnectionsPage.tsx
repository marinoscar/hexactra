import AddIcon from '@mui/icons-material/Add';
import GoogleIcon from '@mui/icons-material/Google';
import LinkOutlinedIcon from '@mui/icons-material/LinkOutlined';
import MicrosoftIcon from '@mui/icons-material/Microsoft';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { Alert, Box, Button, Chip, IconButton, List, ListItem, ListItemIcon, Menu, MenuItem, Paper, Stack, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

import {
  authorize,
  getConnection,
  listConnections,
  listProviders,
  pauseConnection,
  removeConnection,
  resumeConnection,
  testConnection,
  updateConnection,
  type Capability,
  type CapabilityGroup,
  type Connection,
  type Provider,
  type ProviderAvailability,
  type TestResult,
} from '../connections/api';
import { ConnectDialog } from '../connections/ConnectDialog';
import { CapabilitiesDialog, DefaultsDialog, RenameDialog, TestDialog } from '../connections/ConnectionDialogs';
import { GROUPS, GROUP_NAME, PROVIDER_NAME, STATUS_WORDS, levelOf, outcomeBanner, reasonWords, type Outcome } from '../connections/words';
import { EmptyState, ErrorBanner, ListSkeleton, PageContainer, PageHeader, RelativeTime, toast, useApiAction, useConfirm } from '../ui';

const RETURN_TO = '/settings/connections';
const TOUCH = { minHeight: { xs: 44, sm: 'auto' } } as const;

const STATUS_COLOR = { active: 'success', paused: 'default', needs_reconnect: 'warning', revoked: 'error' } as const;

function ProviderMark({ provider }: { provider: Connection['provider'] }) {
  if (provider === 'google') return <GoogleIcon aria-label="Google" />;
  if (provider === 'microsoft') return <MicrosoftIcon aria-label="Microsoft" />;
  return <LinkOutlinedIcon aria-label="Other" />;
}

interface RowProps {
  connection: Connection;
  canWrite: boolean;
  busy: boolean;
  onRename: () => void;
  onCapabilities: () => void;
  onDefaults: () => void;
  onTest: () => void;
  onTogglePause: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
}

/** One account: the mark, the label, the email, what it may do, its state and defaults, when it was last used. */
function ConnectionRow({ connection: c, canWrite, busy, onRename, onCapabilities, onDefaults, onTest, onTogglePause, onReconnect, onDisconnect }: RowProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = () => setAnchor(null);
  const pick = (fn: () => void) => () => {
    close();
    fn();
  };
  const reason = reasonWords(c);
  return (
    <ListItem aria-label={`Connection ${c.label}`} divider sx={{ alignItems: 'flex-start', pr: canWrite ? 7 : 2, py: 1.5 }} secondaryAction={canWrite ? <IconButton aria-label={`Actions for ${c.label}`} onClick={(e) => setAnchor(e.currentTarget)} sx={{ minWidth: 44, minHeight: 44 }}><MoreVertIcon /></IconButton> : undefined}>
      <ListItemIcon sx={{ minWidth: 40, mt: 0.5 }}>
        <ProviderMark provider={c.provider} />
      </ListItemIcon>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography component="span" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
            {c.label}
          </Typography>
          <Chip size="small" color={STATUS_COLOR[c.status]} variant={c.status === 'active' ? 'outlined' : 'filled'} label={STATUS_WORDS[c.status]} />
          {c.defaultFor.map((g) => (
            <Chip key={g} size="small" variant="outlined" color="primary" label={`Default for ${GROUP_NAME[g].toLowerCase()}`} />
          ))}
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          {c.accountEmail}
          {c.accountName ? ` · ${c.accountName}` : ''}
        </Typography>
        <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', mt: 0.75 }} aria-label="What it may do">
          {GROUPS.map((g) => {
            const level = levelOf(c.capabilities, g);
            return level ? <Chip key={g.group} size="small" label={`${g.name}: ${level}`} /> : null;
          })}
          {c.capabilities.length === 0 && <Chip size="small" variant="outlined" label="Nothing switched on" />}
        </Stack>
        {reason && (
          <Typography variant="body2" color={c.status === 'needs_reconnect' ? 'warning.main' : 'text.secondary'} sx={{ mt: 0.75 }}>
            {reason}
          </Typography>
        )}
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
          {c.lastUsedAt ? <RelativeTime iso={c.lastUsedAt} prefix="Last used " /> : 'Not used yet'}
        </Typography>
        {c.status === 'needs_reconnect' && canWrite && (
          <Button variant="contained" color="warning" size="small" onClick={onReconnect} disabled={busy} sx={{ mt: 1, ...TOUCH }}>
            Reconnect
          </Button>
        )}
      </Box>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={close}>
        <MenuItem onClick={pick(onRename)}>Rename</MenuItem>
        {c.status !== 'needs_reconnect' && <MenuItem onClick={pick(onCapabilities)}>Change what it can do</MenuItem>}
        {c.status !== 'needs_reconnect' && <MenuItem onClick={pick(onDefaults)}>Make default for…</MenuItem>}
        {c.status === 'active' && <MenuItem onClick={pick(onTest)}>Test</MenuItem>}
        {c.status === 'active' && <MenuItem onClick={pick(onTogglePause)}>Pause</MenuItem>}
        {c.status === 'paused' && <MenuItem onClick={pick(onTogglePause)}>Resume</MenuItem>}
        <MenuItem onClick={pick(onDisconnect)} sx={{ color: 'error.main' }}>
          Disconnect
        </MenuItem>
      </Menu>
    </ListItem>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box component="section" aria-label={title} sx={{ mb: 3 }}>
      <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
        {title}
      </Typography>
      <Paper variant="outlined">
        <List disablePadding>{children}</List>
      </Paper>
    </Box>
  );
}

/**
 * `/settings/connections` (E39.2, #599): the owner's accounts at Google and Microsoft, several per provider, each with a name,
 * what it may do (Mail, Calendar, Documents: read or read and write), its defaults and its state. Writes need `connections:write`.
 * No token or scope string is ever shown: the API returns none.
 */
export function ConnectionsPage() {
  const { api, viewer } = usePlatformHost();
  const confirm = useConfirm();
  const action = useApiAction('Could not change the connection');
  const canWrite = viewer.hasPermission('connections:write');
  const [params, setParams] = useSearchParams();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [providers, setProviders] = useState<ProviderAvailability[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [renaming, setRenaming] = useState<Connection | null>(null);
  const [changing, setChanging] = useState<Connection | null>(null);
  const [defaulting, setDefaulting] = useState<Connection | null>(null);
  const [testing, setTesting] = useState<{ connection: Connection; result: TestResult | null } | null>(null);
  const [banner, setBanner] = useState<{ outcome: string; id: string | null; missing: string[] } | null>(null);
  const { setError } = action;

  const load = useCallback(async () => {
    try {
      const [list, provs] = await Promise.all([listConnections(api), listProviders(api).catch(() => [] as ProviderAvailability[])]);
      setConnections(list);
      setProviders(provs);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not load your connections');
      setConnections([]);
    }
  }, [api, setError]);

  useEffect(() => {
    void load();
  }, [load]);

  // The consent returns here with `?connect=<outcome>`: show it once, then leave the address clean.
  useEffect(() => {
    const outcome = params.get('connect');
    if (!outcome) return;
    setBanner({ outcome, id: params.get('connection'), missing: (params.get('missing') ?? '').split(',').filter(Boolean) });
    const next = new URLSearchParams(params);
    for (const k of ['connect', 'connection', 'missing']) next.delete(k);
    setParams(next, { replace: true });
  }, [params, setParams]);

  const outcome: Outcome | null = useMemo(() => {
    if (!banner) return null;
    const label = connections?.find((c) => c.id === banner.id)?.label ?? null;
    return outcomeBanner(banner.outcome, label, banner.missing);
  }, [banner, connections]);

  const go = (url: string) => window.location.assign(url);

  const reconnect = async (c: Connection) => {
    if (c.provider === 'mcp') return;
    const r = await action.run(`reconnect-${c.id}`, () => authorize(api, { provider: c.provider as Provider, capabilities: c.capabilities.length > 0 ? c.capabilities : ['mail_read'], loginHint: c.accountEmail, returnTo: RETURN_TO }));
    if (r) go(r.authorizeUrl);
  };

  const togglePause = async (c: Connection) => {
    const r = await action.run(`pause-${c.id}`, () => (c.status === 'paused' ? resumeConnection(api, c.id) : pauseConnection(api, c.id)));
    if (r) {
      toast(c.status === 'paused' ? `${c.label} resumed` : `${c.label} paused`);
      await load();
    }
  };

  const runTest = async (c: Connection) => {
    setTesting({ connection: c, result: null });
    const result = await action.run(`test-${c.id}`, () => testConnection(api, c.id), 'The test could not run');
    if (result) setTesting({ connection: c, result });
    else setTesting(null);
  };

  const disconnect = async (c: Connection) => {
    const detail = await action.run(`detail-${c.id}`, () => getConnection(api, c.id), 'Could not load the connection');
    if (!detail) return;
    const used = detail.usedBy;
    const ok = await confirm({
      title: `Disconnect ${c.label}?`,
      body: (
        <>
          <Typography component="span" sx={{ display: 'block' }}>
            Hexactra revokes its access at {c.provider === 'mcp' ? 'the provider' : PROVIDER_NAME[c.provider]} and deletes the saved sign-in. You can connect it again later.
          </Typography>
          {used.length > 0 ? (
            <>
              <Typography component="span" sx={{ display: 'block', mt: 1 }}>
                These use it and will show &ldquo;connection removed&rdquo;:
              </Typography>
              <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
                {used.map((u) => (
                  <li key={`${u.kind}-${u.id}`}>{u.name}</li>
                ))}
              </Box>
            </>
          ) : (
            <Typography component="span" sx={{ display: 'block', mt: 1 }}>
              No task or chat uses it.
            </Typography>
          )}
        </>
      ),
      confirmLabel: 'Disconnect',
      destructive: true,
    });
    if (!ok) return;
    const r = await action.run(`remove-${c.id}`, () => removeConnection(api, c.id));
    if (r) {
      toast(r.revoked ? `${c.label} disconnected` : `${c.label} disconnected. The provider could not be asked: remove the app in your ${c.provider === 'mcp' ? 'provider' : PROVIDER_NAME[c.provider]} account settings.`, r.revoked ? 'success' : 'warning');
      await load();
    }
  };

  const saveRename = async (label: string) => {
    if (!renaming) return;
    const r = await action.run('rename', () => updateConnection(api, renaming.id, { label }));
    if (r) {
      setRenaming(null);
      toast('Renamed');
      await load();
    }
  };

  const saveCapabilities = async (capabilities: Capability[]) => {
    if (!changing) return;
    const r = await action.run('capabilities', () => updateConnection(api, changing.id, { capabilities, returnTo: RETURN_TO }));
    if (!r) return;
    if (r.consent) return go(r.consent.authorizeUrl);
    setChanging(null);
    toast('Saved');
    await load();
  };

  const saveDefaults = async (groups: CapabilityGroup[]) => {
    if (!defaulting) return;
    const r = await action.run('defaults', () => updateConnection(api, defaulting.id, { defaultFor: groups }));
    if (r) {
      setDefaulting(null);
      toast('Saved');
      await load();
    }
  };

  const all = connections ?? [];
  const needsAttention = all.filter((c) => c.status === 'needs_reconnect');
  const byProvider = (p: Connection['provider']) => all.filter((c) => c.provider === p && c.status !== 'needs_reconnect');
  const rowFor = (c: Connection) => (
    <ConnectionRow
      key={c.id}
      connection={c}
      canWrite={canWrite}
      busy={action.busy?.endsWith(c.id) === true}
      onRename={() => setRenaming(c)}
      onCapabilities={() => setChanging(c)}
      onDefaults={() => setDefaulting(c)}
      onTest={() => void runTest(c)}
      onTogglePause={() => void togglePause(c)}
      onReconnect={() => void reconnect(c)}
      onDisconnect={() => void disconnect(c)}
    />
  );

  return (
    <PageContainer width="default">
      <PageHeader
        title="Connections"
        subtitle="Your accounts at Google and Microsoft, so a task or chat can read mail, check a calendar or add a row to a spreadsheet when you tell it to."
        back={{ to: '/settings', label: 'Settings' }}
        primary={{ key: 'connect', label: 'Connect an account', Icon: AddIcon, onClick: () => setConnecting(true), hidden: !canWrite }}
      />
      {outcome && (
        <Alert severity={outcome.severity} onClose={() => setBanner(null)} sx={{ mb: 2 }} role="status">
          {outcome.text}
        </Alert>
      )}
      <ErrorBanner error={action.error} onClose={action.clearError} onRetry={connections && connections.length === 0 ? () => void load() : undefined} />
      {connections === null && <ListSkeleton />}
      {connections !== null && all.length === 0 && (
        <EmptyState
          Icon={LinkOutlinedIcon}
          title="No accounts connected yet"
          body="A connection lets Hexactra use one of your Google or Microsoft accounts for mail, calendar or documents. Nothing uses a connection until a task or a chat is told to, and you choose what each account may do."
          action={canWrite ? { key: 'connect', label: 'Connect an account', Icon: AddIcon, onClick: () => setConnecting(true) } : undefined}
        />
      )}
      {needsAttention.length > 0 && <Section title="Needs reconnecting">{needsAttention.map(rowFor)}</Section>}
      {(['google', 'microsoft'] as const).map((p) => {
        const rows = byProvider(p);
        return rows.length > 0 ? (
          <Section key={p} title={PROVIDER_NAME[p]}>
            {rows.map(rowFor)}
          </Section>
        ) : null;
      })}

      <ConnectDialog open={connecting} providers={providers} api={api} returnTo={RETURN_TO} onClose={() => setConnecting(false)} onError={setError} />
      <RenameDialog connection={renaming} onClose={() => setRenaming(null)} onSave={saveRename} />
      <CapabilitiesDialog connection={changing} onClose={() => setChanging(null)} onSave={saveCapabilities} />
      <DefaultsDialog connection={defaulting} onClose={() => setDefaulting(null)} onSave={saveDefaults} />
      <TestDialog connection={testing?.connection ?? null} result={testing?.result ?? null} onClose={() => setTesting(null)} />
    </PageContainer>
  );
}
