import { writeFileSync } from 'node:fs';

import type { Command } from 'commander';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';

import { consoleApi } from './console-api.js';

/** A memory as `GET /api/memories` returns it. */
export interface MemoryView {
  id: string;
  kind: 'person' | 'account' | 'preference' | 'fact';
  label: string;
  aliases: string[];
  attributes: Record<string, string>;
  note: string | null;
  status: 'active' | 'superseded' | 'archived';
  source: 'owner' | 'agent_proposed';
  lastUsedAt: string | null;
  history?: MemoryView[];
}

const KINDS = ['person', 'account', 'preference', 'fact'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

/** `name: value; phone: value`. */
export const attributesText = (a: Record<string, string>): string =>
  Object.entries(a)
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ');

/** The list line: id prefix, kind, label, attributes, flags. */
export function memoryLine(m: MemoryView): string {
  const flags = [m.status !== 'active' ? m.status : null, m.source === 'agent_proposed' ? 'suggested by the agent' : null].filter(Boolean).join(', ');
  return `${m.id.slice(0, 8)}  ${m.kind.padEnd(10)}  ${m.label.padEnd(24)}  ${attributesText(m.attributes)}${flags ? `  [${flags}]` : ''}`;
}

/** `--attr name=value`, repeatable. The value is read from the flag, never from a prompt. */
export function parseAttributes(pairs: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at <= 0) throw new Error(`--attr takes name=value, got "${pair}"`);
    out[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  return out;
}

/** A memory by full id, id prefix or exact label (active or archived). */
export async function findMemory(ref: string): Promise<MemoryView> {
  const api = consoleApi();
  if (UUID.test(ref)) return api.get<MemoryView>(`/memories/${ref}`);
  const all = await api.get<MemoryView[]>('/memories', { query: { status: 'all' } });
  const live = all.filter((m) => m.status !== 'superseded');
  const matches = live.filter((m) => m.id.startsWith(ref) || m.label.toLowerCase() === ref.toLowerCase());
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`"${ref}" matches several memories; use the id`);
  throw new Error(`No memory matches "${ref}". Run \`memories list\`.`);
}

const collect = (value: string, prev: string[]): string[] => [...prev, value];

/** `hexactra memories …` over /api/memories: facts you let the agent use. */
export const memoriesCommand: CliCommandRegistration = (program: Command) => {
  const memories = program.command('memories').description('Memories: facts you let the agent use (people, accounts, preferences)');
  memories
    .command('list')
    .description('Your active memories')
    .option('--kind <kind>', 'person, account, preference or fact')
    .option('--search <text>', 'search labels, aliases and values')
    .option('--archived', 'list archived memories instead')
    .option('--json', 'print JSON')
    .action(async (o: { kind?: string; search?: string; archived?: boolean; json?: boolean }) => {
      if (o.kind && !KINDS.includes(o.kind as (typeof KINDS)[number])) throw new Error(`--kind is one of ${KINDS.join(', ')}`);
      const query: Record<string, string> = { status: o.archived ? 'archived' : 'active' };
      if (o.kind) query.kind = o.kind;
      if (o.search) query.q = o.search;
      const list = await consoleApi().get<MemoryView[]>('/memories', { query });
      if (o.json) return out(JSON.stringify(list, null, 2));
      if (list.length === 0) return out('No memories.');
      for (const m of list) out(memoryLine(m));
    });
  memories
    .command('show <memory>')
    .description('One memory with its history (id, id prefix or label)')
    .option('--json', 'print JSON')
    .action(async (ref: string, o: { json?: boolean }) => {
      const found = await findMemory(ref);
      const m = await consoleApi().get<MemoryView>(`/memories/${found.id}`);
      if (o.json) return out(JSON.stringify(m, null, 2));
      out(`${m.label} (${m.kind}, ${m.status})`);
      out(`id: ${m.id}`);
      if (m.aliases.length) out(`aliases: ${m.aliases.join(', ')}`);
      for (const [k, v] of Object.entries(m.attributes)) out(`  ${k}: ${v}`);
      if (m.note) out(`note: ${m.note}`);
      out(m.source === 'agent_proposed' ? 'source: suggested by the agent, approved by you' : 'source: added by you');
      for (const h of m.history ?? []) out(`  earlier: ${attributesText(h.attributes)}`);
    });
  memories
    .command('add <label>')
    .description('Add a memory. Values come from --attr; never a password, code or full card or account number')
    .requiredOption('--kind <kind>', 'person, account, preference or fact')
    .option('--attr <name=value>', 'a named value (repeatable)', collect, [] as string[])
    .option('--alias <word>', 'another word for it (repeatable)', collect, [] as string[])
    .option('--note <text>', 'free text')
    .option('--json', 'print JSON')
    .action(async (label: string, o: { kind: string; attr: string[]; alias: string[]; note?: string; json?: boolean }) => {
      if (!KINDS.includes(o.kind as (typeof KINDS)[number])) throw new Error(`--kind is one of ${KINDS.join(', ')}`);
      const body = { kind: o.kind, label, attributes: parseAttributes(o.attr), ...(o.alias.length ? { aliases: o.alias } : {}), ...(o.note ? { note: o.note } : {}) };
      const m = await consoleApi().post<MemoryView>('/memories', body);
      if (o.json) return out(JSON.stringify(m, null, 2));
      out(`added ${m.label}  ${m.id}`);
    });
  memories
    .command('rm <memory>')
    .description('Delete a memory and its history permanently (id, id prefix or label)')
    .action(async (ref: string) => {
      const m = await findMemory(ref);
      await consoleApi().delete(`/memories/${m.id}`);
      out(`deleted ${m.label}`);
    });
  memories
    .command('export')
    .description('Write your memories as a hexactra.memories JSON file (stdout, or -o file)')
    .option('-o, --output <file>', 'write to this file instead of stdout')
    .action(async (o: { output?: string }) => {
      const file = await consoleApi().get<unknown>('/memories/export');
      const text = `${JSON.stringify(file, null, 2)}\n`;
      if (o.output) {
        writeFileSync(o.output, text);
        out(`wrote ${o.output}`);
      } else process.stdout.write(text);
    });
};
