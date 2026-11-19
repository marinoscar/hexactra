import { Button, Stack, Typography } from '@mui/material';
import { useState, type FormEvent } from 'react';

import { useProfileTimeZone } from '../ui';
import { ParameterField } from './ParameterField';
import { filledValues, issuesByKey, valuesErrors, type TaskParameter } from './model';
import type { AnswerBody, FormField } from '../components/questions';

export interface FormQuestionProps {
  fields: readonly FormField[];
  onSubmit: (answer: AnswerBody) => void | Promise<void>;
  disabled?: boolean;
  busy?: boolean;
}

const ACTION_SX = { width: { xs: '100%', sm: 'auto' }, minHeight: { xs: 44, sm: 'auto' } } as const;

/**
 * The fields of a `form` question (#552, #556): a task run's missing values,
 * asked at once before it starts, with the same typed fields as the run
 * dialog and one Send. The shared rules check each value before it is sent;
 * a value the API refuses is shown on its field. A sensitive field (never in a
 * form today: those are asked when the run starts) is masked and never kept.
 */
export function FormQuestion({ fields, onSubmit, disabled: off, busy = false }: FormQuestionProps) {
  const disabled = Boolean(off) || busy;
  const timeZone = useProfileTimeZone();
  const [values, setValues] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);
  const [server, setServer] = useState<Record<string, string>>({});
  const defs = fields as unknown as TaskParameter[];
  const local = valuesErrors(defs, values, { timeZone });

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    setTouched(true);
    if (Object.keys(local).length) return;
    try {
      await onSubmit({ outcome: 'completed', fields: filledValues(values) });
    } catch (err) {
      const issues = issuesByKey(err);
      if (issues) setServer(issues);
      throw err;
    }
  };

  return (
    <Stack component="form" noValidate spacing={2} sx={{ mt: 2 }} onSubmit={(e) => void send(e).catch(() => undefined)} aria-label="A few details to start">
      {fields.length > 1 && (
        <Typography variant="body2" color="text.secondary">
          The run starts once these are filled in.
        </Typography>
      )}
      {fields.map((f, i) => (
        <ParameterField
          key={f.key}
          def={f}
          value={values[f.key] ?? ''}
          onChange={(v) => {
            setValues((all) => ({ ...all, [f.key]: v }));
            setServer(({ [f.key]: _gone, ...rest }) => rest);
          }}
          error={server[f.key] ?? (touched ? local[f.key] : null)}
          disabled={disabled}
          autoFocus={i === 0}
        />
      ))}
      <Stack data-testid="question-actions" direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ flexWrap: { sm: 'wrap' }, alignItems: { xs: 'stretch', sm: 'center' } }}>
        <Button type="submit" variant="contained" disabled={disabled} loading={busy} sx={ACTION_SX}>
          Send
        </Button>
        <Button color="error" variant="text" disabled={disabled} onClick={() => void Promise.resolve(onSubmit({ outcome: 'cancelled' })).catch(() => undefined)} sx={ACTION_SX}>
          Decline
        </Button>
      </Stack>
    </Stack>
  );
}
