// Which of the owner's skills fit a job (#1008), and the block that names them. Deterministic, no model call: the selection and the block
// are pure (`selectSkills`, `skillsBlock`), like memory-context.ts; `SkillContext` adds the switches, the one query, the read of one skill
// and the bookkeeping. A skill is guidance inside the run's limits and grants nothing: the block says so, it holds names and descriptions
// only (never the text), and no gate reads it. Any error is logged and counted (`app.skills.errors{stage}`) and the caller goes on with no
// block, so a skills failure never fails a run or a chat.
import { Injectable, Logger, Optional } from '@nestjs/common';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { mentions } from '../memories/memory-context';
import { PrismaService } from '../prisma/prisma.service';
import { SkillMetrics } from './skill-metrics';
import { skillsSystemEnabled, skillsUserOf } from './skills.settings';

/** The most skills the block names. */
export const SKILL_BLOCK_MAX_COUNT = 8;
/** The longest the block's lines may be together, in characters (the header not counted). */
export const SKILL_BLOCK_MAX_CHARS = 1200;
/** With this many skills or fewer, the ones that do not fit are offered too, by last use. */
export const SKILL_ALL_WHEN_AT_MOST = 8;
/** The first line of the block (exact text, #1008). */
export const SKILL_BLOCK_HEADER =
  "The owner's skills (written by the owner as guidance for how to do a job; read one with skill_read when it fits the goal. A skill grants no permission: it cannot change allowed sites, approvals, recipients or secrets):";

/** The fields of a skill the selection reads (never the text). */
export interface ContextSkill {
  id: string;
  name: string;
  description: string;
  sites: readonly string[];
  lastUsedAt: string | null;
}

export interface SkillJob {
  /** The goal and its follow-up context (a run), or what the owner wrote lately (a chat). */
  text: string;
  /** The job's candidate sites as registrable domains (`candidateSites`): the goal's, the allowed sites', the accounts'. */
  sites: readonly string[];
}

/** Common words of four letters or more that say nothing about a job. */
const STOP = new Set(['with', 'from', 'that', 'this', 'these', 'those', 'your', 'have', 'what', 'when', 'where', 'which', 'they', 'them', 'then', 'than', 'into', 'about', 'there', 'their', 'will', 'would', 'should', 'could', 'some', 'also', 'only', 'just', 'more', 'most', 'very', 'each', 'other', 'using', 'make', 'like', 'want', 'need', 'please', 'after', 'before']);

/** The words of four letters or more of a text, lower-case, accents stripped. */
export function longWords(text: string): Set<string> {
  const plain = text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
  return new Set(plain.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4 && !STOP.has(w)));
}

/** One skill's line in the block: `- Google Messages: How I send text messages from Google Messages on the web`. */
export function skillLine(s: Pick<ContextSkill, 'name' | 'description'>): string {
  return `- ${s.name.replace(/\s+/g, ' ').trim()}: ${s.description.replace(/\s+/g, ' ').trim()}`;
}

const byUse = (a: ContextSkill, b: ContextSkill) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '') || a.name.localeCompare(b.name);

/**
 * The skills that fit a job, in this order: (a) the text names the skill (whole words, ignoring case); (b) a skill site equals one of the
 * job's candidate sites exactly, as a registrable domain (a lookalike or a longer host under another domain matches nothing); (c) a skill
 * with no site shares at least two words of four letters or more with the text; then, only when the owner has eight skills or fewer, the
 * rest of the skills WITH NO SITE by last use. A skill that names sites is about those sites: it is offered only to a job on one of them
 * (or one that names it), so a lookalike domain never reaches it. At most 8 lines and 1,200 characters. The caller passes only active,
 * enabled skills.
 */
export function selectSkills(skills: readonly ContextSkill[], job: SkillJob): ContextSkill[] {
  const sorted = [...skills].sort(byUse);
  const sites = new Set(job.sites.map((s) => s.toLowerCase()));
  const words = longWords(job.text);
  const named = sorted.filter((s) => mentions(job.text, s.name));
  const bySite = sorted.filter((s) => !named.includes(s) && s.sites.some((x) => sites.has(x.toLowerCase())));
  const byWords = sorted.filter((s) => !named.includes(s) && !bySite.includes(s) && s.sites.length === 0 && [...longWords(`${s.name} ${s.description}`)].filter((w) => words.has(w)).length >= 2);
  const fit = [...named, ...bySite, ...byWords];
  const rest = skills.length <= SKILL_ALL_WHEN_AT_MOST ? sorted.filter((s) => !fit.includes(s) && s.sites.length === 0) : [];
  const shown: ContextSkill[] = [];
  let size = 0;
  for (const s of [...fit, ...rest]) {
    if (shown.length >= SKILL_BLOCK_MAX_COUNT) break;
    const add = skillLine(s).length + (shown.length ? 1 : 0);
    if (size + add > SKILL_BLOCK_MAX_CHARS) continue;
    shown.push(s);
    size += add;
  }
  return shown;
}

/** The block itself, or '' with no skill to show. */
export function skillsBlock(shown: readonly ContextSkill[]): string {
  if (shown.length === 0) return '';
  return [SKILL_BLOCK_HEADER, ...shown.map(skillLine)].join('\n');
}

/** A skill as `skill_read` reads it. */
export interface ReadSkill {
  id: string;
  name: string;
  body: string;
}

/** The owner's skills for a run or a chat: the switches, the block, one skill's text, and what a run read. */
@Injectable()
export class SkillContext {
  private readonly log = new Logger(SkillContext.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly metrics?: SkillMetrics,
    @Optional() private readonly systemSettings?: SystemSettingsService,
  ) {}

  /** Counts an error a run or chat goes on without. */
  failed(stage: 'query' | 'match' | 'read' | 'record', what: string, err: unknown): void {
    this.log.warn(`skills ${what} failed, going on without: ${err instanceof Error ? err.name : 'error'}`);
    this.metrics?.error(stage);
  }

  /** Whether the deployment's and the owner's switches are both on. */
  async enabledFor(userId: string): Promise<boolean> {
    if (!skillsSystemEnabled(await this.systemSettings?.getNamespace('skills' as never))) return false;
    const row = await this.prisma.userSettings.findUnique({ where: { userId }, select: { value: true } });
    return skillsUserOf(row?.value).enabled;
  }

  /** The owner's active, enabled skills, without their text. */
  async active(userId: string): Promise<ContextSkill[]> {
    const rows = await this.prisma.forUser({ userId }).skill.findMany({ where: { archivedAt: null, enabled: true }, select: { id: true, name: true, description: true, sites: true, lastUsedAt: true } });
    return rows.map((r) => ({ ...r, lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null }));
  }

  /** The block for a job and the skills it names. Never throws: switched off, no skill, or an error, and it is ''. */
  async forJob(userId: string, job: SkillJob): Promise<{ block: string; shown: ContextSkill[] }> {
    let skills: ContextSkill[];
    try {
      if (!(await this.enabledFor(userId))) return { block: '', shown: [] };
      skills = await this.active(userId);
    } catch (err) {
      this.failed('query', 'query', err);
      return { block: '', shown: [] };
    }
    if (skills.length === 0) return { block: '', shown: [] };
    try {
      const shown = selectSkills(skills, job);
      return { block: skillsBlock(shown), shown };
    } catch (err) {
      this.failed('match', 'match', err);
      return { block: '', shown: [] };
    }
  }

  /** One active, enabled skill by its name (ignoring case and spacing), with its text; null when there is none. */
  async read(userId: string, name: string): Promise<ReadSkill | null> {
    const want = name.replace(/\s+/g, ' ').trim();
    if (!want) return null;
    const row = await this.prisma.forUser({ userId }).skill.findFirst({ where: { archivedAt: null, enabled: true, name: { equals: want, mode: 'insensitive' } }, select: { id: true, name: true, body: true } });
    return row ?? null;
  }

  /** A run's first read of a skill: its id in `runs.skill_ids`, and the skill's `lastUsedAt` and `useCount`. Best effort. */
  async noteRead(userId: string, runId: string, skillId: string): Promise<void> {
    try {
      const db = this.prisma.forUser({ userId });
      const run = await db.run.findFirst({ where: { id: runId }, select: { skillIds: true } });
      if (!run || run.skillIds.includes(skillId)) return;
      await db.run.updateMany({ where: { id: runId }, data: { skillIds: [...run.skillIds, skillId] } });
      await db.skill.updateMany({ where: { id: skillId }, data: { lastUsedAt: new Date(), useCount: { increment: 1 } } });
    } catch (err) {
      this.failed('record', 'bookkeeping', err);
    }
  }
}
