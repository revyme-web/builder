// A branch is a full copy of the project — and EVERY accessor has to answer
// for the active branch, listing included. `listFiles` / `exists` read main's
// map until 2026-09-22: a component created on a branch was readable by path
// but invisible to every list (Pages panel, explorer, library, list_files),
// and `exists` denied it, so a second "create" would clobber it.

import { describe, it, expect, beforeEach } from 'vitest';
import { projectFS, resetProjectFS, MAIN_BRANCH_ID, isSharedAcrossBranches } from '@/code/project/project-fs';
import { applyBranch } from '@/code/branching/apply';

beforeEach(() => {
  resetProjectFS(new Map([
    ['app/page.client.tsx', 'home'],
    ['components/Old.tsx', 'old'],
    ['i18n/en.json', '{}'],
  ]));
});

describe('listFiles / exists on a branch', () => {
  it('a file created on the branch lists and exists there — and only there', () => {
    expect(projectFS.createBranch('b')).toBeNull();
    expect(projectFS.switchBranch('b')).toBeNull();
    projectFS.writeFile('components/New.tsx', 'new');

    expect(projectFS.listFiles()).toContain('components/New.tsx');
    expect(projectFS.listFiles('components/')).toEqual(['components/New.tsx', 'components/Old.tsx']);
    expect(projectFS.exists('components/New.tsx')).toBe(true);

    expect(projectFS.switchBranch(MAIN_BRANCH_ID)).toBeNull();
    expect(projectFS.listFiles()).not.toContain('components/New.tsx');
    expect(projectFS.exists('components/New.tsx')).toBe(false);
  });

  it('a file deleted on the branch stops listing there while main keeps it', () => {
    projectFS.createBranch('b');
    projectFS.switchBranch('b');
    projectFS.deleteFile('components/Old.tsx');
    expect(projectFS.listFiles()).not.toContain('components/Old.tsx');
    expect(projectFS.exists('components/Old.tsx')).toBe(false);

    projectFS.switchBranch(MAIN_BRANCH_ID);
    expect(projectFS.exists('components/Old.tsx')).toBe(true);
  });

  it('the branch starts as a byte-identical copy — pages, components, translations', () => {
    projectFS.createBranch('b');
    const main = projectFS.listFiles();
    projectFS.switchBranch('b');
    expect(projectFS.listFiles()).toEqual(main);
    for (const path of main) expect(projectFS.readFile(path)).toBe(projectFS.readBranchFile(MAIN_BRANCH_ID, path));
  });
});

// ─── Editor state is shared, not branched ────────────────────────────────────

describe('_meta/ (chats, comments, cameras, folders) lives on main whatever branch is active', () => {
  it('names the editor-state prefix', () => {
    expect(isSharedAcrossBranches('_meta/agent-chats.json')).toBe(true);
    expect(isSharedAcrossBranches('app/page.client.tsx')).toBe(false);
  });

  it('a chat saved while on a branch is there on main, and the branch stays clean', () => {
    projectFS.createBranch('b');
    projectFS.switchBranch('b');
    projectFS.writeFile('_meta/agent-chats.json', '{"chats":[1]}');
    expect(projectFS.readFile('_meta/agent-chats.json')).toBe('{"chats":[1]}');
    expect(projectFS.exists('_meta/agent-chats.json')).toBe(true);
    expect(projectFS.listFiles('_meta/')).toEqual(['_meta/agent-chats.json']);
    expect(projectFS.listBranches().find((b) => b.id === 'b')?.status).toBe('clean');
    // Not in the branch's own map — review/merge never see it.
    expect(projectFS.readBranchFiles('b')!.has('_meta/agent-chats.json')).toBe(false);

    projectFS.switchBranch(MAIN_BRANCH_ID);
    expect(projectFS.readFile('_meta/agent-chats.json')).toBe('{"chats":[1]}');
  });

  it('a branch is cut without the editor state, and reads main\'s through readBranchFile', () => {
    projectFS.writeFile('_meta/page-camera.json', '{"x":1}');
    projectFS.createBranch('b');
    expect(projectFS.readBranchFiles('b')!.has('_meta/page-camera.json')).toBe(false);
    expect(projectFS.readBranchBase('b')!.has('_meta/page-camera.json')).toBe(false);
    expect(projectFS.readBranchFile('b', '_meta/page-camera.json')).toBe('{"x":1}');
    expect(projectFS.branchFileExists('b', '_meta/page-camera.json')).toBe(true);
    // The website view of main leaves it out too, so drift/merge compare like with like.
    expect(projectFS.readBranchFiles(MAIN_BRANCH_ID)!.has('_meta/page-camera.json')).toBe(false);
    expect(projectFS.readBranchFiles(MAIN_BRANCH_ID, { shared: true })!.has('_meta/page-camera.json')).toBe(true);
  });

  it('applying a branch leaves the chats and cameras written meanwhile untouched', () => {
    projectFS.writeFile('_meta/agent-chats.json', '{"chats":[]}');
    projectFS.createBranch('b');
    projectFS.switchBranch('b');
    projectFS.writeFile('i18n/en.json', '{"hello":"hi"}');
    projectFS.writeFile('_meta/agent-chats.json', '{"chats":["on-branch"]}');
    projectFS.writeFile('_meta/page-camera.json', '{"x":2}');
    const res = applyBranch('b');
    expect(res.status).toBe('applied');
    expect(res.files).toEqual(['i18n/en.json']);
    expect(projectFS.getActiveBranchId()).toBe(MAIN_BRANCH_ID);
    expect(projectFS.readFile('i18n/en.json')).toBe('{"hello":"hi"}');
    expect(projectFS.readFile('_meta/agent-chats.json')).toBe('{"chats":["on-branch"]}');
    expect(projectFS.readFile('_meta/page-camera.json')).toBe('{"x":2}');
    expect(projectFS.readBranchBase('b')!.has('_meta/agent-chats.json')).toBe(false);
  });
});
