import { Alert, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, FormControlLabel, Stack, TextField } from '@mui/material';
import { useEffect, useId, useState, type ReactNode } from 'react';

import { useBreakpoint } from '../ui';
import type { Capability, CapabilityGroup, Connection } from './api';
import { CapabilityPicker } from './CapabilityPicker';
import { CAPABILITY_WORDS, GROUPS, PROVIDER_NAME } from './words';

/** A dialog that is full-screen on a phone, with buttons that stack there. */
function Shell({ open, title, onClose, children, actions, busy }: { open: boolean; title: string; onClose: () => void; children: ReactNode; actions: ReactNode; busy?: boolean }) {
  const { isPhone } = useBreakpoint();
  const id = useId();
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm" fullScreen={isPhone} aria-labelledby={id}>
      <DialogTitle id={id}>{title}</DialogTitle>
      <DialogContent>{children}</DialogContent>
      <DialogActions sx={{ flexDirection: { xs: 'column-reverse', sm: 'row' }, gap: 1, '& > :not(style)': { m: 0 } }}>{actions}</DialogActions>
    </Dialog>
  );
}

const TOUCH = { minHeight: { xs: 44, sm: 'auto' } } as const;

export function RenameDialog({ connection, onClose, onSave }: { connection: Connection | null; onClose: () => void; onSave: (label: string) => Promise<void> }) {
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setLabel(connection?.label ?? ''), [connection]);
  const save = async () => {
    setBusy(true);
    try {
      await onSave(label.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell
      open={connection !== null}
      title="Rename"
      onClose={onClose}
      busy={busy}
      actions={
        <>
          <Button onClick={onClose} disabled={busy} sx={TOUCH}>
            Cancel
          </Button>
          <Button variant="contained" onClick={save} disabled={busy || label.trim().length === 0 || label.trim() === connection?.label} sx={TOUCH}>
            Save
          </Button>
        </>
      }
    >
      <TextField autoFocus fullWidth margin="dense" label="Name" value={label} onChange={(e) => setLabel(e.target.value)} helperText={connection ? `The account is ${connection.accountEmail}.` : undefined} slotProps={{ htmlInput: { maxLength: 60 } }} />
    </Shell>
  );
}

/** "Change what it can do": turning one off is immediate; adding one the provider has not granted asks for a new consent. */
export function CapabilitiesDialog({ connection, onClose, onSave }: { connection: Connection | null; onClose: () => void; onSave: (capabilities: Capability[]) => Promise<void> }) {
  const [value, setValue] = useState<Capability[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => setValue(connection?.capabilities ?? []), [connection]);
  if (!connection) return <Shell open={false} title="" onClose={onClose} actions={null}>{null}</Shell>;
  const provider = connection.provider === 'mcp' ? 'the provider' : PROVIDER_NAME[connection.provider];
  const added = value.filter((c) => !connection.capabilities.includes(c));
  const needConsent = added.filter((c) => !connection.granted.includes(c));
  const removed = connection.capabilities.filter((c) => !value.includes(c));
  const changed = added.length > 0 || removed.length > 0;
  const save = async () => {
    setBusy(true);
    try {
      await onSave(value);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell
      open
      title={`What ${connection.label} can do`}
      onClose={onClose}
      busy={busy}
      actions={
        <>
          <Button onClick={onClose} disabled={busy} sx={TOUCH}>
            Cancel
          </Button>
          <Button variant="contained" onClick={save} disabled={busy || !changed} sx={TOUCH}>
            {needConsent.length > 0 ? `Save and continue to ${provider}` : 'Save'}
          </Button>
        </>
      }
    >
      <Stack spacing={2} sx={{ pt: 1 }}>
        <CapabilityPicker value={value} onChange={setValue} granted={connection.granted} providerName={provider} />
        {removed.length > 0 && (
          <Alert severity="info">
            Turning off {removed.map((c) => CAPABILITY_WORDS[c].toLowerCase()).join(', ')} takes effect now. {provider} keeps the permission until you disconnect the account here, or remove the app in your {provider} account settings.
          </Alert>
        )}
        {needConsent.length > 0 && (
          <Alert severity="warning">
            {provider} will ask you to allow {needConsent.map((c) => CAPABILITY_WORDS[c].toLowerCase()).join(', ')}. The account stays as it is meanwhile; the switch comes on when you allow it.
          </Alert>
        )}
      </Stack>
    </Shell>
  );
}

/** "Make default for…": which areas this account is used for when a task or chat does not say which account. */
export function DefaultsDialog({ connection, onClose, onSave }: { connection: Connection | null; onClose: () => void; onSave: (groups: CapabilityGroup[]) => Promise<void> }) {
  const [value, setValue] = useState<CapabilityGroup[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => setValue(connection?.defaultFor ?? []), [connection]);
  const save = async () => {
    setBusy(true);
    try {
      await onSave(value);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell
      open={connection !== null}
      title={connection ? `Make ${connection.label} the default for…` : ''}
      onClose={onClose}
      busy={busy}
      actions={
        <>
          <Button onClick={onClose} disabled={busy} sx={TOUCH}>
            Cancel
          </Button>
          <Button variant="contained" onClick={save} disabled={busy} sx={TOUCH}>
            Save
          </Button>
        </>
      }
    >
      <DialogContentText sx={{ mb: 1 }}>Used when a task or chat does not say which account. There is one default for each area and provider: choosing it here takes it from the account that had it.</DialogContentText>
      <Stack>
        {GROUPS.map((g) => {
          const on = connection?.capabilities.includes(g.read) === true;
          return (
            <FormControlLabel
              key={g.group}
              sx={TOUCH}
              disabled={!on}
              control={<Checkbox checked={value.includes(g.group)} onChange={(e) => setValue(e.target.checked ? [...value, g.group] : value.filter((x) => x !== g.group))} />}
              label={`${g.name}${on ? '' : ' (switched off for this account)'}`}
            />
          );
        })}
      </Stack>
    </Shell>
  );
}
