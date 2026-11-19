import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Collapse,
  FormControl,
  FormControlLabel,
  FormHelperText,
  FormLabel,
  MenuItem,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useId, useState } from 'react';

import { ParameterField } from './ParameterField';
import { IDENTITY_FIELD_LABEL, TYPE_LABEL, TYPE_ORDER, defaultMode, type DefaultMode, type TaskParameter, type TaskParameterType } from './model';
import type { MemoryOption } from './useMemoryOptions';

export interface ParametersSectionProps {
  parameters: readonly TaskParameter[];
  onChange: (key: string, next: TaskParameter) => void;
  /** The owner's memories for "From a memory"; null hides that mode (no `memories:read`, or the list could not be loaded). */
  memories: readonly MemoryOption[] | null;
  /** Messages by parameter key (the server's `details.issues`). */
  errors?: Record<string, string>;
  disabled?: boolean;
}

const TAP = { minHeight: { xs: 44, sm: 'auto' } } as const;

function numberOrUndefined(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/** One parameter's row: label, type, required, options, how it gets its value, help and limits. */
function ParameterRow({ p, onChange, memories, error, disabled }: { p: TaskParameter; onChange: (next: TaskParameter) => void; memories: readonly MemoryOption[] | null; error?: string; disabled?: boolean }) {
  const uid = useId();
  const [more, setMore] = useState(Boolean(p.constraints && Object.keys(p.constraints).length));
  const mode = defaultMode(p);
  const set = (change: Partial<TaskParameter>) => onChange({ ...p, ...change });
  const setMode = (m: DefaultMode) => {
    if (m === 'ask') {
      const { default: _d, ...rest } = p;
      onChange(rest);
    } else if (m === 'value') set({ default: { value: p.default && 'value' in p.default ? p.default.value : '' } });
    else if (m === 'identity') set({ default: { identity: { field: p.default && 'identity' in p.default ? p.default.identity.field : 'full_name' } } });
    else {
      const first = memories?.[0];
      set({ default: { memory: { id: first?.id ?? '', attribute: first?.attributes[0] ?? '' } } });
    }
  };
  const setType = (type: TaskParameterType) => {
    const next: TaskParameter = { ...p, type };
    if (type !== 'choice') delete next.options;
    else if (!next.options) next.options = [];
    // A fixed default of another type would no longer fit.
    if (next.default && 'value' in next.default) next.default = { value: '' };
    // A detail taken from the saved details is typed as text.
    if (next.default && 'identity' in next.default && type !== 'text') delete next.default;
    onChange(next);
  };
  const setSensitive = (on: boolean) => {
    const next: TaskParameter = { ...p };
    if (on) {
      next.sensitive = true;
      delete next.default;
    } else delete next.sensitive;
    onChange(next);
  };
  const setConstraint = (key: 'min' | 'max' | 'maxLength', text: string) => {
    const c = { ...(p.constraints ?? {}) };
    const n = numberOrUndefined(text);
    if (n === undefined) delete c[key];
    else c[key] = key === 'maxLength' ? Math.max(1, Math.round(n)) : n;
    const next: TaskParameter = { ...p, constraints: c };
    if (Object.keys(c).length === 0) delete next.constraints;
    onChange(next);
  };

  const memory = p.default && 'memory' in p.default ? p.default.memory : null;
  const identity = p.default && 'identity' in p.default ? p.default.identity : null;
  const picked = memory ? memories?.find((m) => m.id === memory.id) : undefined;
  const numeric = p.type === 'number' || p.type === 'money';

  return (
    <Paper variant="outlined" role="group" aria-label={`Parameter ${p.label}`} data-field={`param:${p.key}`} tabIndex={-1} sx={{ p: { xs: 1.5, sm: 2 }, borderColor: error ? 'error.main' : undefined, outline: 'none' }}>
      <Stack spacing={2}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
          <Chip size="small" variant="outlined" label={`{{${p.key}}}`} sx={{ fontFamily: 'monospace', maxWidth: '100%' }} />
          {p.sensitive && <Chip size="small" color="warning" variant="outlined" label="Sensitive" />}
        </Stack>
        {error && (
          <Alert severity="error" role="alert">
            {error}
          </Alert>
        )}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField label="Label" value={p.label} onChange={(e) => set({ label: e.target.value })} disabled={disabled} fullWidth slotProps={{ htmlInput: { maxLength: 80 } }} />
          <TextField select label="Type" value={p.type} onChange={(e) => setType(e.target.value as TaskParameterType)} disabled={disabled} sx={{ minWidth: { sm: 200 } }} fullWidth>
            {TYPE_ORDER.map((t) => (
              <MenuItem key={t} value={t} sx={{ minHeight: 44 }}>
                {TYPE_LABEL[t]}
              </MenuItem>
            ))}
          </TextField>
        </Stack>
        <FormControlLabel control={<Switch checked={p.required !== false} disabled={disabled} onChange={(e) => set({ required: e.target.checked })} />} label="Required" />
        {p.type === 'choice' && (
          <Autocomplete
            multiple
            freeSolo
            options={[]}
            value={p.options ?? []}
            onChange={(_e, v) => set({ options: (v as string[]).map((o) => o.trim()).filter((o, i, all) => o && all.indexOf(o) === i).slice(0, 50) })}
            disabled={disabled}
            renderValue={(value, getItemProps) =>
              value.map((o, index) => {
                const { key, ...props } = getItemProps({ index });
                return <Chip key={key} label={o} size="small" {...props} />;
              })
            }
            renderInput={(params) => <TextField {...params} label="Options" helperText="Type an option and press Enter. 2 to 50." />}
          />
        )}
        <FormControlLabel
          control={<Switch checked={p.sensitive === true} disabled={disabled} onChange={(e) => setSensitive(e.target.checked)} />}
          label="Sensitive"
        />
        {p.sensitive ? (
          <FormHelperText sx={{ mt: -1.5 }}>Asked every time, never stored. The agent types it without seeing it.</FormHelperText>
        ) : (
          <FormControl component="fieldset" disabled={disabled}>
            <FormLabel component="legend" id={`${uid}-default`}>
              Value
            </FormLabel>
            <RadioGroup aria-labelledby={`${uid}-default`} value={mode} onChange={(e) => setMode(e.target.value as DefaultMode)}>
              <FormControlLabel value="ask" control={<Radio />} label="Ask every time" sx={TAP} />
              <FormControlLabel value="value" control={<Radio />} label="Always use this value" sx={TAP} />
              {memories !== null && <FormControlLabel value="memory" control={<Radio />} label="From a memory" sx={TAP} disabled={disabled || memories.length === 0} />}
              <FormControlLabel value="identity" control={<Radio />} label="From your saved details" sx={TAP} disabled={disabled || p.type !== 'text'} />
            </RadioGroup>
            {p.type !== 'text' && <FormHelperText>Saved details are filled as text: set the type to Text to use them.</FormHelperText>}
            {mode === 'identity' && identity && (
              <Box sx={{ mt: 1 }}>
                <TextField select label="Which saved detail" value={identity.field} onChange={(e) => set({ default: { identity: { field: e.target.value } } })} fullWidth disabled={disabled} helperText="The agent fills it from your secrets provider. The value is never shown to the agent or stored.">
                  {Object.entries(IDENTITY_FIELD_LABEL).map(([key, label]) => (
                    <MenuItem key={key} value={key} sx={{ minHeight: 44 }}>
                      {label}
                    </MenuItem>
                  ))}
                </TextField>
              </Box>
            )}
            {memories !== null && memories.length === 0 && <FormHelperText>You have no memories yet. Add one on the Memories page to use it here.</FormHelperText>}
            {mode === 'value' && p.default && 'value' in p.default && (
              <Box sx={{ mt: 1 }}>
                <ParameterField def={{ ...p, label: `${p.label}: saved value`, help: undefined }} value={p.default.value} onChange={(v) => set({ default: { value: v } })} disabled={disabled} />
              </Box>
            )}
            {mode === 'memory' && memory && memories && (
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mt: 1 }}>
                <TextField
                  select
                  label="Memory"
                  value={picked ? memory.id : ''}
                  onChange={(e) => {
                    const m = memories.find((x) => x.id === e.target.value);
                    set({ default: { memory: { id: e.target.value, attribute: m?.attributes[0] ?? '' } } });
                  }}
                  fullWidth
                  disabled={disabled}
                  helperText={!picked && memory.id ? 'This memory no longer exists: the value will be asked for' : undefined}
                >
                  {memories.map((m) => (
                    <MenuItem key={m.id} value={m.id} sx={{ minHeight: 44 }}>
                      {m.label}
                    </MenuItem>
                  ))}
                </TextField>
                <TextField select label="Which value" value={picked?.attributes.includes(memory.attribute) ? memory.attribute : ''} onChange={(e) => set({ default: { memory: { id: memory.id, attribute: e.target.value } } })} fullWidth disabled={disabled || !picked}>
                  {(picked?.attributes ?? []).map((a) => (
                    <MenuItem key={a} value={a} sx={{ minHeight: 44 }}>
                      {a}
                    </MenuItem>
                  ))}
                </TextField>
              </Stack>
            )}
          </FormControl>
        )}
        <TextField label="Help text" value={p.help ?? ''} onChange={(e) => set({ help: e.target.value || undefined })} disabled={disabled} fullWidth helperText="One line under the field when it is asked for." slotProps={{ htmlInput: { maxLength: 200 } }} />
        <Box>
          <Button size="small" onClick={() => setMore((m) => !m)} aria-expanded={more} aria-controls={`${uid}-more`} sx={TAP}>
            More
          </Button>
          <Collapse in={more} id={`${uid}-more`}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mt: 1 }}>
              {numeric && (
                <>
                  <TextField label="Minimum" type="number" value={p.constraints?.min ?? ''} onChange={(e) => setConstraint('min', e.target.value)} disabled={disabled} fullWidth slotProps={{ htmlInput: { inputMode: 'decimal' } }} />
                  <TextField label="Maximum" type="number" value={p.constraints?.max ?? ''} onChange={(e) => setConstraint('max', e.target.value)} disabled={disabled} fullWidth slotProps={{ htmlInput: { inputMode: 'decimal' } }} />
                </>
              )}
              <TextField label="Maximum length" type="number" value={p.constraints?.maxLength ?? ''} onChange={(e) => setConstraint('maxLength', e.target.value)} disabled={disabled} fullWidth slotProps={{ htmlInput: { inputMode: 'numeric', min: 1 } }} />
            </Stack>
          </Collapse>
        </Box>
      </Stack>
    </Paper>
  );
}

/**
 * The Parameters section of the task form (#556): one row per `{{Name}}`
 * placeholder of the goal, in order of appearance. The rows follow the goal
 * (the form keeps them in step with the shared parser); this component only
 * edits each definition.
 */
export function ParametersSection({ parameters, onChange, memories, errors = {}, disabled }: ParametersSectionProps) {
  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        Each <Box component="code">{'{{Name}}'}</Box> in the goal is a blank. Say what it is, and whether the task asks for it each time or uses a saved value.
      </Typography>
      {parameters.map((p) => (
        <ParameterRow key={p.key} p={p} onChange={(next) => onChange(p.key, next)} memories={memories} error={errors[p.key]} disabled={disabled} />
      ))}
    </Stack>
  );
}
