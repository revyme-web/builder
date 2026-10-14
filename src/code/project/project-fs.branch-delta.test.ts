// project-fs.branch-delta.test.ts — branches are saved as deltas, not copies.
//
// Each branch used to ride in the save as two FULL copies of the site (files +
// baseSnapshot). Four branches on a 1.8 MB site made a 16 MB save — past the
// database's packet limit — and every save after that failed (2026-10-12).
// These pin the delta encoding: exact round-trip, legacy records still load,
// and the save no longer grows with the size of the site per branch.

import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryProjectFS, MAIN_BRANCH_ID, applyFileDelta, diffFileMaps } from './project-fs';
import type { ProjectData } from '@/backend/types';

const big = (tag: string) => `${tag}:${'x'.repeat(50_000)}`;

let fs: InMemoryProjectFS;
beforeEach(() => {
  fs = new InMemoryProjectFS(new Map([
    ['app/page.client.tsx', big('home')],
    ['app/about/page.client.tsx', big('about')],
    ['components/Nav.tsx', big('nav')],
    ['_meta/page-camera.json', '{"x":1}'],
  ]));
});

function reload(data: ProjectData): InMemoryProjectFS {
  const booted = new InMemoryProjectFS(new Map(Object.entries(data.files)));
  booted.hydrateBranches(data.branches, data.activeBranchId, data.files);
  return booted;
}

describe('diffFileMaps / applyFileDelta', () => {
  it('round-trips adds, changes and deletes', () => {
    const from = new Map([['a', '1'], ['b', '2'], ['c', '3']]);
    const to = new Map([['a', '1'], ['b', 'two'], ['d', '4']]);
    const delta = diffFileMaps(from, to);
    expect(delta).toEqual({ set: { b: 'two', d: '4' }, del: ['c'] });
    expect(applyFileDelta(from, delta)).toEqual(to);
  });

  it('rejects a malformed delta', () => {
    expect(applyFileDelta(new Map(), { set: {} })).toBeNull();
    expect(applyFileDelta(new Map(), null)).toBeNull();
  });
});

describe('branch envelope — deltas', () => {
  it('round-trips a branch with edits, a new file and a deleted file, after main moved on', () => {
    fs.createBranch('redesign');
    fs.switchBranch('redesign');
    fs.writeFile('app/page.client.tsx', 'branch-home');
    fs.writeFile('components/New.tsx', 'new');
    fs.deleteFile('app/about/page.client.tsx');
    // Main changes AFTER the branch was cut: the branch's base must not follow.
    fs.switchBranch(MAIN_BRANCH_ID);
    fs.writeFile('components/Nav.tsx', 'nav-v2');
    fs.switchBranch('redesign');

    const data = fs.toEnvelope();
    const booted = reload(data);

    expect(booted.getActiveBranchId()).toBe('redesign');
    expect(booted.readFile('app/page.client.tsx')).toBe('branch-home');
    expect(booted.readFile('components/New.tsx')).toBe('new');
    expect(booted.exists('app/about/page.client.tsx')).toBe(false);
    expect(booted.readFile('components/Nav.tsx')).toBe(big('nav'));
    expect(booted.readBranchFile(MAIN_BRANCH_ID, 'components/Nav.tsx')).toBe('nav-v2');
    expect(booted.readBranchBase('redesign')).toEqual(fs.readBranchBase('redesign'));
  });

  it('a branch costs its edits, not another copy of the site', () => {
    const before = JSON.stringify(fs.toEnvelope()).length;
    for (const id of ['one', 'two', 'three', 'four', 'five']) {
      fs.createBranch(id);
      fs.switchBranch(id);
      fs.writeFile('app/page.client.tsx', `edit-${id}`);
      fs.switchBranch(MAIN_BRANCH_ID);
    }
    const after = JSON.stringify(fs.toEnvelope()).length;
    // Five branches on a ~150 KB site: well under one extra site copy in total.
    expect(after - before).toBeLessThan(5_000);
  });

  it('still loads legacy full-copy branch records', () => {
    const legacy: ProjectData = {
      format: 'revyme-v2',
      files: { 'app/page.client.tsx': 'main-home' },
      branches: {
        old: {
          files: { 'app/page.client.tsx': 'old-home' },
          baseSnapshot: { 'app/page.client.tsx': 'main-home' },
          status: 'dirty',
          parentId: MAIN_BRANCH_ID,
          order: 0,
          createdAt: 1,
          lastEditedAt: null,
        },
      },
      activeBranchId: 'old',
      mainBranchId: MAIN_BRANCH_ID,
    };
    const booted = reload(legacy);
    expect(booted.readFile('app/page.client.tsx')).toBe('old-home');
    expect(booted.readBranchFile(MAIN_BRANCH_ID, 'app/page.client.tsx')).toBe('main-home');
  });

  it('rebuilds against main AS SAVED, not main after load migrations', () => {
    fs.createBranch('b');
    const data = fs.toEnvelope();
    // A load migration rewrites main before branches hydrate.
    const booted = new InMemoryProjectFS(new Map([...Object.entries(data.files), ['components/Nav.tsx', 'migrated']]));
    booted.hydrateBranches(data.branches, MAIN_BRANCH_ID, data.files);
    expect(booted.readBranchFile('b', 'components/Nav.tsx')).toBe(big('nav'));
  });

  it('editor state under _meta/ never enters a branch delta', () => {
    fs.createBranch('b');
    const data = fs.toEnvelope();
    const rec = data.branches?.b;
    expect(JSON.stringify(rec)).not.toContain('_meta/');
  });
});
