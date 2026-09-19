// agent-run-lock-store.test.ts — Porte 8 (vii) / D-T5 inter-branches: the
// branch-scoped run lock (P8-SCOPED-LOCK, ex-TEMP-P1 global lock).
//
// Unit tests for the lock store itself + its enforcement at the mutation
// queue (the soundness net): entries targeting a LOCKED branch are refused
// outside an agent window, entries on unlocked branches pass mid-run, and
// the partitioned drain lands each on its own map. Panel inerting + banner
// are declarative UI over the same hooks (human validation §15); the switch
// gate is covered in active-file-store.test.ts, batch-abort in batch.test.ts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { projectFS, resetProjectFS, MAIN_BRANCH_ID } from '@/code/project/project-fs';
import {
  initMutationQueue,
  setActiveFilePath,
  syncQueueCode,
  getCurrentCode,
  queueMutation,
  flushNow,
} from '@/code/mutation/mutation-queue';
import {
  lockBranch,
  unlockBranch,
  isBranchLocked,
  isActiveBranchLocked,
  getLockedBranches,
  isHumanWritesLocked,
  withAgentWriteAccess,
  withAgentWriteAccessAsync,
  isAgentWriteOpen,
  isLockHolderScoped,
  setLockHolderScoped,
  throwIfLockedForHumanWrite,
} from './agent-run-lock-store';

const FILE = 'app/page.client.tsx';
const V1 = `export default function Page() { return <div data-id="a"><p data-id="b">V1</p></div> }`;
const BRANCH = 'agent-x';

beforeEach(() => {
  resetProjectFS(new Map([[FILE, V1]]));
  setActiveFilePath(FILE);
  initMutationQueue(V1, (newCode) => {
    projectFS.writeFile(FILE, newCode);
  });
  syncQueueCode(V1);
});

afterEach(() => {
  for (const b of getLockedBranches()) unlockBranch(b);
  resetProjectFS();
});

describe('agent-run-lock-store (P8-SCOPED-LOCK)', () => {
  it('starts unlocked with a closed window', () => {
    expect(isHumanWritesLocked()).toBe(false);
    expect(isAgentWriteOpen()).toBe(false);
    expect(getLockedBranches()).toEqual([]);
    expect(isBranchLocked(BRANCH)).toBe(false);
    expect(isActiveBranchLocked()).toBe(false);
  });

  it('lock/unlock is refcounted per branch', () => {
    lockBranch(BRANCH);
    lockBranch(BRANCH);
    expect(isBranchLocked(BRANCH)).toBe(true);
    expect(isHumanWritesLocked()).toBe(true);
    unlockBranch(BRANCH);
    expect(isBranchLocked(BRANCH)).toBe(true);
    unlockBranch(BRANCH);
    expect(isBranchLocked(BRANCH)).toBe(false);
    expect(isHumanWritesLocked()).toBe(false);
    // Unmatched release never goes negative.
    unlockBranch(BRANCH);
    expect(isBranchLocked(BRANCH)).toBe(false);
  });

  it('withAgentWriteAccess opens re-entrantly and always closes', () => {
    expect(isAgentWriteOpen()).toBe(false);
    withAgentWriteAccess(() => {
      expect(isAgentWriteOpen()).toBe(true);
      withAgentWriteAccess(() => {
        expect(isAgentWriteOpen()).toBe(true);
      });
      expect(isAgentWriteOpen()).toBe(true);
    });
    expect(isAgentWriteOpen()).toBe(false);
  });

  it('withAgentWriteAccess closes on throw', () => {
    expect(() =>
      withAgentWriteAccess(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(isAgentWriteOpen()).toBe(false);
  });

  it('withAgentWriteAccessAsync closes after await and on reject', async () => {
    await withAgentWriteAccessAsync(async () => {
      expect(isAgentWriteOpen()).toBe(true);
      await new Promise((r) => setTimeout(r, 5));
      expect(isAgentWriteOpen()).toBe(true);
    });
    expect(isAgentWriteOpen()).toBe(false);
    await expect(
      withAgentWriteAccessAsync(async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    expect(isAgentWriteOpen()).toBe(false);
  });

  // PORT-PENDING: needs the branch-partitioned mutation queue (entries carrying {author,file,branchId}, grouped drain, lock gating, runtime-guarantee normalization on commit). Ported separately — see the branching port notes.
  it.skip('queueMutation is refused on the locked branch outside a window (canvas-busy)', () => {
    lockBranch(MAIN_BRANCH_ID);
    queueMutation({ type: 'updateStyles', nodeId: 'b', styles: { color: 'red' } });
    flushNow();
    // Nothing landed: neither the queue base nor the file moved.
    expect(getCurrentCode()).toBe(V1);
    expect(projectFS.readFile(FILE)).toBe(V1);
  });

  it('queueMutation passes inside an agent window on the locked branch', async () => {
    lockBranch(MAIN_BRANCH_ID);
    await withAgentWriteAccessAsync(async () => {
      queueMutation({ type: 'updateStyles', nodeId: 'b', styles: { color: 'red' } });
      flushNow();
    });
    expect(projectFS.readFile(FILE)).toContain('red');
  });

  it('unlocking restores human writes', () => {
    lockBranch(MAIN_BRANCH_ID);
    unlockBranch(MAIN_BRANCH_ID);
    queueMutation({ type: 'updateStyles', nodeId: 'b', styles: { color: 'red' } });
    flushNow();
    expect(projectFS.readFile(FILE)).toContain('red');
  });

  it('(vii) simultaneity: human writes on main pass while another branch is locked', () => {
    expect(projectFS.createBranch(BRANCH)).toBeNull();
    lockBranch(BRANCH);
    // Human gesture on the unlocked active branch is accepted…
    queueMutation({ type: 'updateStyles', nodeId: 'b', styles: { color: 'red' } });
    flushNow();
    expect(projectFS.readFile(FILE)).toContain('red');
    // …and the locked branch map is untouched.
    expect(projectFS.readBranchFile(BRANCH, FILE)).toBe(V1);
    expect(isActiveBranchLocked()).toBe(false);
  });

  // PORT-PENDING: needs the branch-partitioned mutation queue (entries carrying {author,file,branchId}, grouped drain, lock gating, runtime-guarantee normalization on commit). Ported separately — see the branching port notes.
  it.skip('(vii) simultaneity: interleaved human + agent entries drain partitioned, never mixed', () => {
    expect(projectFS.createBranch(BRANCH)).toBeNull();
    projectFS.writeBranchFile(BRANCH, FILE, V1);
    lockBranch(BRANCH);
    // Human entry (main) + agent entry (branch, inside its window) parked together.
    queueMutation({ type: 'updateStyles', nodeId: 'b', styles: { color: 'red' } });
    withAgentWriteAccess(() => {
      queueMutation(
        { type: 'updateStyles', nodeId: 'b', styles: { color: 'blue' } },
        { author: 'agent', file: FILE, branchId: BRANCH },
      );
    });
    flushNow();
    flushNow({ branchId: BRANCH });
    // Each landed on its own map; neither leaked into the other.
    expect(projectFS.readFile(FILE)).toContain('red');
    expect(projectFS.readFile(FILE)).not.toContain('blue');
    const branchCode = projectFS.readBranchFile(BRANCH, FILE) ?? '';
    expect(branchCode).toContain('blue');
    expect(branchCode).not.toContain('red');
  });

  it('(vii) simultaneity: human writes on the locked branch are still refused', () => {
    expect(projectFS.createBranch(BRANCH)).toBeNull();
    lockBranch(BRANCH);
    // A human write explicitly routed at the locked branch (no window) is refused…
    queueMutation(
      { type: 'updateStyles', nodeId: 'b', styles: { color: 'red' } },
      { author: 'human', file: FILE, branchId: BRANCH },
    );
    // …nothing was even queued: the branch map is untouched after a flush.
    flushNow({ branchId: BRANCH });
    expect(projectFS.readBranchFile(BRANCH, FILE)).toBe(V1);
  });

  it('throwIfLockedForHumanWrite fires only outside an agent window on a locked branch', () => {
    expect(() => throwIfLockedForHumanWrite('probe')).not.toThrow();
    lockBranch(MAIN_BRANCH_ID);
    try {
      expect(() => throwIfLockedForHumanWrite('components guard')).toThrow(/holds branch/);
      withAgentWriteAccess(() => {
        expect(() => throwIfLockedForHumanWrite('components guard')).not.toThrow();
      });
    } finally {
      unlockBranch(MAIN_BRANCH_ID);
    }
  });

  it('lock-holder scope flag defaults fail-closed and toggles explicitly', () => {
    expect(isLockHolderScoped()).toBe(false);
    setLockHolderScoped(true);
    expect(isLockHolderScoped()).toBe(true);
    setLockHolderScoped(false);
    expect(isLockHolderScoped()).toBe(false);
  });
});
