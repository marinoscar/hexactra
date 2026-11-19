// "Keep a record of each run" (E39.10, #607): three steps for the common case (what to capture, email me the report, add a row to a
// spreadsheet). It only FILLS THE FORM with outputs and two deliveries; the owner still saves. Nothing is sent or created here.
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControl, FormControlLabel, InputLabel, MenuItem, Select, Stack, Step, StepLabel, Stepper, Switch, TextField, Typography, useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useState } from 'react';

import type { Connection } from '../connections/api';
import { newOutput, type TaskOutput } from '../taskOutputs/model';
import { connectionFits, emailDefaults, newDraft, type DeliveryDraft, type EmailConfig, type SheetRowConfig } from './drafts';

export interface GuidedResult {
  /** New outputs to add to the form (after the ones it has). */
  outputs: TaskOutput[];
  /** New deliveries to add to the form. */
  deliveries: DeliveryDraft[];
}

export interface GuidedSetupProps {
  open: boolean;
  onClose: () => void;
  taskName: string;
  connections: readonly Connection[];
  ownAddress: string | null;
  /** The outputs the task already has: they are kept, and the sheet maps them too. */
  existingOutputs: readonly TaskOutput[];
  onApply: (result: GuidedResult) => void;
}

const STEPS = ['What to capture', 'Email me the report', 'Add a row to a spreadsheet'];
const TAP = { minHeight: { xs: 44, sm: 'auto' } } as const;

export function GuidedSetup({ open, onClose, taskName, connections, ownAddress, existingOutputs, onApply }: GuidedSetupProps) {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const sheetAccounts = connections.filter((c) => connectionFits(c, 'sheet_row'));
  const mailAccounts = connections.filter((c) => connectionFits(c, 'email'));
  const [step, setStep] = useState(0);
  const [labels, setLabels] = useState<string[]>(['']);
  const [email, setEmail] = useState(true);
  const [address, setAddress] = useState(ownAddress ?? '');
  const [via, setVia] = useState<string>('console');
  const [sheet, setSheet] = useState(sheetAccounts.length > 0);
  const [account, setAccount] = useState<string>(sheetAccounts[0]?.id ?? '');
  const [title, setTitle] = useState('');

  const reset = () => {
    setStep(0);
    setLabels(['']);
    setEmail(true);
    setAddress(ownAddress ?? '');
    setVia('console');
    setSheet(sheetAccounts.length > 0);
    setAccount(sheetAccounts[0]?.id ?? '');
    setTitle('');
  };

  const outputs = labels.map((l) => l.trim()).filter(Boolean).map((l) => newOutput(l));
  const finish = () => {
    const all = [...existingOutputs, ...outputs];
    const deliveries: DeliveryDraft[] = [];
    if (email && address.trim()) {
      const d = newDraft('email', { ownAddress: address.trim().toLowerCase() });
      d.config = { ...emailDefaults(address.trim().toLowerCase()), via: via === 'console' ? 'console' : { connectionId: via } } satisfies EmailConfig;
      deliveries.push(d);
    }
    if (sheet && account) {
      const d = newDraft('sheet_row', { outputs: all, connections });
      const c = d.config as SheetRowConfig;
      c.connectionId = account;
      c.createIfMissing = true;
      c.newTitle = title.trim() || `${taskName.trim() || 'Task'} log`;
      deliveries.push(d);
    }
    onApply({ outputs, deliveries });
    reset();
  };

  const last = step === STEPS.length - 1;
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" fullScreen={fullScreen} aria-labelledby="guided-title">
      <DialogTitle id="guided-title">Keep a record of each run</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Stepper activeStep={step} alternativeLabel sx={{ display: { xs: 'none', sm: 'flex' } }}>
            {STEPS.map((s) => (
              <Step key={s}>
                <StepLabel>{s}</StepLabel>
              </Step>
            ))}
          </Stepper>
          <Typography variant="subtitle2" sx={{ display: { sm: 'none' } }}>
            Step {step + 1} of {STEPS.length}: {STEPS[step]}
          </Typography>
          {step === 0 && (
            <Stack spacing={1.5}>
              <Typography variant="body2" color="text.secondary">
                What should the agent write down at the end of each run? One value per line, for example &ldquo;Confirmation number&rdquo; or &ldquo;Amount paid&rdquo;.
                {existingOutputs.length > 0 ? ` This task already captures ${existingOutputs.length}; they stay.` : ''}
              </Typography>
              {labels.map((l, i) => (
                <TextField key={i} size="small" label={`Value ${i + 1}`} value={l} onChange={(e) => setLabels((all) => all.map((x, j) => (j === i ? e.target.value : x)))} fullWidth />
              ))}
              <Button size="small" onClick={() => setLabels((all) => [...all, ''])} disabled={labels.length >= 10} sx={{ alignSelf: 'flex-start', ...TAP }}>
                Add another value
              </Button>
            </Stack>
          )}
          {step === 1 && (
            <Stack spacing={1.5}>
              <FormControlLabel sx={TAP} control={<Switch checked={email} onChange={(e) => setEmail(e.target.checked)} />} label="Email me a report when a run succeeds" />
              {email && (
                <>
                  <TextField size="small" type="email" label="Email address" value={address} onChange={(e) => setAddress(e.target.value)} helperText="The report is attached as a PDF, with the values the agent captured." fullWidth />
                  {mailAccounts.length > 0 && (
                    <FormControl size="small">
                      <InputLabel id="guided-via-label">Send from</InputLabel>
                      <Select labelId="guided-via-label" label="Send from" value={via} onChange={(e) => setVia(String(e.target.value))}>
                        <MenuItem value="console">The console</MenuItem>
                        {mailAccounts.map((m) => (
                          <MenuItem key={m.id} value={m.id}>
                            {m.label}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  )}
                </>
              )}
            </Stack>
          )}
          {step === 2 && (
            <Stack spacing={1.5}>
              {sheetAccounts.length === 0 ? (
                <Alert severity="info">Connect a Google or Microsoft account with permission to change documents to add a row to a spreadsheet. You can skip this step.</Alert>
              ) : (
                <>
                  <FormControlLabel sx={TAP} control={<Switch checked={sheet} onChange={(e) => setSheet(e.target.checked)} />} label="Add a row to a spreadsheet after each run" />
                  {sheet && (
                    <>
                      <FormControl size="small">
                        <InputLabel id="guided-account-label">Account</InputLabel>
                        <Select labelId="guided-account-label" label="Account" value={account} onChange={(e) => setAccount(String(e.target.value))}>
                          {sheetAccounts.map((a) => (
                            <MenuItem key={a.id} value={a.id}>
                              {a.label}
                            </MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                      <TextField size="small" label="Name of the new spreadsheet" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`${taskName.trim() || 'Task'} log`} helperText="Created the first time a run sends. You can point it at an existing one later." fullWidth />
                    </>
                  )}
                </>
              )}
            </Stack>
          )}
          <Box>
            <Typography variant="caption" color="text.secondary">
              This only fills in the form. Nothing is created or sent until you save the task.
            </Typography>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} sx={TAP}>
          Cancel
        </Button>
        {step > 0 && (
          <Button onClick={() => setStep((s) => s - 1)} sx={TAP}>
            Back
          </Button>
        )}
        {last ? (
          <Button variant="contained" onClick={finish} sx={TAP}>
            Fill in the form
          </Button>
        ) : (
          <Button variant="contained" onClick={() => setStep((s) => s + 1)} sx={TAP}>
            Next
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
