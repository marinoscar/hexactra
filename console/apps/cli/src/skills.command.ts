import { readFileSync } from 'node:fs';

import type { Command } from 'commander';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';

import { consoleApi } from './console-api.js';

/** A skill as `GET /api/skills` returns it (#1008). */
export interface SkillView {
  id: string;
  name: string;
  description: string;
  body: string;
  sites: string[];
  enabled: boolean;
  archivedAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

/** The list line: id prefix, name, sites, flags, description. */
export function skillLine(s: SkillView): string {
  const flags = [s.archivedAt ? 'archived' : null, s.enabled ? null : 'off'].filter(Boolean).join(', ');
  return `${s.id.slice(0, 8)}  ${s.name.padEnd(24)}  ${(s.sites.join(', ') || '-').padEnd(20)}  ${s.description}${flags ? `  [${flags}]` : ''}`;
}

/** The text of a skill from a text file (a SKILL.md is read whole: the owner checks what they send). */
export function readTextFile(path: string): string {
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) throw new Error(`${path} is empty`);
  return text;
}

/** A skill by full id, id prefix or exact name (ignoring case), archived ones included. */
export async function findSkill(ref: string): Promise<SkillView> {
  const api = consoleApi();
  if (UUID.test(ref)) return api.get<SkillView>(`/skills/${ref}`);
  const all = await api.get<SkillView[]>('/skills', { query: { archived: 'all' } });
  const matches = all.filter((s) => s.name.toLowerCase() === ref.toLowerCase());
  const found = matches.length ? matches : all.filter((s) => s.id.startsWith(ref));
  if (found.length === 1) return found[0]!;
  if (found.length > 1) throw new Error(`"${ref}" matches several skills; use the id`);
  throw new Error(`No skill matches "${ref}". Run \`skills list\`.`);
}

const collect = (value: string, prev: string[]): string[] => [...prev, value];

/** `hexactra skills …` over /api/skills: your playbooks for the agent. A skill grants nothing. */
export const skillsCommand: CliCommandRegistration = (program: Command) => {
  const skills = program.command('skills').description('Skills: how you want the agent to do a kind of job (guidance; a skill grants no permission)');
  skills
    .command('list')
    .description('Your skills')
    .option('--search <text>', 'search names, descriptions and sites')
    .option('--archived', 'list archived skills instead')
    .option('--json', 'print JSON')
    .action(async (o: { search?: string; archived?: boolean; json?: boolean }) => {
      const query: Record<string, string> = { archived: o.archived ? 'true' : 'false' };
      if (o.search) query.q = o.search;
      const list = await consoleApi().get<SkillView[]>('/skills', { query });
      if (o.json) return out(JSON.stringify(list, null, 2));
      if (list.length === 0) return out('No skills.');
      for (const s of list) out(skillLine(s));
    });
  skills
    .command('show <skill>')
    .description('One skill with its text (id, id prefix or name)')
    .option('--json', 'print JSON')
    .action(async (ref: string, o: { json?: boolean }) => {
      const s = await findSkill(ref);
      if (o.json) return out(JSON.stringify(s, null, 2));
      out(`${s.name}${s.enabled ? '' : ' (off)'}${s.archivedAt ? ' (archived)' : ''}`);
      out(`id: ${s.id}`);
      out(`when to use it: ${s.description}`);
      out(`sites: ${s.sites.join(', ') || '-'}`);
      out(`read by ${s.useCount} run${s.useCount === 1 ? '' : 's'}${s.lastUsedAt ? `, last ${s.lastUsedAt}` : ''}`);
      out('');
      out(s.body);
    });
  skills
    .command('add')
    .description('Add a skill. Its text comes from a text file; never a password, code or full card or account number')
    .requiredOption('--name <name>', 'what you call it (at most 60 characters)')
    .requiredOption('--description <text>', 'when to use it (at most 200 characters)')
    .requiredOption('--file <path>', 'a text or Markdown file with the guidance (at most 4,000 characters)')
    .option('--site <domain>', 'a site it is about, such as google.com (repeatable, at most 10)', collect, [] as string[])
    .option('--off', 'add it switched off')
    .option('--json', 'print JSON')
    .action(async (o: { name: string; description: string; file: string; site: string[]; off?: boolean; json?: boolean }) => {
      const body = { name: o.name, description: o.description, body: readTextFile(o.file), sites: o.site, ...(o.off ? { enabled: false } : {}) };
      const s = await consoleApi().post<SkillView>('/skills', body);
      if (o.json) return out(JSON.stringify(s, null, 2));
      out(`added ${s.name}  ${s.id}`);
    });
  skills
    .command('edit <skill>')
    .description('Change a skill: its name, when to use it, its text (from a file) or its sites')
    .option('--name <name>', 'a new name')
    .option('--description <text>', 'when to use it')
    .option('--file <path>', 'a text or Markdown file with the new guidance')
    .option('--site <domain>', 'the sites it is about: replaces the list (repeatable)', collect, [] as string[])
    .option('--no-sites', 'remove every site')
    .option('--json', 'print JSON')
    .action(async (ref: string, o: { name?: string; description?: string; file?: string; site: string[]; sites?: boolean; json?: boolean }) => {
      const patch: Record<string, unknown> = {};
      if (o.name) patch.name = o.name;
      if (o.description) patch.description = o.description;
      if (o.file) patch.body = readTextFile(o.file);
      if (o.site.length) patch.sites = o.site;
      else if (o.sites === false) patch.sites = [];
      if (Object.keys(patch).length === 0) throw new Error('Nothing to change: pass --name, --description, --file, --site or --no-sites');
      const found = await findSkill(ref);
      const s = await consoleApi().patch<SkillView>(`/skills/${found.id}`, patch);
      if (o.json) return out(JSON.stringify(s, null, 2));
      out(`changed ${s.name}`);
    });
  for (const [cmd, enabled] of [
    ['enable', true],
    ['disable', false],
  ] as const) {
    skills
      .command(`${cmd} <skill>`)
      .description(enabled ? 'Switch a skill on: it is offered when it fits a job' : 'Switch a skill off: kept, never offered')
      .action(async (ref: string) => {
        const found = await findSkill(ref);
        const s = await consoleApi().patch<SkillView>(`/skills/${found.id}`, { enabled });
        out(`${s.name} is ${enabled ? 'on' : 'off'}`);
      });
  }
  skills
    .command('archive <skill>')
    .description('Archive a skill (kept, never offered); --undo unarchives it')
    .option('--undo', 'unarchive it')
    .action(async (ref: string, o: { undo?: boolean }) => {
      const found = await findSkill(ref);
      const s = await consoleApi().post<SkillView>(`/skills/${found.id}/${o.undo ? 'unarchive' : 'archive'}`, {});
      out(`${o.undo ? 'unarchived' : 'archived'} ${s.name}`);
    });
  skills
    .command('delete <skill>')
    .description('Delete a skill permanently (id, id prefix or name)')
    .action(async (ref: string) => {
      const s = await findSkill(ref);
      await consoleApi().delete(`/skills/${s.id}`);
      out(`deleted ${s.name}`);
    });
};
