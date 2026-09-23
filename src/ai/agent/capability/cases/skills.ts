// Project skills — the user's own saved instructions (the reference builder's Skills). The
// agent lists and reads them, and saves one only when asked; every case runs
// the real `_meta/skills.json` through the real store.
import type { CapabilityCase } from '../harness';
import { projectFS } from '@/code/project/project-fs';
import { SKILLS_FILE_PATH, parseSkills } from '@/code/project/skills-config';

const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const stored = () => parseSkills(projectFS.readFile(SKILLS_FILE_PATH)).skills;

export const SKILLS_CASES: CapabilityCase[] = [
  {
    id: 'skills/save-list-read', domain: 'skills', status: 'supported',
    feature: 'Save a skill when asked, then find and read it',
    ask: 'save this as a skill called brand voice: short sentences, no exclamation marks',
    calls: [
      { tool: 'save_skill', args: { name: 'Brand voice', description: 'Keep copy on brand', content: '- Short sentences.\n- No exclamation marks.', always_apply: true } },
      { tool: 'list_skills', args: {} },
      { tool: 'read_skill', args: { name: '/brand-voice' } },
    ],
    expect: (w) => {
      must(w.replies[0].data?.saved === '/brand-voice' && w.replies[0].data?.always_apply === true, `not saved: ${w.replies[0].text.slice(0, 200)}`);
      must(stored().some((s) => s.name === 'brand-voice' && s.alwaysApply && /No exclamation/.test(s.content)), 'the skill is not in _meta/skills.json');
      must(w.replies[1].data?.skills?.[0]?.name === '/brand-voice', 'list_skills does not list it');
      must(/Short sentences/.test(w.replies[2].data?.instructions ?? ''), 'read_skill does not return the instructions');
    },
  },
  {
    id: 'skills/update-and-rename', domain: 'skills', status: 'supported',
    feature: 'Update a skill in place, rename it',
    ask: 'rename my seo skill to seo-check and add a rule about alt text',
    calls: [
      { tool: 'save_skill', args: { name: 'seo', description: 'SEO', content: 'Titles under 60 characters.' } },
      { tool: 'save_skill', args: { name: 'seo-check', previous_name: 'seo', description: 'SEO review', content: 'Titles under 60 characters.\nEvery image has alt text.' } },
    ],
    expect: (w) => {
      const all = stored();
      must(all.length === 1 && all[0].name === 'seo-check' && /alt text/.test(all[0].content), `rename/update failed: ${JSON.stringify(all.map((s) => s.name))}`);
    },
  },
  {
    id: 'skills/refusals', domain: 'skills', status: 'supported',
    feature: 'A skill with no name, no instructions, or too long is refused with the reason',
    ask: '(safety) save an empty / nameless / oversized skill; read one that does not exist',
    calls: [
      { tool: 'save_skill', args: { name: '!!!', description: '', content: 'x' } },
      { tool: 'save_skill', args: { name: 'empty', description: '', content: '   ' } },
      { tool: 'save_skill', args: { name: 'huge', description: '', content: 'x'.repeat(9000) } },
      { tool: 'read_skill', args: { name: 'nope' } },
    ],
    allowFailedCalls: true,
    expect: (w) => {
      must(w.replies.every((r) => r.isError), 'one of the refusals did not hold');
      must(/characters/.test(w.replies[2].text), 'the size refusal does not say why');
      must(stored().length === 0, 'a refused skill was written anyway');
    },
  },
];
