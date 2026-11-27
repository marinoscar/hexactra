import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormLabel,
  IconButton,
  MenuItem,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { Fragment, useEffect, useId, useRef, useState } from 'react';

import { inputModeOf, type TaskParameter } from '../taskParams/model';
import { useBreakpoint } from '../ui';
import { batchFormErrors, parsePastedRows, type Batch, type BatchFormErrors } from './model';

const WRAP = { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 } as const;
const TAP = { minHeight: { xs: 44, sm: 36 } } as const;

interface FormRow {
  id: number;
  values: Record<string, string>;
}

export interface RunForSeveralDialogProps {
  open: boolean;
  task: { id: string; name: string; parameters?: TaskParameter[] | null };
  onClose: () => void;
  /** The batch was created and its first row started. */
  onStarted: (batch: Batch) => void;
}

const filled = (r: FormRow) => Object.values(r.values).some((v) => v.trim() !== '');

/** One cell: a compact field for a value of one parameter (a select for a choice). */
function Cell({ def, value, onChange, error, label, disabled, inTable = false }: { def: TaskParameter; value: string; onChange: (v: string) => void; error?: string; label: string; disabled: boolean; inTable?: boolean }) {
  // In the table the column header names the value: the field has no visible label, only its accessible name ("Row 2: Message").
  const named = inTable ? { slotProps: { htmlInput: { 'aria-label': label, inputMode: inputModeOf(def.type) } } } : null;
  const common = {
    size: 'small' as const,
    fullWidth: true,
    value,
    disabled,
    error: Boolean(error),
    helperText: error,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
    'data-param': def.key,
  };
  if (def.type === 'choice') {
    return (
      <TextField {...common} select {...(inTable ? { slotProps: { htmlInput: { 'aria-label': label } }, SelectProps: { displayEmpty: true, inputProps: { 'aria-label': label } } } : { label, slotProps: { inputLabel: { shrink: true } } })}>
        <MenuItem value="" sx={{ minHeight: 44 }}>
          <em>None</em>
        </MenuItem>
        {(def.options ?? []).map((o) => (
          <MenuItem key={o} value={o} sx={{ minHeight: 44, whiteSpace: 'normal' }}>
            {o}
          </MenuItem>
        ))}
      </TextField>
    );
  }
  const type = def.type === 'date' ? 'date' : 'text';
  if (named) return <TextField {...common} type={type} {...named} />;
  return <TextField {...common} label={label} type={type} slotProps={{ htmlInput: { inputMode: inputModeOf(def.type) }, inputLabel: def.type === 'date' ? { shrink: true } : undefined }} />;
}

/**
 * "Run for several" (E51.1, #1006): a table of the task's parameters, one row per run, with add, remove and paste from a
 * spreadsheet (tab-separated, an optional header of labels). **Start N runs** sends the filled rows to
 * `POST /tasks/{id}/batches`; the API checks every row before anything is written and its per-row errors land on their
 * rows and cells. A blank cell takes the task's saved value (default or memory), as a single run does.
 */
export function RunForSeveralDialog({ open, task, onClose, onStarted }: RunForSeveralDialogProps) {
  const { api } = usePlatformHost();
  const { isPhone } = useBreakpoint();
  const titleId = useId();
  const params = task.parameters ?? [];
  const nextId = useRef(3);
  const [rows, setRows] = useState<FormRow[]>([
    { id: 1, values: {} },
    { id: 2, values: {} },
  ]);
  const [paste, setPaste] = useState('');
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const [onFailure, setOnFailure] = useState<'continue' | 'stop'>('continue');
  const [errors, setErrors] = useState<BatchFormErrors | null>(null);
  /** The row ids in the order they were sent: the API names rows by that position. */
  const [sent, setSent] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    nextId.current = 3;
    setRows([
      { id: 1, values: {} },
      { id: 2, values: {} },
    ]);
    setPaste('');
    setPasteNote(null);
    setOnFailure('continue');
    setErrors(null);
    setSent([]);
  }, [open, task.id]);

  const newRow = (values: Record<string, string> = {}): FormRow => ({ id: nextId.current++, values });
  const toSend = rows.filter(filled);
  const n = toSend.length;
  const errorsOf = (id: number) => {
    const at = sent.indexOf(id);
    return at >= 0 ? errors?.rows[at + 1] : undefined;
  };

  const setValue = (id: number, key: string, value: string) => setRows((prev) => prev.map((r) => (r.id === id ? { ...r, values: { ...r.values, [key]: value } } : r)));
  const remove = (id: number) => setRows((prev) => prev.filter((r) => r.id !== id));
  const addPasted = () => {
    const parsed = parsePastedRows(paste, params);
    if (parsed.rows.length === 0) {
      setPasteNote('Nothing to add: paste rows copied from a spreadsheet, one per line, with a tab between values.');
      return;
    }
    setRows((prev) => [...prev.filter(filled), ...parsed.rows.map((v) => newRow(v))]);
    setPaste('');
    setPasteNote([`Added ${parsed.rows.length} ${parsed.rows.length === 1 ? 'row' : 'rows'}${parsed.header ? ' (the first line was the header)' : ''}.`, ...parsed.warnings].join(' '));
  };

  const start = async () => {
    setBusy(true);
    setErrors(null);
    const order = toSend.map((r) => r.id);
    setSent(order);
    try {
      const body = {
        rows: toSend.map((r) => ({ inputs: Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v !== '')) })),
        onFailure,
      };
      const batch = await api.post<Batch>(`/tasks/${encodeURIComponent(task.id)}/batches`, body);
      onStarted(batch);
    } catch (e) {
      setErrors(batchFormErrors(e, params));
    } finally {
      setBusy(false);
    }
  };

  const rowError = (id: number) => {
    const e = errorsOf(id);
    return e?.row ? (
      <Typography variant="caption" color="error" role="alert" sx={{ display: 'block', ...WRAP }}>
        {e.row}
      </Typography>
    ) : null;
  };
  const removeButton = (r: FormRow, i: number) => (
    <IconButton aria-label={`Remove row ${i + 1}`} onClick={() => remove(r.id)} disabled={busy || rows.length <= 1} sx={{ width: 44, height: 44 }}>
      <DeleteOutlineIcon />
    </IconButton>
  );

  const table = isPhone ? (
    <Stack spacing={1.5} aria-label="Rows">
      {rows.map((r, i) => (
        <Paper key={r.id} variant="outlined" sx={{ p: 1.5 }} data-row={i + 1}>
          <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
            <Typography variant="subtitle2" component="p">
              Row {i + 1}
            </Typography>
            {removeButton(r, i)}
          </Stack>
          <Stack spacing={1.5}>
            {params.map((p) => (
              <Cell key={p.key} def={p} label={p.label} value={r.values[p.key] ?? ''} onChange={(v) => setValue(r.id, p.key, v)} error={errorsOf(r.id)?.cells[p.key]} disabled={busy} />
            ))}
          </Stack>
          {rowError(r.id)}
        </Paper>
      ))}
    </Stack>
  ) : (
    <TableContainer component={Paper} variant="outlined" sx={{ maxWidth: '100%', overflowX: 'auto' }}>
      <Table size="small" aria-label="Rows">
        <TableHead>
          <TableRow>
            <TableCell sx={{ width: 40 }}>#</TableCell>
            {params.map((p) => (
              <TableCell key={p.key} sx={{ ...WRAP, minWidth: 160 }}>
                {p.label}
                {p.required !== false && ' *'}
              </TableCell>
            ))}
            <TableCell sx={{ width: 56 }}>
              <Box component="span" sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
                Remove
              </Box>
            </TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r, i) => (
            <Fragment key={r.id}>
              <TableRow data-row={i + 1}>
                <TableCell sx={{ verticalAlign: 'top', pt: 2 }}>{i + 1}</TableCell>
                {params.map((p) => (
                  <TableCell key={p.key} sx={{ verticalAlign: 'top' }}>
                    <Cell inTable def={p} label={`Row ${i + 1}: ${p.label}`} value={r.values[p.key] ?? ''} onChange={(v) => setValue(r.id, p.key, v)} error={errorsOf(r.id)?.cells[p.key]} disabled={busy} />
                  </TableCell>
                ))}
                <TableCell sx={{ verticalAlign: 'top' }}>{removeButton(r, i)}</TableCell>
              </TableRow>
              {errorsOf(r.id)?.row && (
                <TableRow>
                  <TableCell />
                  <TableCell colSpan={params.length + 1} sx={{ pt: 0 }}>
                    {rowError(r.id)}
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} aria-labelledby={titleId} fullWidth maxWidth="md" fullScreen={isPhone}>
      <DialogTitle id={titleId} sx={WRAP}>
        Run {task.name} for several
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            One run per row, one after another. Each run asks before a send or a payment, as a single run does. A blank value uses the task&apos;s saved value.
          </Typography>
          {errors && (
            <Alert severity="error" sx={WRAP} onClose={() => setErrors(null)}>
              {errors.message}
            </Alert>
          )}
          {table}
          <Box>
            <Button startIcon={<AddIcon />} onClick={() => setRows((prev) => [...prev, newRow()])} disabled={busy} sx={TAP}>
              Add row
            </Button>
          </Box>
          <Box>
            <TextField
              label="Paste rows"
              multiline
              minRows={2}
              maxRows={8}
              fullWidth
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              disabled={busy}
              helperText={`Copy cells from a spreadsheet: one row per line. The first line may name the columns (${params.map((p) => p.label).join(', ')}); otherwise they are in that order.`}
            />
            <Button onClick={addPasted} disabled={busy || paste.trim() === ''} sx={{ mt: 1, ...TAP }}>
              Add pasted rows
            </Button>
            {pasteNote && (
              <Typography variant="body2" role="status" sx={{ mt: 0.5, ...WRAP }}>
                {pasteNote}
              </Typography>
            )}
          </Box>
          <FormControl>
            <FormLabel id={`${titleId}-fail`}>When a run fails</FormLabel>
            <RadioGroup aria-labelledby={`${titleId}-fail`} value={onFailure} onChange={(e) => setOnFailure(e.target.value === 'stop' ? 'stop' : 'continue')}>
              <FormControlLabel value="continue" control={<Radio />} label="Go on with the next row" disabled={busy} />
              <FormControlLabel value="stop" control={<Radio />} label="Stop the rows not started" disabled={busy} />
            </RadioGroup>
          </FormControl>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ flexDirection: { xs: 'column-reverse', sm: 'row' }, alignItems: 'stretch', gap: 1, px: 3, pb: 2, '& > :not(style) ~ :not(style)': { ml: { xs: 0, sm: 1 } } }}>
        <Button onClick={onClose} disabled={busy} sx={TAP}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void start()} disabled={busy || n < 2} sx={TAP}>
          {busy ? 'Starting…' : `Start ${n} ${n === 1 ? 'run' : 'runs'}`}
        </Button>
      </DialogActions>
      {n < 2 && (
        <Typography variant="caption" color="text.secondary" sx={{ px: 3, pb: 2, textAlign: 'right' }}>
          Fill at least 2 rows. For one, use Run.
        </Typography>
      )}
    </Dialog>
  );
}
