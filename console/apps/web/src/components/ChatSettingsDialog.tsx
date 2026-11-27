import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, FormHelperText, Stack, Switch, Typography, useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useEffect, useState } from 'react';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { SwitchedOnTools } from '../taskConnections/AccountsSection';
import { useConnections } from '../connections/useConnections';
import { PolicySelect } from '../policies/PolicySelect';
import { usePolicyCatalog } from '../policies/usePolicyCatalog';
import type { Chat, ChatSettings } from '../types/chat';
import { AllowedSitesInput } from './AllowedSitesInput';
import { MachinePicker, useFleetHosts } from './MachinePicker';
import { ProfilePicker } from './ProfilePicker';
import { SuggestMemoriesSwitch } from '../memories/SuggestMemoriesSwitch';
import { UseSavedTasksSwitch } from './UseSavedTasksSwitch';
import { SavedLoginsToggle } from '../secrets/SavedLoginsSwitch';

export interface ChatSettingsDialogProps {
  open: boolean;
  chat: Chat;
  onClose: () => void;
  /** Save the settings (`PATCH /chats/:id`). Rejects with the API's error, which the dialog shows. */
  onSave: (settings: ChatSettings) => Promise<void>;
}

const settingsOf = (chat: Chat): ChatSettings => ({ profile: chat.profile, hostId: chat.hostId, hostFallback: chat.hostFallback, policyId: chat.policyId, allowedDomains: chat.allowedDomains, confirmRiskyActions: chat.confirmRiskyActions, useSavedLogins: chat.useSavedLogins ?? false, useSavedIdentity: chat.useSavedIdentity ?? false, useSavedCards: chat.useSavedCards ?? false, recordVideo: chat.recordVideo ?? false });

/**
 * How the chat's runs execute: the machine, the browser profile, the agent
 * policy, and the two limits a task has (allowed sites, confirmation before a
 * purchase). They apply to the next run the chat starts.
 */
export function ChatSettingsDialog({ open, chat, onClose, onSave }: ChatSettingsDialogProps) {
  const { viewer } = usePlatformHost();
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const hosts = useFleetHosts();
  const catalog = usePolicyCatalog({ withTiers: false });
  const canPickPolicy = viewer.hasPermission('agent_policies:read');
  const accounts = useConnections(open);
  const canReadConnections = viewer.hasPermission('connections:read');
  const [values, setValues] = useState<ChatSettings>(() => settingsOf(chat));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Start from the chat's current settings each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setValues(settingsOf(chat));
    setError(null);
  }, [open, chat]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave({ ...values, profile: values.profile.trim() || 'default' });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the settings');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm" fullScreen={fullScreen} aria-labelledby="chat-settings-title">
      <DialogTitle id="chat-settings-title">Chat settings</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            These apply to the next browser run this chat starts.
          </Typography>
          {error && <Alert severity="error">{error}</Alert>}
          <MachinePicker hosts={hosts} hostId={values.hostId} hostFallback={values.hostFallback} disabled={busy} onChange={(change) => setValues((v) => ({ ...v, ...change }))} />
          <ProfilePicker hosts={viewer.hasPermission('fleet:read') ? hosts : null} hostId={values.hostId} value={values.profile} disabled={busy} onChange={(profile) => setValues((v) => ({ ...v, profile }))} />
          {canPickPolicy && <PolicySelect catalog={catalog} value={values.policyId} disabled={busy} onChange={(policyId) => setValues((v) => ({ ...v, policyId }))} manageLink />}
          <AllowedSitesInput value={values.allowedDomains} disabled={busy} onChange={(allowedDomains) => setValues((v) => ({ ...v, allowedDomains }))} />
          <FormControlLabel
            control={<Switch checked={values.confirmRiskyActions} disabled={busy} onChange={(e) => setValues((v) => ({ ...v, confirmRiskyActions: e.target.checked }))} />}
            label="Ask me before a purchase or another step that is hard to undo"
          />
          {/* The chat's runs record a video (#906): not masked, owner-only. */}
          <Box>
            <FormControlLabel
              control={<Switch checked={values.recordVideo} disabled={busy} onChange={(e) => setValues((v) => ({ ...v, recordVideo: e.target.checked }))} slotProps={{ input: { 'aria-describedby': 'chat-record-help' } }} />}
              label="Record a video of this chat's runs"
            />
            <FormHelperText id="chat-record-help" sx={{ mt: 0 }}>
              Watch each run afterwards on its page. The video is not masked: anything on the page or typed into it is visible. Only you can watch it.
            </FormHelperText>
          </Box>
          {/* Disabled, with the reason, while no provider is connected or a switch is off (E37.4, #593). */}
          <SavedLoginsToggle
            checked={values.useSavedLogins}
            disabled={busy}
            onChange={(useSavedLogins) => setValues((v) => ({ ...v, useSavedLogins, ...(useSavedLogins ? {} : { useSavedIdentity: false, useSavedCards: false }) }))}
            identity={{ checked: values.useSavedIdentity, onChange: (useSavedIdentity) => setValues((v) => ({ ...v, useSavedIdentity })) }}
            cards={{ checked: values.useSavedCards, onChange: (useSavedCards) => setValues((v) => ({ ...v, useSavedCards })) }}
          />
          {canReadConnections && (
            <Stack spacing={1} component="section" aria-label="Tools and accounts">
              <Typography variant="subtitle2" component="h3">
                Tools and accounts
              </Typography>
              {/* Nothing to choose here (E50.17): everything the owner switched on is available to every chat. */}
              <SwitchedOnTools connections={accounts.connections} failed={accounts.failed} />
            </Stack>
          )}
          {/* A setting of the owner, not of this chat (#553): saved as soon as it is switched. */}
          <div>
            <SuggestMemoriesSwitch disabled={busy} />
          </div>
          {/* A setting of the owner too (#1007): saved as soon as it is switched. */}
          <div>
            <UseSavedTasksSwitch disabled={busy} />
          </div>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={busy} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void save()} disabled={busy} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
