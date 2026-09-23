// The composer's / menu: what is being typed at the caret, and what a pick writes.
import { describe, it, expect } from 'vitest';
import { slashQueryAt, applySkillPick, matchSkills, skillSegments } from './SkillMenu';
import type { ProjectSkill } from '@/code/project/skills-config';

const skill = (name: string, description = ''): ProjectSkill => ({ name, description, content: 'x', alwaysApply: false, createdAt: 0, updatedAt: 0 });

describe('slashQueryAt', () => {
  it('reads a /query at the start or after a space', () => {
    expect(slashQueryAt('/se', 3)).toEqual({ query: 'se', start: 0 });
    expect(slashQueryAt('check /', 7)).toEqual({ query: '', start: 6 });
    expect(slashQueryAt('fix this /brand', 15)).toEqual({ query: 'brand', start: 9 });
  });
  it('is not a command inside a word, a URL, or after the caret moved on', () => {
    expect(slashQueryAt('and/or', 6)).toBeNull();
    expect(slashQueryAt('https://x.com/a', 15)).toBeNull();
    expect(slashQueryAt('/seo check', 10)).toBeNull();
  });
});

describe('applySkillPick', () => {
  it('replaces the partial command with /name and a space, caret after it', () => {
    expect(applySkillPick('fix /se', 7, 4, 'seo-check')).toEqual({ text: 'fix /seo-check ', caret: 15 });
    // Picking in the middle keeps the rest of the message.
    expect(applySkillPick('/br the hero', 3, 0, 'brand-voice')).toEqual({ text: '/brand-voice the hero', caret: 13 });
  });
});

describe('matchSkills', () => {
  it('names starting with the query first, then ones containing it (or in the description)', () => {
    const skills = [skill('launch-check', 'before publish'), skill('seo-check'), skill('check-links')];
    expect(matchSkills(skills, 'check').map((s) => s.name)).toEqual(['check-links', 'launch-check', 'seo-check']);
    expect(matchSkills(skills, 'publish').map((s) => s.name)).toEqual(['launch-check']);
  });
});

describe('skillSegments', () => {
  const names = ['seo-check', 'design-system'];
  it('marks only whole commands the project has, by the send rule', () => {
    expect(skillSegments('/design-system build the pricing page', names)).toEqual([
      { text: '/design-system', skill: 'design-system' },
      { text: ' build the pricing page' },
    ]);
    expect(skillSegments('fix /seo-check and/or /des', names)).toEqual([
      { text: 'fix ' }, { text: '/seo-check', skill: 'seo-check' }, { text: ' and/or /des' },
    ]);
  });
  it('the segments always add back up to the text (the highlight layer never shifts a glyph)', () => {
    for (const t of ['', 'plain', '/seo-check', '/seo-check-', 'a\n/design-system\n\n', '/seo-check/seo-check']) {
      expect(skillSegments(t, names).map((x) => x.text).join('')).toBe(t);
    }
  });
});
