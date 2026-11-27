import AddIcon from '@mui/icons-material/Add';
import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined';
import { Alert, Link, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink, useLocation, useSearchParams } from 'react-router-dom';

import { authorize, getConnection, getMcpStatus, listConnections, listProviders, pauseConnection, removeConnection, resumeConnection, updateConnection, type Capability, type CapabilityGroup, type Connection, type Provider, type ProviderAvailability } from '../connections/api';
import { ConnectDialog } from '../connections/ConnectDialog';
import { ConnectionRow } from '../connections/ConnectionRow';
import { ConnectionsSection, SectionEmpty } from '../connections/ConnectionsSection';
import { CapabilitiesDialog, DefaultsDialog, RenameDialog } from '../connections/ConnectionDialogs';
import { DisconnectBody, disconnectedWords } from '../connections/DisconnectBody';
import { McpAddDialog } from '../connections/McpAddDialog';
import { McpAuthDialog } from '../connections/McpAuthDialog';
import { McpToolsDialog } from '../connections/McpToolsDialog';
import { ToolsToReview } from '../connections/ToolsToReview';
import { SECTION_WORDS, outcomeBanner, type Outcome } from '../connections/words';
import { DiagnosticsPanel } from '../diagnostics/DiagnosticsPanel';
import { getDiagnosticSummary, type DiagnosticSummary, type DiagnosticTarget } from '../diagnostics/api';
import { ErrorBanner, ListSkeleton, PageContainer, PageHeader, toast, useApiAction, useConfirm } from '../ui';
import { WebSearchSection } from '../webSearch/WebSearchSection';

const RETURN_TO = '/settings/connections';

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

/** The panel's target for a connection: its name for the title, its capabilities for the expected stages, its host (copied only if ticked). */
const targetOf = (c: Connection): DiagnosticTarget => ({ kind: 'connection', id: c.id, provider: c.provider, capabilities: c.capabilities, name: c.label, host: c.mcp ? hostOf(c.mcp.url) : null });

/**
 * `/settings/connections`, "Connections and tools" (E39.2, #599; E50.14, #984): everything the agent may use, in three sections:
 * Accounts (Google, Microsoft), Added tools (MCP servers) and Web search. What is switched on here is available to the agent in every
 * task and chat (E50.17); each row has one switch, a visible Test (the diagnostics panel) and its health from the last test. Writes need
 * `connections:write`. No token or scope string is ever shown: the API returns none.
 */
export function ConnectionsPage() {
  const { api, viewer } = usePlatformHost();
  const confirm = useConfirm();
  const action = useApiAction('Could not change the connection');
  const canWrite = viewer.hasPermission('connections:write');
  const canAdmin = viewer.hasPermission('system_settings:read');
  const [params, setParams] = useSearchParams();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [health, setHealth] = useState<Record<string, DiagnosticSummary>>({});
  const [providers, setProviders] = useState<ProviderAvailability[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [addingMcp, setAddingMcp] = useState(false);
  const [toolsOf, setToolsOf] = useState<Connection | null>(null);
  const [signingIn, setSigningIn] = useState<Connection | null>(null);
  const [renaming, setRenaming] = useState<Connection | null>(null);
  const [changing, setChanging] = useState<Connection | null>(null);
  const [defaulting, setDefaulting] = useState<Connection | null>(null);
  const [testing, setTesting] = useState<Connection | null>(null);
  const [banner, setBanner] = useState<{ outcome: string; id: string | null; missing: string[] } | null>(null);
  const { setError } = action;

  const loadHealth = useCallback(async () => {
    const list = await getDiagnosticSummary(api).catch(() => [] as DiagnosticSummary[]);
    setHealth(Object.fromEntries(list.map((s) => [s.targetId, s])));
  }, [api]);

  const load = useCallback(async () => {
    try {
      const [list, provs, mcp] = await Promise.all([listConnections(api), listProviders(api).catch(() => [] as ProviderAvailability[]), getMcpStatus(api).catch(() => ({ enabled: false, restricted: false })), loadHealth()]);
      setConnections(list);
      setProviders(provs);
      setMcpEnabled(mcp.enabled);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not load your connections');
      setConnections([]);
    }
  }, [api, setError, loadHealth]);

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

  // An MCP server that signed in with OAuth comes back with every tool off: the owner reviews them straight away.
  const reviewed = useRef<string | null>(null);
  useEffect(() => {
    if (banner?.outcome !== 'connected' || !banner.id || reviewed.current === banner.id) return;
    const c = connections?.find((x) => x.id === banner.id);
    if (c?.mcp && c.mcp.tools.total > 0) {
      reviewed.current = banner.id;
      setToolsOf(c);
    }
  }, [banner, connections]);

  // `#web-search` (the old Web search address lands here): scroll to the section once the page has its sections.
  const { hash } = useLocation();
  const loaded = connections !== null;
  useEffect(() => {
    if (loaded && hash) document.getElementById(hash.slice(1))?.scrollIntoView?.({ block: 'start' });
  }, [loaded, hash]);

  const go = (url: string) => window.location.assign(url);

  const reconnect = async (c: Connection) => {
    if (c.provider === 'mcp') return setSigningIn(c);
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

  const disconnect = async (c: Connection) => {
    const detail = await action.run(`detail-${c.id}`, () => getConnection(api, c.id), 'Could not load the connection');
    if (!detail) return;
    const ok = await confirm({ title: `Disconnect ${c.label}?`, body: <DisconnectBody connection={c} usedBy={detail.usedBy} />, confirmLabel: 'Disconnect', destructive: true });
    if (!ok) return;
    const r = await action.run(`remove-${c.id}`, () => removeConnection(api, c.id));
    if (r) {
      toast(disconnectedWords(c, r.revoked), r.revoked ? 'success' : 'warning');
      await load();
    }
  };

  const save = async (key: string, fn: () => Promise<unknown>, done: () => void) => {
    const r = await action.run(key, fn);
    if (!r) return;
    done();
    toast('Saved');
    await load();
  };
  const saveRename = (label: string) => (renaming ? save('rename', () => updateConnection(api, renaming.id, { label }), () => setRenaming(null)) : Promise.resolve());
  const saveDefaults = (groups: CapabilityGroup[]) => (defaulting ? save('defaults', () => updateConnection(api, defaulting.id, { defaultFor: groups }), () => setDefaulting(null)) : Promise.resolve());
  const saveCapabilities = async (capabilities: Capability[]) => {
    if (!changing) return;
    const r = await action.run('capabilities', () => updateConnection(api, changing.id, { capabilities, returnTo: RETURN_TO }));
    if (!r) return;
    if (r.consent) return go(r.consent.authorizeUrl);
    setChanging(null);
    toast('Saved');
    await load();
  };

  const all = connections ?? [];
  const needsAttention = all.filter((c) => c.status === 'needs_reconnect');
  const accounts = all.filter((c) => c.provider !== 'mcp' && c.status !== 'needs_reconnect');
  const servers = all.filter((c) => c.provider === 'mcp' && c.status !== 'needs_reconnect');
  const rowFor = (c: Connection) => (
    <ConnectionRow
      key={c.id}
      connection={c}
      health={health[c.id] ?? null}
      canWrite={canWrite}
      canReadRuns={viewer.hasPermission('runs:read')}
      busy={action.busy?.endsWith(c.id) === true}
      onRename={() => setRenaming(c)}
      onCapabilities={() => setChanging(c)}
      onDefaults={() => setDefaulting(c)}
      onTest={() => setTesting(c)}
      onTogglePause={() => void togglePause(c)}
      onReconnect={() => void reconnect(c)}
      onDisconnect={() => void disconnect(c)}
      onTools={() => setToolsOf(c)}
      onSignIn={() => setSigningIn(c)}
    />
  );

  return (
    <PageContainer width="default">
      <PageHeader title="Connections and tools" subtitle="Everything the agent may use for you: your accounts, the tools you added and web search." back={{ to: '/settings', label: 'Settings' }} />
      {outcome && (
        <Alert severity={outcome.severity} onClose={() => setBanner(null)} sx={{ mb: 2 }} role="status">
          {outcome.text}
        </Alert>
      )}
      <ErrorBanner error={action.error} onClose={action.clearError} onRetry={connections && connections.length === 0 ? () => void load() : undefined} />
      {/* The one rule (E50.17): each row's switch is the only place a tool is turned on or off. */}
      <Typography variant="body2" sx={{ mb: 2 }} data-testid="connections-rule">
        What is switched on here is available to the agent in every task and chat. Sending or changing something still asks you first.
      </Typography>
      {connections === null && <ListSkeleton />}
      {connections !== null && (
        <>
          {needsAttention.length > 0 && (
            <ConnectionsSection title="Needs reconnecting" explanation="These no longer work. Connect them again, or remove them.">
              {needsAttention.map(rowFor)}
            </ConnectionsSection>
          )}
          <ConnectionsSection
            title="Accounts"
            explanation={SECTION_WORDS.accounts}
            action={canWrite ? { label: 'Connect an account', Icon: AddIcon, onClick: () => setConnecting(true) } : null}
            empty={<SectionEmpty title="No accounts connected yet" body={SECTION_WORDS.accountsEmpty} />}
          >
            {accounts.map(rowFor)}
          </ConnectionsSection>
          <ToolsToReview servers={servers} onReview={setToolsOf} />
          <ConnectionsSection
            title="Added tools"
            aside="MCP servers"
            explanation={SECTION_WORDS.tools}
            action={canWrite && mcpEnabled ? { label: 'Add a tool', Icon: ExtensionOutlinedIcon, onClick: () => setAddingMcp(true) } : null}
            empty={
              mcpEnabled ? (
                <SectionEmpty title="No tools added yet" body={SECTION_WORDS.toolsEmpty} />
              ) : (
                <SectionEmpty
                  title="Added tools are switched off here"
                  body={
                    <>
                      {SECTION_WORDS.toolsOff}{' '}
                      {canAdmin && (
                        <Link component={RouterLink} to="/admin/settings/connections">
                          Open the administrator&apos;s Connections settings
                        </Link>
                      )}
                    </>
                  }
                />
              )
            }
          >
            {servers.map(rowFor)}
          </ConnectionsSection>
          {viewer.hasPermission('web_search:read') && <ConnectionsSection id="web-search" title="Web search" explanation={SECTION_WORDS.webSearch} body={<WebSearchSection />} />}
        </>
      )}

      <ConnectDialog open={connecting} providers={providers} hasGoogle={all.some((c) => c.provider === 'google')} api={api} returnTo={RETURN_TO} onClose={() => setConnecting(false)} onError={setError} />
      <McpAddDialog open={addingMcp} api={api} returnTo={RETURN_TO} onClose={() => setAddingMcp(false)} onAdded={() => void load()} />
      <McpToolsDialog open={toolsOf !== null} api={api} connection={toolsOf} canWrite={canWrite} onClose={() => setToolsOf(null)} onChanged={() => void load()} />
      <McpAuthDialog
        connection={signingIn}
        api={api}
        returnTo={RETURN_TO}
        onClose={() => setSigningIn(null)}
        onDone={() => {
          setSigningIn(null);
          toast('Signed in again');
          void load();
        }}
      />
      <RenameDialog connection={renaming} onClose={() => setRenaming(null)} onSave={saveRename} />
      <CapabilitiesDialog connection={changing} onClose={() => setChanging(null)} onSave={saveCapabilities} />
      <DefaultsDialog connection={defaulting} onClose={() => setDefaulting(null)} onSave={saveDefaults} />
      <DiagnosticsPanel
        target={testing ? targetOf(testing) : null}
        onClose={() => setTesting(null)}
        onReport={() => void loadHealth()}
        actions={{
          provider: testing?.provider,
          canAdmin,
          adminHref: '/admin/settings/connections',
          onReconnect: testing
            ? () => {
                const c = testing;
                setTesting(null);
                void reconnect(c);
              }
            : undefined,
          onReviewTools: testing?.mcp
            ? () => {
                const c = testing;
                setTesting(null);
                setToolsOf(c);
              }
            : undefined,
        }}
      />
    </PageContainer>
  );
}
