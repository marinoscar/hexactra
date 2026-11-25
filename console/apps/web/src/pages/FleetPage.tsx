import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Chip,
  FormControlLabel,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CheckIcon from '@mui/icons-material/Check';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import LoginIcon from '@mui/icons-material/Login';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import DesktopWindowsOutlined from '@mui/icons-material/DesktopWindowsOutlined';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { Link as RouterLink, useNavigate } from 'react-router-dom';

import { HostSigninChip, ProfileSigninStatus, signinNeededCount } from '../components/fleet/ProfileSigninStatus';
import { needsSignin, type FleetEnrollment, type FleetHost, type FleetProfile } from '../types/fleet';
import { profileInUseRun, signinDesktopPath, startProfileSignin } from '../fleet/signin';
import { fixableCount } from '../fleet/signinQueue';
import { CardSkeleton, EmptyState, ErrorBanner, PageContainer, PageHeader, formatDateTime, useApiAction, useBreakpoint, useConfirm, useProfileTimeZone } from '../ui';

/** How each host mode reads in the list (docs/nodes.md). */
const MODE_LABEL: Record<NonNullable<FleetHost['mode']>, string> = {
  unattended: 'Unattended',
  attended: 'Attended',
  container: 'Container',
};

/**
 * The mode chip, and a hint when it can't do what its mode promises (#412).
 * The user-level agent (`hexactra agent install` without `--mode`) reports
 * itself as unattended because it launches its own browser, but it has no
 * desktop to share: it is a browser-only host, without takeover.
 */
function hostModeLabel(h: Pick<FleetHost, 'mode' | 'desktop' | 'onDemand'>): { label: string; hint: string | null } {
  if (h.mode === 'unattended' && !h.desktop) {
    return { label: 'Browser only', hint: 'No desktop to share, so no takeover. For a node with its own desktop, install it with `hexactra agent install --mode unattended`.' };
  }
  return { label: h.mode ? MODE_LABEL[h.mode] : h.onDemand ? 'Launch mode' : 'Attach mode', hint: null };
}

const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** The rule `PROFILE_NAME` enforces, in words. */
export const PROFILE_NAME_RULE = 'Lowercase letters, digits, "-" and "_"; starts with a letter or digit; 32 characters at most.';
/** How long "Copy" reads "Copied". */
export const COPIED_MS = 2_000;

/** Selects an element's text, so a person can copy it when the Clipboard API is missing. */
function selectText(el: HTMLElement | null) {
  const selection = window.getSelection?.();
  if (!el || !selection) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
}

interface ProfileRowProps {
  host: FleetHost;
  profile: FleetProfile;
  /** The viewer may change profiles on this host (`fleet:write`, an on-demand host). */
  canAct: boolean;
  /** The viewer may open this host's desktop (`fleet:desktop`). */
  canDesktop: boolean;
  disabled: boolean;
  /** "Sign in" on a profile that needs it (E48.3; E48.4 rewires it to the guided sign-in). */
  onSignIn: (profile: FleetProfile) => void;
  onRestart: () => void;
  onClose: () => void;
  onDelete: () => void;
}

/**
 * One profile: its name and browser state in a column that shrinks and wraps
 * (`minWidth: 0`), then its actions in their own column, so the two never
 * overlap. From `sm` up the actions are icon buttons; on a phone they are one
 * "More" menu.
 */
function ProfileRow({ host, profile, canAct, canDesktop, disabled, onSignIn, onRestart, onClose, onDelete }: ProfileRowProps) {
  const { isPhone } = useBreakpoint();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const canDelete = profile.name !== 'default';
  const choose = (action: () => void) => () => {
    setAnchor(null);
    action();
  };
  return (
    <Box component="li" sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.5, minHeight: 48, borderTop: 1, borderColor: 'divider' }}>
      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          {profile.name}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {profile.running ? 'Browser running' : 'Browser stopped'}
        </Typography>
        <ProfileSigninStatus host={host} profile={profile} canDesktop={canDesktop} onSignIn={onSignIn} />
      </Box>
      {canAct && !isPhone && (
        <Stack direction="row" sx={{ flexShrink: 0 }}>
          <Tooltip title="Restart browser">
            <span>
              <IconButton aria-label={`Restart ${profile.name} on ${host.name}`} disabled={disabled} onClick={onRestart}>
                <RestartAltIcon />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Close browser">
            <span>
              <IconButton aria-label={`Close ${profile.name} on ${host.name}`} disabled={disabled || !profile.running} onClick={onClose}>
                <StopCircleOutlinedIcon />
              </IconButton>
            </span>
          </Tooltip>
          {canDelete && (
            <Tooltip title="Delete profile and its sign-ins">
              <span>
                <IconButton aria-label={`Delete ${profile.name} on ${host.name}`} disabled={disabled} onClick={onDelete}>
                  <DeleteOutlineIcon />
                </IconButton>
              </span>
            </Tooltip>
          )}
        </Stack>
      )}
      {canAct && isPhone && (
        <>
          <IconButton
            aria-label={`Actions for ${profile.name} on ${host.name}`}
            aria-haspopup="menu"
            aria-expanded={anchor ? 'true' : undefined}
            disabled={disabled}
            sx={{ flexShrink: 0, width: 44, height: 44 }}
            onClick={(e) => setAnchor(e.currentTarget)}
          >
            <MoreVertIcon />
          </IconButton>
          <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
            <MenuItem sx={{ minHeight: 44 }} onClick={choose(onRestart)}>
              <ListItemIcon>
                <RestartAltIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>Restart browser</ListItemText>
            </MenuItem>
            <MenuItem sx={{ minHeight: 44 }} disabled={!profile.running} onClick={choose(onClose)}>
              <ListItemIcon>
                <StopCircleOutlinedIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>Close browser</ListItemText>
            </MenuItem>
            {canDelete && (
              <MenuItem sx={{ minHeight: 44, color: 'error.main' }} onClick={choose(onDelete)}>
                <ListItemIcon sx={{ color: 'inherit' }}>
                  <DeleteOutlineIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>Delete profile</ListItemText>
              </MenuItem>
            )}
          </Menu>
        </>
      )}
    </Box>
  );
}

function message(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/** `/fleet`: the browser hosts of the fabric and their profiles. */
export function FleetPage() {
  const { api, viewer } = usePlatformHost();
  const navigate = useNavigate();
  const canWrite = viewer.hasPermission('fleet:write');
  const canDesktop = viewer.hasPermission('fleet:desktop');
  const [hosts, setHosts] = useState<FleetHost[] | null>(null);
  const { run, busy, error, setError } = useApiAction();
  const confirm = useConfirm();
  useProfileTimeZone();
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollName, setEnrollName] = useState('');
  const [enrollment, setEnrollment] = useState<FleetEnrollment | null>(null);
  const [newProfile, setNewProfile] = useState<Record<string, string>>({});
  /** The "Needs sign-in" filter: only hosts with a profile that needs sign-in, and only those profiles. */
  const [onlySignin, setOnlySignin] = useState(false);
  const { isPhone } = useBreakpoint();
  const commandRef = useRef<HTMLPreElement | null>(null);
  /** `copied` for 2 s after a copy; `selected` when the Clipboard API is missing and the text was selected instead. */
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'selected'>('idle');
  const copyTimer = useRef<number | null>(null);
  useEffect(() => () => void (copyTimer.current !== null && window.clearTimeout(copyTimer.current)), []);

  const closeEnroll = () => {
    setEnrollOpen(false);
    setEnrollment(null);
    setEnrollName('');
    setCopyState('idle');
  };

  const copyCommand = async () => {
    if (!enrollment) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(enrollment.command);
      setCopyState('copied');
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopyState('idle'), COPIED_MS);
    } catch {
      // No Clipboard API (an insecure origin, an old WebView) or it refused: select the text instead.
      selectText(commandRef.current);
      setCopyState('selected');
    }
  };

  const load = useCallback(async () => {
    try {
      setHosts(await api.get<FleetHost[]>('/fleet/hosts'));
      setError(null);
    } catch (e) {
      setError(message(e, 'Could not load the fleet'));
    }
  }, [api, setError]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run a change, then reload; one at a time. */
  const act = (key: string, change: () => Promise<unknown>) =>
    run(key, async () => {
      await change();
      await load();
    });

  const deleteProfile = async (h: FleetHost, profile: string) => {
    const ok = await confirm({
      title: 'Delete profile',
      body: `Delete profile "${profile}" on ${h.name}? Its cookies and sign-ins are removed.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (ok) await act(`${h.id}/${profile}`, () => api.delete(`/fleet/hosts/${h.id}/profiles/${profile}`));
  };

  const revoke = async (h: FleetHost) => {
    const ok = await confirm({
      title: 'Revoke host',
      body: `Revoke ${h.name}? Its credential stops working and its sessions end.`,
      confirmLabel: 'Revoke',
      destructive: true,
    });
    if (ok) await act(h.id, () => api.delete(`/fleet/hosts/${h.id}`));
  };

  const enroll = async () => {
    try {
      setEnrollment(await api.post<FleetEnrollment>('/fleet/enrollments', enrollName.trim() ? { name: enrollName.trim() } : {}));
    } catch (e) {
      setError(message(e, 'Could not create an enrollment'));
      setEnrollOpen(false);
    }
  };

  /** "Sign in" starts the guided sign-in (E48.4): the console takes over the desktop and opens the profile at Google's sign-in. */
  const openSignin = (h: FleetHost) => async (p: FleetProfile) => {
    setError(null);
    try {
      navigate(signinDesktopPath(await startProfileSignin(api, h.id, p.name)));
    } catch (e) {
      const run = profileInUseRun(e);
      setError(run ? `"${p.name}" is busy with a run (${run.runUrl}). Sign it in when the run ends; a run is never interrupted.` : message(e, 'Could not start the sign-in'));
    }
  };

  const needing = hosts?.reduce((n, h) => n + signinNeededCount(h), 0) ?? 0;
  /** "Fix sign-ins (N)" (E48.6): the profiles this person can sign in from the console, one at a time. */
  const fixable = hosts ? fixableCount(hosts, canDesktop) : 0;
  const shown = onlySignin ? (hosts ?? []).filter((h) => signinNeededCount(h) > 0) : hosts;

  return (
    <PageContainer>
      <PageHeader title="Fleet" primary={{ key: 'enroll', label: 'Enroll host', Icon: AddIcon, onClick: () => setEnrollOpen(true), hidden: !canWrite }} />
      <ErrorBanner error={error} />
      {hosts === null && !error && <CardSkeleton rows={2} />}
      {hosts?.length === 0 && (
        <EmptyState
          Icon={DesktopWindowsOutlined}
          title="No host is enrolled yet"
          body="A host is a machine that runs the browsers your agents use."
          action={{ key: 'connect', label: 'Connect a machine', Icon: AddIcon, onClick: () => setEnrollOpen(true), hidden: !canWrite }}
        />
      )}
      {hosts !== null && hosts.length > 0 && (
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 2 }}>
          <ToggleButton
            size="small"
            value="needs-signin"
            selected={onlySignin}
            onChange={() => setOnlySignin(!onlySignin)}
            sx={{ minHeight: { xs: 44, sm: 'auto' }, px: 1.5, textTransform: 'none' }}
          >
            Needs sign-in ({needing})
          </ToggleButton>
          {fixable > 0 && (
            <Button size="small" variant="contained" component={RouterLink} to="/fleet/signin-queue" startIcon={<LoginIcon />} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
              Fix sign-ins ({fixable})
            </Button>
          )}
        </Stack>
      )}
      {onlySignin && shown?.length === 0 && (
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Every profile is signed in or not yet checked.
        </Typography>
      )}
      <Stack spacing={2} aria-label="Hosts">
        {shown?.map((h) => (
          <Card key={h.id} variant="outlined" aria-label={`Host ${h.name}`}>
            <CardContent>
              <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
                {/* On a phone the name takes its own line and the chips sit under it. */}
                <Typography variant="h6" component="h2" sx={{ mr: 1, width: { xs: '100%', sm: 'auto' }, minWidth: 0, overflowWrap: 'anywhere' }}>
                  {h.name}
                </Typography>
                <Chip size="small" color={h.online ? 'success' : 'default'} label={h.online ? 'Online' : 'Offline'} />
                {(() => {
                  const m = hostModeLabel(h);
                  const chip = <Chip size="small" variant="outlined" label={m.label} />;
                  return m.hint ? <Tooltip title={m.hint}>{chip}</Tooltip> : chip;
                })()}
                {h.desktop && (
                  <Tooltip title="Can share its desktop">
                    <DesktopWindowsOutlined fontSize="small" color="action" aria-label="Desktop available" />
                  </Tooltip>
                )}
                {h.draining && (
                  <Tooltip title="Takes no new runs; runs in progress finish">
                    <Chip size="small" color="warning" label="Disabled" />
                  </Tooltip>
                )}
                <HostSigninChip host={h} />
                <Typography variant="caption" color="text.secondary">
                  v{h.version}
                </Typography>
              </Stack>
              {!h.online && h.profiles.length > 0 && (
                <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
                  Sign-in status as of {formatDateTime(h.lastSeen)}
                </Typography>
              )}
              {h.desktop && canDesktop && (
                <Button size="small" component={RouterLink} to={`/fleet/hosts/${h.id}/desktop`} disabled={!h.online}>
                  Open desktop
                </Button>
              )}
              {/* An offline host keeps its last known status, greyed. */}
              <Box
                component="ul"
                aria-label={`Profiles on ${h.name}`}
                sx={{ listStyle: 'none', p: 0, my: 1, borderBottom: 1, borderColor: 'divider', opacity: h.online ? 1 : 0.6 }}
              >
                {(onlySignin ? h.profiles.filter(needsSignin) : h.profiles).map((p) => (
                  <ProfileRow
                    key={p.name}
                    host={h}
                    profile={p}
                    canAct={canWrite && h.onDemand}
                    canDesktop={canDesktop}
                    disabled={busy !== null}
                    onSignIn={openSignin(h)}
                    onRestart={() => void act(`${h.id}/${p.name}`, () => api.post(`/fleet/hosts/${h.id}/profiles/${p.name}/restart`, {}))}
                    onClose={() => void act(`${h.id}/${p.name}`, () => api.post(`/fleet/hosts/${h.id}/profiles/${p.name}/close`, {}))}
                    onDelete={() => void deleteProfile(h, p.name)}
                  />
                ))}
              </Box>
              {canWrite && h.onDemand && (
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { xs: 'stretch', sm: 'flex-start' }, mt: 2 }}>
                  <TextField
                    size="small"
                    label="New profile"
                    value={newProfile[h.id] ?? ''}
                    onChange={(e) => setNewProfile({ ...newProfile, [h.id]: e.target.value })}
                    error={Boolean(newProfile[h.id]) && !PROFILE_NAME.test(newProfile[h.id] ?? '')}
                    helperText={PROFILE_NAME_RULE}
                    slotProps={{ htmlInput: { 'aria-label': `New profile on ${h.name}`, autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } }}
                    sx={{ flexGrow: 1, maxWidth: { sm: 420 } }}
                  />
                  <Button
                    variant="outlined"
                    sx={{ minHeight: { xs: 44, sm: 40 } }}
                    disabled={busy !== null || !PROFILE_NAME.test(newProfile[h.id] ?? '')}
                    onClick={() =>
                      void act(`${h.id}/new`, async () => {
                        await api.post(`/fleet/hosts/${h.id}/profiles`, { name: newProfile[h.id] });
                        setNewProfile({ ...newProfile, [h.id]: '' });
                      })
                    }
                  >
                    Create
                  </Button>
                </Stack>
              )}
            </CardContent>
            {canWrite && (
              <CardActions>
                <Tooltip title={h.draining ? 'Disabled: takes no new runs' : 'Enabled: takes new runs'}>
                  <FormControlLabel
                    sx={{ ml: 0.5 }}
                    control={
                      <Switch
                        checked={!h.draining}
                        disabled={busy !== null}
                        slotProps={{ input: { 'aria-label': `Enabled: ${h.name}` } }}
                        onChange={() => void act(h.id, () => api.post(`/fleet/hosts/${h.id}/drain`, { enabled: !h.draining }))}
                      />
                    }
                    label="Enabled"
                  />
                </Tooltip>
                <Button
                  color="error"
                  disabled={busy !== null}
                  onClick={() => void revoke(h)}
                >
                  Revoke
                </Button>
              </CardActions>
            )}
          </Card>
        ))}
      </Stack>

      <Dialog open={enrollOpen} onClose={closeEnroll} fullWidth fullScreen={isPhone} aria-labelledby="enroll-title">
        <DialogTitle id="enroll-title">Enroll a host</DialogTitle>
        <DialogContent>
          {!enrollment ? (
            <TextField autoFocus margin="dense" label="Host name (optional)" value={enrollName} onChange={(e) => setEnrollName(e.target.value)} fullWidth />
          ) : (
            <Box>
              <Typography gutterBottom>Run this on the new host. The token works once{enrollment.expiresAt ? ` and expires ${formatDateTime(enrollment.expiresAt)}` : ''}.</Typography>
              <Box
                component="pre"
                ref={commandRef}
                tabIndex={0}
                aria-label="Agent command"
                sx={{
                  m: 0,
                  p: 1.5,
                  bgcolor: 'action.hover',
                  borderRadius: 1,
                  fontFamily: 'monospace',
                  fontSize: '0.875rem',
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  maxHeight: { xs: '50dvh', sm: 240 },
                  overflowY: 'auto',
                  userSelect: 'all',
                }}
              >
                {enrollment.command}
              </Box>
              <Typography variant="body2" color="text.secondary" role="status" sx={{ mt: 1, minHeight: '1.5em' }}>
                {copyState === 'copied' && 'Copied to the clipboard.'}
                {copyState === 'selected' && 'This browser cannot copy for you. The command is selected: copy it from the keyboard or the selection menu.'}
              </Typography>
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          {!enrollment ? (
            <>
              <Button onClick={closeEnroll} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
                Cancel
              </Button>
              <Button variant="contained" onClick={() => void enroll()} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
                Create token
              </Button>
            </>
          ) : (
            <>
              <Button startIcon={copyState === 'copied' ? <CheckIcon /> : <ContentCopyIcon />} onClick={() => void copyCommand()} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
                {copyState === 'copied' ? 'Copied' : 'Copy'}
              </Button>
              <Button variant="contained" onClick={closeEnroll} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
                Done
              </Button>
            </>
          )}
        </DialogActions>
      </Dialog>
    </PageContainer>
  );
}
