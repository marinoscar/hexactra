import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Drawer, Stack, Typography } from '@mui/material';
import { useCallback, useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';

import { useBreakpoint, useProfileTimeZone } from '../ui';
import { ParameterField } from './ParameterField';
import { filledValues, isMissing, issuesByKey, loadSuggestions, saveSuggestions, savedParameters, savedValueText, valuesErrors, type TaskParameter } from './model';

/** What the dialog needs of a task. */
export interface ParamTask {
  id: string;
  name: string;
  parameters?: TaskParameter[] | null;
}

export interface RunInputsDialogProps {
  open: boolean;
  task: ParamTask;
  /** Starts the run with these inputs. Rejects with the API's error, which is shown on its field. */
  onStart: (inputs: Record<string, string>) => Promise<void>;
  onClose: () => void;
}

/** The parameters the dialog asks for: required without a saved value, never a sensitive one (asked when the run starts). */
function askedHere(params: readonly TaskParameter[]): TaskParameter[] {
  return params.filter((p) => isMissing(p) && !p.sensitive);
}

/** Whether running the task needs the dialog: some value has no saved one and can be typed here. */
export function needsRunInputs(task: Pick<ParamTask, 'parameters'>): boolean {
  return askedHere(task.parameters ?? []).length > 0;
}

/**
 * "Run now" on a task with values still missing (#556): one field per missing
 * parameter, the saved values listed below with "Change", and one Start. A
 * dialog from `sm` up, a bottom sheet on a phone. The last values typed for
 * the task are offered as suggestions (this browser only, never a sensitive
 * one). A sensitive parameter is never typed here: the API refuses it, and the
 * run asks for it in a secure field when it starts.
 */
export function RunInputsDialog({ open, task, onStart, onClose }: RunInputsDialogProps) {
  const { isPhone } = useBreakpoint();
  const timeZone = useProfileTimeZone();
  const titleId = useId();
  const params = useMemo(() => task.parameters ?? [], [task.parameters]);
  const asked = useMemo(() => askedHere(params), [params]);
  const saved = useMemo(() => savedParameters(params), [params]);
  const sensitive = useMemo(() => params.filter((p) => p.sensitive), [params]);
  const suggestions = useMemo(() => (open ? loadSuggestions(task.id) : {}), [open, task.id]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [changing, setChanging] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const shown = [...asked, ...saved.filter((p) => changing.has(p.key))];
  const local = valuesErrors(shown.map((p) => (changing.has(p.key) ? { ...p, required: false } : p)), values, { timeZone });
  const set = (key: string, v: string) => {
    setValues((all) => ({ ...all, [key]: v }));
    setErrors(({ [key]: _gone, ...rest }) => rest);
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setTouched(true);
    if (Object.keys(local).length) return;
    setBusy(true);
    setBanner(null);
    const inputs = filledValues(Object.fromEntries(shown.map((p) => [p.key, values[p.key] ?? ''])));
    try {
      await onStart(inputs);
      saveSuggestions(task.id, shown, inputs);
    } catch (err) {
      const issues = (err as { issues?: Record<string, string> | null }).issues ?? issuesByKey(err);
      if (issues) setErrors(issues);
      setBanner(err instanceof Error && err.message ? err.message : 'Could not start the run');
    } finally {
      setBusy(false);
    }
  };

  const body: ReactNode = (
    <Stack spacing={2} component="form" id={`${titleId}-form`} onSubmit={(e) => void submit(e)} noValidate>
      {banner && (
        <Alert severity="error" role="alert">
          {banner}
        </Alert>
      )}
      {asked.map((p, i) => (
        <ParameterField key={p.key} def={p} value={values[p.key] ?? ''} onChange={(v) => set(p.key, v)} error={errors[p.key] ?? (touched ? local[p.key] : null)} disabled={busy} suggestions={suggestions[p.key]} autoFocus={i === 0} />
      ))}
      {saved.length > 0 && (
        <Box component="section" aria-label="Using saved values">
          <Typography variant="subtitle2" component="h3" sx={{ mb: 1 }}>
            Using saved values
          </Typography>
          <Stack spacing={1.5}>
            {saved.map((p) =>
              changing.has(p.key) ? (
                <ParameterField key={p.key} def={{ ...p, required: false, help: p.help ?? `Leave empty to use the saved value (${savedValueText(p)})` }} value={values[p.key] ?? ''} onChange={(v) => set(p.key, v)} error={errors[p.key] ?? (touched ? local[p.key] : null)} disabled={busy} suggestions={suggestions[p.key]} />
              ) : (
                <Stack key={p.key} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2" color="text.secondary">
                      {p.label}
                    </Typography>
                    <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                      {savedValueText(p)}
                    </Typography>
                  </Box>
                  <Button size="small" disabled={busy} onClick={() => setChanging((s) => new Set([...s, p.key]))} sx={{ minHeight: { xs: 44, sm: 'auto' } }} aria-label={`Change ${p.label}`}>
                    Change
                  </Button>
                </Stack>
              ),
            )}
          </Stack>
        </Box>
      )}
      {sensitive.length > 0 && (
        <Typography variant="body2" color="text.secondary">
          {sensitive.map((p) => p.label).join(', ')} {sensitive.length === 1 ? 'is' : 'are'} asked for when the run starts, in a secure field. Never stored.
        </Typography>
      )}
    </Stack>
  );

  const actions = (
    <>
      <Button onClick={onClose} disabled={busy} sx={{ minHeight: 44 }}>
        Cancel
      </Button>
      <Button type="submit" form={`${titleId}-form`} variant="contained" loading={busy} disabled={busy} sx={{ minHeight: 44 }}>
        Start
      </Button>
    </>
  );

  const title = `Run “${task.name}”`;
  if (isPhone) {
    return (
      <Drawer anchor="bottom" open={open} onClose={busy ? undefined : onClose} slotProps={{ paper: { role: 'dialog', 'aria-modal': true, 'aria-labelledby': titleId, sx: { borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '90vh' } } as never }}>
        <Box sx={{ p: 2, overflowY: 'auto' }}>
          <Typography variant="h6" component="h2" id={titleId} sx={{ mb: 2, overflowWrap: 'anywhere' }}>
            {title}
          </Typography>
          {body}
          <Stack direction="row" spacing={1} sx={{ mt: 2, justifyContent: 'flex-end' }}>
            {actions}
          </Stack>
        </Box>
      </Drawer>
    );
  }
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} aria-labelledby={titleId} fullWidth maxWidth="sm">
      <DialogTitle id={titleId} sx={{ overflowWrap: 'anywhere' }}>
        {title}
      </DialogTitle>
      <DialogContent>
        <Box sx={{ pt: 1 }}>{body}</Box>
      </DialogContent>
      <DialogActions>{actions}</DialogActions>
    </Dialog>
  );
}

/**
 * Runs a task, asking for its missing values first when it has any (#556).
 * `ask(task, start)` resolves to what `start` resolved to, or null when the
 * person cancelled. Render `dialog` once in the page.
 */
export function useRunInputs(): {
  ask: <T>(task: ParamTask, start: (inputs: Record<string, string> | undefined) => Promise<T>) => Promise<T | null>;
  dialog: ReactNode;
} {
  const [state, setState] = useState<{ task: ParamTask; start: (inputs: Record<string, string>) => Promise<void>; cancel: () => void } | null>(null);
  const ask = useCallback(<T,>(task: ParamTask, start: (inputs: Record<string, string> | undefined) => Promise<T>): Promise<T | null> => {
    if (!needsRunInputs(task)) return start(undefined);
    return new Promise<T | null>((resolve) => {
      setState({
        task,
        start: async (inputs) => {
          // A failure stays in the dialog (shown on its field); anything else closes it.
          const result = await start(inputs);
          setState(null);
          resolve(result);
        },
        cancel: () => {
          setState(null);
          resolve(null);
        },
      });
    });
  }, []);
  const dialog = state ? <RunInputsDialog open task={state.task} onStart={state.start} onClose={state.cancel} /> : null;
  return { ask, dialog };
}
