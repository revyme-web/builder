// The "New Branch" dialog — one modal for the panel's "+" and the chat's
// "New branch…", over the real in-memory ProjectFS.
//
// What this guards: a branch is created the way every other named thing is
// (the compact name modal, Enter to confirm), the name is validated INSIDE
// the dialog (empty / duplicate never reach the FS), and a successful create
// moves the editor onto the new branch — the panel and the chat header both
// read that pointer, so neither needs a callback to agree with it.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { getDefaultStore } from 'jotai';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import { BranchCreateModal } from './BranchCreateModal';
import BranchesPanel from '../BranchesPanel';
import { projectFS, resetProjectFS, MAIN_BRANCH_ID } from '@/code/project/project-fs';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { clearRememberedBranchFiles } from '@/code/branching/switch-workspace';

const store = getDefaultStore();

beforeEach(() => {
  cleanup();
  resetProjectFS(new Map([['app/page.client.tsx', 'export default function Page() { return <div data-id="a" /> }']]));
  clearRememberedBranchFiles();
  act(() => { store.set(activeFilePathAtom, 'app/page.client.tsx'); });
});

describe('BranchCreateModal', () => {
  it('creates the branch from the typed name and lands the editor on it', () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<BranchCreateModal isOpen onClose={onClose} onCreated={onCreated} />);
    expect(screen.getByText('New Branch')).toBeTruthy();
    const input = screen.getByPlaceholderText('Branch name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Pricing redesign' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCreated).toHaveBeenCalledWith('pricing-redesign');
    expect(onClose).toHaveBeenCalled();
    expect(projectFS.getActiveBranchId()).toBe('pricing-redesign');
    expect(projectFS.listBranches().map((b) => b.id)).toEqual([MAIN_BRANCH_ID, 'pricing-redesign']);
  });

  it('refuses a duplicate inside the dialog — nothing reaches the FS', () => {
    expect(projectFS.createBranch('pricing-redesign')).toBeNull();
    const onCreated = vi.fn();
    render(<BranchCreateModal isOpen onClose={() => {}} onCreated={onCreated} />);
    const input = screen.getByPlaceholderText('Branch name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'pricing redesign' } });
    fireEvent.click(screen.getByText('Create Branch'));
    expect(screen.getByText('“pricing-redesign” already exists.')).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
    expect(projectFS.listBranches()).toHaveLength(2);
    expect(projectFS.getActiveBranchId()).toBe(MAIN_BRANCH_ID);
  });

  it('refuses a name with nothing usable in it', () => {
    render(<BranchCreateModal isOpen onClose={() => {}} />);
    const input = screen.getByPlaceholderText('Branch name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '???' } });
    fireEvent.click(screen.getByText('Create Branch'));
    expect(screen.getByText('Use letters, digits or spaces.')).toBeTruthy();
    expect(projectFS.listBranches()).toHaveLength(1);
  });
});

describe('BranchesPanel', () => {
  it('"+" opens the shared New Branch dialog, and the new branch shows as the active row', () => {
    render(<BranchesPanel />);
    expect(screen.queryByText('New Branch')).toBeNull();
    fireEvent.click(screen.getByTitle('New branch'));
    expect(screen.getByText('New Branch')).toBeTruthy();
    const input = screen.getByPlaceholderText('Branch name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Footer rework' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(projectFS.getActiveBranchId()).toBe('footer-rework');
    expect(screen.getByText('footer-rework')).toBeTruthy();
  });

  it('lays the rows out like the Localization panel — search, then rows inset from the panel edge', () => {
    const { container } = render(<BranchesPanel />);
    expect(screen.getByPlaceholderText('Search branches…')).toBeTruthy();
    const list = container.querySelector('.overflow-y-auto.px-2');
    expect(list, 'the row list carries the px-2 inset the locale/CMS lists use').toBeTruthy();
    expect(list!.textContent).toContain(MAIN_BRANCH_ID);
  });
});
