import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControl,
  FormControlLabel,
  FormGroup,
  FormHelperText,
  FormLabel,
  InputAdornment,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import type { AnswerBody, AskedQuestion, QuestionOption } from './questions';

export interface QuestionAnswerFormProps {
  question: AskedQuestion;
  /** Sends the answer. A secret is passed here once and never kept by the form. */
  onSubmit: (answer: AnswerBody) => void | Promise<void>;
  /** Opens the browser of a browser-bound question (shown when it has a viewer). */
  onOpenBrowser?: () => void;
  disabled?: boolean;
}

/** Why a number does not fit its constraints, or null. */
export function numberError(raw: string, c: AskedQuestion['constraints']): string | null {
  if (raw.trim() === '') return null;
  if (!/^-?\d+(\.\d+)?$/.test(raw.trim())) return 'Enter a number';
  const n = Number(raw);
  if (c?.min !== undefined && n < c.min) return `At least ${c.min}`;
  if (c?.max !== undefined && n > c.max) return `At most ${c.max}`;
  if (c?.step !== undefined) {
    const k = (n - (c.min ?? 0)) / c.step;
    if (Math.abs(k - Math.round(k)) > 1e-9) return `In steps of ${c.step}`;
  }
  return null;
}

/** Why a text answer does not fit its constraints, or null. */
export function textError(v: string, c: AskedQuestion['constraints']): string | null {
  if (v === '') return null;
  if (c?.maxLength !== undefined && v.length > c.maxLength) return `At most ${c.maxLength} characters`;
  if (!c?.multiline && /[\r\n]/.test(v)) return 'One line only';
  if (c?.pattern) {
    try {
      if (!new RegExp(`^(?:${c.pattern})$`, 'u').test(v)) return 'This does not have the expected format';
    } catch {
      return null;
    }
  }
  return null;
}

function OptionLabel({ o }: { o: QuestionOption }) {
  return (
    <Box sx={{ py: 0.5 }}>
      <Typography component="span">{o.label}</Typography>
      {o.description && (
        <Typography component="span" variant="body2" color="text.secondary" sx={{ display: 'block' }}>
          {o.description}
        </Typography>
      )}
    </Box>
  );
}

/**
 * The answer form of one question, for every input type: a radio group, a
 * set of checkboxes, a text or number field, Approve/Deny (with a second
 * step for a high-risk confirmation), a password field for a secret, or
 * Done (after taking over the browser). Decline is always offered. The
 * buttons wrap and fields are full width, so it fits a phone.
 */
export function QuestionAnswerForm({ question: q, onSubmit, onOpenBrowser, disabled }: QuestionAnswerFormProps) {
  const [value, setValue] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [secret, setSecret] = useState('');
  const [confirming, setConfirming] = useState(false);
  const options = q.options ?? [];
  const c = q.constraints;
  const minSel = c?.minSelections ?? 1;
  const maxSel = c?.maxSelections ?? options.length;
  const confirmLabel = q.confirmLabel ?? 'Approve';
  const denyLabel = q.denyLabel ?? 'Deny';

  const error = useMemo(() => (q.input === 'number' ? numberError(value, c) : q.input === 'text' ? textError(value, c) : null), [q.input, value, c]);

  const send = (answer: AnswerBody) => {
    setConfirming(false);
    void onSubmit(answer);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    switch (q.input) {
      case 'text':
      case 'number':
        if (value.trim() !== '' && !error) send({ outcome: 'completed', value: q.input === 'number' ? value.trim() : value });
        return;
      case 'choice':
        if (value) send({ outcome: 'completed', value });
        return;
      case 'multi_choice':
        if (picked.length >= minSel && picked.length <= maxSel) send({ outcome: 'completed', values: options.map((o) => o.id).filter((id) => picked.includes(id)) });
        return;
      case 'secret': {
        if (!secret) return;
        // Dropped from the form before it is sent: the secret is not kept in state.
        const v = secret;
        setSecret('');
        send({ outcome: 'completed', value: v });
        return;
      }
      default:
        send({ outcome: 'completed' });
    }
  };

  const decline = (
    <Button color="error" disabled={disabled} onClick={() => send({ outcome: 'cancelled' })}>
      Decline
    </Button>
  );
  const openBrowser = q.viewerUrl && onOpenBrowser && (
    <Button onClick={onOpenBrowser} disabled={disabled}>
      Open the browser
    </Button>
  );
  const actions = (primary: ReactNode) => (
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mt: 2 }}>
      {primary}
      {decline}
      {openBrowser}
    </Stack>
  );

  if (q.input === 'confirm') {
    const high = q.risk !== 'low';
    if (confirming) {
      return (
        <Box>
          <Alert severity="warning" role="alert">
            This is a high-risk action. Are you sure you want to {confirmLabel.toLowerCase()}?
          </Alert>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mt: 2 }}>
            <Button variant="contained" color="warning" disabled={disabled} onClick={() => send({ outcome: 'completed', value: 'approve' })}>
              Yes, {confirmLabel}
            </Button>
            <Button disabled={disabled} onClick={() => setConfirming(false)}>
              Back
            </Button>
          </Stack>
        </Box>
      );
    }
    return actions(
      <>
        <Button variant="contained" disabled={disabled} onClick={() => (high ? setConfirming(true) : send({ outcome: 'completed', value: 'approve' }))}>
          {confirmLabel}
        </Button>
        <Button variant="outlined" disabled={disabled} onClick={() => send({ outcome: 'completed', value: 'deny' })}>
          {denyLabel}
        </Button>
      </>,
    );
  }

  let field: ReactNode = null;
  let ready = true;
  let primaryLabel = 'Send';
  switch (q.input) {
    case 'choice':
      ready = Boolean(value);
      field = (
        <FormControl fullWidth>
          <FormLabel id="question-choice">Choose one</FormLabel>
          <RadioGroup aria-labelledby="question-choice" value={value} onChange={(e) => setValue(e.target.value)}>
            {options.map((o) => (
              <FormControlLabel key={o.id} value={o.id} control={<Radio />} label={<OptionLabel o={o} />} disabled={disabled} />
            ))}
          </RadioGroup>
        </FormControl>
      );
      break;
    case 'multi_choice': {
      ready = picked.length >= minSel && picked.length <= maxSel;
      const help = minSel === maxSel ? `Choose ${minSel}` : maxSel >= options.length && minSel <= 1 ? 'Choose one or more' : `Choose between ${minSel} and ${maxSel}`;
      field = (
        <FormControl fullWidth component="fieldset">
          <FormLabel component="legend">{help}</FormLabel>
          <FormGroup>
            {options.map((o) => {
              const on = picked.includes(o.id);
              return (
                <FormControlLabel
                  key={o.id}
                  control={<Checkbox checked={on} onChange={() => setPicked((p) => (on ? p.filter((x) => x !== o.id) : [...p, o.id]))} />}
                  label={<OptionLabel o={o} />}
                  disabled={disabled || (!on && picked.length >= maxSel)}
                />
              );
            })}
          </FormGroup>
          <FormHelperText>
            {picked.length} selected
          </FormHelperText>
        </FormControl>
      );
      break;
    }
    case 'text':
      ready = value.trim() !== '' && !error;
      field = (
        <TextField
          fullWidth
          label="Your answer"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled}
          multiline={Boolean(c?.multiline)}
          minRows={c?.multiline ? 3 : undefined}
          error={Boolean(error)}
          helperText={error ?? (c?.maxLength ? `${value.length} / ${c.maxLength}` : ' ')}
          slotProps={{ htmlInput: { maxLength: c?.maxLength, autoComplete: 'off' } }}
        />
      );
      break;
    case 'number':
      ready = value.trim() !== '' && !error;
      field = (
        <TextField
          fullWidth
          label="Number"
          type="number"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled}
          error={Boolean(error)}
          helperText={error ?? ([c?.min !== undefined ? `min ${c.min}` : '', c?.max !== undefined ? `max ${c.max}` : '', c?.step !== undefined ? `step ${c.step}` : ''].filter(Boolean).join(' · ') || ' ')}
          slotProps={{
            htmlInput: { min: c?.min, max: c?.max, step: c?.step ?? 'any', inputMode: 'decimal' },
            input: c?.unit ? { endAdornment: <InputAdornment position="end">{c.unit}</InputAdornment> } : undefined,
          }}
        />
      );
      break;
    case 'secret':
      ready = Boolean(secret);
      field = (
        <TextField
          fullWidth
          label="Code or secret (goes to the agent's browser, never stored)"
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          disabled={disabled}
          slotProps={{ htmlInput: { autoComplete: 'off', spellCheck: false } }}
        />
      );
      break;
    case 'takeover':
      primaryLabel = 'Done';
      field = (
        <Typography variant="body2" color="text.secondary">
          Take over the browser, do what is asked, then press Done.
        </Typography>
      );
      break;
    default:
      primaryLabel = q.kind === 'confirmation' ? 'Approve' : 'Done';
  }

  return (
    <Box component="form" onSubmit={submit} noValidate>
      {field}
      {actions(
        <Button type="submit" variant="contained" disabled={disabled || !ready}>
          {primaryLabel}
        </Button>,
      )}
    </Box>
  );
}
