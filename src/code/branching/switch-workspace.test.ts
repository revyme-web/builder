// branching/switch-workspace.test.ts — P8-B: the switch ceremony proofs.
//
// Mandatory round-trip: main → A → modA → B → modB → A (canvas = A-state)
// → B (canvas = B-state), with canvas-equivalence asserted triple
// (active maps + queue base + node memo) plus guards, reseeds, remembered
// files and lock interplay. No engine file is modified by these tests
// beyond the ceremony itself.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDefaultStore } from 'jotai';
import { projectFS, resetProjectFS } from '@/code/project/project-fs';
import {
  initMutationQueue,
  setActiveFilePath,
  syncQueueCode,
  getCurrentCode,
  queueMutation,
  flushNow,
} from '@/code/mutation/mutation-queue';
import {
  initHistory,
  pushHistoryImmediate,
  getHistoryState,
} from '@/code/mutation/history';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { switchActiveFile } from '@/code/project/active-file-store';
import { selectedIdsAtom, getNodesSnapshot } from '@/code/stores/store';
import {
  lockBranch,
  unlockBranch,
  getLockedBranches,
  setLockHolderScoped,
} from '@/code/stores/agent-run-lock-store';
import { switchBranchFile, clearRememberedBranchFiles } from './switch-workspace';

const FILE = 'app/page.client.tsx';
const ABOUT = 'app/about/page.client.tsx';
const page = (text: string) =>
  `export default function Page() { return <div data-id="root"><p data-id="a">${text}</p></div> }`;
const MAIN_CODE = page('main');
const ABOUT_CODE = page('about');

function seed(): void {
  resetProjectFS(
    new Map([
      [FILE, MAIN_CODE],
      [ABOUT, ABOUT_CODE],
    ]),
  );
  setActiveFilePath(FILE);
  initMutationQueue(MAIN_CODE, (newCode) => {
    projectFS.writeFile(FILE, newCode);
  });
  syncQueueCode(MAIN_CODE);
  initHistory('', () => {}, () => FILE);
  getDefaultStore().set(activeFilePathAtom, FILE);
  expect(projectFS.createBranch('agent-a')).toBeNull();
  expect(projectFS.createBranch('agent-b')).toBeNull();
}

/** Human write through the queue (lands on the ACTIVE branch maps). */
function humanWrite(color: string): void {
  queueMutation({ type: 'updateStyles', nodeId: 'a', styles: { color } });
  flushNow();
}

/** Canvas-equivalence triple: active maps + queue base + node memo. */
function canvasIs(text: string, color?: string): void {
  const file = projectFS.readFile(FILE) ?? '';
  expect(file).toContain(text);
  if (color) expect(file).toContain(color);
  expect(getCurrentCode()).toContain(text);
  const node = getNodesSnapshot().get('a');
  expect(node).toBeDefined();
}

beforeEach(() => {
  seed();
});

afterEach(() => {
  for (const b of getLockedBranches()) unlockBranch(b);
  setLockHolderScoped(false);
  clearRememberedBranchFiles();
  resetProjectFS();
});

describe('switchBranchFile — guards', () => {
  it('refuses unknown branches, same branch is a no-op', () => {
    expect(switchBranchFile('nope')).toContain('Unknown branch');
    expect(projectFS.getActiveBranchId()).toBe('main');
    expect(switchBranchFile('main')).toBeNull();
  });

  it('visit model: entering a locked branch requires its scoped holder (read-only)', () => {
    lockBranch('agent-a');
    // No scoped holder (legacy-style bare lock): entry refused, stays put.
    expect(switchBranchFile('agent-a')).toContain('stop it from the chat');
    expect(projectFS.getActiveBranchId()).toBe('main');
    // The run's own scoped holder may enter (visit, read-only).
    setLockHolderScoped(true);
    try {
      expect(switchBranchFile('agent-a')).toBeNull();
      expect(projectFS.getActiveBranchId()).toBe('agent-a');
    } finally {
      setLockHolderScoped(false);
    }
  });

  it('visit model: leaving a locked branch is allowed (scoped holder)', () => {
    lockBranch('agent-a');
    setLockHolderScoped(true);
    expect(switchBranchFile('agent-a')).toBeNull();
    expect(switchBranchFile('main')).toBeNull();
    expect(projectFS.getActiveBranchId()).toBe('main');
    setLockHolderScoped(false);
  });

  it('legacy holder (unscoped): leaving the locked active branch stays refused', () => {
    lockBranch('main');
    // Direct lockBranch (no holder flag) = legacy queue-base dependence.
    expect(switchBranchFile('agent-a')).toContain('The agent is editing this branch');
    expect(projectFS.getActiveBranchId()).toBe('main');
  });
});

describe('switchBranchFile — mandatory round-trip (P8-B criterion)', () => {
  it('main → A → modA → B → modB → A (canvas=A) → B (canvas=B), independent states', () => {
    expect(switchBranchFile('agent-a')).toBeNull();
    expect(projectFS.getActiveBranchId()).toBe('agent-a');
    humanWrite('red');
    expect(projectFS.readFile(FILE)).toContain('red');
    // Main untouched by the A edit.
    expect(projectFS.readBranchFiles('main')?.get(FILE)).not.toContain('red');

    expect(switchBranchFile('agent-b')).toBeNull();
    // B shows base state, not A's edit.
    canvasIs('main');
    expect(projectFS.readFile(FILE)).not.toContain('red');
    humanWrite('blue');
    expect(projectFS.readFile(FILE)).toContain('blue');

    // Back to A: exactly A-state (red, no blue).
    expect(switchBranchFile('agent-a')).toBeNull();
    canvasIs('main', 'red');
    expect(projectFS.readFile(FILE)).not.toContain('blue');

    // Back to B: exactly B-state (blue, no red).
    expect(switchBranchFile('agent-b')).toBeNull();
    canvasIs('main', 'blue');
    expect(projectFS.readFile(FILE)).not.toContain('red');
  });

  it('lands on the SAME page when the other branch has it; the remembered file is only the fallback', () => {
    // (Owner, 2026-09-22: a switch used to land on the branch's own last
    // file — "its own history of where I am" — even though the page you were
    // on exists there too. See location.ts.)
    expect(switchBranchFile('agent-a')).toBeNull();
    // Human navigates to about on A (atom-level, like FileExplorer would).
    getDefaultStore().set(activeFilePathAtom, ABOUT);
    // B has about too → still on about.
    expect(switchBranchFile('agent-b')).toBeNull();
    expect(getDefaultStore().get(activeFilePathAtom)).toBe(ABOUT);
    // Delete about on B, go home there, then back to A: about exists on A →
    // the same page rule has nothing to keep (we are on home) → home.
    projectFS.deleteFile(ABOUT);
    getDefaultStore().set(activeFilePathAtom, FILE);
    expect(switchBranchFile('agent-a')).toBeNull();
    expect(getDefaultStore().get(activeFilePathAtom)).toBe(FILE);
    // On A go to about; B no longer has it → the file remembered for B
    // (home), not about.
    getDefaultStore().set(activeFilePathAtom, ABOUT);
    expect(switchBranchFile('agent-b')).toBeNull();
    expect(getDefaultStore().get(activeFilePathAtom)).toBe(FILE);
  });

  it('reseeds selection, history, queue base and node memo', () => {
    getDefaultStore().set(selectedIdsAtom, ['a']);
    projectFS.writeFile(FILE, MAIN_CODE.replace('main', 'edited'));
    pushHistoryImmediate('edited');
    expect(getHistoryState().canUndo).toBe(true);

    expect(switchBranchFile('agent-a')).toBeNull();
    // Selection cleared, stacks dropped (undo never spans branches).
    expect(getDefaultStore().get(selectedIdsAtom)).toEqual([]);
    expect(getHistoryState().canUndo).toBe(false);
    // Queue base + node memo follow the new branch.
    expect(getCurrentCode()).toBe(MAIN_CODE);
    expect(getNodesSnapshot().get('a')).toBeDefined();
  });

  it('viewing never dirties a clean branch', () => {
    expect(switchBranchFile('agent-a')).toBeNull();
    expect(switchBranchFile('main')).toBeNull();
    const branches = projectFS.listBranches();
    expect(branches.find((b) => b.id === 'agent-a')?.status).toBe('clean');
    expect(projectFS.readBranchFile('agent-a', FILE)).toBe(MAIN_CODE);
  });

  it('envelope pointer follows the switch (persistence truth)', () => {
    expect(switchBranchFile('agent-a')).toBeNull();
    const env = projectFS.toEnvelope() as { activeBranchId?: string };
    expect(env.activeBranchId).toBe('agent-a');
  });
});

describe('switchBranchFile — visit locked branch read-only', () => {
  function setters() {
    const store = getDefaultStore();
    return {
      setActiveFile: (p: string) => store.set(activeFilePathAtom, p),
      setSelectedIds: (ids: string[]) => store.set(selectedIdsAtom, ids),
      setUpdatingFromCanvas: (_v: boolean) => {},
    };
  }

  // PORT-PENDING: needs the branch-partitioned mutation queue (entries carrying {author,file,branchId}, grouped drain, lock gating, runtime-guarantee normalization on commit). Ported separately — see the branching port notes.
  it.skip('MAIN → locked TEST allowed; navigate/select/render work; mutations refused', async () => {
    lockBranch('agent-a');
    setLockHolderScoped(true);
    try {
      // Enter the locked branch (visit).
      expect(switchBranchFile('agent-a')).toBeNull();
      expect(projectFS.getActiveBranchId()).toBe('agent-a');
      // File navigation on the locked branch works.
      switchActiveFile(FILE, ABOUT, setters(), { syncQueueCode, flushNow });
      expect(getDefaultStore().get(activeFilePathAtom)).toBe(ABOUT);
      switchActiveFile(ABOUT, FILE, setters(), { syncQueueCode, flushNow });
      // Selection works and is never cleared by the run.
      getDefaultStore().set(selectedIdsAtom, ['a']);
      expect(getDefaultStore().get(selectedIdsAtom)).toEqual(['a']);
      // Render reflects TEST.
      expect(getNodesSnapshot().get('a')).toBeDefined();
      // Property mutation refused, nothing persisted.
      queueMutation({ type: 'updateStyles', nodeId: 'a', styles: { color: 'red' } });
      flushNow();
      expect(projectFS.readBranchFile('agent-a', FILE)).toBe(MAIN_CODE);
      // File mutation refused, nothing persisted.
      const { modifyProjectFile } = await import('@/code/project/modify-file');
      expect(modifyProjectFile(FILE, (c) => `${c} `)).toBeNull();
      expect(projectFS.readBranchFile('agent-a', FILE)).toBe(MAIN_CODE);
    } finally {
      setLockHolderScoped(false);
    }
  });

  // PORT-PENDING: needs the branch-partitioned mutation queue (entries carrying {author,file,branchId}, grouped drain, lock gating, runtime-guarantee normalization on commit). Ported separately — see the branching port notes.
  it.skip('heal-on-switch is skipped on a locked branch (viewing never writes)', async () => {
    const NOID = `export default function Page() { return (<div data-id="root"><MyWidget /></div>); }`;
    projectFS.writeBranchFile('agent-a', ABOUT, NOID);
    lockBranch('agent-a');
    setLockHolderScoped(true);
    try {
      expect(switchBranchFile('agent-a')).toBeNull();
      switchActiveFile(FILE, ABOUT, setters(), { syncQueueCode, flushNow });
      expect(getDefaultStore().get(activeFilePathAtom)).toBe(ABOUT);
      expect(projectFS.readBranchFile('agent-a', ABOUT)).toBe(NOID);
    } finally {
      setLockHolderScoped(false);
    }
  });
});

describe('switchBranchFile — lock interplay (vii simultaneity preserved)', () => {
  it('human switches between unlocked branches while a scoped run works elsewhere', () => {
    lockBranch('agent-a');
    setLockHolderScoped(true);
    try {
      // main → B allowed (neither locked); the run's branch untouched.
      expect(switchBranchFile('agent-b')).toBeNull();
      expect(projectFS.getActiveBranchId()).toBe('agent-b');
      humanWrite('green');
      expect(projectFS.readBranchFile('agent-a', FILE)).toBe(MAIN_CODE);
      // …and visiting the run's branch is allowed read-only (visit model).
      expect(switchBranchFile('agent-a')).toBeNull();
      expect(projectFS.getActiveBranchId()).toBe('agent-a');
    } finally {
      setLockHolderScoped(false);
    }
  });
});
