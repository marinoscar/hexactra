import { useEffect, useState } from 'react';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, FormHelperText, Link, Stack, Switch, TextField } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { PolicySelect } from '../policies/PolicySelect';
import { usePolicyCatalog } from '../policies/usePolicyCatalog';
import { ErrorBanner, useApiAction, useBreakpoint } from '../ui';
import { MachinePicker, useFleetHosts, type MachineChoice } from './MachinePicker';
import { ProfileSigninWarning } from './ProfileSigninWarning';

/** The longest goal the API takes. */
export const GOAL_MAX = 4000;

export interface NewRunDialogProps {
  open: boolean;
  onClose: () => void;
  /** The run started: its id. */
  onStarted: (runId: string) => void;
}

/**
 * "New run": a one-off goal, its browser profile, the machine and the agent
 * policy. `POST /runs`; the policy is sent only when one is chosen (none
 * follows the user's default). Full-screen on a phone.
 */
export function NewRunDialog({ open, onClose, onStarted }: NewRunDialogProps) {
  const { api, viewer } = usePlatformHost();
  const { isPhone } = useBreakpoint();
  const canPickPolicy = viewer.hasPermission('agent_policies:read');
  const catalog = usePolicyCatalog({ withTiers: false });
  const hosts = useFleetHosts();
  const action = useApiAction('Could not start the run');
  const [goal, setGoal] = useState('');
  const [profile, setProfile] = useState('default');
  const [machine, setMachine] = useState<MachineChoice>({ hostId: null, hostFallback: true });
  const [policyId, setPolicyId] = useState<string | null>(null);
  const [record, setRecord] = useState(false);
  const { clearError } = action;

  useEffect(() => {
    if (open) clearError();
  }, [open, clearError]);

  const trimmed = goal.trim();
  const start = async () => {
    const run = await action.run('start', () =>
      api.post<{ id: string }>('/runs', {
        goal: trimmed,
        profile: profile.trim() || 'default',
        ...(machine.hostId ? { hostId: machine.hostId, hostFallback: machine.hostFallback } : {}),
        ...(canPickPolicy && policyId ? { policyId } : {}),
        ...(record ? { record: true } : {}),
      }),
    );
    if (!run) return;
    setGoal('');
    setRecord(false);
    onStarted(run.id);
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" fullScreen={isPhone} aria-labelledby="new-run-title">
      <DialogTitle id="new-run-title">New run</DialogTitle>
      <DialogContent>
        <Box
          component="form"
          id="new-run-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed) void start();
          }}
        >
          <Stack spacing={2} sx={{ pt: 1 }}>
            <ErrorBanner error={action.error} onClose={action.clearError} />
            <TextField
              label="Goal"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              multiline
              minRows={3}
              maxRows={12}
              required
              autoFocus
              fullWidth
              slotProps={{ htmlInput: { maxLength: GOAL_MAX } }}
              helperText={
                <Box component="span" sx={{ display: 'flex', gap: 1, justifyContent: 'space-between' }}>
                  <span>What the agent should achieve, in plain words.</span>
                  <span style={{ whiteSpace: 'nowrap' }}>
                    {goal.length.toLocaleString('en-US')} / {GOAL_MAX.toLocaleString('en-US')}
                  </span>
                </Box>
              }
            />
            <TextField label="Profile" value={profile} onChange={(e) => setProfile(e.target.value)} helperText="The browser profile (its sign-ins)." />
            <MachinePicker hosts={hosts} hostId={machine.hostId} hostFallback={machine.hostFallback} onChange={(change) => setMachine((m) => ({ ...m, ...change }))} />
            <ProfileSigninWarning hosts={hosts} hostId={machine.hostId} profile={profile.trim() || 'default'} />
            {canPickPolicy && <PolicySelect catalog={catalog} value={policyId} onChange={setPolicyId} manageLink />}
            <Box>
              <FormControlLabel control={<Switch checked={record} onChange={(e) => setRecord(e.target.checked)} slotProps={{ input: { 'aria-describedby': 'new-run-record-help' } }} />} label="Record a video of this run" />
              <FormHelperText id="new-run-record-help" sx={{ mt: 0 }}>
                The video is not masked: anything on the page is visible. Only you can watch it.
              </FormHelperText>
            </Box>
            <Link component={RouterLink} to={`/tasks/new${trimmed ? `?goal=${encodeURIComponent(trimmed)}` : ''}`} variant="body2" onClick={onClose}>
              Save as task instead
            </Link>
          </Stack>
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
          Cancel
        </Button>
        <Button type="submit" form="new-run-form" variant="contained" disabled={!trimmed || action.busy !== null} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
          Start
        </Button>
      </DialogActions>
    </Dialog>
  );
}
