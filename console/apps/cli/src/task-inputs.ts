// `hexactra tasks run --input` (E36.6, #552): the values of a task's
// `{{parameters}}`, from flags and, at a terminal, a prompt per missing value.
// A sensitive parameter is never read here: it is asked for in the signed-in
// console when the run starts.
import { matchInputKey } from '@app/shared/task-params';

/** A task parameter as `GET /tasks` returns it (the fields the CLI reads). */
export interface CliTaskParameter {
  key: string;
  label: string;
  type: string;
  required: boolean;
  options?: string[];
  help?: string;
  default?: unknown;
  sensitive?: boolean;
}

/** commander's collector for a repeatable `--input name=value`. */
export function collectInput(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** `["amount=25", "Phone Number=555"]` as `{ amount: "25", "Phone Number": "555" }`; a flag without `=` is an error. */
export function parseInputFlags(flags: readonly string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of flags ?? []) {
    const i = f.indexOf('=');
    if (i <= 0) throw new Error(`--input takes name=value, not "${f}"`);
    out[f.slice(0, i).trim()] = f.slice(i + 1);
  }
  return out;
}

/** The required parameters with no value given, no default and not sensitive: what a terminal can ask for. */
export function missingParameters(params: readonly CliTaskParameter[], given: Record<string, string>): CliTaskParameter[] {
  const keys = new Set(Object.keys(given).map((name) => matchInputKey(params, name) ?? name));
  return params.filter((p) => p.required && !p.sensitive && !p.default && !keys.has(p.key));
}

/** The prompt line for one parameter: its label, type, options and help. */
export function promptFor(p: CliTaskParameter): string {
  const kind = p.type === 'choice' && p.options?.length ? `one of ${p.options.join(', ')}` : p.type === 'money' ? 'amount' : p.type;
  return `${p.label} (${kind})${p.help ? ` – ${p.help}` : ''}: `;
}

/** Ask for each missing value at a terminal (stderr, so stdout stays clean for --json). Empty answers are left out. */
export async function promptMissing(missing: readonly CliTaskParameter[], ask?: (q: string) => Promise<string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!missing.length) return out;
  let close: (() => void) | null = null;
  let question = ask;
  if (!question) {
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    close = () => rl.close();
    question = (q) => rl.question(q);
  }
  try {
    for (const p of missing) {
      const v = (await question(promptFor(p))).trim();
      if (v) out[p.key] = v;
    }
  } finally {
    close?.();
  }
  return out;
}
