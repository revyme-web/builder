// skills-config.ts — the project's SKILLS, in `_meta/skills.json`.
//
// A skill is the user's own instructions for a kind of work in THIS project —
// their design system, their brand voice, the check they run before launch —
// saved once and reused from the agent chat with `/name` (the reference builder's Skills,
// 2026-09). Not to be confused with the agent's MANUALS (the service's
// private knowledge of how Revyme works, `load_manual`): a skill is the
// user's, readable and editable by anyone who can edit the project.
//
// Why a project file and not a database row: the source is the document. The
// skills ride the normal project save, are shared with teammates, and `_meta/`
// is shared across branches (project-fs isSharedAcrossBranches), so a skill is
// the same on every branch. `_meta/` never ships in the published site.
//
// "Always apply" is the step past the reference builder: a brand voice or a design system
// should shape EVERY request, not only the ones where someone remembered to
// type `/brand-voice` — those ride every turn's context (editor-context.ts).

import { trace } from '@/shared/debug-trace';

export const SKILLS_FILE_PATH = '_meta/skills.json';

/** A skill's instructions — a page of rules, not a document. Billed as input
 *  on every turn that carries it. */
export const SKILL_CONTENT_MAX = 8000;
export const SKILL_DESCRIPTION_MAX = 200;
export const MAX_SKILLS = 40;

/** `/seo-check` — lowercase words joined by dashes, typed after the slash. */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 40;

export interface ProjectSkill {
  /** The slash command, without the slash. Unique in the project. */
  name: string;
  /** One line: what it is for — shown in the `/` menu and to the agent. */
  description: string;
  /** The instructions (Markdown). */
  content: string;
  /** Rides every agent turn, not only when invoked with `/name`. */
  alwaysApply: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SkillsFile {
  version: 1;
  skills: ProjectSkill[];
}

/** "Brand Voice!" → "brand-voice". Empty when nothing usable is left. */
export function toSkillName(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/^\/+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SKILL_NAME_MAX)
    .replace(/-+$/g, '');
}

/**
 * Parse the file. Defensive: it is hand-editable JSON in the project, so a
 * bad row costs that row, never the panel — and every string is capped here
 * too, so a pasted novel can never ride a turn uncapped.
 */
export function parseSkills(raw: string | null | undefined): SkillsFile {
  if (!raw) return { version: 1, skills: [] };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    trace.error('skills-config:parse-failed', { err: String(err) });
    return { version: 1, skills: [] };
  }
  const rows = Array.isArray((data as SkillsFile)?.skills) ? (data as SkillsFile).skills : [];
  const seen = new Set<string>();
  const skills: ProjectSkill[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const name = typeof r.name === 'string' ? toSkillName(r.name) : '';
    if (!name || seen.has(name) || typeof r.content !== 'string') continue;
    seen.add(name);
    skills.push({
      name,
      description: typeof r.description === 'string' ? r.description.slice(0, SKILL_DESCRIPTION_MAX) : '',
      content: r.content.slice(0, SKILL_CONTENT_MAX),
      alwaysApply: r.alwaysApply === true,
      createdAt: Number.isFinite(r.createdAt) ? r.createdAt : 0,
      updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt : 0,
    });
    if (skills.length >= MAX_SKILLS) break;
  }
  return { version: 1, skills };
}

export function serializeSkills(file: SkillsFile): string {
  return JSON.stringify(file, null, 2);
}

/** The `/name` tokens in a message that name one of the project's skills, in
 *  the order written, each once. `/` must start the message or follow a
 *  space — "and/or" and a URL path are not commands. */
export function invokedSkillNames(text: string, skills: readonly ProjectSkill[]): string[] {
  const known = new Set(skills.map((s) => s.name));
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)\/([a-z0-9][a-z0-9-]*)/g)) {
    const name = m[1].replace(/-+$/, '');
    if (known.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}
