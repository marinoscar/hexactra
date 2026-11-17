import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Collapse,
  FormControl,
  FormControlLabel,
  FormHelperText,
  FormLabel,
  Link,
  MenuItem,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { PolicySelect } from '../policies/PolicySelect';
import type { PolicyCatalog } from '../policies/usePolicyCatalog';
import type { ScheduleDraft } from '../schedule/draft';
import {
  CRON_FIELDS,
  HOUR_STEPS,
  MAX_DAILY_TIMES,
  MAX_MONTHLY_DAYS,
  MINUTE_STEPS,
  SCHEDULE_MODES,
  WEEKDAYS,
  WEEKDAY_PRESETS,
  cronToSpec,
  formatTimeOfDay,
  normalizeSpec,
  parseTimeOfDay,
  specToCron,
  switchMode,
  validateSpec,
  type HourStep,
  type MinuteStep,
  type ScheduleMode,
  type ScheduleSpec,
  type TimeOfDay,
  type Weekday,
} from '../schedule/model';
import { useSchedulePreview } from '../schedule/useSchedulePreview';
import { formatDateTime, formatRelative, useBreakpoint, useConfirm } from '../ui';

export type { ScheduleDraft } from '../schedule/draft';

export interface ScheduleEditorProps {
  value: ScheduleDraft;
  /** Called with the whole draft. `cron` is only ever an expression the editor's own validation accepts. */
  onChange: (draft: ScheduleDraft) => void;
  /** Whether the draft can be saved: false while a field is incomplete or the server refuses the expression or the zone. */
  onValidity?: (ok: boolean) => void;
  disabled?: boolean;
  /** The user's profile time zone: what a new schedule uses, and what the "differs" hint compares with. */
  profileTimezone: string;
  /** The policies to offer as an override; omit to hide the policy control (no `agent_policies:read`). */
  catalog?: Pick<PolicyCatalog, 'policies' | 'defaultId' | 'byId'>;
  /** The task's own policy (null follows the user's default): what "Task's policy" resolves to. */
  taskPolicyId?: string | null;
}

/** IANA zones the runtime knows; empty where `Intl.supportedValuesOf` is missing (the field is then free text). */
function supportedTimeZones(): string[] {
  try {
    const zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
    return zones.length > 0 && !zones.includes('UTC') ? ['UTC', ...zones] : zones;
  } catch {
    return [];
  }
}

const MIN_TAP = { minHeight: 44 };

/** A time of day through the browser's own time field; the model is always 24-hour. */
function TimeField({ label, value, onChange, disabled }: { label: string; value: TimeOfDay; onChange: (t: TimeOfDay) => void; disabled?: boolean }) {
  return (
    <TextField
      type="time"
      size="small"
      label={label}
      value={formatTimeOfDay(value)}
      disabled={disabled}
      onChange={(e) => {
        const t = parseTimeOfDay(e.target.value);
        if (t) onChange(t);
      }}
      slotProps={{ inputLabel: { shrink: true }, htmlInput: { step: 60 } }}
      sx={{ width: 150 }}
    />
  );
}

/** Days 1 to 31 as toggle buttons, seven to a row; the arrow keys, Home and End move between them. */
function MonthDayGrid({ days, onToggle, disabled }: { days: number[]; onToggle: (day: number) => void; disabled?: boolean }) {
  const [focusDay, setFocusDay] = useState(days[0] ?? 1);
  const grid = useRef<HTMLDivElement>(null);
  const move = (e: KeyboardEvent, day: number) => {
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    const next = e.key === 'Home' ? 1 : e.key === 'End' ? 31 : delta === undefined ? null : day + delta;
    if (next === null || next < 1 || next > 31) return;
    e.preventDefault();
    setFocusDay(next);
    grid.current?.querySelector<HTMLElement>(`[data-day="${next}"]`)?.focus();
  };
  return (
    <Box ref={grid} role="group" aria-label="Days of the month" sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 0.5, maxWidth: 420 }}>
      {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
        <ToggleButton
          key={day}
          value={day}
          size="small"
          selected={days.includes(day)}
          disabled={disabled}
          data-day={day}
          tabIndex={day === focusDay ? 0 : -1}
          aria-label={`Day ${day}`}
          onFocus={() => setFocusDay(day)}
          onKeyDown={(e) => move(e, day)}
          onChange={() => onToggle(day)}
          sx={{ minWidth: 0, px: 0, minHeight: { xs: 40, sm: 36 } }}
        >
          {day}
        </ToggleButton>
      ))}
    </Box>
  );
}

/**
 * The schedule editor: a builder for the common schedules (every N minutes or
 * hours, daily, weekly, monthly), an Advanced mode for any 5-field cron
 * expression, what the schedule means and when it runs next (from
 * `POST /schedules/preview`), its time zone, what happens when the previous
 * run is still going, an optional policy override and the Active switch.
 *
 * Controlled, and it never saves: the parent keeps the draft and owns the
 * request. It needs a `ConfirmProvider` above it.
 */
export function ScheduleEditor({ value, onChange, onValidity, disabled, profileTimezone, catalog, taskPolicyId }: ScheduleEditorProps) {
  const { isPhone } = useBreakpoint();
  const confirm = useConfirm();
  const ids = useId();
  const zones = useMemo(supportedTimeZones, []);

  // The spec on screen. It can be ahead of `value.cron` while it is incomplete
  // (no day chosen yet): an invalid spec is never emitted.
  const [spec, setSpec] = useState<ScheduleSpec>(() => cronToSpec(value.cron));
  const emitted = useRef(value.cron);
  useEffect(() => {
    // The parent replaced the expression (another schedule opened in the same editor).
    if (value.cron !== emitted.current) {
      emitted.current = value.cron;
      setSpec(cronToSpec(value.cron));
    }
  }, [value.cron]);

  const localError = validateSpec(spec);
  const cron = localError === null ? specToCron(spec) : null;
  const preview = useSchedulePreview(cron, value.timezone);
  const refused = !preview.pending && preview.result?.valid === false;
  // Advanced text is only known to be good once the server has answered; a builder spec is good by construction.
  const ok = localError === null && !refused && !(preview.pending && spec.mode === 'advanced');
  const report = useRef(onValidity);
  report.current = onValidity;
  useEffect(() => {
    report.current?.(ok);
  }, [ok]);

  const patch = (change: Partial<ScheduleDraft>) => onChange({ ...value, ...change });
  const apply = (next: ScheduleSpec) => {
    const normal = next.mode === 'daily' ? next : normalizeSpec(next);
    setSpec(normal);
    if (validateSpec(normal) === null) {
      const expression = specToCron(normal);
      emitted.current = expression;
      if (expression !== value.cron) patch({ cron: expression });
    }
  };

  const chooseMode = async (mode: ScheduleMode) => {
    if (mode === spec.mode) return;
    if (spec.mode !== 'advanced') return apply(switchMode(spec, mode, value.cron));
    const parsed = cronToSpec(spec.cron);
    if (parsed.mode === 'advanced' && spec.cron.trim()) {
      const label = SCHEDULE_MODES.find((m) => m.mode === mode)!.label.toLowerCase();
      const replace = await confirm({
        title: 'Replace this expression?',
        body: `This expression cannot be shown in the builder. Replace it with ${mode === 'hours' ? 'an' : 'a'} ${label} schedule?`,
        confirmLabel: 'Replace',
      });
      if (!replace) return;
    }
    apply(parsed.mode === mode ? parsed : switchMode(parsed, mode, value.cron));
  };

  // "More options": time zone, overlap rule and policy. Always shown from `sm`;
  // on a phone it is collapsed unless one of them is not the default.
  const customised = value.policyId !== null || value.timezone !== profileTimezone || value.concurrency === 'queue';
  const [moreOpen, setMoreOpen] = useState(customised);
  useEffect(() => {
    if (customised) setMoreOpen(true);
  }, [customised]);
  const [zoneOpen, setZoneOpen] = useState(false);
  const zoneDiffers = value.timezone !== profileTimezone;
  const taskPolicy = catalog?.byId(taskPolicyId ?? catalog.defaultId);

  const fields = (() => {
    switch (spec.mode) {
      case 'minutes':
        return (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
            <Typography>Every</Typography>
            <TextField
              select
              size="small"
              value={spec.every}
              disabled={disabled}
              onChange={(e) => apply({ mode: 'minutes', every: Number(e.target.value) as MinuteStep })}
              slotProps={{ htmlInput: { 'aria-label': 'Minutes between runs' } }}
              sx={{ width: 90 }}
            >
              {MINUTE_STEPS.map((n) => (
                <MenuItem key={n} value={n}>
                  {n}
                </MenuItem>
              ))}
            </TextField>
            <Typography>minutes</Typography>
          </Stack>
        );
      case 'hours':
        return (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
            <Typography>Every</Typography>
            <TextField
              select
              size="small"
              value={spec.every}
              disabled={disabled}
              onChange={(e) => apply({ ...spec, every: Number(e.target.value) as HourStep })}
              slotProps={{ htmlInput: { 'aria-label': 'Hours between runs' } }}
              sx={{ width: 90 }}
            >
              {HOUR_STEPS.map((n) => (
                <MenuItem key={n} value={n}>
                  {n}
                </MenuItem>
              ))}
            </TextField>
            <Typography>{spec.every === 1 ? 'hour at minute' : 'hours at minute'}</Typography>
            <TextField
              type="number"
              size="small"
              value={Number.isNaN(spec.minute) ? '' : spec.minute}
              disabled={disabled}
              error={localError !== null}
              onChange={(e) => apply({ ...spec, minute: e.target.value === '' ? Number.NaN : Number(e.target.value) })}
              slotProps={{ htmlInput: { min: 0, max: 59, 'aria-label': 'Minute of the hour', inputMode: 'numeric' } }}
              sx={{ width: 90 }}
            />
          </Stack>
        );
      case 'daily':
        return (
          <Stack spacing={1}>
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1.5, alignItems: 'center' }}>
              {spec.times.map((t, i) => (
                <Stack key={i} direction="row" sx={{ alignItems: 'center' }}>
                  <TimeField
                    label={spec.times.length > 1 ? `Time ${i + 1}` : 'Time'}
                    value={t}
                    disabled={disabled}
                    onChange={(time) => apply({ mode: 'daily', times: spec.times.map((old, j) => (j === i ? time : old)) })}
                  />
                  {spec.times.length > 1 && (
                    <Button size="small" disabled={disabled} aria-label={`Remove time ${i + 1}`} onClick={() => apply({ mode: 'daily', times: spec.times.filter((_, j) => j !== i) })} sx={MIN_TAP}>
                      Remove
                    </Button>
                  )}
                </Stack>
              ))}
            </Stack>
            {spec.times.length < MAX_DAILY_TIMES && (
              <Box>
                <Button
                  size="small"
                  disabled={disabled}
                  onClick={() => {
                    // The next free hour after the last time, at the same minute.
                    const last = spec.times[spec.times.length - 1] ?? { hour: 8, minute: 0 };
                    const taken = new Set(spec.times.map((t) => t.hour));
                    let hour = (last.hour + 1) % 24;
                    while (taken.has(hour)) hour = (hour + 1) % 24;
                    apply({ mode: 'daily', times: [...spec.times, { hour, minute: spec.times[0]?.minute ?? 0 }] });
                  }}
                  sx={MIN_TAP}
                >
                  Add a time
                </Button>
              </Box>
            )}
          </Stack>
        );
      case 'weekly':
        return (
          <Stack spacing={1.5}>
            <ToggleButtonGroup
              fullWidth
              size="small"
              value={spec.days}
              disabled={disabled}
              aria-label="Days of the week"
              onChange={(_, days: Weekday[]) => apply({ ...spec, days })}
              sx={{ maxWidth: 520 }}
            >
              {WEEKDAYS.map((d) => (
                <ToggleButton key={d.day} value={d.day} aria-label={d.name} sx={{ ...MIN_TAP, minWidth: 0, px: 0 }}>
                  {isPhone ? d.letter : d.short}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
              {WEEKDAY_PRESETS.map((p) => (
                <Button key={p.label} size="small" variant="outlined" disabled={disabled} onClick={() => apply({ ...spec, days: p.days })} sx={MIN_TAP}>
                  {p.label}
                </Button>
              ))}
            </Stack>
            <TimeField label="Time" value={spec.time} disabled={disabled} onChange={(time) => apply({ ...spec, time })} />
          </Stack>
        );
      case 'monthly': {
        const full = spec.days.length >= MAX_MONTHLY_DAYS;
        return (
          <Stack spacing={1.5}>
            <MonthDayGrid
              days={spec.days}
              disabled={disabled}
              onToggle={(day) => {
                if (spec.days.includes(day)) apply({ ...spec, days: spec.days.filter((d) => d !== day) });
                else if (!full) apply({ ...spec, days: [...spec.days, day] });
              }}
            />
            <FormHelperText sx={{ mx: 0 }}>
              {full ? `Up to ${MAX_MONTHLY_DAYS} days. Remove one to choose another.` : `Choose up to ${MAX_MONTHLY_DAYS} days.`}
              {spec.days.some((d) => d >= 29) && ' Months without that day are skipped.'}
            </FormHelperText>
            <TimeField label="Time" value={spec.time} disabled={disabled} onChange={(time) => apply({ ...spec, time })} />
          </Stack>
        );
      }
      case 'advanced': {
        const parts = spec.cron.trim() ? spec.cron.trim().split(/\s+/) : [];
        return (
          <Stack spacing={1}>
            <TextField
              fullWidth
              size="small"
              label="Cron expression"
              placeholder="0 9 * * 1-5"
              value={spec.cron}
              disabled={disabled}
              error={localError !== null || refused}
              helperText="minute hour day-of-month month day-of-week"
              onChange={(e) => apply({ mode: 'advanced', cron: e.target.value })}
              autoComplete="off"
              spellCheck={false}
              slotProps={{ htmlInput: { style: { fontFamily: 'monospace' }, autoCapitalize: 'off', autoCorrect: 'off' } }}
            />
            <Box aria-label="The expression's fields" sx={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 0.5 }}>
              {CRON_FIELDS.map((name, i) => (
                <Box key={name} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, px: 0.5, py: 0.5, textAlign: 'center', minWidth: 0 }}>
                  <Typography component="div" data-testid={`cron-field-${i}`} sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere', minHeight: '1.5em' }}>
                    {parts[i] ?? '–'}
                  </Typography>
                  <Typography component="div" variant="caption" color="text.secondary" sx={{ lineHeight: 1.2 }}>
                    {name}
                  </Typography>
                </Box>
              ))}
            </Box>
          </Stack>
        );
      }
    }
  })();

  const result = preview.result;
  const summary = (
    <Paper variant="outlined" aria-live="polite" aria-label="Schedule summary" sx={{ p: 1.5, opacity: preview.pending && result ? 0.6 : 1, transition: 'opacity 150ms' }}>
      {localError !== null ? (
        <Typography color="error">{localError}</Typography>
      ) : result?.valid === false ? (
        <Typography color="error">{result.message}</Typography>
      ) : result?.valid ? (
        <>
          <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>
            {result.description} · {result.timezone}
          </Typography>
          {!value.enabled && (
            <Typography variant="body2" color="text.secondary">
              Paused: it does not run until it is active again.
            </Typography>
          )}
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Next runs
          </Typography>
          <Box component="ol" aria-label="Next runs" sx={{ m: 0, pl: 2.5 }}>
            {result.next.map((iso, i) => (
              <Typography component="li" variant="body2" key={iso}>
                {formatDateTime(iso, { timeZone: result.timezone })}
                {i === 0 && ` (${formatRelative(iso, Date.now(), { timeZone: result.timezone })})`}
              </Typography>
            ))}
          </Box>
        </>
      ) : preview.failed ? (
        <Typography color="text.secondary">Could not check this schedule. You can still save it; it is checked again when saved.</Typography>
      ) : (
        <Typography color="text.secondary">Checking this schedule…</Typography>
      )}
    </Paper>
  );

  const more = (
    <Stack spacing={2}>
      <Box>
        <Typography variant="body2">
          Time zone: <strong>{value.timezone}</strong>
          {!zoneDiffers && ' (from your profile)'}{' '}
          <Link component="button" type="button" disabled={disabled} onClick={() => setZoneOpen((o) => !o)} aria-expanded={zoneOpen} sx={{ verticalAlign: 'baseline', minHeight: { xs: 44, sm: 'auto' }, px: 0.5 }}>
            Change
          </Link>
        </Typography>
        <Collapse in={zoneOpen} unmountOnExit>
          <Box sx={{ mt: 1, maxWidth: 360 }}>
            {zones.length > 0 ? (
              <Autocomplete
                size="small"
                options={zones.includes(value.timezone) ? zones : [value.timezone, ...zones]}
                value={value.timezone}
                disableClearable
                disabled={disabled}
                onChange={(_, zone) => patch({ timezone: zone })}
                renderInput={(params) => <TextField {...params} label="Time zone" />}
              />
            ) : (
              <TextField
                fullWidth
                size="small"
                label="Time zone"
                helperText="An IANA name, for example Europe/Madrid"
                value={value.timezone}
                disabled={disabled}
                error={refused}
                onChange={(e) => patch({ timezone: e.target.value })}
              />
            )}
          </Box>
        </Collapse>
        {zoneDiffers && (
          <Alert
            severity="info"
            sx={{ mt: 1 }}
            action={
              <Button color="inherit" size="small" disabled={disabled} onClick={() => patch({ timezone: profileTimezone })}>
                Use my profile time zone
              </Button>
            }
          >
            This schedule uses {value.timezone}; your profile is {profileTimezone}.
          </Alert>
        )}
      </Box>
      <FormControl disabled={disabled}>
        <FormLabel id={`${ids}-overlap`}>If the previous run is still going</FormLabel>
        <RadioGroup aria-labelledby={`${ids}-overlap`} value={value.concurrency} onChange={(e) => patch({ concurrency: e.target.value === 'queue' ? 'queue' : 'skip' })}>
          <FormControlLabel value="skip" control={<Radio />} label="Skip this run (recommended)" />
          <FormControlLabel value="queue" control={<Radio />} label="Start another run anyway" />
        </RadioGroup>
      </FormControl>
      {catalog && catalog.policies.length > 0 && (
        <Box sx={{ maxWidth: 360 }}>
          <PolicySelect
            size="small"
            label="Policy override"
            nullLabel="Task's policy"
            nullPolicyId={taskPolicy?.id ?? null}
            catalog={catalog}
            value={value.policyId}
            disabled={disabled}
            onChange={(policyId) => patch({ policyId })}
          />
          <FormHelperText sx={{ mx: 0 }}>Scheduled runs use the task's policy unless you choose another here.</FormHelperText>
        </Box>
      )}
    </Stack>
  );

  return (
    <Stack spacing={2} aria-label="Schedule editor" role="group">
      <Box>
        {isPhone ? (
          <TextField select fullWidth size="small" label="Repeats" value={spec.mode} disabled={disabled} onChange={(e) => void chooseMode(e.target.value as ScheduleMode)}>
            {SCHEDULE_MODES.map((m) => (
              <MenuItem key={m.mode} value={m.mode}>
                {m.label}
              </MenuItem>
            ))}
          </TextField>
        ) : (
          <>
            <Typography id={`${ids}-repeats`} variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
              Repeats
            </Typography>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={spec.mode}
              disabled={disabled}
              aria-labelledby={`${ids}-repeats`}
              onChange={(_, mode: ScheduleMode | null) => {
                if (mode) void chooseMode(mode);
              }}
              sx={{ flexWrap: 'wrap' }}
            >
              {SCHEDULE_MODES.map((m) => (
                <ToggleButton key={m.mode} value={m.mode} sx={{ px: 1.5 }}>
                  {m.label}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </>
        )}
      </Box>
      {fields}
      {summary}
      {isPhone ? (
        <Box>
          <Button size="small" aria-expanded={moreOpen} aria-controls={`${ids}-more`} onClick={() => setMoreOpen((o) => !o)} sx={MIN_TAP}>
            More options
          </Button>
          <Collapse in={moreOpen} id={`${ids}-more`} unmountOnExit>
            <Box sx={{ pt: 1 }}>{more}</Box>
          </Collapse>
        </Box>
      ) : (
        more
      )}
      <FormControlLabel
        control={<Switch checked={value.enabled} disabled={disabled} onChange={(e) => patch({ enabled: e.target.checked })} />}
        label={value.enabled ? 'Active' : 'Paused'}
        sx={{ alignSelf: 'flex-start' }}
      />
    </Stack>
  );
}
