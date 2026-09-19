import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from 'jotai';
import { projectFS, projectVersionAtom, MAIN_BRANCH_ID } from '@/code/project/project-fs';
import { branchesAtom, activeBranchIdAtom, isOnMainAtom, dirtyBranchesAtom, toBranchId } from './branch-store';

const PAGE = `'use client';\nexport default function Page() { return <div data-id="root" style={{ position: 'relative' }}></div>; }`;

describe('toBranchId', () => {
  it('normalizes what a user types into a legal id', () => {
    expect(toBranchId('My New Branch')).toBe('my-new-branch');
    expect(toBranchId('  Hero__v2!! ')).toBe('hero-v2');
    expect(toBranchId('--a--b--')).toBe('a-b');
  });
  it('returns empty when nothing legal survives, so the caller can refuse', () => {
    expect(toBranchId('!!!')).toBe('');
    expect(toBranchId('   ')).toBe('');
  });
  it('caps at the 48-char id limit ProjectFS enforces', () => {
    expect(toBranchId('x'.repeat(80))).toHaveLength(48);
  });
});

describe('branch-store atoms', () => {
  let store: ReturnType<typeof createStore>;
  beforeEach(() => {
    for (const b of projectFS.listBranches()) if (!b.protected) projectFS.deleteBranch(b.id);
    projectFS.switchBranch(MAIN_BRANCH_ID);
    projectFS.loadSnapshot(new Map([['app/page.client.tsx', PAGE]]));
    store = createStore();
  });

  it('lists main alone on a fresh project, and main is protected', () => {
    const list = store.get(branchesAtom);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(MAIN_BRANCH_ID);
    expect(list[0].protected).toBe(true);
    expect(store.get(isOnMainAtom)).toBe(true);
  });

  it('re-derives on the project version pulse after a branch is created', () => {
    expect(store.get(branchesAtom)).toHaveLength(1);
    projectFS.createBranch('test', { from: projectFS.getSnapshot() });
    store.set(projectVersionAtom, (v) => v + 1);
    expect(store.get(branchesAtom).map((b) => b.id)).toEqual([MAIN_BRANCH_ID, 'test']);
  });

  it('tracks the active branch and reports leaving main', () => {
    projectFS.createBranch('test', { from: projectFS.getSnapshot() });
    projectFS.switchBranch('test');
    store.set(projectVersionAtom, (v) => v + 1);
    expect(store.get(activeBranchIdAtom)).toBe('test');
    expect(store.get(isOnMainAtom)).toBe(false);
    projectFS.switchBranch(MAIN_BRANCH_ID);
    store.set(projectVersionAtom, (v) => v + 1);
    expect(store.get(isOnMainAtom)).toBe(true);
  });

  it('a branch is clean until edited, then dirty — and main never appears dirty', () => {
    projectFS.createBranch('test', { from: projectFS.getSnapshot() });
    store.set(projectVersionAtom, (v) => v + 1);
    expect(store.get(dirtyBranchesAtom)).toEqual([]);

    projectFS.switchBranch('test');
    projectFS.writeFile('app/page.client.tsx', PAGE.replace('relative', 'absolute'));
    store.set(projectVersionAtom, (v) => v + 1);
    expect(store.get(dirtyBranchesAtom).map((b) => b.id)).toEqual(['test']);

    projectFS.switchBranch(MAIN_BRANCH_ID);
  });

  it('edits on a branch do NOT touch main — main stays the publish truth', () => {
    projectFS.createBranch('test', { from: projectFS.getSnapshot() });
    projectFS.switchBranch('test');
    projectFS.writeFile('app/page.client.tsx', 'BRANCH ONLY');
    expect(projectFS.readFile('app/page.client.tsx')).toBe('BRANCH ONLY');

    projectFS.switchBranch(MAIN_BRANCH_ID);
    expect(projectFS.readFile('app/page.client.tsx')).toBe(PAGE);
  });
});
