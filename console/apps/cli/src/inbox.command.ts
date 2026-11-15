import type { Command } from 'commander';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';

import { consoleApi } from './console-api.js';
import { readStdinLine, type InboxItem } from './inbox.js';

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
        out(`${i.runId.slice(0, 8)}  [${i.kind}, ${i.input}]  ${i.prompt}`);
        if (i.choices.length) out(`          choices: ${i.choices.join(' | ')}`);
      }
    });
  inbox
    .command('answer <run>')
    .description('Answer a request: --done, --value TEXT, --choice C, --secret-stdin, or --decline')
    .option('--done', 'you did what was asked (CAPTCHA, approval, sign-in)')
    .option('--value <text>', 'a text answer')
    .option('--choice <choice>', 'one of the offered choices')
    .option('--secret-stdin', 'read a code or password from stdin (never pass secrets as arguments)')
    .option('--decline', 'you cannot or will not help')
    .action(async (ref: string, o: { done?: boolean; value?: string; choice?: string; secretStdin?: boolean; decline?: boolean }) => {
      const api = consoleApi();
      const items = await api.get<InboxItem[]>('/inbox');
      const matches = items.filter((i) => i.runId === ref || i.runId.startsWith(ref));
      if (matches.length !== 1) throw new Error(matches.length ? `"${ref}" matches several requests` : `No waiting request for "${ref}" (see \`hexactra inbox list\`)`);
      const item = matches[0]!;
      let body: { outcome: 'completed' | 'cancelled'; value?: string };
      if (o.decline) body = { outcome: 'cancelled' };
      else if (o.secretStdin) body = { outcome: 'completed', value: await readStdinLine() };
      else if (o.value !== undefined) body = { outcome: 'completed', value: o.value };
      else if (o.choice !== undefined) body = { outcome: 'completed', value: o.choice };
      else if (o.done) body = { outcome: 'completed' };
      else throw new Error(`This request needs ${item.input === 'secret' ? '--secret-stdin' : item.input === 'text' ? '--value' : item.input === 'choice' ? '--choice' : '--done'} (or --decline).`);
      await api.post(`/inbox/${item.runId}/respond`, body);
      out(body.outcome === 'completed' ? 'sent; the agent continues' : 'declined');
    });
};
