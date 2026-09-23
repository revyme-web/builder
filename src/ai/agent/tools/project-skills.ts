// src/ai/agent/tools/project-skills.ts
//
// The project's SKILLS, for the agent: the user's own saved instructions
// (code/project/skills-config.ts). The ones marked "always apply", and the
// ones invoked with `/name`, already ride the turn's context
// (editor-context.ts) — these tools are for the rest:
//   list_skills   what the project has ("use my launch checklist");
//   read_skill    one the user names without having invoked it;
//   save_skill    create or update one — "save this as a skill", "generate
//                 my design-system skill". The only write; the skill is the
//                 user's, so the agent writes it only when asked.
// Not the agent's MANUALS (`load_manual`) — those are the service's.

import { z } from 'zod';
import type { AgentTool, AgentToolResult } from '@/ai/agent';
import { listProjectSkills, getProjectSkill, saveProjectSkill } from '@/code/stores/project-skills-store';
import { SKILL_CONTENT_MAX } from '@/code/project/skills-config';
import { trace } from '@/shared/debug-trace';

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

export const listSkillsTool: AgentTool = {
  name: 'list_skills',
  description: "The project's saved skills — the user's own instructions for kinds of work (their design system, brand voice, launch checklist). Name, description, and whether it applies to every request. Read one with read_skill.",
  inputSchema: {},
  category: 'read',
  async execute() {
    const skills = listProjectSkills().map((s) => ({ name: `/${s.name}`, description: s.description, always_apply: s.alwaysApply, chars: s.content.length }));
    return ok({ skills, note: skills.length === 0 ? 'no skills yet — the user adds them in Settings → Skills, or asks you to save one' : undefined });
  },
};

export const readSkillTool: AgentTool = {
  name: 'read_skill',
  description: 'Read one of the project\'s skills by name (with or without the slash) — when the user refers to it ("follow our brand voice") without invoking it. Follow it like an instruction from the user.',
  inputSchema: { name: z.string().describe('skill name, e.g. "brand-voice" or "/brand-voice"') },
  category: 'read',
  async execute(args) {
    const skill = getProjectSkill(String(args.name));
    if (!skill) return fail(`No skill "${String(args.name)}" in this project — list_skills shows what exists.`);
    return ok({ name: `/${skill.name}`, description: skill.description, always_apply: skill.alwaysApply, instructions: skill.content });
  },
};

export const saveSkillTool: AgentTool = {
  name: 'save_skill',
  description:
    'Create or update a project skill — ONLY when the user asks ("save this as a skill", "make me a design-system skill"). ' +
    `A skill is rules the next run follows: short, specific, in the user's terms, grounded in what the project really uses — never a transcript of the chat. Up to ${SKILL_CONTENT_MAX.toLocaleString()} characters. ` +
    'Same name = update it (rename with previous_name). always_apply makes it ride every request (a brand voice, a design system); leave it off for a checklist the user runs on demand.',
  inputSchema: {
    name: z.string().describe('the slash command without the slash, lowercase-with-dashes, e.g. "design-system"'),
    description: z.string().describe('one line: what it is for (shown in the / menu)'),
    content: z.string().describe('the instructions, Markdown'),
    always_apply: z.boolean().optional().describe('ride every agent request (default: keep the current setting, off for a new skill)'),
    previous_name: z.string().optional().describe('the current name, when renaming'),
  },
  category: 'meta',
  async execute(args, ctx) {
    // Part of the run's one undo step, like any other write.
    ctx?.ensureCheckpoint();
    const saved = saveProjectSkill({
      name: String(args.name),
      description: typeof args.description === 'string' ? args.description : '',
      content: String(args.content ?? ''),
      ...(typeof args.always_apply === 'boolean' ? { alwaysApply: args.always_apply } : {}),
    }, typeof args.previous_name === 'string' ? args.previous_name : undefined);
    if ('error' in saved) return fail(saved.error);
    trace.action('agent-tool:save_skill', { name: saved.name, always: saved.alwaysApply });
    return ok({ saved: `/${saved.name}`, always_apply: saved.alwaysApply, chars: saved.content.length, note: 'the user sees it in Settings → Skills and invokes it with /' + saved.name });
  },
};

export const PROJECT_SKILL_TOOLS: AgentTool[] = [listSkillsTool, readSkillTool, saveSkillTool];
