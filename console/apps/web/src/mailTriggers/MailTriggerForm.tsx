// The form of an email trigger (E39.8, #605): which account, who it must come from (required), what else to look for, how the
// task's parameters take values from the message, what to do with the message afterwards, and the daily cap.
import { Alert, Box, FormControlLabel, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material';

import type { Connection } from '../connections/api';
import type { TaskParameter } from '@app/shared/task-params';
import { MAPPING_LABEL, POLL_CHOICES, type MappingDraft, type MappingKind, type TriggerDraft } from './model';

export interface MailTriggerFormProps {
  draft: TriggerDraft;
  onChange: (next: TriggerDraft) => void;
  /** Accounts that can be watched: the owner's, with reading mail switched on. */
  connections: readonly Connection[];
  parameters: readonly TaskParameter[];
  /** Messages by field (`from`, `connectionId`, `mapping:<key>`…): the form's own checks and the server's. */
  errors: Record<string, string>;
  disabled?: boolean;
}

const KINDS: MappingKind[] = ['none', 'fixed', 'subject', 'from', 'date', 'capture_subject', 'capture_text'];
const tap = { '& .MuiInputBase-root': { minHeight: { xs: 48, sm: 'auto' } } } as const;

export function MailTriggerForm({ draft, onChange, connections, parameters, errors, disabled }: MailTriggerFormProps) {
  const set = (change: Partial<TriggerDraft>) => onChange({ ...draft, ...change });
  const connection = connections.find((c) => c.id === draft.connectionId);
  const canModify = Boolean(connection?.capabilities.includes('mail_modify'));
  const setMapping = (key: string, m: MappingDraft) => set({ mappings: { ...draft.mappings, [key]: m } });
  // A sensitive parameter is asked for in the console when the run starts: it never takes a value from an email.
  const mappable = parameters.filter((p) => !p.sensitive);

  return (
    <Stack spacing={2.5} sx={{ pt: 1 }}>
      {connections.length === 0 && <Alert severity="info">No connected account can read mail yet. Connect one in Settings → Connections and switch on reading mail.</Alert>}

      <TextField
        select
        label="Account to watch"
        value={draft.connectionId}
        onChange={(e) => set({ connectionId: e.target.value })}
        error={Boolean(errors.connectionId)}
        helperText={errors.connectionId ?? 'The mailbox this trigger reads.'}
        disabled={disabled}
        required
        sx={tap}
      >
        {connections.map((c) => (
          <MenuItem key={c.id} value={c.id}>
            {c.label} ({c.accountEmail})
          </MenuItem>
        ))}
      </TextField>

      <TextField
        label="From (required)"
        value={draft.from}
        onChange={(e) => set({ from: e.target.value })}
        error={Boolean(errors.from)}
        helperText={errors.from ?? 'An exact address, or one domain written @example.test. Several are fine, one per line. Only mail from them can start the task.'}
        disabled={disabled}
        required
        multiline
        minRows={2}
        slotProps={{ htmlInput: { 'aria-label': 'From', autoCapitalize: 'none', spellCheck: false } }}
      />

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField label="Subject contains" value={draft.subjectContains} onChange={(e) => set({ subjectContains: e.target.value })} disabled={disabled} fullWidth sx={tap} />
        <TextField label="Text contains" value={draft.textContains} onChange={(e) => set({ textContains: e.target.value })} disabled={disabled} fullWidth sx={tap} />
      </Stack>

      <TextField select label="Attachment" value={draft.attachment} onChange={(e) => set({ attachment: e.target.value as TriggerDraft['attachment'] })} disabled={disabled} sx={tap}>
        <MenuItem value="any">Either way</MenuItem>
        <MenuItem value="with">Has an attachment</MenuItem>
        <MenuItem value="without">Has no attachment</MenuItem>
      </TextField>

      {mappable.length > 0 && (
        <Box component="fieldset" sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}>
          <Typography component="legend" variant="subtitle2" sx={{ mb: 0.5 }}>
            Fill the task's details from the email
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            Values are data only. They cannot change the allowed sites, the confirmations or who anything is sent to. A value that is missing or does not fit is asked for before the run starts.
          </Typography>
          <Stack spacing={2}>
            {mappable.map((p) => {
              const m = draft.mappings[p.key] ?? { kind: 'none' as const, value: '' };
              const needsValue = m.kind === 'fixed' || m.kind === 'capture_subject' || m.kind === 'capture_text';
              return (
                <Stack key={p.key} direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                  <TextField select label={p.label} value={m.kind} onChange={(e) => setMapping(p.key, { kind: e.target.value as MappingKind, value: '' })} disabled={disabled} fullWidth sx={tap}>
                    {KINDS.map((k) => (
                      <MenuItem key={k} value={k}>
                        {MAPPING_LABEL[k]}
                      </MenuItem>
                    ))}
                  </TextField>
                  {needsValue && (
                    <TextField
                      label={m.kind === 'fixed' ? 'Value' : 'Pattern with one group, e.g. #(INV-\\d+)'}
                      value={m.value}
                      onChange={(e) => setMapping(p.key, { ...m, value: e.target.value })}
                      error={Boolean(errors[`mapping:${p.key}`])}
                      helperText={errors[`mapping:${p.key}`]}
                      disabled={disabled}
                      fullWidth
                      slotProps={{ htmlInput: { 'aria-label': `${p.label} value`, autoCapitalize: 'none', spellCheck: false } }}
                      sx={tap}
                    />
                  )}
                </Stack>
              );
            })}
          </Stack>
        </Box>
      )}

      <Alert severity="info" sx={{ overflowWrap: 'anywhere' }}>
        The email itself is never put into the task's goal. The agent can read it only if this task lets it use the account's mail; otherwise the trigger just starts the task with the details above. Anything it reads is information, not instructions.
      </Alert>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField select label="After a run starts" value={draft.afterStart} onChange={(e) => set({ afterStart: e.target.value as TriggerDraft['afterStart'] })} error={Boolean(errors.afterStart)} helperText={errors.afterStart ?? (canModify ? undefined : 'Marking or labelling needs the account\'s "change mail" switch.')} disabled={disabled} fullWidth sx={tap}>
          <MenuItem value="none">Leave the email as it is</MenuItem>
          <MenuItem value="mark_read" disabled={!canModify}>
            Mark it read
          </MenuItem>
          <MenuItem value="add_label" disabled={!canModify}>
            Add a label
          </MenuItem>
        </TextField>
        {draft.afterStart === 'add_label' && <TextField label="Label" value={draft.labelId} onChange={(e) => set({ labelId: e.target.value })} error={Boolean(errors.labelId)} helperText={errors.labelId} disabled={disabled} fullWidth sx={tap} />}
      </Stack>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField select label="Look for mail" value={draft.pollMinutes} onChange={(e) => set({ pollMinutes: Number(e.target.value) })} disabled={disabled} fullWidth sx={tap}>
          {POLL_CHOICES.map((c) => (
            <MenuItem key={c.minutes} value={c.minutes}>
              {c.label}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          label="Most runs per day"
          type="number"
          value={draft.maxRunsPerDay}
          onChange={(e) => set({ maxRunsPerDay: Number(e.target.value) })}
          error={Boolean(errors.maxRunsPerDay)}
          helperText={errors.maxRunsPerDay ?? 'A flood or a mail loop stops here.'}
          disabled={disabled}
          fullWidth
          slotProps={{ htmlInput: { min: 1, max: 100 } }}
          sx={tap}
        />
      </Stack>

      <FormControlLabel
        control={<Switch checked={draft.acceptUnverified} onChange={(e) => set({ acceptUnverified: e.target.checked })} disabled={disabled} />}
        label="Also accept mail the provider could not verify. Off is safer: only mail that passed the provider's sender check starts the task. A message that failed it never does."
      />

      <FormControlLabel control={<Switch checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} disabled={disabled} />} label="On. Only mail that arrives after it is switched on counts." />
    </Stack>
  );
}
