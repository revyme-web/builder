// project-skills-store.ts — read / write the project's skills.
//
// Storage shape and the reasons for it: code/project/skills-config.ts. Same
// posture as the agent's chats: the file rides the normal project save, every
// write bumps the project version (panels re-read), there is no backend.
// Imperative on purpose — the agent's tools, the chat composer and the
// Settings section all call it, and only the Settings section is React.

import { useAtomValue } from 'jotai';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { bumpProjectVersion } from '@/code/project/modify-file';
import {
  SKILLS_FILE_PATH, SKILL_CONTENT_MAX, SKILL_DESCRIPTION_MAX, SKILL_NAME_RE, MAX_SKILLS,
  parseSkills, serializeSkills, toSkillName, type ProjectSkill,
} from '@/code/project/skills-config';
import { trace } from '@/shared/debug-trace';

function read(): ProjectSkill[] {
  return parseSkills(projectFS.readFile(SKILLS_FILE_PATH)).skills;
}

function write(skills: ProjectSkill[]): void {
  projectFS.writeFile(SKILLS_FILE_PATH, serializeSkills({ version: 1, skills }));
  bumpProjectVersion();
}

/** Every skill, alphabetical — the order the `/` menu and Settings show. */
export function listProjectSkills(): ProjectSkill[] {
  return [...read()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getProjectSkill(name: string): ProjectSkill | null {
  const key = toSkillName(name);
  return read().find((s) => s.name === key) ?? null;
}

/** Re-renders with every project change — the Settings list, the `/` menu. */
export function useProjectSkills(): ProjectSkill[] {
  useAtomValue(projectVersionAtom);
  return listProjectSkills();
}

export type SkillDraft = { name: string; description?: string; content: string; alwaysApply?: boolean };

/**
 * Create a skill, or update the one with that name (`previousName` renames).
 * Returns the saved skill, or why it was refused — the Settings form and the
 * agent's `save_skill` show the same reason.
 */
export function saveProjectSkill(draft: SkillDraft, previousName?: string, now: number = Date.now()): ProjectSkill | { error: string } {
  const name = toSkillName(draft.name);
  if (!name || !SKILL_NAME_RE.test(name)) return { error: 'Give the skill a name — letters, numbers and dashes, like "brand-voice".' };
  const content = draft.content.trim();
  if (!content) return { error: 'A skill needs instructions.' };
  if (content.length > SKILL_CONTENT_MAX) return { error: `Instructions are limited to ${SKILL_CONTENT_MAX.toLocaleString()} characters (this is ${content.length.toLocaleString()}). Keep a skill to the rules that matter.` };
  const description = (draft.description ?? '').trim().slice(0, SKILL_DESCRIPTION_MAX);

  const skills = read();
  const from = previousName ? toSkillName(previousName) : name;
  const existing = skills.find((s) => s.name === from);
  if (name !== from && skills.some((s) => s.name === name)) return { error: `There is already a skill called /${name}.` };
  if (!existing && skills.length >= MAX_SKILLS) return { error: `A project holds up to ${MAX_SKILLS} skills.` };

  const saved: ProjectSkill = {
    name,
    description,
    content,
    alwaysApply: draft.alwaysApply ?? existing?.alwaysApply ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  write([...skills.filter((s) => s.name !== from), saved]);
  trace.action('project-skills:save', { name, created: !existing, renamed: name !== from, chars: content.length });
  return saved;
}

export function setSkillAlwaysApply(name: string, alwaysApply: boolean): void {
  const skills = read();
  const key = toSkillName(name);
  if (!skills.some((s) => s.name === key)) return;
  write(skills.map((s) => (s.name === key ? { ...s, alwaysApply, updatedAt: Date.now() } : s)));
  trace.action('project-skills:always-apply', { name: key, alwaysApply });
}

export function deleteProjectSkill(name: string): boolean {
  const skills = read();
  const key = toSkillName(name);
  if (!skills.some((s) => s.name === key)) return false;
  write(skills.filter((s) => s.name !== key));
  trace.action('project-skills:delete', { name: key });
  return true;
}
