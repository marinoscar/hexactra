import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CloseIcon from '@mui/icons-material/Close';
import EditIcon from '@mui/icons-material/Edit';
import LightbulbIcon from '@mui/icons-material/LightbulbOutlined';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import { Box, Button, Chip, FormControlLabel, IconButton, Paper, Stack, Switch, TextField, Typography } from '@mui/material';
import { useState, type ReactNode } from 'react';

import type { TaskBuilderSpec } from '../types/taskBuilder';

/** Where a section of the spec stands. */
export type SectionState = 'done' | 'missing' | 'optional';

export interface SpecSection {
  key: string;
  title: string;
  state: SectionState;
}

/** The sections of a spec and where each stands: what the panel shows and what Create needs. */
export function specSections(spec: TaskBuilderSpec): SpecSection[] {
  const has = (v: unknown) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '');
  return [
    { key: 'goal', title: 'Goal', state: has(spec.goal) || has(spec.objective) ? 'done' : 'missing' },
    { key: 'where', title: 'Sites and accounts', state: has(spec.sites) || has(spec.allowedDomains) || has(spec.accounts) ? 'done' : 'optional' },
    { key: 'parameters', title: 'What changes each run', state: has(spec.parameters) ? 'done' : 'optional' },
    { key: 'outputs', title: 'What to keep', state: has(spec.outputs) ? 'done' : 'optional' },
    { key: 'guardrails', title: 'Guardrails', state: spec.guardrails && Object.keys(spec.guardrails).length ? 'done' : 'optional' },
    { key: 'schedules', title: 'Schedule', state: has(spec.schedules) ? 'done' : 'optional' },
    { key: 'policy', title: 'Agent policy', state: spec.policy ? 'done' : 'optional' },
  ];
}

/** Whether a draft can be asked for: the builder knows what the task should do. */
export const canCreate = (spec: TaskBuilderSpec): boolean => Boolean(spec.goal?.trim() || spec.objective?.trim());

const STATE_LABEL: Record<SectionState, string> = { done: 'Done', missing: 'Needed', optional: 'Optional' };

function Section({ section, children }: { section: SpecSection; children: ReactNode }) {
  return (
    <Box component="section" aria-label={section.title} sx={{ py: 1.25, borderTop: 1, borderColor: 'divider', '&:first-of-type': { borderTop: 0 } }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
        {section.state === 'done' ? <CheckCircleIcon fontSize="small" color="success" aria-hidden /> : <RadioButtonUncheckedIcon fontSize="small" color={section.state === 'missing' ? 'warning' : 'disabled'} aria-hidden />}
        <Typography variant="subtitle2" component="h3" sx={{ flex: 1 }}>
          {section.title}
        </Typography>
        <Typography variant="caption" color={section.state === 'missing' ? 'warning.main' : 'text.secondary'}>
          {STATE_LABEL[section.state]}
        </Typography>
      </Stack>
      <Box sx={{ pl: 3.5 }}>{children}</Box>
    </Box>
  );
}

const Empty = ({ children }: { children: ReactNode }) => (
  <Typography variant="body2" color="text.secondary">
    {children}
  </Typography>
);

/** Chips for a list, each removable when the owner may edit. */
function ChipList({ items, onRemove, label }: { items: string[]; onRemove?: (index: number) => void; label: string }) {
  return (
    <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 0.75 }}>
      {items.map((text, i) => (
        <Chip key={`${i}-${text}`} label={text} size="small" sx={{ maxWidth: '100%' }} onDelete={onRemove ? () => onRemove(i) : undefined} deleteIcon={onRemove ? <CloseIcon aria-label={`Remove ${label}: ${text}`} /> : undefined} />
      ))}
    </Stack>
  );
}

function EditableText({ label, value, multiline, onSave, disabled }: { label: string; value: string | undefined; multiline?: boolean; onSave: (v: string | null) => Promise<void>; disabled?: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (editing !== null) {
    return (
      <Stack spacing={1}>
        <TextField label={label} value={editing} onChange={(e) => setEditing(e.target.value)} multiline={multiline} minRows={multiline ? 3 : undefined} size="small" fullWidth autoFocus />
        <Stack direction="row" spacing={1}>
          <Button
            size="small"
            variant="contained"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave(editing.trim() ? editing.trim() : null);
                setEditing(null);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
          <Button size="small" onClick={() => setEditing(null)} disabled={busy}>
            Cancel
          </Button>
        </Stack>
      </Stack>
    );
  }
  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'flex-start' }}>
      <Typography variant="body2" sx={{ flex: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }} color={value ? 'text.primary' : 'text.secondary'}>
        {value || 'Not yet.'}
      </Typography>
      {!disabled && (
        <IconButton size="small" aria-label={`Edit ${label.toLowerCase()}`} onClick={() => setEditing(value ?? '')}>
          <EditIcon fontSize="small" />
        </IconButton>
      )}
    </Stack>
  );
}

const GUARDRAILS: { key: keyof NonNullable<TaskBuilderSpec['guardrails']>; label: string }[] = [
  { key: 'confirmRiskyActions', label: 'Confirm before purchases and other hard-to-undo steps' },
  { key: 'useSavedLogins', label: 'Sign in with my saved logins' },
  { key: 'useSavedIdentity', label: 'Fill my saved details' },
  { key: 'useSavedCards', label: 'Pay with my saved cards' },
];

export interface TaskSpecPanelProps {
  spec: TaskBuilderSpec;
  /** Change the spec; undefined when it is read-only (an archived builder). */
  onPatch?: (patch: Partial<Record<keyof TaskBuilderSpec, unknown>>) => Promise<void>;
}

/** The task so far (E42.4): each section of the spec, where it stands, and what the builder suggests. */
export function TaskSpecPanel({ spec, onPatch }: TaskSpecPanelProps) {
  const sections = specSections(spec);
  const s = Object.fromEntries(sections.map((x) => [x.key, x])) as Record<string, SpecSection>;
  const remove = <K extends 'sites' | 'allowedDomains' | 'parameters' | 'outputs' | 'schedules' | 'accounts'>(key: K) =>
    onPatch
      ? (i: number) => {
          const next = ((spec[key] as unknown[] | undefined) ?? []).filter((_, j) => j !== i);
          void onPatch({ [key]: next.length ? next : null });
        }
      : undefined;
  return (
    <Paper variant="outlined" component="aside" aria-label="Task so far" sx={{ p: 2, borderRadius: 3 }}>
      <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
        Task so far
      </Typography>
      <Section section={{ ...s.goal!, title: 'Name' }}>
        <EditableText label="Name" value={spec.name} onSave={(v) => onPatch!({ name: v })} disabled={!onPatch} />
      </Section>
      <Section section={s.goal!}>
        {spec.objective && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5, overflowWrap: 'anywhere' }}>
            Done when: {spec.objective}
          </Typography>
        )}
        <EditableText label="Goal" value={spec.goal} multiline onSave={(v) => onPatch!({ goal: v })} disabled={!onPatch} />
      </Section>
      <Section section={s.where!}>
        {!spec.sites?.length && !spec.allowedDomains?.length && !spec.accounts?.length && <Empty>Any site; no account.</Empty>}
        <Stack spacing={0.75}>
          {!!spec.sites?.length && <ChipList label="site" items={spec.sites} onRemove={remove('sites')} />}
          {!!spec.allowedDomains?.length && <ChipList label="allowed site" items={spec.allowedDomains.map((d) => `Only ${d}`)} onRemove={remove('allowedDomains')} />}
          {!!spec.accounts?.length && <ChipList label="account" items={spec.accounts.map((a) => `${a.label} · ${a.access === 'read_write' ? 'read and change' : 'read only'}`)} onRemove={remove('accounts')} />}
        </Stack>
      </Section>
      <Section section={s.parameters!}>
        {spec.parameters?.length ? <ChipList label="parameter" items={spec.parameters.map((p) => `{{${p.name}}} · ${p.type}${p.memory ? ` · from ${p.memory}` : p.default ? ` · ${p.default}` : ''}`)} onRemove={remove('parameters')} /> : <Empty>Nothing; the task is the same every time.</Empty>}
      </Section>
      <Section section={s.outputs!}>
        {spec.outputs?.length ? <ChipList label="output" items={spec.outputs.map((o) => `${o.label} · ${o.type}`)} onRemove={remove('outputs')} /> : <Empty>Nothing kept beyond the answer.</Empty>}
      </Section>
      <Section section={s.guardrails!}>
        <Stack>
          {GUARDRAILS.map((g) => (
            <FormControlLabel
              key={g.key}
              control={<Switch size="small" checked={spec.guardrails?.[g.key] === true} disabled={!onPatch} onChange={(e) => void onPatch?.({ guardrails: { [g.key]: e.target.checked } })} />}
              label={<Typography variant="body2">{g.label}</Typography>}
            />
          ))}
        </Stack>
      </Section>
      <Section section={s.schedules!}>
        {spec.schedules?.length ? <ChipList label="schedule" items={spec.schedules.map((x) => `${x.description ?? x.cron} · ${x.timezone}`)} onRemove={remove('schedules')} /> : <Empty>Runs when you start it.</Empty>}
      </Section>
      <Section section={s.policy!}>{spec.policy ? <Typography variant="body2">{spec.policy.ref ?? 'Your default policy'}{spec.policy.why ? ` · ${spec.policy.why}` : ''}</Typography> : <Empty>Your default policy.</Empty>}</Section>
      {!!spec.edgeCases?.length && (
        <Box sx={{ pt: 1.25, borderTop: 1, borderColor: 'divider' }}>
          <Typography variant="subtitle2" component="h3">
            When something goes wrong
          </Typography>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {spec.edgeCases.map((e) => (
              <Typography component="li" variant="body2" key={e}>
                {e}
              </Typography>
            ))}
          </Box>
        </Box>
      )}
      {(!!spec.openQuestions?.length || !!spec.suggestions?.length) && (
        <Box sx={{ pt: 1.25, mt: 1, borderTop: 1, borderColor: 'divider' }}>
          {!!spec.openQuestions?.length && (
            <>
              <Typography variant="subtitle2" component="h3">
                Still open
              </Typography>
              <Box component="ul" sx={{ m: 0, mb: 1, pl: 2.5 }}>
                {spec.openQuestions.map((q) => (
                  <Typography component="li" variant="body2" key={q}>
                    {q}
                  </Typography>
                ))}
              </Box>
            </>
          )}
          {!!spec.suggestions?.length && (
            <>
              <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                <LightbulbIcon fontSize="small" color="primary" aria-hidden />
                <Typography variant="subtitle2" component="h3">
                  Suggestions
                </Typography>
              </Stack>
              <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                {spec.suggestions.map((q) => (
                  <Typography component="li" variant="body2" key={q}>
                    {q}
                  </Typography>
                ))}
              </Box>
            </>
          )}
        </Box>
      )}
    </Paper>
  );
}
