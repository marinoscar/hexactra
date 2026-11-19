import MoreVertIcon from '@mui/icons-material/MoreVert';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Collapse,
  FormControl,
  FormControlLabel,
  FormHelperText,
  FormLabel,
  IconButton,
  Menu,
  MenuItem,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { useConnections } from '../connections/useConnections';
import { DeliveriesSection } from '../deliveries/DeliveriesSection';
import { DeliverySecretsDialog } from '../deliveries/DeliverySecretsDialog';
import { summarize } from '../deliveries/drafts';
import { syncDeliveries, type CreatedSecret } from '../deliveries/sync';
import { deliveryErrorText } from '../deliveries/drafts';
import { useTaskDeliveries } from '../deliveries/useTaskDeliveries';
import { AccountsSection } from '../taskConnections/AccountsSection';
import { summaryLine, type ConnectionSelection, type NeedsBrowser } from '../taskConnections/model';
import { CollapsedSection } from '../taskForm/CollapsedSection';
import { AllowedSitesInput } from './AllowedSitesInput';
import { MachinePicker } from './MachinePicker';
import { ProfilePicker } from './ProfilePicker';
import { ScheduleEditor } from './ScheduleEditor';
import { ScheduleSummary, type ScheduleSummaryData } from './ScheduleSummary';
import { SavedCardsSwitch, SavedIdentitySwitch, SavedLoginsSwitch } from '../secrets/SavedLoginsSwitch';
import { useSavedLoginsAvailability } from '../secrets/useSavedLoginsAvailability';
import { runTaskWith } from '../policies/api';
import { NO_HARD_STOP_WARNING, budgetSummary, hasNoHardStop, startModel, tierRange } from '../policies/format';
import { PolicySelect } from '../policies/PolicySelect';
import { usePolicyCatalog } from '../policies/usePolicyCatalog';
import type { ScheduleDraft } from '../schedule/draft';
import { useSchedulePreview } from '../schedule/useSchedulePreview';
import { createTask, deleteTask, replaceTaskSchedules, updateTask } from '../taskForm/api';
import { effectiveKeys, type TaskOutput } from '../taskOutputs/model';
import { OutputsSection } from '../taskOutputs/OutputsSection';
import { GoalField } from '../taskParams/GoalField';
import { previewGoal, syncParameters, type TaskParameter } from '../taskParams/model';
import { ParametersSection } from '../taskParams/ParametersSection';
import { useRunInputs } from '../taskParams/RunInputsDialog';
import { useMemoryOptions } from '../taskParams/useMemoryOptions';
import { useLeaveGuard } from '../taskForm/useLeaveGuard';
import {
  GOAL_MAX,
  MAX_SCHEDULES,
  NAME_COUNTER_FROM,
  NAME_MAX,
  createBody,
  isDirty,
  mapApiError,
  newFormSchedule,
  patchBody,
  savedParameters,
  scheduleItems,
  schedulesChanged,
  validateValues,
  type FieldErrors,
  type TaskFieldValues,
  type TaskFormValues,
} from '../taskForm/values';
import type { FleetHost } from '../types/fleet';
import { ErrorBanner, aboveBottomBar, toast, useBreakpoint, useConfirm, useProfileTimeZone } from '../ui';

export interface TaskFormProps {
  mode: 'create' | 'edit';
  /** The task being edited (`mode: 'edit'`). */
  taskId?: string;
  /** What the form starts from: empty, a prefilled goal, a copy, or the saved task. */
  initial: TaskFormValues;
  /** The saved schedules by id: what a collapsed, unchanged schedule shows (its words, its next run). */
  savedSchedules?: readonly (ScheduleSummaryData & { id: string })[];
  /** Where Cancel goes. */
  cancelTo: string;
  /** Called once a new task was created, before the form leaves (a chat is told its draft was saved). Its failure never fails the save. */
  onCreated?: (taskId: string) => void | Promise<void>;
  /** A new task from nothing starts with the owner's default for "Use my saved logins" (E37.4); a copy or a chat's draft keeps its own. */
  useOwnerSavedLoginsDefault?: boolean;
}

/** Where the form goes after a save (the task's page, #428). */
export const taskPath = (id: string) => `/tasks/${id}`;

export const GOAL_HELP = 'Say what you want done and what you want back. Example: “Open my electricity account, read the amount due and the due date, and tell me both.”';

const MIN_TAP = { minHeight: { xs: 44, sm: 'auto' } } as const;

/** One schedule of the form: its draft, a stable key, and whether Save will delete it. */
interface ScheduleRow {
  key: string;
  draft: ScheduleDraft;
  removed: boolean;
}

interface FormState {
  fields: TaskFieldValues;
  rows: ScheduleRow[];
  /** What the server holds: the form is dirty when it differs. */
  initial: TaskFormValues;
  /** Messages by field: a task field's name, `schedule:<row key>`, or `schedules` (the section). */
  errors: FieldErrors;
  banner: string | null;
  saving: null | 'save' | 'run' | 'delete';
}

let rowSeq = 0;
const toRow = (draft: ScheduleDraft): ScheduleRow => ({ key: draft.id ?? `new-${++rowSeq}`, draft, removed: false });

function initialState(initial: TaskFormValues): FormState {
  const { schedules, ...fields } = initial;
  return { fields, rows: schedules.map(toRow), initial, errors: {}, banner: null, saving: null };
}

const FIELD_ORDER = ['name', 'goal', 'parameters', 'outputs', 'hostId', 'profile', 'policyId', 'allowedDomains'];

function Section({ title, id, children, anchor }: { title: string; id: string; children: ReactNode; anchor?: string }) {
  return (
    <Card variant="outlined" component="section" aria-labelledby={id} id={anchor} sx={{ scrollMarginTop: 72 }}>
      <CardContent sx={{ p: { xs: 2, sm: 3 }, '&:last-child': { pb: { xs: 2, sm: 3 } } }}>
        <Typography variant="h6" component="h2" id={id} sx={{ mb: 2 }}>
          {title}
        </Typography>
        <Stack spacing={2}>{children}</Stack>
      </CardContent>
    </Card>
  );
}

/** A collapsed schedule in words: the saved row's own text while it is unchanged, else the server's preview of the draft. */
function DraftSummary({ draft, saved, catalog, profileTimezone }: { draft: ScheduleDraft; saved?: ScheduleSummaryData; catalog?: Parameters<typeof ScheduleSummary>[0]['catalog']; profileTimezone: string }) {
  // The saved row while the draft still says the same thing.
  const same = saved && saved.cron === draft.cron && saved.timezone === draft.timezone ? saved : undefined;
  const preview = useSchedulePreview(same ? null : draft.cron, draft.timezone, 1);
  const described = preview.result?.valid ? preview.result : null;
  const schedule: ScheduleSummaryData = {
    cron: draft.cron,
    timezone: draft.timezone,
    enabled: draft.enabled,
    policyId: draft.policyId,
    description: same ? same.description : described?.description,
    nextRunAt: same && same.enabled === draft.enabled ? same.nextRunAt : (described?.next[0] ?? null),
    consecutiveFailures: same ? same.consecutiveFailures : 0,
  };
  return <ScheduleSummary schedule={schedule} catalog={catalog} profileTimezone={profileTimezone} />;
}

/**
 * The task form (#427): what the agent should do, where it runs, its agent
 * policy, the per-task safety opt-ins and its schedules, saved in one step.
 *
 * Create sends one `POST /tasks` (the schedules with it). Edit sends
 * `PATCH /tasks/:id` with the changed fields only, then
 * `PUT /tasks/:id/schedules` when the schedule set changed. It never sends
 * `maxSteps`, `maxMinutes` or `model`; `policyId` goes only when the viewer
 * may read agent policies. Needs a `ConfirmProvider` and a router above it.
 */
export function TaskForm({ mode, taskId, initial, savedSchedules, cancelTo, onCreated, useOwnerSavedLoginsDefault }: TaskFormProps) {
  const { api, viewer } = usePlatformHost();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { isPhone } = useBreakpoint();
  const profileTimezone = useProfileTimeZone();
  const uid = useId();
  const canRun = viewer.hasPermission('runs:write');
  const canFleet = viewer.hasPermission('fleet:read');
  const canPickPolicy = viewer.hasPermission('agent_policies:read');
  const catalog = usePolicyCatalog();
  const memories = useMemoryOptions();
  const runInputs = useRunInputs();
  const accounts = useConnections();
  const deliveries = useTaskDeliveries(mode === 'edit' ? taskId : undefined);
  const canReadConnections = viewer.hasPermission('connections:read');
  const canSeeDeliveries = viewer.hasPermission('runs:read');
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [deliveriesOpen, setDeliveriesOpen] = useState(false);
  const [guidedOpen, setGuidedOpen] = useState(false);
  const [secrets, setSecrets] = useState<{ list: CreatedSecret[]; then: string } | null>(null);

  const [form, setForm] = useState<FormState>(() => initialState(initial));
  const savedLogins = useSavedLoginsAvailability();
  const savedLoginsDefaulted = useRef(false);
  // A new task starts from the owner's default, once it is known; that is the form's starting point, not an edit.
  useEffect(() => {
    if (!useOwnerSavedLoginsDefault || savedLoginsDefaulted.current || !savedLogins.loaded) return;
    savedLoginsDefaulted.current = true;
    if (savedLogins.defaultOn && savedLogins.available) setForm((f) => (f.fields.useSavedLogins ? f : { ...f, fields: { ...f.fields, useSavedLogins: true }, initial: { ...f.initial, useSavedLogins: true } }));
  }, [useOwnerSavedLoginsDefault, savedLogins.loaded, savedLogins.defaultOn, savedLogins.available]);
  const update = (change: Partial<FormState>) => setForm((f) => ({ ...f, ...change }));
  const { fields, rows, errors, saving } = form;
  /** Change task fields; a field's message goes when the field changes. */
  const setFields = (change: Partial<TaskFieldValues>) =>
    setForm((f) => {
      const next = { ...f.errors };
      for (const key of Object.keys(change)) delete next[key];
      return { ...f, fields: { ...f.fields, ...change }, errors: next };
    });

  // Which schedule panels are expanded, and which expanded editors say their draft cannot be saved.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set());
  const toggle = (set: ReadonlySet<string>, key: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(key);
    else next.delete(key);
    return next;
  };
  const [tipsOpen, setTipsOpen] = useState(false);
  // The parameters whose placeholder the last goal edit removed, and the goal before it (Undo puts it back, #556).
  const [removal, setRemoval] = useState<{ goal: string; labels: string[] } | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  // The machines to choose from. Without fleet:read, or when the request fails, the pickers
  // fall back ("Any available machine" only, a profile text field); it never blocks saving.
  const [fleet, setFleet] = useState<{ status: 'loading' | 'ok' | 'none' | 'failed'; hosts: FleetHost[] }>({ status: canFleet ? 'loading' : 'none', hosts: [] });
  useEffect(() => {
    if (!canFleet) return;
    let live = true;
    api
      .get<FleetHost[]>('/fleet/hosts')
      .then((hosts) => live && setFleet({ status: 'ok', hosts }))
      .catch(() => live && setFleet({ status: 'failed', hosts: [] }));
    return () => {
      live = false;
    };
  }, [api, canFleet]);
  const fleetKnown = fleet.status === 'ok' || fleet.status === 'loading';

  // The policy. A failed catalog leaves the task's policy untouched; a policy that no longer exists reads as the default.
  const policyFailed = canPickPolicy && catalog.error !== null;
  const sendPolicy = canPickPolicy && !policyFailed;
  const policyMissing = sendPolicy && !catalog.loading && catalog.policies.length > 0 && fields.policyId !== null && !catalog.byId(fields.policyId);
  const shownPolicyId = policyMissing ? null : fields.policyId;
  const policy = sendPolicy ? catalog.byId(shownPolicyId ?? catalog.defaultId) : undefined;
  const scheduleCatalog = sendPolicy ? catalog : undefined;

  const synced = useMemo(() => syncParameters(fields.goal, fields.parameters), [fields.goal, fields.parameters]);
  const parameters = synced.parameters;
  /** A new goal: rows follow its placeholders; a removed one can be undone. */
  const setGoal = (goal: string) => {
    const before = syncParameters(fields.goal, fields.parameters).parameters;
    const after = syncParameters(goal, fields.parameters);
    const gone = before.filter((p) => !after.parameters.some((q) => q.key === p.key));
    // New placeholders get a definition the form keeps (so a row edit sticks); old ones are kept for Undo until Save.
    const known = new Set(fields.parameters.map((p) => p.key));
    const added = after.parameters.filter((p) => !known.has(p.key));
    setFields({ goal, ...(added.length ? { parameters: [...fields.parameters, ...added] } : {}) });
    if (gone.length) setRemoval({ goal: fields.goal, labels: gone.map((p) => p.label) });
  };
  const setParameter = (key: string, next: TaskParameter) =>
    setForm((f) => {
      const { [`param:${key}`]: _gone, parameters: _section, ...rest } = f.errors;
      const exists = f.fields.parameters.some((p) => p.key === key);
      const list = exists ? f.fields.parameters.map((p) => (p.key === key ? next : p)) : [...f.fields.parameters, next];
      return { ...f, fields: { ...f.fields, parameters: list }, errors: rest };
    });

  const setOutputs = (outputs: TaskOutput[]) =>
    setForm((f) => {
      const { outputs: _section, ...rest } = f.errors;
      for (const k of Object.keys(rest)) if (k.startsWith('output:')) delete rest[k];
      return { ...f, fields: { ...f.fields, outputs }, errors: rest };
    });

  // One line for the folded deliveries section. While the saved list (or the account names it needs) is still loading it says so: "Nothing is
  // sent" must never be shown for a task whose deliveries have not been read yet.
  const deliveriesSummary = deliveries.failed
    ? 'The deliveries could not be loaded.'
    : !deliveries.loaded || (canReadConnections && accounts.connections === null && deliveries.drafts.length === 1)
      ? 'Loading the deliveries…'
      : deliveries.drafts.length === 0
        ? 'Nothing is sent when a run ends.'
        : deliveries.drafts.length === 1
          ? summarize(deliveries.drafts[0]!, accounts.connections ?? [])
          : `${deliveries.drafts.length} deliveries after each run`;
  const setConnections = (connections: ConnectionSelection[]) => setFields({ connections });
  const setNeedsBrowser = (needsBrowser: NeedsBrowser) => setFields({ needsBrowser });

  const values: TaskFormValues = useMemo(() => ({ ...fields, schedules: rows.filter((r) => !r.removed).map((r) => r.draft) }), [fields, rows]);
  const dirty = isDirty(values, form.initial) || deliveries.dirty;
  const local = validateValues(values, { checkProfile: true });

  // The outputs' messages by row: the form's own checks while editing, and the server's after a failed save.
  const outputErrorsByRow: Record<number, string> = {};
  for (const [k, v] of Object.entries({ ...local, ...errors })) {
    if (k === 'outputs') outputErrorsByRow[-1] = v;
    else if (k.startsWith('output:')) outputErrorsByRow[Number(k.slice(7))] = v;
  }
  const required = Boolean(fields.name.trim() && fields.goal.trim()) && synced.errors.length === 0;
  const outputErrors = Object.keys(local).some((k) => k === 'outputs' || k.startsWith('output:'));
  const blocked = saving !== null || !required || Boolean(local.profile) || Boolean(local.allowedDomains) || outputErrors || invalid.size > 0 || (mode === 'edit' && !dirty);
  const busy = saving !== null;
  const activeRows = rows.filter((r) => !r.removed);
  const savedById = useMemo(() => new Map((savedSchedules ?? []).map((s) => [s.id, s])), [savedSchedules]);

  const allowLeave = useLeaveGuard(dirty && saving !== 'delete', () =>
    confirm({ title: 'Discard your changes?', body: 'What you changed on this page has not been saved.', confirmLabel: 'Discard', cancelLabel: 'Keep editing', destructive: true }),
  );

  // Scroll to and focus the first invalid field after a failed save.
  const root = useRef<HTMLFormElement>(null);
  const [focusField, setFocusField] = useState<string | null>(null);
  useEffect(() => {
    if (!focusField) return;
    const holder = root.current?.querySelector<HTMLElement>(`[data-field="${focusField}"]`);
    // A schedule panel takes the focus itself: its label and its error are what a screen reader should read.
    const target = focusField.startsWith('schedule') ? holder : (holder?.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, [role="combobox"]') ?? holder);
    holder?.scrollIntoView?.({ block: 'center' });
    target?.focus({ preventScroll: true });
    setFocusField(null);
  }, [focusField]);

  /** Show a failure: on its fields (opening the schedule it names), else in the banner. */
  const fail = (error: unknown, fallback: string, sent: readonly ScheduleRow[], prefix = '') => {
    const mapped = mapApiError(error, fallback);
    const next: FieldErrors = {};
    const opened: string[] = [];
    for (const [field, message] of Object.entries(mapped.fields)) {
      const index = /^schedules\[(\d+)\]$/.exec(field);
      const row = index ? sent[Number(index[1])] : undefined;
      // An output's problem (E39.5): by the index of what was sent (cleaned rows) or by its key; the row shows it.
      const sentOutput = /^outputs\[(\d+)\]$/.exec(field);
      const keyed = field.startsWith('output-key:') ? effectiveKeys(fields.outputs).indexOf(field.slice('output-key:'.length)) : -1;
      if (field.startsWith('param:')) next[field] = message;
      else if (sentOutput) next[`output:${fields.outputs.map((o, i) => (o.label.trim() ? i : -1)).filter((i) => i >= 0)[Number(sentOutput[1])] ?? 0}`] = message;
      else if (field.startsWith('output-key:')) next[keyed >= 0 ? `output:${keyed}` : 'outputs'] = message;
      else if (row) {
        next[`schedule:${row.key}`] = message;
        opened.push(row.key);
      } else if (index) next.schedules = message;
      else next[field] = message;
    }
    if (opened.length > 0) setOpen((o) => new Set([...o, ...opened]));
    const first = FIELD_ORDER.find((f) => f in next) ?? Object.keys(next).find((k) => k.startsWith('param:') || k.startsWith('output:')) ?? Object.keys(next)[0];
    const text = error instanceof Error && error.message ? error.message : fallback;
    update({ saving: null, errors: next, banner: prefix ? `${prefix}${text}` : mapped.banner });
    if (first) setFocusField(first);
  };

  const submit = async (andRun: boolean) => {
    if (blocked) return;
    const sent = activeRows;
    update({ saving: andRun ? 'run' : 'save', errors: {}, banner: null });
    let id = taskId ?? '';
    if (mode === 'create') {
      try {
        id = (await createTask(api, createBody(values, { sendPolicy }))).id;
      } catch (e) {
        return fail(e, 'Could not create the task', sent);
      }
      // The task exists: whoever asked to hear about it is told, and cannot undo the save by failing.
      await Promise.resolve(onCreated?.(id)).catch(() => undefined);
    } else {
      const { schedules: initialSchedules, ...initialFields } = form.initial;
      const patch = patchBody(fields, initialFields, { sendPolicy });
      if (patch) {
        try {
          await updateTask(api, id, patch);
        } catch (e) {
          return fail(e, 'Could not save the task', sent);
        }
        // The task fields are saved now: a retry after a schedule failure sends the schedules only.
        setForm((f) => ({ ...f, initial: { ...fields, schedules: f.initial.schedules } }));
      }
      if (schedulesChanged(values.schedules, initialSchedules)) {
        try {
          await replaceTaskSchedules(api, id, scheduleItems(values.schedules));
        } catch (e) {
          return fail(e, 'Could not save the schedules', sent, patch ? 'The task was saved but its schedules were not: ' : '');
        }
      }
    }
    // The deliveries (E39.10): saved after the task, which they belong to. A refusal leaves the task saved and says so.
    let dest = taskPath(id);
    let toldSecrets: CreatedSecret[] = [];
    if (canSeeDeliveries && !deliveries.failed && deliveries.dirty) {
      const result = await syncDeliveries(api, id, deliveries.saved, deliveries.drafts);
      deliveries.settle(result.saved, result.drafts);
      toldSecrets = result.secrets;
      if (result.error) {
        const text = deliveryErrorText(result.error.cause);
        if (mode === 'create') {
          // The task exists now: go to its edit page, where the delivery that was refused can be fixed.
          allowLeave();
          toast(`The task was saved, but its deliveries were not: ${text}`, 'error');
          if (toldSecrets.length > 0) return setSecrets({ list: toldSecrets, then: `/tasks/${id}/edit` });
          return navigate(`/tasks/${id}/edit`);
        }
        setDeliveriesOpen(true);
        return update({ saving: null, banner: `The deliveries were not all saved: ${text}` });
      }
    }
    allowLeave();
    toast(mode === 'create' ? 'Task created' : 'Task saved');
    if (andRun) {
      try {
        // Values still missing are asked for first (#556); Cancel leaves the saved task on its page.
        const run = await runInputs.ask({ id, name: fields.name.trim(), parameters: savedParameters(fields) }, (inputs) => runTaskWith(api, id, undefined, inputs));
        if (run) dest = `/runs/${run.id}`;
      } catch (e) {
        toast(`The task was saved, but the run could not be started: ${e instanceof Error && e.message ? e.message : 'try again from the task'}`, 'error');
      }
    }
    if (toldSecrets.length > 0) return setSecrets({ list: toldSecrets, then: dest });
    navigate(dest);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit(false);
  };

  /** Delete asks first: the task's schedules go with it (the same words as the Tasks list). */
  const remove = async () => {
    if (!taskId) return;
    const ok = await confirm({ title: `Delete task “${form.initial.name}”?`, body: 'Its schedules are deleted. Its runs are kept.', confirmLabel: 'Delete', destructive: true });
    if (!ok) return;
    update({ saving: 'delete', banner: null });
    try {
      await deleteTask(api, taskId);
    } catch (e) {
      return update({ saving: null, banner: e instanceof Error && e.message ? e.message : 'Could not delete the task' });
    }
    allowLeave();
    toast('Task deleted');
    navigate('/tasks');
  };

  // ---- Schedules ----
  const setRows = (change: (rows: ScheduleRow[]) => ScheduleRow[]) => setForm((f) => ({ ...f, rows: change(f.rows) }));
  const addSchedule = () => {
    const row = toRow(newFormSchedule(profileTimezone));
    setForm((f) => {
      const { schedules: _section, ...rest } = f.errors;
      return { ...f, rows: [...f.rows, row], errors: rest };
    });
    setOpen((o) => toggle(o, row.key, true));
  };
  const changeDraft = (key: string, draft: ScheduleDraft) =>
    setForm((f) => {
      const { [`schedule:${key}`]: _gone, ...rest } = f.errors;
      return { ...f, rows: f.rows.map((r) => (r.key === key ? { ...r, draft } : r)), errors: rest };
    });
  const removeSchedule = (row: ScheduleRow) => {
    setOpen((o) => toggle(o, row.key, false));
    setInvalid((s) => toggle(s, row.key, false));
    // A saved schedule stays, marked, until Save; a new one just goes.
    setRows((all) => (row.draft.id ? all.map((r) => (r.key === row.key ? { ...r, removed: true } : r)) : all.filter((r) => r.key !== row.key)));
  };

  const nameLength = fields.name.length;
  const nameError = errors.name;
  const goalError = errors.goal;
  const start = policy ? startModel(policy.spec, catalog.effective) : null;

  const progress = <CircularProgress size={18} color="inherit" aria-label="Saving" />;
  const saveButton = (
    <Button type="submit" variant="contained" disabled={blocked} fullWidth={isPhone} startIcon={saving === 'save' ? progress : undefined} sx={{ minHeight: 44 }}>
      Save
    </Button>
  );

  return (
    <Box
      component="form"
      ref={root}
      noValidate
      onSubmit={onSubmit}
      aria-label={mode === 'create' ? 'New task' : 'Edit task'}
      aria-busy={busy}
      // Room for the phone's fixed save bar, so it never covers the last field; a focused field scrolls clear of it.
      sx={{ pb: { xs: 11, sm: 0 }, '& input, & textarea, & [role="combobox"]': { scrollMarginBottom: { xs: 160, sm: 24 } } }}
    >
      <ErrorBanner error={form.banner} onClose={() => update({ banner: null })} />
      <Stack spacing={{ xs: 2, sm: 3 }}>
        <Section title="What should the agent do?" id={`${uid}-what`}>
          <Box data-field="name">
            <TextField
              label="Name"
              value={fields.name}
              onChange={(e) => setFields({ name: e.target.value })}
              required
              fullWidth
              autoFocus={mode === 'create'}
              disabled={busy}
              error={Boolean(nameError)}
              helperText={nameError ?? (nameLength > NAME_COUNTER_FROM ? `${nameLength} / ${NAME_MAX}` : undefined)}
              slotProps={{ htmlInput: { maxLength: NAME_MAX } }}
            />
          </Box>
          <Box data-field="goal">
            <GoalField
              value={fields.goal}
              onChange={setGoal}
              required
              disabled={busy}
              error={goalError}
              maxLength={GOAL_MAX}
              helperText={
                <Box component="span" sx={{ display: 'flex', gap: 2, justifyContent: 'space-between' }}>
                  <span>{GOAL_HELP}</span>
                  <Box component="span" sx={{ flexShrink: 0 }}>
                    {fields.goal.length} / {GOAL_MAX}
                  </Box>
                </Box>
              }
            />
            {parameters.length > 0 && synced.errors.length === 0 && (
              <Typography variant="body2" color="text.secondary" aria-label="Goal preview" sx={{ mt: 1, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
                Preview: {previewGoal(fields.goal, parameters)}
              </Typography>
            )}
          </Box>
          {removal && (
            <Alert
              severity="info"
              role="status"
              onClose={() => setRemoval(null)}
              action={
                <Button
                  color="inherit"
                  size="small"
                  disabled={busy}
                  onClick={() => {
                    setFields({ goal: removal.goal });
                    setRemoval(null);
                  }}
                >
                  Undo
                </Button>
              }
            >
              {removal.labels.length === 1 ? `Parameter “${removal.labels[0]}” removed.` : `Parameters ${removal.labels.map((l) => `“${l}”`).join(', ')} removed.`}
            </Alert>
          )}
          <Box>
            <Button size="small" onClick={() => setTipsOpen((o) => !o)} aria-expanded={tipsOpen} aria-controls={`${uid}-tips`} sx={MIN_TAP}>
              Tips
            </Button>
            <Collapse in={tipsOpen} id={`${uid}-tips`}>
              <Box component="ul" sx={{ m: 0, pl: 3, color: 'text.secondary', typography: 'body2' }}>
                <li>Name the site the agent should use.</li>
                <li>Say what “done” looks like: what you want back, or what should have changed.</li>
                <li>Say what to do when sign-in is needed, for example “ask me”.</li>
              </Box>
            </Collapse>
          </Box>
        </Section>

        {parameters.length > 0 && (
          <Section title="Parameters" id={`${uid}-params`} anchor="parameters">
            {errors.parameters && (
              <Alert severity="error" role="alert" data-field="parameters" tabIndex={-1}>
                {errors.parameters}
              </Alert>
            )}
            <ParametersSection
              parameters={parameters}
              onChange={setParameter}
              memories={memories}
              errors={Object.fromEntries(Object.entries(errors).filter(([k]) => k.startsWith('param:')).map(([k, v]) => [k.slice(6), v]))}
              disabled={busy}
            />
          </Section>
        )}

        {canReadConnections && (
          <CollapsedSection
            title="Accounts the agent may use"
            anchor="accounts"
            summary={accounts.connections === null && fields.connections.length > 0 ? 'Loading your accounts…' : summaryLine(fields.connections, accounts.connections)}
            open={accountsOpen}
            onToggle={setAccountsOpen}
          >
            <AccountsSection
              connections={accounts.connections}
              failed={accounts.failed}
              selections={fields.connections}
              onChange={setConnections}
              disabled={busy}
              browser={{ value: fields.needsBrowser, onChange: setNeedsBrowser, goal: fields.goal }}
            />
          </CollapsedSection>
        )}

        <Section title="Outputs" id={`${uid}-outputs`} anchor="outputs">
          <OutputsSection
            outputs={fields.outputs}
            onChange={setOutputs}
            errors={outputErrorsByRow}
            scheduled={activeRows.length > 0}
            disabled={busy}
          />
        </Section>

        {canSeeDeliveries && (
          <CollapsedSection
            title="Where the result goes"
            anchor="deliveries"
            summary={deliveriesSummary}
            open={deliveriesOpen}
            onToggle={setDeliveriesOpen}
          >
            <DeliveriesSection
              drafts={deliveries.drafts}
              onChange={deliveries.setDrafts}
              saved={deliveries.saved}
              taskId={mode === 'edit' ? (taskId ?? null) : null}
              taskName={fields.name}
              outputs={fields.outputs}
              connections={accounts.connections}
              canEdit={canRun && !busy}
              loadFailed={deliveries.failed}
              guidedOpen={guidedOpen}
              onGuidedOpenChange={setGuidedOpen}
              onGuided={(r) => {
                if (r.outputs.length > 0) setOutputs([...fields.outputs, ...r.outputs]);
                deliveries.setDrafts((old) => [...old, ...r.deliveries]);
              }}
            />
          </CollapsedSection>
        )}

        <Section title="Where it runs" id={`${uid}-where`}>
          <Box data-field="hostId">
            <MachinePicker hosts={fleet.hosts} hostId={fields.hostId} hostFallback={fields.hostFallback} disabled={busy} error={errors.hostId} onChange={setFields} />
          </Box>
          <Stack spacing={2} data-field="profile">
            <ProfilePicker
              hosts={fleetKnown ? fleet.hosts : null}
              hostId={fields.hostId}
              value={fields.profile}
              disabled={busy}
              error={errors.profile ?? local.profile}
              onChange={(profile) => setFields({ profile })}
            />
          </Stack>
          <Typography variant="body2" color="text.secondary">
            The profile holds the sign-ins the agent uses.
            {fleet.status === 'failed' && ' The machines could not be loaded, so any available machine runs it and the profile is typed by name.'}
          </Typography>
        </Section>

        {canPickPolicy && (
          <Section title="Model and budget" id={`${uid}-policy`}>
            <Box data-field="policyId">
              <PolicySelect
                catalog={catalog}
                value={shownPolicyId}
                onChange={(policyId) => setFields({ policyId })}
                manageLink
                summary={false}
                disabled={busy || policyFailed}
                error={errors.policyId}
              />
              {policyFailed && <FormHelperText error>Policies could not be loaded. Saving keeps this task's policy as it is.</FormHelperText>}
              {policyMissing && <FormHelperText>This task's policy was deleted; it runs under your default.</FormHelperText>}
            </Box>
            {policy && (
              <Box>
                <Typography variant="body2" aria-label="Policy summary" sx={{ overflowWrap: 'anywhere' }}>
                  {start?.model ? `Starts on ${start.model}` : 'No model is set for its first tier'} · {tierRange(policy.spec)} · {budgetSummary(policy.spec)}
                </Typography>
                {hasNoHardStop(policy.spec) && (
                  <Typography variant="body2" sx={{ color: 'warning.main', mt: 0.5 }}>
                    {NO_HARD_STOP_WARNING}
                  </Typography>
                )}
              </Box>
            )}
          </Section>
        )}

        <Section title="Safety" id={`${uid}-safety`}>
          <Box data-field="allowedDomains">
            <AllowedSitesInput value={fields.allowedDomains} onChange={(allowedDomains) => setFields({ allowedDomains })} disabled={busy} error={errors.allowedDomains ?? local.allowedDomains} />
          </Box>
          <Box>
            <FormControlLabel
              control={<Switch checked={fields.confirmRiskyActions} disabled={busy} onChange={(e) => setFields({ confirmRiskyActions: e.target.checked })} />}
              label="Ask me before purchases and other irreversible steps"
            />
            <FormHelperText sx={{ mt: 0 }}>The agent pauses and asks in your Inbox.</FormHelperText>
          </Box>
        </Section>

        <Section title="Saved logins and details" id={`${uid}-saved-logins`}>
          <SavedLoginsSwitch checked={fields.useSavedLogins} onChange={(useSavedLogins) => setFields({ useSavedLogins, ...(useSavedLogins ? {} : { useSavedIdentity: false, useSavedCards: false }) })} disabled={busy} availability={savedLogins} />
          <SavedIdentitySwitch checked={fields.useSavedIdentity} onChange={(useSavedIdentity) => setFields({ useSavedIdentity })} disabled={busy} parentOn={fields.useSavedLogins} availability={savedLogins} />
          <SavedCardsSwitch checked={fields.useSavedCards} onChange={(useSavedCards) => setFields({ useSavedCards })} disabled={busy} parentOn={fields.useSavedLogins} availability={savedLogins} />
          <FormControl component="fieldset" disabled={busy || !savedLogins.available || !fields.useSavedLogins} sx={{ ml: { xs: 0, sm: 6 } }}>
            <FormLabel component="legend" id={`${uid}-unattended-label`}>
              When it runs without me and reaches a payment
            </FormLabel>
            <RadioGroup
              aria-labelledby={`${uid}-unattended-label`}
              value={fields.unattendedPayments}
              onChange={(e) => setFields({ unattendedPayments: e.target.value === 'allow' ? 'allow' : 'ask' })}
            >
              <FormControlLabel value="ask" control={<Radio />} label="Ask me" sx={MIN_TAP} />
              <FormControlLabel value="allow" control={<Radio />} label="Go ahead" sx={MIN_TAP} />
            </RadioGroup>
            <FormHelperText sx={{ mt: 0 }} data-testid="unattended-help">
              {fields.unattendedPayments === 'allow' ? 'The agent will pay without asking, while you are not there, after signing in with a saved login, and (with a saved card) only at a shop and up to an amount you remembered in Saved approvals. Choose this only for a task you trust, on a site you listed above. Your saved approvals and the sites you allowed still apply.' : 'A run that signed in with a saved login still stops and asks in your Inbox before it pays, even if you switched the question off above.'}
            </FormHelperText>
            {fields.unattendedPayments === 'allow' && (
              <Alert severity="warning" sx={{ mt: 1 }}>
                &ldquo;Go ahead&rdquo; lets this task spend money unattended.
              </Alert>
            )}
          </FormControl>
        </Section>

        <Section title="Schedule" id={`${uid}-schedule`} anchor="schedule">
          {errors.schedules && (
            <Alert severity="error" role="alert" data-field="schedules" tabIndex={-1}>
              {errors.schedules}
            </Alert>
          )}
          {rows.length === 0 && <Typography color="text.secondary">This task only runs when you start it.</Typography>}
          {rows.map((row) => {
            const number = activeRows.indexOf(row) + 1;
            const error = errors[`schedule:${row.key}`];
            const errorId = `${uid}-schedule-error-${row.key}`;
            if (row.removed) {
              return (
                <Alert
                  key={row.key}
                  severity="info"
                  action={
                    <Button color="inherit" size="small" disabled={busy || activeRows.length >= MAX_SCHEDULES} onClick={() => setRows((all) => all.map((r) => (r.key === row.key ? { ...r, removed: false } : r)))}>
                      Undo
                    </Button>
                  }
                >
                  “{savedById.get(row.key)?.description ?? row.draft.cron}” will be removed when you save.
                </Alert>
              );
            }
            const expanded = open.has(row.key);
            return (
              <Paper key={row.key} variant="outlined" role="group" aria-label={`Schedule ${number}`} aria-describedby={error ? errorId : undefined} data-field={`schedule:${row.key}`} tabIndex={-1} sx={{ p: { xs: 1.5, sm: 2 }, borderColor: error ? 'error.main' : undefined, outline: 'none' }}>
                <Stack spacing={1.5}>
                  {error && (
                    <Alert severity="error" role="alert" id={errorId}>
                      {error}
                    </Alert>
                  )}
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
                    <Box sx={{ flex: '1 1 200px', minWidth: 0 }}>
                      {expanded ? (
                        <Typography variant="subtitle2">Schedule {number}</Typography>
                      ) : (
                        <DraftSummary draft={row.draft} saved={savedById.get(row.key)} catalog={scheduleCatalog} profileTimezone={profileTimezone} />
                      )}
                    </Box>
                    <Stack direction="row" spacing={0.5} sx={{ '& .MuiButton-root': MIN_TAP }}>
                      <Button
                        size="small"
                        disabled={busy || (expanded && invalid.has(row.key))}
                        aria-expanded={expanded}
                        onClick={() => setOpen((o) => toggle(o, row.key, !expanded))}
                      >
                        {expanded ? 'Done' : 'Edit'}
                      </Button>
                      <Button size="small" color="error" disabled={busy} onClick={() => removeSchedule(row)}>
                        Remove
                      </Button>
                    </Stack>
                  </Stack>
                  {expanded && (
                    <ScheduleEditor
                      key={row.key}
                      value={row.draft}
                      onChange={(draft) => changeDraft(row.key, draft)}
                      onValidity={(ok) => setInvalid((s) => (s.has(row.key) === !ok ? s : toggle(s, row.key, !ok)))}
                      disabled={busy}
                      profileTimezone={profileTimezone}
                      catalog={scheduleCatalog}
                      taskPolicyId={shownPolicyId}
                      parameters={parameters}
                    />
                  )}
                </Stack>
              </Paper>
            );
          })}
          <Box>
            <Button variant={rows.length === 0 ? 'outlined' : 'text'} disabled={busy || activeRows.length >= MAX_SCHEDULES} onClick={addSchedule} sx={MIN_TAP}>
              {activeRows.length === 0 ? 'Add a schedule' : 'Add another schedule'}
            </Button>
            {activeRows.length >= MAX_SCHEDULES && <FormHelperText>A task has at most {MAX_SCHEDULES} schedules.</FormHelperText>}
          </Box>
        </Section>

        {!isPhone && (
          <Stack direction="row" spacing={1} role="group" aria-label="Form actions">
            {saveButton}
            {canRun && (
              <Button variant="outlined" disabled={blocked} startIcon={saving === 'run' ? progress : undefined} onClick={() => void submit(true)}>
                Save and run now
              </Button>
            )}
            <Button disabled={busy} onClick={() => navigate(cancelTo)}>
              Cancel
            </Button>
          </Stack>
        )}

        {mode === 'edit' && (
          <Card variant="outlined" component="section" aria-labelledby={`${uid}-danger`} sx={{ borderColor: 'error.main' }}>
            <CardContent sx={{ p: { xs: 2, sm: 3 }, '&:last-child': { pb: { xs: 2, sm: 3 } } }}>
              <Typography variant="h6" component="h2" id={`${uid}-danger`} sx={{ mb: 1 }}>
                Danger zone
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Deleting a task deletes its schedules. Its runs are kept.
              </Typography>
              <Button color="error" variant="outlined" disabled={busy} onClick={() => void remove()} sx={MIN_TAP}>
                Delete task
              </Button>
            </CardContent>
          </Card>
        )}
      </Stack>

      {runInputs.dialog}
      <DeliverySecretsDialog
        secrets={secrets?.list ?? []}
        onClose={() => {
          const to = secrets?.then;
          setSecrets(null);
          if (to) navigate(to);
        }}
      />
      {isPhone && (
        // Fixed above the shell's bottom navigation; last in the form, so the focus order ends here.
        <Paper
          square
          elevation={8}
          role="group"
          aria-label="Form actions"
          sx={{ position: 'fixed', left: 0, right: 0, bottom: aboveBottomBar().xs, zIndex: (t) => t.zIndex.appBar - 1, p: 1.5, display: 'flex', gap: 1, alignItems: 'center' }}
        >
          {saveButton}
          <IconButton aria-label="More actions" aria-haspopup="menu" disabled={busy} onClick={(e) => setMenuAnchor(e.currentTarget)} sx={{ width: 44, height: 44, flexShrink: 0 }}>
            <MoreVertIcon />
          </IconButton>
          <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
            {canRun && (
              <MenuItem
                disabled={blocked}
                sx={{ minHeight: 44 }}
                onClick={() => {
                  setMenuAnchor(null);
                  void submit(true);
                }}
              >
                Save and run now
              </MenuItem>
            )}
            <MenuItem
              sx={{ minHeight: 44 }}
              onClick={() => {
                setMenuAnchor(null);
                navigate(cancelTo);
              }}
            >
              Cancel
            </MenuItem>
          </Menu>
        </Paper>
      )}
    </Box>
  );
}
