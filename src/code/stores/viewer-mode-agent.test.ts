// viewer-mode-agent.test.ts — "an agent is editing this branch" IS viewer mode.
//
// The builder already had one centralised read-only mechanism (viewer role,
// offline) that every editing surface keys on; a run holding the branch the
// user is on is its third reason, not a second mechanism (owner, 2026-09-22:
// "we don't have to rebuild everything that already locks all editing").
// What this pins: the imperative predicate follows the lock AND the run's
// own write window (so the agent's writes pass and the human's don't), the
// UI predicate follows the lock alone, a run on another branch locks
// nothing here, the role-only reads never flip, and the write-path
// backstops (undo/redo, modifyProjectFile, page switch, multi-queue) refuse.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { getDefaultStore } from 'jotai';
import { projectFS, resetProjectFS, MAIN_BRANCH_ID } from '@/code/project/project-fs';
import { isViewerMode, isViewerRole, useIsViewer, useIsViewerRole, useViewerReason, setViewerMode, setOfflineMode } from './viewer-mode-store';
import { lockBranch, unlockBranch, withAgentWriteAccess, setLockHolderScoped } from './agent-run-lock-store';
import { undo, redo, clearHistoryStacks } from '@/code/mutation/history';
import { modifyProjectFile } from '@/code/project/modify-file';
import { switchActiveFile, activeFilePathAtom } from '@/code/project/active-file-store';
import { initMutationQueue, setActiveFilePath, syncQueueCode, queueMutations, flushNow, getCurrentCode } from '@/code/mutation/mutation-queue';

const HOME = 'app/page.client.tsx';
const ABOUT = 'app/about/page.client.tsx';
const V1 = `export default function Page() { return <div data-id="a"><p data-id="b">V1</p></div> }`;
const store = getDefaultStore();

beforeEach(() => {
  resetProjectFS(new Map([[HOME, V1], [ABOUT, V1], ['_meta/comments.json', '[]']]));
  setViewerMode(false);
  setOfflineMode(false);
  setLockHolderScoped(false);
  clearHistoryStacks();
  initMutationQueue(V1, () => {});
  setActiveFilePath(HOME);
  syncQueueCode(V1);
  store.set(activeFilePathAtom, HOME);
});
afterEach(() => {
  for (const id of [MAIN_BRANCH_ID, 'b', 'other']) { try { unlockBranch(id); } catch { /* not locked */ } }
});

describe('the lock as a viewer reason', () => {
  it('a run holding the active branch makes the editor read-only, with reason "agent"', () => {
    expect(isViewerMode()).toBe(false);
    lockBranch(MAIN_BRANCH_ID);
    expect(isViewerMode()).toBe(true);
    const reason = renderHook(() => useViewerReason());
    expect(reason.result.current).toBe('agent');
    const viewer = renderHook(() => useIsViewer());
    expect(viewer.result.current).toBe(true);
    act(() => { unlockBranch(MAIN_BRANCH_ID); });
    expect(isViewerMode()).toBe(false);
    expect(viewer.result.current).toBe(false);
    expect(reason.result.current).toBe(null);
  });

  it("the agent's own write window passes the imperative gate; the UI stays read-only through it", () => {
    lockBranch(MAIN_BRANCH_ID);
    const viewer = renderHook(() => useIsViewer());
    withAgentWriteAccess(() => {
      expect(isViewerMode()).toBe(false);
      expect(viewer.result.current).toBe(true);
    });
    expect(isViewerMode()).toBe(true);
  });

  it('a run on ANOTHER branch leaves this one editable', () => {
    projectFS.createBranch('other');
    lockBranch('other');
    expect(isViewerMode()).toBe(false);
    expect(renderHook(() => useViewerReason()).result.current).toBe(null);
  });

  it('role wins over the lock for the banner; the role-only reads never follow the lock', () => {
    lockBranch(MAIN_BRANCH_ID);
    expect(isViewerRole()).toBe(false);
    expect(renderHook(() => useIsViewerRole()).result.current).toBe(false);
    setViewerMode(true);
    expect(renderHook(() => useViewerReason()).result.current).toBe('viewer');
  });
});

describe('write-path backstops while the canvas is busy', () => {
  it('undo / redo are refused', () => {
    lockBranch(MAIN_BRANCH_ID);
    expect(undo()).toBe(false);
    expect(redo()).toBe(false);
  });

  it('modifyProjectFile refuses site files but lets editor state (_meta/) through', () => {
    lockBranch(MAIN_BRANCH_ID);
    expect(modifyProjectFile(ABOUT, (c) => c.replace('V1', 'V2'))).toBeNull();
    expect(projectFS.readFile(ABOUT)).toBe(V1);
    expect(modifyProjectFile('_meta/comments.json', () => '[{"id":1}]')).not.toBeNull();
    expect(projectFS.readFile('_meta/comments.json')).toBe('[{"id":1}]');
    // Inside the run's own window the same write lands.
    withAgentWriteAccess(() => { modifyProjectFile(ABOUT, (c) => c.replace('V1', 'V2')); });
    expect(projectFS.readFile(ABOUT)).toContain('V2');
  });

  it('a human page switch is refused while an unbranched run holds the base; a scoped run lets it through', () => {
    lockBranch(MAIN_BRANCH_ID);
    const setters = { setActiveFile: (p: string) => store.set(activeFilePathAtom, p), setSelectedIds: () => {}, setUpdatingFromCanvas: () => {} };
    const queue = { syncQueueCode, flushNow };
    switchActiveFile(HOME, ABOUT, setters, queue);
    expect(store.get(activeFilePathAtom)).toBe(HOME);
    setLockHolderScoped(true);
    switchActiveFile(HOME, ABOUT, setters, queue);
    expect(store.get(activeFilePathAtom)).toBe(ABOUT);
  });

  it('queueMutations (multi-drag) is refused on a locked branch like queueMutation', () => {
    lockBranch(MAIN_BRANCH_ID);
    queueMutations([{ type: 'updateStyles', nodeId: 'b', styles: { color: 'red' } } as never]);
    flushNow();
    expect(getCurrentCode()).not.toContain('red');
    withAgentWriteAccess(() => { queueMutations([{ type: 'updateStyles', nodeId: 'b', styles: { color: 'red' } } as never]); flushNow(); });
    expect(getCurrentCode()).toContain('red');
  });
});
