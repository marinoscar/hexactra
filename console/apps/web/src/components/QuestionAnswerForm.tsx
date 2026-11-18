import VisibilityOffOutlined from '@mui/icons-material/VisibilityOffOutlined';
import VisibilityOutlined from '@mui/icons-material/VisibilityOutlined';
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
  IconButton,
  InputAdornment,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';

import { numberError, numberHint, selectionBounds, selectionHelp, selectionOk, textError } from '@app/shared/question-rules';

import { digitsOnly, secretLabel, type AnswerBody, type AskedQuestion, type QuestionOption } from './questions';

export interface QuestionAnswerFormProps {
  question: AskedQuestion;
  /** Sends the answer. A secret is passed here once and never kept by the form. */
  onSubmit: (answer: AnswerBody) => void | Promise<void>;
  /** Opens the browser of a browser-bound question (shown when it has a viewer). */
  onOpenBrowser?: () => void;
  /** Every control is disabled (the viewer may not answer). */
  disabled?: boolean;
  /** The answer is being sent: every control is disabled and the primary button shows progress. */
  busy?: boolean;
}

/** A shown secret hides again after this long without a keystroke. */
export const SECRET_AUTO_HIDE_MS = 30_000;

/** More options than this scroll inside the form, so the action row stays in reach. */
export const OPTIONS_SCROLL_ABOVE = 8;

const SECRET_HELP = "Sent straight to the agent's browser. Never stored or shown again.";

/** One action button: full width and 44 px tall on a phone, its own width from `sm` up. */
const ACTION_SX = { width: { xs: '100%', sm: 'auto' }, minHeight: { xs: 44, sm: 'auto' } } as const;

/** An option row: full width, at least 44 px tall, the whole row clickable, its text wrapping. */
const OPTION_ROW_SX = {
  m: 0,
  width: '100%',
  minHeight: 44,
  alignItems: 'flex-start',
  borderRadius: 1,
  '&:hover': { bgcolor: 'action.hover' },
  '& .MuiFormControlLabel-label': { flex: 1, minWidth: 0, overflowWrap: 'anywhere', pt: '5px' },
} as const;

// The answer rules (constraints, selections) are shared with the MCP Apps
// question card and the API: packages/shared/question-rules.js.
export { numberError, textError } from '@app/shared/question-rules';

function OptionLabel({ o }: { o: QuestionOption }) {
  return (
    <Box sx={{ py: 0.5, overflowWrap: 'anywhere' }}>
      <Typography component="span" sx={{ overflowWrap: 'anywhere' }}>
        {o.label}
      </Typography>
      {o.description && (
        <Typography component="span" variant="body2" color="text.secondary" sx={{ display: 'block', overflowWrap: 'anywhere' }}>
          {o.description}
        </Typography>
      )}
    </Box>
  );
}

/** The options of a choice: a plain list, or a scrolling box when there are many. */
function OptionsBox({ count, children }: { count: number; children: ReactNode }) {
  if (count <= OPTIONS_SCROLL_ABOVE) return <>{children}</>;
  return (
    <Box data-testid="options-scroll" sx={{ maxHeight: '50vh', overflowY: 'auto', border: 1, borderColor: 'divider', borderRadius: 1, mt: 0.5 }}>
      {children}
    </Box>
  );
}

/**
 * The answer form of one question, for every input type: a radio group, a
 * set of checkboxes, a text or number field, Approve/Deny (with a second
 * step for a high-risk confirmation), a secret field with a show/hide
 * control, or Done (after taking over the browser). Decline is always
 * offered, last. The actions are one row from `sm` up and a full-width
 * stack on a phone; every label is forced above its field, so no text is
 * ever drawn over a value.
 *
 * A secret lives in this component's state only while it is typed: it is
 * dropped before `onSubmit` is called, and showing it only changes the
 * input's `type`.
 */
export function QuestionAnswerForm({ question: q, onSubmit, onOpenBrowser, disabled: off, busy = false }: QuestionAnswerFormProps) {
  const disabled = Boolean(off) || busy;
  const [value, setValue] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [secret, setSecret] = useState('');
  // A one-time code starts shown (typing it blind causes retries); anything else starts hidden.
  const shownByDefault = q.kind === 'code';
  const [shown, setShown] = useState(shownByDefault);
  const [confirming, setConfirming] = useState(false);
  const [opened, setOpened] = useState(false);
  const isSecret = q.input === 'secret';
  const options = q.options ?? [];
  const c = q.constraints;
  const bounds = selectionBounds(c, options.length);
  const minSel = bounds.min;
  const maxSel = bounds.max;
  const confirmLabel = q.confirmLabel ?? 'Approve';
  const denyLabel = q.denyLabel ?? 'Deny';

  const error = useMemo(() => (q.input === 'number' ? numberError(value, c) : q.input === 'text' ? textError(value, c) : null), [q.input, value, c]);

  // A shown secret hides again when the tab is hidden...
  useEffect(() => {
    if (!isSecret) return;
    const hide = () => {
      if (document.visibilityState === 'hidden') setShown(false);
    };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, [isSecret]);
  // ...and after 30 s without a keystroke (`secret` restarts the timer).
  useEffect(() => {
    if (!isSecret || !shown) return;
    const t = setTimeout(() => setShown(false), SECRET_AUTO_HIDE_MS);
    return () => clearTimeout(t);
  }, [isSecret, shown, secret]);

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
        if (selectionOk(picked.length, bounds)) send({ outcome: 'completed', values: options.map((o) => o.id).filter((id) => picked.includes(id)) });
        return;
      case 'secret': {
        if (!secret) return;
        // Dropped from the form (and hidden again) before it is sent: the secret is not kept in state.
        const v = secret;
        setSecret('');
        setShown(false);
        send({ outcome: 'completed', value: v });
        return;
      }
      default:
        send({ outcome: 'completed' });
    }
  };

  const decline = (
    <Button color="error" variant="text" disabled={disabled} onClick={() => send({ outcome: 'cancelled' })} sx={ACTION_SX}>
      Decline
    </Button>
  );
  const canOpen = Boolean(q.viewerUrl && onOpenBrowser);
  const open = () => {
    setOpened(true);
    onOpenBrowser?.();
  };
  // Primary first, then the secondary actions, then Open the browser, then Decline: one row from `sm` up, a full-width stack on a phone.
  const actions = (primary: ReactNode, openBrowser: ReactNode = canOpen && (
    <Button onClick={open} disabled={disabled} sx={ACTION_SX}>
      Open the browser
    </Button>
  )) => (
    <Stack data-testid="question-actions" direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ flexWrap: { sm: 'wrap' }, alignItems: { xs: 'stretch', sm: 'center' }, mt: 2 }}>
      {primary}
      {openBrowser}
      {decline}
    </Stack>
  );

  if (q.input === 'confirm') {
    const high = q.risk !== 'low';
    if (confirming) {
      return (
        <Box sx={{ mt: 2 }}>
          <Alert severity="warning" role="alert" sx={{ overflowWrap: 'anywhere' }}>
            This is a high-risk action. Are you sure you want to {confirmLabel.toLowerCase()}?
          </Alert>
          <Stack data-testid="question-actions" direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ flexWrap: { sm: 'wrap' }, mt: 2 }}>
            <Button variant="contained" color="warning" disabled={disabled} loading={busy} onClick={() => send({ outcome: 'completed', value: 'approve' })} sx={ACTION_SX}>
              Yes, {confirmLabel}
            </Button>
            <Button disabled={disabled} onClick={() => setConfirming(false)} sx={ACTION_SX}>
              Back
            </Button>
          </Stack>
        </Box>
      );
    }
    return actions(
      <>
        <Button variant="contained" disabled={disabled} loading={busy} onClick={() => (high ? setConfirming(true) : send({ outcome: 'completed', value: 'approve' }))} sx={ACTION_SX}>
          {confirmLabel}
        </Button>
        <Button variant="outlined" disabled={disabled} onClick={() => send({ outcome: 'completed', value: 'deny' })} sx={ACTION_SX}>
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
          <OptionsBox count={options.length}>
            <RadioGroup aria-labelledby="question-choice" value={value} onChange={(e) => setValue(e.target.value)}>
              {options.map((o) => (
                <FormControlLabel key={o.id} value={o.id} control={<Radio />} label={<OptionLabel o={o} />} disabled={disabled} sx={OPTION_ROW_SX} />
              ))}
            </RadioGroup>
          </OptionsBox>
        </FormControl>
      );
      break;
    case 'multi_choice': {
      ready = selectionOk(picked.length, bounds);
      const help = selectionHelp(bounds, options.length);
      field = (
        <FormControl fullWidth component="fieldset">
          <FormLabel component="legend">{help}</FormLabel>
          <OptionsBox count={options.length}>
            <FormGroup>
              {options.map((o) => {
                const on = picked.includes(o.id);
                return (
                  <FormControlLabel
                    key={o.id}
                    control={<Checkbox checked={on} onChange={() => setPicked((p) => (on ? p.filter((x) => x !== o.id) : [...p, o.id]))} />}
                    label={<OptionLabel o={o} />}
                    disabled={disabled || (!on && picked.length >= maxSel)}
                    sx={OPTION_ROW_SX}
                  />
                );
              })}
            </FormGroup>
          </OptionsBox>
          <FormHelperText sx={{ mx: 0 }}>
            {picked.length} of {maxSel} selected{picked.length < minSel && minSel > 1 ? ` (at least ${minSel})` : ''}
          </FormHelperText>
        </FormControl>
      );
      break;
    }
    case 'text': {
      ready = value.trim() !== '' && !error;
      const counter = c?.maxLength ? `${value.length} / ${c.maxLength}` : null;
      // A sign-in's username (#524): the phone's password manager may offer it, and nothing "corrects" it.
      const login = q.kind === 'login';
      field = (
        <TextField
          fullWidth
          label={login ? 'Username or email' : 'Your answer'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled}
          multiline={Boolean(c?.multiline)}
          minRows={c?.multiline ? 3 : undefined}
          error={Boolean(error)}
          // The error on the left, the counter on the right; nothing (no placeholder line) when there is neither.
          helperText={
            error || counter ? (
              <Box component="span" sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
                <span>{error}</span>
                {counter && (
                  <Box component="span" sx={{ flexShrink: 0, color: 'text.secondary' }}>
                    {counter}
                  </Box>
                )}
              </Box>
            ) : undefined
          }
          slotProps={{ inputLabel: { shrink: true }, htmlInput: { maxLength: c?.maxLength, ...(login ? { autoComplete: 'username', autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } : { autoComplete: 'off' }) } }}
        />
      );
      break;
    }
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
          helperText={error ?? (numberHint(c) || undefined)}
          // No native spinner: on a phone it takes the room the value and the unit need.
          sx={{
            '& input[type=number]': { MozAppearance: 'textfield', minWidth: 0 },
            '& input::-webkit-outer-spin-button, & input::-webkit-inner-spin-button': { WebkitAppearance: 'none', margin: 0 },
          }}
          slotProps={{
            inputLabel: { shrink: true },
            htmlInput: { min: c?.min, max: c?.max, step: c?.step ?? 'any', inputMode: 'decimal' },
            input: c?.unit ? { endAdornment: <InputAdornment position="end" sx={{ flexShrink: 0, maxWidth: '50%', overflow: 'hidden' }}>{c.unit}</InputAdornment> } : undefined,
          }}
        />
      );
      break;
    case 'secret': {
      ready = Boolean(secret);
      const code = q.kind === 'code';
      field = (
        <TextField
          fullWidth
          label={secretLabel(q.kind)}
          type={shown ? 'text' : 'password'}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          disabled={disabled}
          helperText={SECRET_HELP}
          slotProps={{
            // Always above the field: an autofilled or pasted value can never sit under the label.
            inputLabel: { shrink: true },
            htmlInput: {
              // `new-password` is the value Chrome honours to stop autofill and save prompts; a code is a one-time code.
              autoComplete: code ? 'one-time-code' : 'new-password',
              inputMode: code && digitsOnly(c?.pattern) ? 'numeric' : 'text',
              spellCheck: false,
              autoCapitalize: 'none',
              autoCorrect: 'off',
              // Password managers: do not offer to save or fill this.
              'data-1p-ignore': 'true',
              'data-lpignore': 'true',
            },
            input: {
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    aria-label={shown ? 'Hide value' : 'Show value'}
                    aria-pressed={shown}
                    edge="end"
                    disabled={disabled}
                    onClick={() => setShown((s) => !s)}
                    // The field keeps its focus and caret.
                    onMouseDown={(e) => e.preventDefault()}
                  >
                    {shown ? <VisibilityOffOutlined /> : <VisibilityOutlined />}
                  </IconButton>
                </InputAdornment>
              ),
            },
          }}
        />
      );
      break;
    }
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

  // A takeover's first step is opening the browser: that is the primary action until it has been opened once.
  const openFirst = q.input === 'takeover' && canOpen && !opened;
  return (
    <Box component="form" onSubmit={submit} noValidate sx={{ mt: 2 }}>
      {field}
      {openFirst
        ? actions(
            <Button variant="contained" onClick={open} disabled={disabled} sx={ACTION_SX}>
              Open the browser
            </Button>,
            <Button type="submit" variant="outlined" disabled={disabled || !ready} loading={busy} sx={ACTION_SX}>
              {primaryLabel}
            </Button>,
          )
        : actions(
            <Button type="submit" variant="contained" disabled={disabled || !ready} loading={busy} sx={ACTION_SX}>
              {primaryLabel}
            </Button>,
          )}
    </Box>
  );
}
