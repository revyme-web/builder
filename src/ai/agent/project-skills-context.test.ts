// Which skills ride a turn: every always-apply one, plus the ones the message
// invoked — in full until the budget, and a skill over it is still NAMED.
import { describe, it, expect } from 'vitest';
import { formatProjectSkills, SKILLS_CONTEXT_CAP } from './editor-context';
import type { ProjectSkill } from '@/code/project/skills-config';

const skill = (name: string, content: string, alwaysApply = false): ProjectSkill => ({ name, description: `${name} desc`, content, alwaysApply, createdAt: 0, updatedAt: 0 });

describe('formatProjectSkills', () => {
  it('nothing always-on and nothing invoked: no section at all', () => {
    expect(formatProjectSkills([skill('seo', 'x')], [])).toBe('');
  });

  it('always-apply first, then the invoked ones; each says why it is there', () => {
    const out = formatProjectSkills([skill('seo', 'SEO RULES'), skill('voice', 'VOICE RULES', true)], ['seo']);
    expect(out.indexOf('/voice (always apply)')).toBeLessThan(out.indexOf('/seo (invoked for this request)'));
    expect(out).toContain('VOICE RULES');
    expect(out).toContain('SEO RULES');
  });

  it('over the budget: the skill is named for read_skill, not silently dropped', () => {
    const big = 'y'.repeat(SKILLS_CONTEXT_CAP - 100);
    const out = formatProjectSkills([skill('design-system', big, true), skill('seo', 'SEO RULES')], ['seo']);
    expect(out).not.toContain('SEO RULES');
    expect(out).toContain('read_skill: /seo');
  });
});
