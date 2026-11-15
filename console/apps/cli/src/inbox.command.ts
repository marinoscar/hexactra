import type { Command } from 'commander';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';

import { consoleApi } from './console-api.js';
import { inboxRef, readStdinLine, type InboxItem } from './inbox.js';
import { answerFromFlags, constraintText, optionLines, type AnswerFlags } from './questions.js';

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

/** `hexactra inbox …`: what agents are waiting for, and answering them. */
export const inboxCommand: CliCommandRegistration = (program: Command) => {
  const inbox = program.command('inbox').description('Requests from agents waiting for you');
  inbox
    .command('list')
    .option('--json', 'print JSON')
    .action(async (o: { json?: boolean }) => {
      const items = await consoleApi().get<InboxItem[]>('/inbox');
      if (o.json) return out(JSON.stringify(items, null, 2));
      if (!items.length) return out('Nothing is waiting for you.');
      for (const i of items) {
        out(`${inboxRef(i)}  [${i.kind}, ${i.input}]  ${i.prompt}`);
        for (const line of optionLines(i)) out(`          ${line}`);
        const c = constraintText(i);
        if (c) out(`          ${c}`);
      }
    });
  inbox
    .command('answer <ref>')
    .description('Answer a request (by its run or question id, or a prefix): --done, --value V, --values a,b, --choice ID, --approve, --deny, --secret-stdin, or --decline')
    .option('--done', 'you did what was asked (CAPTCHA, sign-in, taking over the browser)')
    .option('--value <value>', 'a text or number answer')
    .option('--values <ids>', 'multi_choice: option ids, comma separated')
    .option('--choice <id>', 'one of the offered options (its id)')
    .option('--approve', 'confirm: approve')
    .option('--deny', 'confirm: deny')
    .option('--secret-stdin', 'read a code or password from stdin (never pass secrets as arguments)')
    .option('--decline', 'you cannot or will not help')
    .action(async (ref: string, o: AnswerFlags) => {
      const api = consoleApi();
      const items = await api.get<InboxItem[]>('/inbox');
      const matches = items.filter((i) => [i.runId, i.questionId].some((id) => id && (id === ref || id.startsWith(ref))));
      if (matches.length !== 1) throw new Error(matches.length ? `"${ref}" matches several requests` : `No waiting request for "${ref}" (see \`hexactra inbox list\`)`);
      const item = matches[0]!;
      // A run's question by its run (the run resumes at once); a free-standing one through the broker.
      const body = await answerFromFlags(o, item.input, readStdinLine);
      if (item.runId) await api.post(`/inbox/${item.runId}/respond`, body);
      else await api.post(`/questions/${item.questionId}/answer`, { ...body, channel: 'cli' });
      out(body.outcome === 'completed' ? 'sent; the agent continues' : 'declined');
    });
};
