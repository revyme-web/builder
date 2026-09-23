// Settings → Skills: add from the library, write one, switch always-apply,
// delete — and "Generate" hands the agent the design-system request.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { getDefaultStore } from 'jotai';
import SkillsSection, { GENERATE_DESIGN_SYSTEM_REQUEST } from './SkillsSection';
import { resetProjectFS, projectVersionAtom } from '@/code/project/project-fs';
import { setBumpVersion } from '@/code/project/modify-file';
import { getProjectSkill, listProjectSkills } from '@/code/stores/project-skills-store';
import { agentQueuedRequestAtom } from '@/code/stores/agent-chat-store';
import { leftPanelAtom } from '@/code/stores/left-panel-store';
import { settingsOverlayOpenAtom } from '@/code/stores/website-settings-store';

const store = getDefaultStore();
// The canvas wires this at boot (useMutationQueueLifecycle); a write to
// `_meta/` re-renders its readers through it.
setBumpVersion(() => store.set(projectVersionAtom, (v) => v + 1));
beforeEach(() => {
  cleanup();
  resetProjectFS(new Map([['app/page.tsx', 'x']]));
  act(() => { store.set(agentQueuedRequestAtom, null); store.set(settingsOverlayOpenAtom, true); });
});

describe('SkillsSection', () => {
  it('adds a starter from the library — a template opens straight in the editor', () => {
    render(<SkillsSection />);
    fireEvent.click(screen.getByText('Add from library'));
    const library = screen.getByTestId('skills-library');
    const seoRow = [...library.querySelectorAll('li')].find((li) => li.textContent?.includes('/seo-check'))!;
    fireEvent.click(seoRow.querySelector('button')!);
    expect(getProjectSkill('seo-check')?.content).toContain('get_seo');
    expect(seoRow.textContent).toContain('Added');
    // brand-voice is a template: added, and opened to fill in.
    const voiceRow = [...library.querySelectorAll('li')].find((li) => li.textContent?.includes('/brand-voice'))!;
    fireEvent.click(voiceRow.querySelector('button')!);
    expect(screen.getByTestId('skill-editor')).toBeTruthy();
  });

  it('writes a new skill; the name becomes a /command; a bad one says why', () => {
    render(<SkillsSection />);
    fireEvent.click(screen.getByText('New skill'));
    const [name, description] = screen.getByTestId('skill-editor').querySelectorAll('input');
    const content = screen.getByTestId('skill-editor').querySelector('textarea')!;
    fireEvent.change(name, { target: { value: 'Launch Check' } });
    expect(screen.getByText('Saved as /launch-check')).toBeTruthy();
    fireEvent.change(description, { target: { value: 'Before publishing' } });
    fireEvent.change(content, { target: { value: 'x'.repeat(8100) } });
    fireEvent.click(screen.getByText('Save'));
    expect(screen.getByTestId('skill-editor-error').textContent).toContain('8,000');
    fireEvent.change(content, { target: { value: 'Check every link.' } });
    fireEvent.click(screen.getByText('Save'));
    expect(getProjectSkill('launch-check')).toMatchObject({ description: 'Before publishing', content: 'Check every link.' });
    expect(screen.getByTestId('skills-list').textContent).toContain('/launch-check');
  });

  it('switches always-apply and deletes after confirming', () => {
    render(<SkillsSection />);
    fireEvent.click(screen.getByText('New skill'));
    fireEvent.change(screen.getByTestId('skill-editor').querySelector('input')!, { target: { value: 'voice' } });
    fireEvent.change(screen.getByTestId('skill-editor').querySelector('textarea')!, { target: { value: 'Short sentences.' } });
    fireEvent.click(screen.getByText('Save'));
    const row = screen.getByTestId('skills-list').querySelector('[data-skill="voice"]')!;
    fireEvent.click(row.querySelector('button[aria-pressed]')!);
    expect(getProjectSkill('voice')?.alwaysApply).toBe(true);
    fireEvent.click(screen.getByText('Delete'));
    const deletes = screen.getAllByText('Delete');
    fireEvent.click(deletes[deletes.length - 1]);
    expect(listProjectSkills()).toEqual([]);
  });

  it('Generate queues the design-system request, closes Settings and opens the chat', () => {
    render(<SkillsSection />);
    fireEvent.click(screen.getByText('Generate'));
    expect(store.get(agentQueuedRequestAtom)?.text).toBe(GENERATE_DESIGN_SYSTEM_REQUEST);
    expect(store.get(settingsOverlayOpenAtom)).toBe(false);
    expect(store.get(leftPanelAtom)).toBe('vibe');
  });
});
