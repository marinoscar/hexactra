import type { PlatformApiClient } from '@marinoscar/platform-web/core';

/** The limits the API enforces (apps/api/src/skills/skills.schemas.ts). */
export const SKILL_LIMITS = { name: 60, description: 200, body: 4000, sites: 10 } as const;

/** A skill as `GET /api/skills` returns it (#1008). */
export interface Skill {
  id: string;
  name: string;
  description: string;
  body: string;
  sites: string[];
  enabled: boolean;
  archivedAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SkillInput {
  name: string;
  description: string;
  body: string;
  sites: string[];
}

export function listSkills(api: PlatformApiClient, archived: boolean): Promise<Skill[]> {
  return api.get<Skill[]>(`/skills?archived=${archived ? 'all' : 'false'}`);
}

export function getSkill(api: PlatformApiClient, id: string): Promise<Skill> {
  return api.get<Skill>(`/skills/${encodeURIComponent(id)}`);
}

export function createSkill(api: PlatformApiClient, input: SkillInput): Promise<Skill> {
  return api.post<Skill>('/skills', input);
}

export function updateSkill(api: PlatformApiClient, id: string, patch: Partial<SkillInput> & { enabled?: boolean }): Promise<Skill> {
  return api.patch<Skill>(`/skills/${id}`, patch);
}

export function setSkillArchived(api: PlatformApiClient, id: string, archived: boolean): Promise<Skill> {
  return api.post<Skill>(`/skills/${id}/${archived ? 'archive' : 'unarchive'}`, {});
}

export function deleteSkill(api: PlatformApiClient, id: string): Promise<void> {
  return api.delete<void>(`/skills/${id}`);
}

/** The owner's switch (`skills.enabled`, on by default). */
export async function getSkillsOn(api: PlatformApiClient): Promise<boolean> {
  const doc = await api.get<{ skills?: { enabled?: boolean } | null }>('/user-settings');
  return doc.skills?.enabled !== false;
}

export async function setSkillsOn(api: PlatformApiClient, enabled: boolean): Promise<boolean> {
  const doc = await api.patch<{ skills?: { enabled?: boolean } | null }>('/user-settings', { skills: { enabled } });
  return doc.skills?.enabled !== false;
}

/** What "Fill from a SKILL.md file" takes from a file: never anything else. */
export interface SkillFileFill {
  name: string;
  description: string;
  body: string;
}

/**
 * Reads a SKILL.md (the agentskills.io format: YAML front matter with `name` and `description`, then the text) in the browser. Only the
 * `name` and `description` lines of the front matter are read; the rest of the file is the text. Folders, `scripts/`, `references/` and
 * links are not followed: nothing is fetched and nothing is saved until the owner presses Save. A file without front matter is all text.
 */
export function parseSkillFile(text: string): SkillFileFill {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!fm) return { name: '', description: '', body: src.trim() };
  const field = (key: string): string => {
    const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(fm[1]!);
    if (!m) return '';
    const v = m[1]!.trim();
    return /^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v;
  };
  return { name: field('name'), description: field('description'), body: src.slice(fm[0].length).trim() };
}
