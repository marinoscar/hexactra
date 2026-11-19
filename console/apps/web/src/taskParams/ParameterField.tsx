import { Autocomplete, Box, Button, MenuItem, Stack, TextField } from '@mui/material';
import { useId } from 'react';

import { inputModeOf, type TaskParameter } from './model';

/** What a field needs of a parameter (a task parameter, or a field of a `form` question). */
export type FieldDef = Pick<TaskParameter, 'key' | 'label' | 'type' | 'required' | 'options' | 'help' | 'constraints' | 'sensitive'>;

export interface ParameterFieldProps {
  def: FieldDef;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  disabled?: boolean;
  /** Earlier values for this field (never for a sensitive one). */
  suggestions?: readonly string[];
  autoFocus?: boolean;
}

const TAP = { minHeight: { xs: 44, sm: 'auto' } } as const;

function isoToday(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * One parameter as a typed field: a numeric keypad for a number or an
 * amount, a date picker with Today and Tomorrow, a select for a choice, the
 * `tel` and `email` keyboards, and a masked field for a sensitive value. The
 * label is always above the field and the error is the field's helper text,
 * so a screen reader reads both.
 */
export function ParameterField({ def, value, onChange, error, disabled, suggestions, autoFocus }: ParameterFieldProps) {
  const id = useId();
  const helper = error ?? def.help ?? (def.required === false ? 'Optional' : undefined);
  const common = {
    id,
    label: def.label,
    required: def.required !== false,
    fullWidth: true,
    disabled,
    autoFocus,
    error: Boolean(error),
    helperText: helper,
    'data-param': def.key,
  } as const;

  if (def.type === 'choice') {
    return (
      <TextField {...common} select value={value} onChange={(e) => onChange(e.target.value)} slotProps={{ inputLabel: { shrink: true } }}>
        {(def.options ?? []).map((o) => (
          <MenuItem key={o} value={o} sx={{ minHeight: 44, whiteSpace: 'normal' }}>
            {o}
          </MenuItem>
        ))}
      </TextField>
    );
  }

  if (def.type === 'date') {
    return (
      <Box>
        <TextField {...common} type="date" value={value} onChange={(e) => onChange(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
        <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
          <Button size="small" disabled={disabled} onClick={() => onChange(isoToday(0))} sx={TAP} aria-label={`${def.label}: today`}>
            Today
          </Button>
          <Button size="small" disabled={disabled} onClick={() => onChange(isoToday(1))} sx={TAP} aria-label={`${def.label}: tomorrow`}>
            Tomorrow
          </Button>
        </Stack>
      </Box>
    );
  }

  const htmlType = def.sensitive ? 'password' : def.type === 'email' ? 'email' : def.type === 'phone' ? 'tel' : 'text';
  const htmlInput = {
    inputMode: def.sensitive ? 'text' : inputModeOf(def.type),
    autoComplete: def.sensitive ? 'new-password' : 'off',
    spellCheck: false,
    ...(def.constraints?.maxLength ? { maxLength: def.constraints.maxLength } : {}),
    ...(def.sensitive ? { 'data-1p-ignore': 'true', 'data-lpignore': 'true' } : {}),
  };
  const offered = !def.sensitive && suggestions && suggestions.length > 0 ? suggestions : null;
  if (offered) {
    return (
      <Autocomplete
        freeSolo
        options={[...offered]}
        inputValue={value}
        onInputChange={(_e, v) => onChange(v)}
        disabled={disabled}
        renderInput={(params) => (
          <TextField
            {...params}
            {...common}
            id={params.id}
            type={htmlType}
            slotProps={{ ...params.slotProps, inputLabel: { ...params.slotProps.inputLabel, shrink: true }, htmlInput: { ...params.slotProps.htmlInput, ...htmlInput } }}
          />
        )}
      />
    );
  }
  return (
    <TextField
      {...common}
      type={htmlType}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      slotProps={{ inputLabel: { shrink: true }, htmlInput }}
    />
  );
}
