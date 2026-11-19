import AddIcon from '@mui/icons-material/Add';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import { Alert, Autocomplete, Box, Button, Chip, Collapse, FormControlLabel, IconButton, MenuItem, Paper, Stack, Switch, TextField, Tooltip, Typography } from '@mui/material';
import { useState } from 'react';

import { MAX_OUTPUTS, OUTPUT_TYPE_LABEL, OUTPUT_TYPE_ORDER, effectiveKeys, newOutput, type TaskOutput, type TaskOutputType } from './model';

export interface OutputsSectionProps {
  outputs: readonly TaskOutput[];
  onChange: (next: TaskOutput[]) => void;
  /** Messages by row index (the form's checks, or the server's `details.issues`), and `-1` for the section. */
  errors?: Record<number, string>;
  /** The task has a schedule: with no outputs a hint says to add some. */
  scheduled?: boolean;
  disabled?: boolean;
}

const TAP = { minHeight: { xs: 44, sm: 'auto' } } as const;

/** One output's row: label, type, required, sensitive, what to look for, and (under "More") its key. */
function OutputRow({
  o,
  index,
  count,
  keyShown,
  error,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  o: TaskOutput;
  index: number;
  count: number;
  keyShown: string;
  error?: string;
  disabled?: boolean;
  onChange: (next: TaskOutput) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const [more, setMore] = useState(Boolean(o.key));
  const set = (change: Partial<TaskOutput>) => onChange({ ...o, ...change });
  const setType = (type: TaskOutputType) => {
    const next: TaskOutput = { ...o, type };
    if (type !== 'choice') delete next.options;
    else if (!next.options) next.options = [];
    onChange(next);
  };
  const name = o.label.trim() || `Output ${index + 1}`;
  return (
    <Paper variant="outlined" role="group" aria-label={`Output ${name}`} data-field={`output:${index}`} tabIndex={-1} sx={{ p: { xs: 1.5, sm: 2 }, borderColor: error ? 'error.main' : undefined, outline: 'none' }}>
      <Stack spacing={2}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5, minWidth: 0 }}>
            <Chip size="small" variant="outlined" label={keyShown} sx={{ fontFamily: 'monospace', maxWidth: '100%' }} />
            {o.sensitive && <Chip size="small" color="warning" variant="outlined" label="Sensitive" />}
          </Stack>
          <Stack direction="row" sx={{ flexShrink: 0 }}>
            <Tooltip title="Move up">
              <span>
                <IconButton aria-label={`Move ${name} up`} size="small" disabled={disabled || index === 0} onClick={() => onMove(-1)} sx={{ minWidth: 44, minHeight: 44 }}>
                  <ArrowUpwardIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Move down">
              <span>
                <IconButton aria-label={`Move ${name} down`} size="small" disabled={disabled || index === count - 1} onClick={() => onMove(1)} sx={{ minWidth: 44, minHeight: 44 }}>
                  <ArrowDownwardIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Remove">
              <span>
                <IconButton aria-label={`Remove ${name}`} size="small" disabled={disabled} onClick={onRemove} sx={{ minWidth: 44, minHeight: 44 }}>
                  <DeleteOutlinedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        </Stack>
        {error && (
          <Alert severity="error" role="alert">
            {error}
          </Alert>
        )}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField label="Label" value={o.label} onChange={(e) => set({ label: e.target.value })} disabled={disabled} fullWidth placeholder="Confirmation number" slotProps={{ htmlInput: { maxLength: 80 } }} />
          <TextField select label="Type" value={o.type} onChange={(e) => setType(e.target.value as TaskOutputType)} disabled={disabled} sx={{ minWidth: { sm: 200 } }} fullWidth>
            {OUTPUT_TYPE_ORDER.map((t) => (
              <MenuItem key={t} value={t} sx={{ minHeight: 44 }}>
                {OUTPUT_TYPE_LABEL[t]}
              </MenuItem>
            ))}
          </TextField>
        </Stack>
        {o.type === 'choice' && (
          <Autocomplete
            multiple
            freeSolo
            options={[]}
            value={o.options ?? []}
            onChange={(_e, v) => set({ options: (v as string[]).map((x) => x.trim()).filter((x, i, all) => x && all.indexOf(x) === i).slice(0, 50) })}
            disabled={disabled}
            renderValue={(value, getItemProps) =>
              value.map((opt, i) => {
                const { key, ...props } = getItemProps({ index: i });
                return <Chip key={key} label={opt} size="small" {...props} />;
              })
            }
            renderInput={(params) => <TextField {...params} label="Options" helperText="Type an option and press Enter. 2 to 50." />}
          />
        )}
        <TextField
          label="What to look for"
          value={o.help ?? ''}
          onChange={(e) => set({ help: e.target.value })}
          disabled={disabled}
          fullWidth
          helperText="Optional, one line. The agent reads it."
          slotProps={{ htmlInput: { maxLength: 200 } }}
        />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 0, sm: 3 }}>
          <FormControlLabel control={<Switch checked={o.required !== false} disabled={disabled} onChange={(e) => set({ required: e.target.checked })} />} label="Required" />
          <FormControlLabel control={<Switch checked={o.sensitive === true} disabled={disabled} onChange={(e) => set({ sensitive: e.target.checked || undefined })} />} label="Sensitive" />
        </Stack>
        {o.sensitive && <Typography variant="body2" color="text.secondary" sx={{ mt: -1 }}>Hidden wherever you or an export see it, and never sent to an AI app.</Typography>}
        <Box>
          <Button size="small" onClick={() => setMore((m) => !m)} aria-expanded={more} sx={TAP}>
            {more ? 'Less' : 'More'}
          </Button>
          <Collapse in={more}>
            <TextField
              label="Key"
              value={o.key}
              onChange={(e) => set({ key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })}
              disabled={disabled}
              fullWidth
              placeholder={keyShown}
              helperText="How the value is named in exports, webhooks and the API. Left empty, it follows the label."
              slotProps={{ htmlInput: { maxLength: 40 } }}
              sx={{ mt: 1 }}
            />
          </Collapse>
        </Box>
      </Stack>
    </Paper>
  );
}

/**
 * The Outputs section of the task form (E39.5, #600): rows of label, type, required, what to look for and sensitive, added,
 * removed and reordered; the key follows the label and is editable under "More". A scheduled task with no outputs gets a hint.
 */
export function OutputsSection({ outputs, onChange, errors, scheduled, disabled }: OutputsSectionProps) {
  const keys = effectiveKeys(outputs);
  const full = outputs.length >= MAX_OUTPUTS;
  const replace = (i: number, next: TaskOutput) => onChange(outputs.map((o, n) => (n === i ? next : o)));
  const move = (i: number, by: -1 | 1) => {
    const next = [...outputs];
    const [row] = next.splice(i, 1);
    next.splice(i + by, 0, row!);
    onChange(next);
  };
  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        What you want back from every run, as named values: an amount paid, a confirmation number, a date. The agent has to return them when it finishes; they are kept with the run and listed on this task.
      </Typography>
      {errors?.[-1] && (
        <Alert severity="error" role="alert" data-field="outputs" tabIndex={-1}>
          {errors[-1]}
        </Alert>
      )}
      {outputs.length === 0 && scheduled && <Alert severity="info">Add outputs to keep a record of each run.</Alert>}
      {outputs.map((o, i) => (
        <OutputRow
          key={i}
          o={o}
          index={i}
          count={outputs.length}
          keyShown={keys[i]!}
          error={errors?.[i]}
          disabled={disabled}
          onChange={(next) => replace(i, next)}
          onMove={(by) => move(i, by)}
          onRemove={() => onChange(outputs.filter((_x, n) => n !== i))}
        />
      ))}
      <Box>
        <Button variant="outlined" startIcon={<AddIcon />} onClick={() => onChange([...outputs, newOutput()])} disabled={disabled || full} sx={TAP}>
          Add an output
        </Button>
        {full && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            At most {MAX_OUTPUTS} outputs.
          </Typography>
        )}
      </Box>
    </Stack>
  );
}
