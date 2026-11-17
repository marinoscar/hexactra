import { useCallback, useEffect, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { Alert, Box, Button, Chip, Divider, IconButton, ListItemIcon, ListItemText, ListSubheader, Menu, MenuItem, Stack, TextField, Tooltip, Typography, useMediaQuery } from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AspectRatioIcon from '@mui/icons-material/AspectRatio';
import ContentPasteIcon from '@mui/icons-material/ContentPaste';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import KeyboardCommandKeyIcon from '@mui/icons-material/KeyboardCommandKey';
import LoginIcon from '@mui/icons-material/Login';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import PanToolOutlinedIcon from '@mui/icons-material/PanToolOutlined';
import ReplayIcon from '@mui/icons-material/Replay';
import BackHandOutlinedIcon from '@mui/icons-material/BackHandOutlined';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useShellMainVariant } from '@marinoscar/platform-web/shell/headless';
import RFB from '@novnc/novnc/core/rfb.js';
import type { ElementType, ReactNode } from 'react';

import { KEYBOARD_SENTINEL, SPECIAL_KEYSYMS, diffKeysyms } from '../components/remoteKeyboard';
import type { FleetHost } from '../types/fleet';
import { BOTTOM_BAR_HEIGHT, formatDateTime, useBreakpoint } from '../ui';

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

/** The remote screen scaled to the viewer (`fit`) or at its own pixel size (`actual`). */
export type ViewerScale = 'fit' | 'actual';

/**
 * Applies the scale to a noVNC client. At actual size the canvas is clipped to
 * the viewer and a drag moves the visible part (noVNC's own viewport drag), so
 * the viewer pans inside itself and the page never scrolls; a tap or click
 * without a drag still reaches the remote.
 */
export function applyScale(r: Pick<RFB, 'scaleViewport' | 'clipViewport' | 'dragViewport'>, scale: ViewerScale): void {
  const fit = scale === 'fit';
  r.scaleViewport = fit;
  r.clipViewport = !fit;
  r.dragViewport = !fit;
}

/**
 * How much of the window's bottom the on-screen keyboard covers, in CSS pixels
 * (0 without the Visual Viewport API or with no keyboard). Browsers that
 * overlay the keyboard keep the layout height, so the viewer shrinks itself.
 */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)));
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, []);
  return inset;
}

interface ToolButtonProps {
  label: string;
  Icon: ElementType;
  /** An icon button (label in `aria-label` and a tooltip) instead of a text button. */
  compact: boolean;
  onClick: () => void;
  disabled?: boolean;
  variant?: 'text' | 'contained';
  color?: 'primary' | 'warning' | 'inherit';
  pressed?: boolean;
}

/** One toolbar action: a text button on a desktop, a 44 px icon button below `md`. */
function ToolButton({ label, Icon, compact, onClick, disabled, variant = 'text', color = 'primary', pressed }: ToolButtonProps) {
  if (!compact) {
    return (
      <Button size="small" variant={variant} color={color} startIcon={<Icon />} onClick={onClick} disabled={disabled} aria-pressed={pressed}>
        {label}
      </Button>
    );
  }
  const filled = variant === 'contained' && !disabled;
  return (
    <Tooltip title={label}>
      <span>
        <IconButton
          aria-label={label}
          aria-pressed={pressed}
          color={color}
          onClick={onClick}
          disabled={disabled}
          sx={{
            width: 44,
            height: 44,
            ...(filled ? { bgcolor: `${color}.main`, color: `${color}.contrastText`, '&:hover': { bgcolor: `${color}.dark` } } : {}),
            ...(pressed ? { bgcolor: 'action.selected' } : {}),
          }}
        >
          <Icon />
        </IconButton>
      </span>
    </Tooltip>
  );
}

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
  // The viewer fills <main>: no padding around it, and the shell (the one owner of the window's height) sizes it.
  useShellMainVariant('full-bleed');
  const { isPhone, isDesktop } = useBreakpoint();
  const compact = !isDesktop;
  const portrait = useMediaQuery('(orientation: portrait)');
  const keyboardInset = useKeyboardInset();
  const root = useRef<HTMLDivElement | null>(null);
  const keyboard = useRef<HTMLInputElement | null>(null);
  const [scale, setScale] = useState<ViewerScale>('fit');
  const scaleRef = useRef<ViewerScale>('fit');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [more, setMore] = useState<HTMLElement | null>(null);
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
      applyScale(r, scaleRef.current);
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
  const signIn = async (name: string = profile) => {
    setNotice(null);
    try {
      await api.post(`/fleet/hosts/${id}/profiles/${encodeURIComponent(name)}/show`, {});
      setNotice(`Chrome for "${name}" is open at the Google sign-in. Sign in, then close that window to save it.`);
    } catch (e) {
      setError(message(e, 'Could not open the profile'));
    }
  };

  /** Fit the remote screen to the viewer, or show it at its own size. */
  const toggleScale = () => {
    const next: ViewerScale = scale === 'fit' ? 'actual' : 'fit';
    scaleRef.current = next;
    setScale(next);
    if (rfb.current) applyScale(rfb.current, next);
  };

  // Full screen covers the toolbar too, so the keyboard and Release stay reachable. Not every browser has it (iPhone Safari).
  const canFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled === true && typeof document.documentElement.requestFullscreen === 'function';
  useEffect(() => {
    const changed = () => setIsFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
    else void root.current?.requestFullscreen?.().catch(() => undefined);
  };

  /** Opens the on-screen keyboard: its keys go to the remote through the hidden field. */
  const openKeyboard = () => {
    const field = keyboard.current;
    if (!field) return;
    field.value = KEYBOARD_SENTINEL;
    field.dataset.sent = KEYBOARD_SENTINEL;
    field.focus({ preventScroll: true });
  };
  const sendKeysyms = (keysyms: number[]) => {
    for (const keysym of keysyms) rfb.current?.sendKey(keysym, null);
  };

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

  const connected = status === 'connected';
  const signInProfiles = host && host.mode === 'unattended' ? host.profiles : [];
  // The on-screen keyboard covers the bottom of the window (and the phone's bottom bar with it): the viewer ends above it.
  const keyboardPad = Math.max(0, keyboardInset - (isPhone ? BOTTOM_BAR_HEIGHT : 0));
  const menuItem = (key: string, text: string, Icon: ElementType, onClick: () => void, disabled: boolean): ReactNode => (
    <MenuItem
      key={key}
      sx={{ minHeight: 44 }}
      disabled={disabled}
      onClick={() => {
        setMore(null);
        onClick();
      }}
    >
      <ListItemIcon>
        <Icon fontSize="small" />
      </ListItemIcon>
      <ListItemText>{text}</ListItemText>
    </MenuItem>
  );

  return (
    <Box
      ref={root}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        // Fills <main> and never grows it: the shell's height is the window's (`100dvh`, with its `100vh` fallback), so a
        // mobile browser's collapsing toolbars and a rotation resize the viewer and the page itself never scrolls.
        flex: '1 1 0',
        minHeight: 0,
        minWidth: 0,
        overflow: 'hidden',
        // <main> keeps 24 px of padding under a full-bleed page; the viewer takes it back.
        mb: -3,
        pb: `${keyboardPad}px`,
        px: { xs: 1, sm: 2 },
        pt: 1,
        gap: 1,
        bgcolor: 'background.default',
      }}
    >
      <Stack direction="row" role="toolbar" aria-label="Desktop controls" sx={{ alignItems: 'center', flexWrap: 'wrap', columnGap: 1, rowGap: 0.5 }}>
        {/* The page's title row: on a phone it takes the full width and the buttons form one row under it. */}
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0, flexGrow: 1, flexBasis: { xs: '100%', sm: 'auto' } }}>
          {compact && (
            <Tooltip title="Close">
              <IconButton aria-label="Close" onClick={() => void close()} sx={{ width: 44, height: 44, ml: -1 }}>
                <ArrowBackIcon />
              </IconButton>
            </Tooltip>
          )}
          <Typography variant="h6" component="h1" noWrap sx={{ minWidth: 0, fontSize: { xs: '1rem', sm: '1.25rem' } }}>
            {host ? `${host.name}: desktop` : 'Desktop'}
          </Typography>
          <Chip size="small" color={connected ? 'success' : 'default'} label={label[status]} sx={{ flexShrink: 0 }} />
        </Stack>
        <Stack direction="row" sx={{ alignItems: 'center', flexWrap: compact ? 'nowrap' : 'wrap', columnGap: compact ? 0.5 : 1, rowGap: 0.5 }}>
          {lease ? (
            <ToolButton compact={compact} label="Release" Icon={BackHandOutlinedIcon} variant="contained" color="warning" onClick={() => void release()} />
          ) : (
            <ToolButton compact={compact} label="Take over" Icon={PanToolOutlinedIcon} variant="contained" onClick={() => void takeOver()} disabled={!connected} />
          )}
          <ToolButton
            compact={compact}
            label={scale === 'fit' ? 'Actual size' : 'Fit to window'}
            Icon={scale === 'fit' ? AspectRatioIcon : FitScreenIcon}
            onClick={toggleScale}
            disabled={!connected}
          />
          <ToolButton compact={compact} label="Keyboard" Icon={KeyboardIcon} onClick={openKeyboard} disabled={!connected || !lease} />
          <ToolButton compact={compact} label="Ctrl-Alt-Del" Icon={KeyboardCommandKeyIcon} onClick={() => rfb.current?.sendCtrlAltDel()} disabled={!connected} />
          {canFullscreen && (
            <ToolButton
              compact={compact}
              label={isFullscreen ? 'Exit full screen' : 'Full screen'}
              Icon={isFullscreen ? FullscreenExitIcon : FullscreenIcon}
              onClick={fullscreen}
              disabled={!connected}
              pressed={isFullscreen}
            />
          )}
          {!compact && signInProfiles.length > 0 && (
            <>
              <TextField select size="small" label="Profile" value={profile} onChange={(e) => setProfile(e.target.value)} sx={{ minWidth: 120 }}>
                {signInProfiles.map((p) => (
                  <MenuItem key={p.name} value={p.name}>
                    {p.name}
                  </MenuItem>
                ))}
              </TextField>
              <ToolButton compact={false} label="Sign in to profile" Icon={LoginIcon} onClick={() => void signIn()} disabled={!connected} />
            </>
          )}
          {!compact && (
            <>
              <ToolButton compact={false} label="Paste clipboard" Icon={ContentPasteIcon} onClick={() => void paste()} disabled={!connected} />
              <ToolButton compact={false} label="Reconnect" Icon={ReplayIcon} onClick={() => void open()} disabled={connected || status === 'loading'} />
              <Button size="small" color="inherit" onClick={() => void close()}>
                Close
              </Button>
            </>
          )}
          {compact && (
            <>
              <Tooltip title="More">
                <IconButton aria-label="More" aria-haspopup="menu" aria-expanded={more ? 'true' : undefined} onClick={(e) => setMore(e.currentTarget)} sx={{ width: 44, height: 44 }}>
                  <MoreVertIcon />
                </IconButton>
              </Tooltip>
              {/* Inside the page's root, so the menu also shows in full screen. */}
              <Menu anchorEl={more} open={Boolean(more)} onClose={() => setMore(null)} container={() => root.current}>
                {menuItem('paste', 'Paste clipboard', ContentPasteIcon, () => void paste(), !connected)}
                {menuItem('reconnect', 'Reconnect', ReplayIcon, () => void open(), connected || status === 'loading')}
                {signInProfiles.length > 0 && <Divider />}
                {signInProfiles.length > 0 && <ListSubheader sx={{ lineHeight: '32px' }}>Sign in to profile</ListSubheader>}
                {signInProfiles.map((p) => menuItem(`profile-${p.name}`, p.name, LoginIcon, () => void signIn(p.name), !connected))}
              </Menu>
            </>
          )}
        </Stack>
      </Stack>
      {status === 'offline' && host && (
        <Alert severity="warning">
          {host.name} is offline (last seen {formatDateTime(host.lastSeen)}). On the node, run `hexactra agent status`.
        </Alert>
      )}
      {status === 'unavailable' && host && (
        <Alert severity="info">
          {host.name} does not share a desktop. Attended nodes need an X11 session (not Wayland); see the node guide.
        </Alert>
      )}
      {lease && (
        <Alert severity="warning" sx={{ py: 0 }}>
          You are controlling {host?.name ?? 'this node'}; the agent is paused until you release it.
        </Alert>
      )}
      {!lease && heldBy && <Alert severity="info" sx={{ py: 0 }}>{heldBy} is controlling this desktop; you are watching.</Alert>}
      {!lease && connected && !heldBy && (
        <Typography variant="caption" color="text.secondary">
          You are watching. Take over to use the mouse and keyboard; the agent pauses until you release it.
        </Typography>
      )}
      {connected && scale === 'actual' && (
        <Typography variant="caption" color="text.secondary">
          Actual size: drag to move around the screen. Switch to Fit to drag on the remote.
        </Typography>
      )}
      {connected && isPhone && portrait && (
        <Typography variant="caption" color="text.secondary" data-testid="rotate-hint">
          Rotate for a larger view.
        </Typography>
      )}
      {notice && <Alert severity="info">{notice}</Alert>}
      {error && <Alert severity="error">{error}</Alert>}
      <Box sx={{ position: 'relative', flex: '1 1 0', minHeight: 120, minWidth: 0 }}>
        {/* The remote screen is always dark, whatever the theme: noVNC paints its own backdrop the same. */}
        <Box
          ref={screen}
          aria-label="Remote desktop"
          sx={{ position: 'absolute', inset: 0, bgcolor: 'common.black', borderRadius: 1, overflow: 'hidden', touchAction: 'none' }}
        />
        {/* What the on-screen keyboard types into. 16 px so a phone does not zoom on focus; invisible, never in the way. */}
        <Box
          component="input"
          ref={keyboard}
          aria-label="Keyboard input for the remote desktop"
          tabIndex={-1}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          defaultValue={KEYBOARD_SENTINEL}
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
            const keysym = SPECIAL_KEYSYMS[e.key];
            if (keysym === undefined) return;
            e.preventDefault();
            sendKeysyms([keysym]);
          }}
          onInput={(e: React.FormEvent<HTMLInputElement>) => {
            const field = e.currentTarget;
            sendKeysyms(diffKeysyms(field.dataset.sent ?? KEYBOARD_SENTINEL, field.value));
            // While a word is being composed the keyboard owns the text; afterwards the field goes back to its filler.
            if ((e.nativeEvent as InputEvent).isComposing) field.dataset.sent = field.value;
            else {
              field.value = KEYBOARD_SENTINEL;
              field.dataset.sent = KEYBOARD_SENTINEL;
            }
          }}
          sx={{ position: 'absolute', top: 0, left: 0, width: 1, height: 1, p: 0, border: 0, opacity: 0, fontSize: 16, pointerEvents: 'none' }}
        />
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ pb: 1 }}>
        Everything you do here happens on the node. Opening and closing the desktop is recorded. <RouterLink to="/fleet">Back to Fleet</RouterLink>
      </Typography>
    </Box>
  );
}
