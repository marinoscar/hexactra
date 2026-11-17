import { useCallback, useEffect, useState } from 'react';
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
  List,
  ListItem,
  ListItemText,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import DesktopWindowsOutlined from '@mui/icons-material/DesktopWindowsOutlined';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { Link as RouterLink } from 'react-router-dom';

import type { FleetEnrollment, FleetHost } from '../types/fleet';
import { CardSkeleton, EmptyState, ErrorBanner, PageContainer, PageHeader, formatDateTime, useApiAction, useConfirm, useProfileTimeZone } from '../ui';

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
export function hostModeLabel(h: Pick<FleetHost, 'mode' | 'desktop' | 'onDemand'>): { label: string; hint: string | null } {
  if (h.mode === 'unattended' && !h.desktop) {
    return { label: 'Browser only', hint: 'No desktop to share, so no takeover. For a node with its own desktop, install it with `hexactra agent install --mode unattended`.' };
  }
  return { label: h.mode ? MODE_LABEL[h.mode] : h.onDemand ? 'Launch mode' : 'Attach mode', hint: null };
}

const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function message(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/** `/fleet`: the browser hosts of the fabric and their profiles. */
export function FleetPage() {
  const { api, viewer } = usePlatformHost();
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

  return (
    <PageContainer>
      <PageHeader title="Fleet" primary={{ key: 'enroll', label: 'Enroll host', Icon: AddIcon, onClick: () => setEnrollOpen(true), hidden: !canWrite }} />
      <ErrorBanner error={error} />
      {hosts === null && !error && <CardSkeleton rows={2} />}
      {hosts?.length === 0 && <EmptyState Icon={DesktopWindowsOutlined} title="No host is enrolled yet" />}
      <Stack spacing={2} aria-label="Hosts">
        {hosts?.map((h) => (
          <Card key={h.id} variant="outlined" aria-label={`Host ${h.name}`}>
            <CardContent>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
                <Typography variant="h6" component="h2" sx={{ mr: 1 }}>
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
                <Typography variant="caption" color="text.secondary">
                  v{h.version}
                </Typography>
              </Stack>
              {h.desktop && canDesktop && (
                <Button size="small" component={RouterLink} to={`/fleet/hosts/${h.id}/desktop`} disabled={!h.online}>
                  Open desktop
                </Button>
              )}
              <List dense aria-label={`Profiles on ${h.name}`}>
                {h.profiles.map((p) => (
                  <ListItem
                    key={p.name}
                    secondaryAction={
                      canWrite &&
                      h.onDemand && (
                        <Stack direction="row">
                          <Tooltip title="Restart browser">
                            <IconButton
                              aria-label={`Restart ${p.name} on ${h.name}`}
                              disabled={busy !== null}
                              onClick={() => void act(`${h.id}/${p.name}`, () => api.post(`/fleet/hosts/${h.id}/profiles/${p.name}/restart`, {}))}
                            >
                              <RestartAltIcon />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="Close browser">
                            <span>
                              <IconButton
                                aria-label={`Close ${p.name} on ${h.name}`}
                                disabled={busy !== null || !p.running}
                                onClick={() => void act(`${h.id}/${p.name}`, () => api.post(`/fleet/hosts/${h.id}/profiles/${p.name}/close`, {}))}
                              >
                                <StopCircleOutlinedIcon />
                              </IconButton>
                            </span>
                          </Tooltip>
                          {p.name !== 'default' && (
                            <Tooltip title="Delete profile and its sign-ins">
                              <IconButton
                                aria-label={`Delete ${p.name} on ${h.name}`}
                                disabled={busy !== null}
                                onClick={() => void deleteProfile(h, p.name)}
                              >
                                <DeleteOutlineIcon />
                              </IconButton>
                            </Tooltip>
                          )}
                        </Stack>
                      )
                    }
                  >
                    <ListItemText primary={p.name} secondary={p.running ? 'Browser running' : 'Browser stopped'} />
                  </ListItem>
                ))}
              </List>
              {canWrite && h.onDemand && (
                <Stack direction="row" spacing={1}>
                  <TextField
                    size="small"
                    label="New profile"
                    value={newProfile[h.id] ?? ''}
                    onChange={(e) => setNewProfile({ ...newProfile, [h.id]: e.target.value })}
                    error={Boolean(newProfile[h.id]) && !PROFILE_NAME.test(newProfile[h.id] ?? '')}
                  />
                  <Button
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

      <Dialog
        open={enrollOpen}
        onClose={() => {
          setEnrollOpen(false);
          setEnrollment(null);
          setEnrollName('');
        }}
        fullWidth
      >
        <DialogTitle>Enroll a host</DialogTitle>
        <DialogContent>
          {!enrollment ? (
            <TextField autoFocus margin="dense" label="Host name (optional)" value={enrollName} onChange={(e) => setEnrollName(e.target.value)} fullWidth />
          ) : (
            <Box>
              <Typography gutterBottom>Run this on the new host. The token works once{enrollment.expiresAt ? ` and expires ${formatDateTime(enrollment.expiresAt)}` : ''}.</Typography>
              <Box component="pre" aria-label="Agent command" sx={{ p: 1.5, bgcolor: 'action.hover', borderRadius: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {enrollment.command}
              </Box>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          {!enrollment ? (
            <Button variant="contained" onClick={() => void enroll()}>
              Create token
            </Button>
          ) : (
            <Button onClick={() => void navigator.clipboard?.writeText(enrollment.command)}>Copy</Button>
          )}
        </DialogActions>
      </Dialog>
    </PageContainer>
  );
}
