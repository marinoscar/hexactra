import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Chip,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import DesktopWindowsOutlined from '@mui/icons-material/DesktopWindowsOutlined';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { Link as RouterLink } from 'react-router-dom';

/** One host, as `GET /api/fleet/hosts` returns it. */
export interface FleetHost {
  id: string;
  name: string;
  version: string;
  online: boolean;
  browserConnected: boolean;
  onDemand: boolean;
  draining: boolean;
  viewerUrl: string | null;
  mode: 'unattended' | 'attended' | 'container' | null;
  desktop: boolean;
  profiles: { name: string; running: boolean }[];
  lastSeen: string;
}

/** `POST /api/fleet/enrollments`. */
export interface FleetEnrollment {
  enrollmentToken: string;
  expiresAt: string | null;
  command: string;
}


/** How each host mode reads in the list (docs/nodes.md). */
const MODE_LABEL: Record<NonNullable<FleetHost['mode']>, string> = {
  unattended: 'Unattended',
  attended: 'Attended',
  container: 'Container',
};

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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
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
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run a change, then reload; one at a time. */
  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await run();
      await load();
    } catch (e) {
      setError(message(e, 'The change failed'));
    } finally {
      setBusy(null);
    }
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
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Stack direction="row" sx={{ mb: 2, alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="h4" component="h1">
          Fleet
        </Typography>
        {canWrite && (
          <Button variant="contained" onClick={() => setEnrollOpen(true)}>
            Enroll host
          </Button>
        )}
      </Stack>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {hosts?.length === 0 && <Alert severity="info">No host is enrolled yet.</Alert>}
      <Stack spacing={2} aria-label="Hosts">
        {hosts?.map((h) => (
          <Card key={h.id} variant="outlined" aria-label={`Host ${h.name}`}>
            <CardContent>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
                <Typography variant="h6" component="h2" sx={{ mr: 1 }}>
                  {h.name}
                </Typography>
                <Chip size="small" color={h.online ? 'success' : 'default'} label={h.online ? 'Online' : 'Offline'} />
                <Chip size="small" variant="outlined" label={h.mode ? MODE_LABEL[h.mode] : h.onDemand ? 'Launch mode' : 'Attach mode'} />
                {h.desktop && (
                  <Tooltip title="Can share its desktop">
                    <DesktopWindowsOutlined fontSize="small" color="action" aria-label="Desktop available" />
                  </Tooltip>
                )}
                {h.draining && <Chip size="small" color="warning" label="Draining" />}
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
                                onClick={() => {
                                  if (window.confirm(`Delete profile "${p.name}" on ${h.name}? Its cookies and sign-ins are removed.`)) {
                                    void act(`${h.id}/${p.name}`, () => api.delete(`/fleet/hosts/${h.id}/profiles/${p.name}`));
                                  }
                                }}
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
                <Button
                  disabled={busy !== null}
                  onClick={() => void act(h.id, () => api.post(`/fleet/hosts/${h.id}/drain`, { enabled: !h.draining }))}
                >
                  {h.draining ? 'Undrain' : 'Drain'}
                </Button>
                <Button
                  color="error"
                  disabled={busy !== null}
                  onClick={() => {
                    if (window.confirm(`Revoke ${h.name}? Its credential stops working and its sessions end.`)) {
                      void act(h.id, () => api.delete(`/fleet/hosts/${h.id}`));
                    }
                  }}
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
              <Typography gutterBottom>Run this on the new host. The token works once{enrollment.expiresAt ? ` and expires ${new Date(enrollment.expiresAt).toLocaleString()}` : ''}.</Typography>
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
    </Container>
  );
}
