// autosave-branch.test.ts — what a save carries once branches exist.
//
// `files` is MAIN, always: the publish / export / backup truth. Branches ride
// beside it in the v2 envelope, and the editor's position (which branch) is
// remembered. Until 2026-09-22 the save shipped `getSnapshot()` — the ACTIVE
// branch's map — as `files` in v1: sitting on a branch wrote the branch over
// main in the DB, and no branch survived a reload. These pin the contract.

import { beforeEach, describe, expect, it } from 'vitest';
import { buildProjectData } from './autosave';
import { PROJECT_FORMAT } from './types';
import { projectFS, resetProjectFS, MAIN_BRANCH_ID, InMemoryProjectFS } from '@/code/project/project-fs';

beforeEach(() => {
  resetProjectFS(new Map([['app/page.client.tsx', 'main-home'], ['components/A.tsx', 'a']]));
});

describe('buildProjectData', () => {
  it('a project with no branch saves the v1 envelope, byte-identical to before branching', () => {
    const data = buildProjectData();
    expect(data.format).toBe(PROJECT_FORMAT);
    expect(data.files).toEqual({ 'app/page.client.tsx': 'main-home', 'components/A.tsx': 'a' });
    expect(data.branches).toBeUndefined();
    expect(data.activeBranchId).toBeUndefined();
  });

  it('while ON a branch, `files` is still main — the branch rides beside it', () => {
    projectFS.createBranch('redesign');
    projectFS.switchBranch('redesign');
    projectFS.writeFile('app/page.client.tsx', 'branch-home');
    projectFS.writeFile('components/New.tsx', 'new');

    const data = buildProjectData();
    expect(data.format).toBe('revyme-v2');
    expect(data.files['app/page.client.tsx']).toBe('main-home');
    expect(data.files['components/New.tsx']).toBeUndefined();
    expect(data.branches?.redesign?.files).toEqual({
      'app/page.client.tsx': 'branch-home', 'components/A.tsx': 'a', 'components/New.tsx': 'new',
    });
    expect(data.branches?.redesign?.baseSnapshot?.['app/page.client.tsx']).toBe('main-home');
    expect(data.activeBranchId).toBe('redesign');
    expect(data.mainBranchId).toBe(MAIN_BRANCH_ID);
  });

  it('round-trips: a fresh FS hydrated from the envelope has the same branches and lands on the same one', () => {
    projectFS.createBranch('redesign');
    projectFS.switchBranch('redesign');
    projectFS.writeFile('app/page.client.tsx', 'branch-home');
    const data = buildProjectData();

    const booted = new InMemoryProjectFS(new Map(Object.entries(data.files)));
    booted.hydrateBranches(data.branches, data.activeBranchId);
    expect(booted.getActiveBranchId()).toBe('redesign');
    expect(booted.readFile('app/page.client.tsx')).toBe('branch-home');
    expect(booted.readBranchFile(MAIN_BRANCH_ID, 'app/page.client.tsx')).toBe('main-home');
    expect(booted.listBranches().map((b) => b.id)).toEqual([MAIN_BRANCH_ID, 'redesign']);
  });
});
