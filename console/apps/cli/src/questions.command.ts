import type { Command } from 'commander';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';

import { consoleApi } from './console-api.js';
import { readStdinLine } from './inbox.js';
import { QUESTION_INPUTS, answerFromFlags, answerText, constraintText, optionLines, waitForQuestion, type AnswerFlags, type Question } from './questions.js';

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

const collect = (v: string, prev: string[] = []): string[] => [...prev, v];

function num(name: string) {
  return (v: string): number => {
    const n = Number(v);
    if (v.trim() === '' || !Number.isFinite(n)) throw new Error(`${name} must be a number`);
    return n;
  };
}

function int(name: string) {
  return (v: string): number => {
    const n = num(name)(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number`);
    return n;
  };
}

/** `--option id=label` (or a bare label, its own id) as an option of the contract. */
export function parseOption(v: string): string | { id: string; label: string } {
  const at = v.indexOf('=');
  if (at <= 0) return v;
  return { id: v.slice(0, at), label: v.slice(at + 1) };
}

function print(q: Question): void {
  out(`${q.id}  [${q.kind}, ${q.input}${q.risk ? `, ${q.risk} risk` : ''}]  ${q.status}`);
  out(`  ${q.prompt}`);
  out(`  asked by ${q.askedBy}${q.runId ? ` for run ${q.runId}` : ''}${q.pageTitle ? ` on “${q.pageTitle}”` : ''}`);
  for (const line of optionLines(q)) out(`    ${line}`);
  const c = constraintText(q);
  if (c) out(`  ${c}`);
  if (q.input === 'confirm') out(`  --approve = ${q.confirmLabel ?? 'Approve'}, --deny = ${q.denyLabel ?? 'Deny'}`);
  if (q.status === 'pending') out(`  expires ${new Date(q.expiresAt).toLocaleString()}`);
  else out(`  ${answerText(q)}`);
}

/** A question named by its id or an unambiguous prefix of a pending one's. */
async function resolveId(ref: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) return ref;
  const pending = await consoleApi().get<Question[]>('/questions', { query: { status: 'pending', limit: 200 } });
  const matches = pending.filter((q) => q.id.startsWith(ref));
  if (matches.length !== 1) throw new Error(matches.length ? `"${ref}" matches several questions` : `No pending question "${ref}" (see \`hexactra questions list\`)`);
  return matches[0]!.id;
}

interface AskFlags {
  input: string;
  prompt: string;
  kind?: string;
  option?: string[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  pattern?: string;
  maxLength?: number;
  multiline?: boolean;
  minSelections?: number;
  maxSelections?: number;
  confirmLabel?: string;
  denyLabel?: string;
  risk?: string;
  timeout?: number;
  wait?: number;
  json?: boolean;
}

/** The `POST /api/questions` body the `questions ask` flags give. */
export function askBody(o: AskFlags): Record<string, unknown> {
  if (!(QUESTION_INPUTS as readonly string[]).includes(o.input)) throw new Error(`--input is one of ${QUESTION_INPUTS.filter((i) => i !== 'secret' && i !== 'credentials').join(', ')}`);
  if (o.input === 'credentials') throw new Error('A sign-in is only asked inside a browser session (its password is typed there, never stored); the CLI does not ask for one.');
  if (o.input === 'secret') throw new Error('A secret is only asked inside a browser session (it is typed there, never stored); the CLI does not ask for one.');
  const constraints = {
    ...(o.min !== undefined ? { min: o.min } : {}),
    ...(o.max !== undefined ? { max: o.max } : {}),
    ...(o.step !== undefined ? { step: o.step } : {}),
    ...(o.unit !== undefined ? { unit: o.unit } : {}),
    ...(o.pattern !== undefined ? { pattern: o.pattern } : {}),
    ...(o.maxLength !== undefined ? { maxLength: o.maxLength } : {}),
    ...(o.multiline ? { multiline: true } : {}),
    ...(o.minSelections !== undefined ? { minSelections: o.minSelections } : {}),
    ...(o.maxSelections !== undefined ? { maxSelections: o.maxSelections } : {}),
  };
  return {
    input: o.input,
    prompt: o.prompt,
    ...(o.kind ? { kind: o.kind } : {}),
    ...(o.option?.length ? { options: o.option.map(parseOption) } : {}),
    ...(Object.keys(constraints).length ? { constraints } : {}),
    ...(o.confirmLabel ? { confirmLabel: o.confirmLabel } : {}),
    ...(o.denyLabel ? { denyLabel: o.denyLabel } : {}),
    ...(o.risk ? { risk: o.risk } : {}),
    ...(o.timeout !== undefined ? { timeoutMs: o.timeout * 1000 } : {}),
    asker: 'cli',
  };
}

/** `hexactra questions …`: ask yourself a question, follow it, list and answer questions. */
export const questionsCommand: CliCommandRegistration = (program: Command) => {
  const questions = program.command('questions').description('Questions agents ask you (and that you can ask yourself)');

  questions
    .command('list')
    .description('Pending questions; --all for answered, declined and expired ones too')
    .option('--all', 'every recent question, not only the pending ones')
    .option('--json', 'print JSON')
    .action(async (o: { all?: boolean; json?: boolean }) => {
      const items = await consoleApi().get<Question[]>('/questions', { query: { ...(o.all ? {} : { status: 'pending' }), limit: 100 } });
      if (o.json) return out(JSON.stringify(items, null, 2));
      if (!items.length) return out(o.all ? 'No questions yet.' : 'Nothing is waiting for you.');
      for (const q of items) {
        out(`${q.id.slice(0, 8)}  [${q.kind}, ${q.input}]  ${q.status === 'pending' ? '' : `(${answerText(q)})  `}${q.prompt}`);
        for (const line of optionLines(q)) out(`          ${line}`);
      }
    });

  questions
    .command('show <id>')
    .description('One question and its answer; --wait holds while it is pending')
    .option('--wait <seconds>', 'wait up to this long for an answer', int('--wait'))
    .option('--json', 'print JSON')
    .action(async (ref: string, o: { wait?: number; json?: boolean }) => {
      const q = await waitForQuestion(consoleApi(), await resolveId(ref), o.wait ?? 0);
      if (o.json) return out(JSON.stringify(q, null, 2));
      print(q);
    });

  questions
    .command('ask')
    .description('Ask yourself a question (no browser; never a secret), answered from any of your devices')
    .requiredOption('--input <type>', 'none, text, choice, multi_choice, number, confirm or takeover')
    .requiredOption('--prompt <text>', 'the question')
    .option('--kind <kind>', 'captcha, code, passkey, login, confirmation or other')
    .option('--option <id=label>', 'an option of choice or multi_choice (repeat it); a bare label is its own id', collect)
    .option('--min <n>', 'number: the smallest value', num('--min'))
    .option('--max <n>', 'number: the largest value', num('--max'))
    .option('--step <n>', 'number: the increment', num('--step'))
    .option('--unit <unit>', 'number: the unit, e.g. kg')
    .option('--pattern <regex>', 'text: the format the whole answer must match')
    .option('--max-length <n>', 'text: the longest answer', int('--max-length'))
    .option('--multiline', 'text: allow several lines')
    .option('--min-selections <n>', 'multi_choice: at least this many', int('--min-selections'))
    .option('--max-selections <n>', 'multi_choice: at most this many', int('--max-selections'))
    .option('--confirm-label <text>', 'confirm: the approve button')
    .option('--deny-label <text>', 'confirm: the deny button')
    .option('--risk <level>', 'confirm: low or high (high by default)')
    .option('--timeout <seconds>', 'how long the question stays open (default 1 hour)', int('--timeout'))
    .option('--wait <seconds>', 'wait up to this long for the answer', int('--wait'))
    .option('--json', 'print JSON')
    .action(async (o: AskFlags) => {
      const api = consoleApi();
      const asked = await api.post<Question>('/questions', askBody(o));
      const q = o.wait ? await waitForQuestion(api, asked.id, o.wait, asked) : asked;
      if (o.json) return out(JSON.stringify(q, null, 2));
      print(q);
    });

  questions
    .command('answer <id>')
    .description('Answer a question: --value, --values a,b, --choice ID, --approve, --deny, --done, --secret-stdin, or --decline')
    .option('--value <value>', 'text or number')
    .option('--values <ids>', 'multi_choice: option ids, comma separated')
    .option('--choice <id>', 'choice: an option id')
    .option('--approve', 'confirm: approve')
    .option('--deny', 'confirm: deny')
    .option('--done', 'none or takeover: you did what was asked')
    .option('--decline', 'you cannot or will not answer')
    .option('--secret-stdin', 'read a code or password from stdin (never pass secrets as arguments)')
    .action(async (ref: string, o: AnswerFlags) => {
      const api = consoleApi();
      const id = await resolveId(ref);
      const q = await api.get<Question>(`/questions/${id}`);
      const body = await answerFromFlags(o, q.input, readStdinLine);
      const done = await api.post<Question>(`/questions/${id}/answer`, { ...body, channel: 'cli' });
      out(body.outcome === 'completed' ? `sent (${answerText(done)})` : 'declined');
    });
};
