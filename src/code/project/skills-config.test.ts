// The skills file is hand-editable project JSON: every row is checked, every
// string capped; and only a real /command invokes a skill.
import { describe, it, expect } from 'vitest';
import { parseSkills, toSkillName, invokedSkillNames, SKILL_CONTENT_MAX, MAX_SKILLS, type ProjectSkill } from './skills-config';

const skill = (name: string, extra: Partial<ProjectSkill> = {}): ProjectSkill => ({ name, description: '', content: 'x', alwaysApply: false, createdAt: 0, updatedAt: 0, ...extra });

describe('toSkillName', () => {
  it('turns what people type into a /command', () => {
    expect(toSkillName('Brand Voice!')).toBe('brand-voice');
    expect(toSkillName('/seo-check')).toBe('seo-check');
    expect(toSkillName('Café  menu')).toBe('cafe-menu');
    expect(toSkillName('!!!')).toBe('');
  });
});

describe('parseSkills', () => {
  it('keeps good rows, drops bad and duplicate ones, caps every string', () => {
    const raw = JSON.stringify({ version: 1, skills: [
      { name: 'Brand voice', description: 'd', content: 'rules', alwaysApply: true },
      { name: 'brand-voice', content: 'duplicate' },
      { name: 'no-content' },
      null,
      { name: 'big', content: 'y'.repeat(SKILL_CONTENT_MAX + 500), description: 'z'.repeat(500) },
    ] });
    const { skills } = parseSkills(raw);
    expect(skills.map((s) => s.name)).toEqual(['brand-voice', 'big']);
    expect(skills[0].alwaysApply).toBe(true);
    expect(skills[1].content.length).toBe(SKILL_CONTENT_MAX);
    expect(skills[1].description.length).toBe(200);
  });

  it('a broken file costs the skills, never the panel; the count is capped', () => {
    expect(parseSkills('{not json').skills).toEqual([]);
    expect(parseSkills(null).skills).toEqual([]);
    const many = JSON.stringify({ skills: Array.from({ length: MAX_SKILLS + 5 }, (_, i) => ({ name: `s${i}`, content: 'x' })) });
    expect(parseSkills(many).skills.length).toBe(MAX_SKILLS);
  });
});

describe('invokedSkillNames', () => {
  const skills = [skill('seo-check'), skill('brand-voice')];
  it('finds the project\'s /commands, in order, once each', () => {
    expect(invokedSkillNames('/seo-check the home page, then /brand-voice and /seo-check again', skills)).toEqual(['seo-check', 'brand-voice']);
  });
  it('a slash inside a word or a path is not a command; unknown names are ignored', () => {
    expect(invokedSkillNames('and/or https://x.com/seo-check', skills)).toEqual([]);
    expect(invokedSkillNames('/nothing here', skills)).toEqual([]);
  });
});
