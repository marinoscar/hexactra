import { useCallback, useEffect, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { Alert, Box, Button, Chip, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import RFB from '@novnc/novnc/core/rfb.js';

import type { FleetHost } from './FleetPage';

/** A takeover lease (`/api/fleet/hosts/:id/takeover`). */
interface Lease {
  leaseId: string;
  userId: string;
  displayName: string | null;
  expiresAt: string;
}

/** Renew the lease this often while the page is open. */
export const RENEW_MS = 60_000;

type Status = 'loading' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'offline' | 'unavailable' | 'error';

/** Reconnect delays: 1 s doubling to 30 s, ten tries. */
export const backoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** attempt);
const MAX_TRIES = 10;
/** A connection counts as healthy (and resets the backoff) after this long. */
export const STABLE_MS = 10_000;

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/**
 * A host's remote desktop (#339, docs/nodes.md), from the web app and the
 * Android app. The page opens a viewer session (an HttpOnly cookie scoped to
 * this host's /viewer/ path), then a WebSocket to /viewer/<id>/websockify
 * that nginx checks with the API and relays through the fabric to the node.
 */
export function DesktopPage() {
  const { id = '' } = useParams<{ id: string }>();
  const { api } = usePlatformHost();
  const navigate = useNavigate();
  const screen = useRef<HTMLDivElement | null>(null);
  const rfb = useRef<RFB | null>(null);
  const tries = useRef(0);
  const closing = useRef(false);
  const [host, setHost] = useState<FleetHost | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [lease, setLease] = useState<Lease | null>(null);
  const [heldBy, setHeldBy] = useState<string | null>(null);
  const leaseRef = useRef<Lease | null>(null);
  const [profile, setProfile] = useState('default');
  const [notice, setNotice] = useState<string | null>(null);

  const connect = useCallback(
    (wsPath: string) => {
      if (!screen.current) return;
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const r = new RFB(screen.current, `${scheme}//${window.location.host}${wsPath}`, { shared: true });
      r.scaleViewport = true;
      r.focusOnClick = true;
      // Watching is the default; input needs the takeover lease (the fabric enforces it too).
      r.viewOnly = !leaseRef.current;
      let connectedAt = 0;
      r.addEventListener('connect', () => {
        connectedAt = Date.now();
        setStatus('connected');
      });
      r.addEventListener('disconnect', () => {
        rfb.current = null;
        if (closing.current) return;
        // Only a connection that stayed up resets the backoff; one that drops
        // right after connecting keeps backing off (and stays under the
        // server's reconnect limit).
        if (connectedAt && Date.now() - connectedAt >= STABLE_MS) tries.current = 0;
        if (tries.current >= MAX_TRIES) {
          setStatus('error');
          setError('The desktop connection keeps dropping. Check that the node is online, then reconnect.');
          return;
        }
        setStatus('reconnecting');
        const wait = backoff(tries.current++);
        window.setTimeout(() => {
          if (!closing.current) connect(wsPath);
        }, wait);
      });
      rfb.current = r;
    },
    [],
  );

  const open = useCallback(async () => {
    setError(null);
    setStatus('loading');
    try {
      const h = await api.get<FleetHost>(`/fleet/hosts/${id}`);
      setHost(h);
      if (h.profiles.length && !h.profiles.some((p) => p.name === 'default')) setProfile(h.profiles[0]!.name);
      if (!h.online) return setStatus('offline');
      if (!h.desktop) return setStatus('unavailable');
      const s = await api.post<{ wsPath: string }>(`/fleet/hosts/${id}/viewer-session`, {});
      setStatus('connecting');
      tries.current = 0;
      connect(s.wsPath);
    } catch (e) {
      setStatus('error');
      setError(message(e, 'Could not open the desktop'));
    }
  }, [api, connect, id]);

  useEffect(() => {
    closing.current = false;
    void open();
    void api
      .get<Lease | null>(`/fleet/hosts/${id}/takeover`)
      .then((l) => setHeldBy(l && typeof l === 'object' && l.leaseId ? (l.displayName ?? 'Someone') : null))
      .catch(() => undefined);
    return () => {
      closing.current = true;
      rfb.current?.disconnect();
      const l = leaseRef.current;
      if (l) void api.delete(`/fleet/hosts/${id}/takeover/${l.leaseId}`).catch(() => undefined);
      void api.delete(`/fleet/hosts/${id}/viewer-session`).catch(() => undefined);
    };
  }, [api, id, open]);

  const setControl = (l: Lease | null) => {
    leaseRef.current = l;
    setLease(l);
    if (rfb.current) rfb.current.viewOnly = !l;
  };

  /** Pauses the agent and lets this person use the desktop (#342). */
  const takeOver = async () => {
    setError(null);
    try {
      const l = await api.post<Lease>(`/fleet/hosts/${id}/takeover`, {});
      setControl(l);
      setHeldBy(null);
      rfb.current?.focus();
    } catch (e) {
      setError(message(e, 'Could not take over'));
    }
  };

  const release = async () => {
    const l = leaseRef.current;
    setControl(null);
    if (l) await api.delete(`/fleet/hosts/${id}/takeover/${l.leaseId}`).catch(() => undefined);
  };

  // Keep the lease while the page is open.
  useEffect(() => {
    if (!lease) return;
    const t = window.setInterval(() => {
      const l = leaseRef.current;
      if (!l) return;
      void api
        .post<Lease>(`/fleet/hosts/${id}/takeover/${l.leaseId}/renew`, {})
        .then((n) => {
          leaseRef.current = n;
        })
        .catch(() => setControl(null));
    }, RENEW_MS);
    return () => window.clearInterval(t);
  }, [api, id, lease]);

  const close = async () => {
    await release();
    closing.current = true;
    rfb.current?.disconnect();
    await api.delete(`/fleet/hosts/${id}/viewer-session`).catch(() => undefined);
    navigate('/fleet');
  };

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      rfb.current?.clipboardPasteFrom(text);
    } catch {
      setError('The browser did not allow reading the clipboard.');
    }
  };

  /** Opens the profile's Chrome on this desktop at the Google sign-in (#340). */
  const signIn = async () => {
    setNotice(null);
    try {
      await api.post(`/fleet/hosts/${id}/profiles/${encodeURIComponent(profile)}/show`, {});
      setNotice(`Chrome for "${profile}" is open at the Google sign-in. Sign in, then close that window to save it.`);
    } catch (e) {
      setError(message(e, 'Could not open the profile'));
    }
  };

  const fullscreen = () => void screen.current?.requestFullscreen?.().catch(() => undefined);

  const label: Record<Status, string> = {
    loading: 'Opening…',
    connecting: 'Connecting…',
    connected: 'Connected',
    reconnecting: 'Reconnecting…',
    closed: 'Closed',
    offline: 'Node offline',
    unavailable: 'No desktop',
    error: 'Not connected',
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: 'calc(100dvh - 64px)', p: { xs: 1, sm: 2 }, gap: 1 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        <Typography variant="h6" component="h1" sx={{ mr: 1 }}>
          {host ? `${host.name}: desktop` : 'Desktop'}
        </Typography>
        <Chip size="small" color={status === 'connected' ? 'success' : 'default'} label={label[status]} />
        <Box sx={{ flexGrow: 1 }} />
        {lease ? (
          <Button size="small" variant="contained" color="warning" onClick={() => void release()}>
            Release
          </Button>
        ) : (
          <Button size="small" variant="contained" onClick={() => void takeOver()} disabled={status !== 'connected'}>
            Take over
          </Button>
        )}
        {host && host.mode === 'unattended' && host.profiles.length > 0 && (
          <>
            <TextField select size="small" label="Profile" value={profile} onChange={(e) => setProfile(e.target.value)} sx={{ minWidth: 120 }}>
              {host.profiles.map((p) => (
                <MenuItem key={p.name} value={p.name}>
                  {p.name}
                </MenuItem>
              ))}
            </TextField>
            <Button size="small" onClick={() => void signIn()} disabled={status !== 'connected'}>
              Sign in to profile
            </Button>
          </>
        )}
        <Button size="small" onClick={fullscreen} disabled={status !== 'connected'}>
          Full screen
        </Button>
        <Button size="small" onClick={() => rfb.current?.sendCtrlAltDel()} disabled={status !== 'connected'}>
          Ctrl-Alt-Del
        </Button>
        <Button size="small" onClick={() => void paste()} disabled={status !== 'connected'}>
          Paste clipboard
        </Button>
        <Button size="small" onClick={() => void open()} disabled={status === 'connected' || status === 'loading'}>
          Reconnect
        </Button>
        <Button size="small" color="inherit" onClick={() => void close()}>
          Close
        </Button>
      </Stack>
      {status === 'offline' && host && (
        <Alert severity="warning">
          {host.name} is offline (last seen {new Date(host.lastSeen).toLocaleString()}). On the node, run `hexactra agent status`.
        </Alert>
      )}
      {status === 'unavailable' && host && (
        <Alert severity="info">
          {host.name} does not share a desktop. Attended nodes need an X11 session (not Wayland); see the node guide.
        </Alert>
      )}
      {lease && (
        <Alert severity="warning">
          You are controlling {host?.name ?? 'this node'}; the agent is paused until you release it.
        </Alert>
      )}
      {!lease && heldBy && <Alert severity="info">{heldBy} is controlling this desktop; you are watching.</Alert>}
      {!lease && status === 'connected' && !heldBy && (
        <Typography variant="caption" color="text.secondary">
          You are watching. Take over to use the mouse and keyboard; the agent pauses until you release it.
        </Typography>
      )}
      {notice && <Alert severity="info">{notice}</Alert>}
      {error && <Alert severity="error">{error}</Alert>}
      <Box
        ref={screen}
        aria-label="Remote desktop"
        sx={{ flexGrow: 1, minHeight: 240, bgcolor: '#000', borderRadius: 1, overflow: 'hidden', touchAction: 'none' }}
      />
      <Typography variant="caption" color="text.secondary">
        Everything you do here happens on the node. Opening and closing the desktop is recorded. <RouterLink to="/fleet">Back to Fleet</RouterLink>
      </Typography>
    </Box>
  );
}
