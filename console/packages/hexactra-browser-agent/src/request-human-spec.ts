// The words of a request for a person (`request_human`) and of the line the model reads after the answer: pure helpers.
import { clip } from '@marinoscar/hexactra-agent';

/** The model's `request_human` arguments (snake_case, nulls for what does not apply). */
export interface RequestHumanArgs {
  kind: string;
  prompt: string;
  input: string;
  choices?: string[] | null;
  options?: { id: string; label: string; description?: string | null }[] | null;
  constraints?: Partial<Record<'max_length' | 'pattern' | 'multiline' | 'min' | 'max' | 'step' | 'unit' | 'min_selections' | 'max_selections', unknown>> | null;
  confirm_label?: string | null;
  deny_label?: string | null;
  risk?: 'low' | 'high' | null;
  /** credentials and secret: the words of the page's "remember me" option, when it has one (#527). */
  remember_label?: string | null;
  /** A confirmation's topic from the fixed list (#555); anything else is `other`. Never a source of authorization. */
  topic?: string | null;
}

const CONSTRAINT_FROM_MODEL = {
  max_length: 'maxLength',
  pattern: 'pattern',
  multiline: 'multiline',
  min: 'min',
  max: 'max',
  step: 'step',
  unit: 'unit',
  min_selections: 'minSelections',
  max_selections: 'maxSelections',
} as const;

/** The model's `request_human` arguments as the console's question contract (camelCase, nulls dropped), ready to validate. */
export function requestHumanSpec(a: RequestHumanArgs): Record<string, unknown> {
  const options = a.options?.length
    ? a.options.map((o) => ({ id: o.id, label: o.label, ...(o.description ? { description: o.description } : {}) }))
    : a.choices?.length
      ? a.choices.map((c) => c.slice(0, 100))
      : undefined;
  const constraints: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a.constraints ?? {})) {
    const key = CONSTRAINT_FROM_MODEL[k as keyof typeof CONSTRAINT_FROM_MODEL];
    if (key && v !== null && v !== undefined) constraints[key] = v;
  }
  return {
    kind: a.kind,
    prompt: a.prompt,
    input: a.input,
    ...(options && (a.input === 'choice' || a.input === 'multi_choice') ? { options } : {}),
    ...(Object.keys(constraints).length ? { constraints } : {}),
    ...(a.input === 'confirm' && a.confirm_label ? { confirmLabel: a.confirm_label } : {}),
    ...(a.input === 'confirm' && a.deny_label ? { denyLabel: a.deny_label } : {}),
    ...(a.input === 'confirm' && a.risk ? { risk: a.risk } : {}),
    // The page's words, cut to the fabric's limit; only where a person types a secret.
    ...((a.input === 'credentials' || a.input === 'secret') && a.remember_label?.trim() ? { rememberLabel: a.remember_label.trim().replace(/\s+/g, ' ').slice(0, 80) } : {}),
  };
}

/** What the model reads after a person answered (never a secret). */
export function answerLine(a: { input: string; kind: string; value?: string; values?: string[]; options: { id: string; label: string }[] | null; unit: string | null; rememberLabel?: string | null; remember?: boolean }): string {
  const label = (id: string) => (a.options ?? []).find((o) => o.id === id)?.label ?? id;
  // The person's choice for the site's "remember me" option (#527). Without one, the page's box is left as it is.
  const remember =
    a.rememberLabel && a.remember !== undefined
      ? a.remember
        ? ` The person chose to tick "${clip(a.rememberLabel, 80)}": make sure that box is ticked before you submit.`
        : ` The person chose not to tick "${clip(a.rememberLabel, 80)}": make sure that box is unticked before you submit.`
      : '';
  switch (a.input) {
    case 'secret':
      return `The person provided the secret. Type it with type_handoff_secret(selector).${remember}`;
    case 'credentials':
      return `The person gave the sign-in. Type the username "${clip(a.value ?? '', 200)}" with type_text into the username field, then type the password with type_handoff_secret(selector) into the password field, then submit.${remember}`;
    case 'confirm':
      return a.value === 'approve' ? 'The person approved.' : 'The person denied it. Do not do it; finish if you cannot continue another way.';
    case 'choice':
      return `The person chose: ${clip(label(a.value ?? ''), 500)}`;
    case 'multi_choice':
      return `The person selected: ${clip((a.values ?? []).map(label).join(', '), 500)}`;
    case 'number':
      return `The person entered: ${clip(`${a.value ?? ''}${a.unit ? ` ${a.unit}` : ''}`, 500)}`;
    case 'text':
      return `The person answered: ${clip(a.value ?? '', 500)}`;
    case 'takeover':
      return 'The person took over the browser and is done. Check the page and continue.';
    default:
      return `The person completed the ${a.kind} step. Check the page and continue.`;
  }
}
