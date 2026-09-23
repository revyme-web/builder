// Saving, renaming, refusing and deleting skills — the rules the Settings
// form and the agent's save_skill share.
import { describe, it, expect, beforeEach } from 'vitest';
import { resetProjectFS, projectFS } from '@/code/project/project-fs';
import { saveProjectSkill, listProjectSkills, getProjectSkill, deleteProjectSkill, setSkillAlwaysApply } from './project-skills-store';
import { SKILLS_FILE_PATH, MAX_SKILLS } from '@/code/project/skills-config';

beforeEach(() => { resetProjectFS(new Map([['app/page.tsx', 'export default function Page() { return null; }']])); });

describe('project skills store', () => {
  it('creates, then updates in place keeping createdAt and the always-apply choice', () => {
    const a = saveProjectSkill({ name: 'Brand voice', description: 'd', content: 'v1', alwaysApply: true }, undefined, 100);
    expect('error' in a).toBe(false);
    const b = saveProjectSkill({ name: 'brand-voice', content: 'v2' }, undefined, 200);
    expect(b).toMatchObject({ name: 'brand-voice', content: 'v2', alwaysApply: true, createdAt: 100, updatedAt: 200 });
    expect(listProjectSkills()).toHaveLength(1);
    expect(projectFS.readFile(SKILLS_FILE_PATH)).toContain('v2');
  });

  it('renames; refuses a rename onto another skill', () => {
    saveProjectSkill({ name: 'seo', content: 'a' });
    saveProjectSkill({ name: 'launch', content: 'b' });
    expect(saveProjectSkill({ name: 'launch', content: 'a' }, 'seo')).toEqual({ error: 'There is already a skill called /launch.' });
    expect('error' in saveProjectSkill({ name: 'seo-check', content: 'a' }, 'seo')).toBe(false);
    expect(listProjectSkills().map((s) => s.name)).toEqual(['launch', 'seo-check']);
  });

  it('refuses no name, no instructions, too long, and past the project limit', () => {
    expect('error' in saveProjectSkill({ name: '!!', content: 'x' })).toBe(true);
    expect('error' in saveProjectSkill({ name: 'a', content: '  ' })).toBe(true);
    expect('error' in saveProjectSkill({ name: 'a', content: 'x'.repeat(8001) })).toBe(true);
    for (let i = 0; i < MAX_SKILLS; i++) saveProjectSkill({ name: `s${i}`, content: 'x' });
    expect('error' in saveProjectSkill({ name: 'one-more', content: 'x' })).toBe(true);
  });

  it('toggles always-apply and deletes', () => {
    saveProjectSkill({ name: 'voice', content: 'x' });
    setSkillAlwaysApply('/voice', true);
    expect(getProjectSkill('voice')?.alwaysApply).toBe(true);
    expect(deleteProjectSkill('voice')).toBe(true);
    expect(getProjectSkill('voice')).toBeNull();
    expect(deleteProjectSkill('voice')).toBe(false);
  });
});
