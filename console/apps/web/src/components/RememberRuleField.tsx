import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Alert, Box, Button, Checkbox, Collapse, FormControl, FormControlLabel, FormLabel, InputAdornment, MenuItem, Radio, RadioGroup, Stack, TextField, Typography } from '@mui/material';
import { useId, useState } from 'react';

import type { RememberRuleBody, RememberScope, Rememberable } from './questions';

/** The categories that move money: the amount limit is offered for these. */
const AMOUNT_CATEGORIES: readonly string[] = ['payment', 'purchase', 'send'];
/** The categories the warning line is shown for when the box is ticked. */
const WARN_CATEGORIES: readonly string[] = ['payment', 'purchase', 'send', 'delete'];

/** The tick and its limits, as the form keeps them while the person chooses. */
export interface RememberRuleState {
  ticked: boolean;
  scope: RememberScope;
  /** The amount limit as typed; '' for none. */
  amount: string;
  /** How long the rule lasts: always, or a number of days. */
  days: 'always' | '30' | '7';
}

export const NO_REMEMBER: RememberRuleState = { ticked: false, scope: 'everywhere', amount: '', days: 'always' };

/** Why the amount limit is not a positive amount, or null ('' is no limit). */
export function amountError(amount: string): string | null {
  const v = amount.trim();
  if (v === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(v) || Number(v) <= 0) return 'Enter an amount, like 50 or 49.99';
  return null;
}

/** The `rememberRule` an answer carries, or undefined when the box is not ticked (or the amount is not valid). */
export function rememberRuleOf(r: Rememberable | null | undefined, s: RememberRuleState): RememberRuleBody | undefined {
  if (!r || !s.ticked || amountError(s.amount)) return undefined;
  const scopes = r.scopes ?? ['everywhere'];
  const withAmount = r.kind === 'gate' && AMOUNT_CATEGORIES.includes(r.category ?? '');
  return {
    enabled: true,
    ...(s.scope !== 'everywhere' && scopes.includes(s.scope) ? { scope: s.scope } : {}),
    ...(withAmount && s.amount.trim() ? { maxAmount: Number(s.amount.trim()) } : {}),
    ...(s.days !== 'always' ? { expiresInDays: Number(s.days) } : {}),
  };
}

export interface RememberRuleFieldProps {
  rememberable: Rememberable;
  value: RememberRuleState;
  onChange: (next: RememberRuleState) => void;
  disabled?: boolean;
}

const SCOPE_LABEL: Record<RememberScope, string> = {
  everywhere: 'Everywhere on this site',
  this_task: 'Only in this task',
  this_chat: 'Only in this chat',
};

/**
 * "Don't ask again" (#555), under the Allow and Deny buttons of a question the server marked rememberable: a
 * checkbox, off by default, naming exactly what would be remembered; once ticked, a "Limit it" disclosure (where,
 * up to an amount for a payment, a purchase or a send, for how long; all optional) and, for a step that moves
 * money or deletes something, one line of warning. Only the signed-in web and Android app render it.
 */
export function RememberRuleField({ rememberable: r, value: s, onChange, disabled = false }: RememberRuleFieldProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const scopes = r.scopes ?? ['everywhere'];
  const withAmount = r.kind === 'gate' && AMOUNT_CATEGORIES.includes(r.category ?? '');
  const warn = r.kind === 'gate' && WARN_CATEGORIES.includes(r.category ?? '');
  const amountProblem = amountError(s.amount);
  const set = (patch: Partial<RememberRuleState>) => onChange({ ...s, ...patch });
  return (
    <Box data-testid="remember-rule" sx={{ mt: 1.5 }}>
      <FormControlLabel
        sx={{ alignItems: 'flex-start', m: 0, minHeight: { xs: 44, sm: 'auto' } }}
        control={<Checkbox checked={s.ticked} onChange={(e) => set({ ticked: e.target.checked })} disabled={disabled} sx={{ mt: -0.5 }} />}
        label={
          <Typography variant="body2" sx={{ pt: 0.75, overflowWrap: 'anywhere' }}>
            Don&apos;t ask again: {r.summary}
          </Typography>
        }
      />
      {s.ticked && (
        <Box sx={{ pl: { xs: 0, sm: 4 } }}>
          {warn && (
            <Alert severity="warning" variant="outlined" sx={{ mt: 1, overflowWrap: 'anywhere' }}>
              The agent will do this without asking, whenever a job reaches this button on this site. You can stop it in Settings → Saved approvals.
            </Alert>
          )}
          <Button
            size="small"
            onClick={() => setOpen((o) => !o)}
            disabled={disabled}
            aria-expanded={open}
            aria-controls={`${id}-limits`}
            endIcon={open ? <ExpandLessIcon /> : <ExpandMoreIcon />}
            sx={{ mt: 1, minHeight: { xs: 44, sm: 'auto' } }}
          >
            Limit it
          </Button>
          <Collapse in={open} id={`${id}-limits`}>
            <Stack spacing={2} sx={{ mt: 1 }}>
              {scopes.length > 1 && (
                <FormControl disabled={disabled}>
                  <FormLabel id={`${id}-where`}>Where</FormLabel>
                  <RadioGroup aria-labelledby={`${id}-where`} value={s.scope} onChange={(e) => set({ scope: e.target.value as RememberScope })}>
                    {scopes.map((sc) => (
                      <FormControlLabel key={sc} value={sc} control={<Radio />} label={SCOPE_LABEL[sc]} sx={{ minHeight: { xs: 44, sm: 'auto' } }} />
                    ))}
                  </RadioGroup>
                </FormControl>
              )}
              {withAmount && (
                <TextField
                  label="Up to an amount (optional)"
                  value={s.amount}
                  onChange={(e) => set({ amount: e.target.value })}
                  disabled={disabled}
                  error={Boolean(amountProblem)}
                  helperText={amountProblem ?? 'Larger amounts, or an amount the agent does not know, still ask.'}
                  slotProps={{ htmlInput: { inputMode: 'decimal' }, input: { startAdornment: <InputAdornment position="start">$</InputAdornment> }, inputLabel: { shrink: true } }}
                  sx={{ maxWidth: 280 }}
                />
              )}
              <TextField select label="For how long" value={s.days} onChange={(e) => set({ days: e.target.value as RememberRuleState['days'] })} disabled={disabled} slotProps={{ inputLabel: { shrink: true } }} sx={{ maxWidth: 280 }}>
                <MenuItem value="always">Always</MenuItem>
                <MenuItem value="30">30 days</MenuItem>
                <MenuItem value="7">7 days</MenuItem>
              </TextField>
            </Stack>
          </Collapse>
        </Box>
      )}
    </Box>
  );
}
