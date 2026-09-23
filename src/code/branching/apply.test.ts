// branching/apply.test.ts — P8 (iv): apply onto main, proofs.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { projectFS, resetProjectFS } from '@/code/project/project-fs';
import { applyBranch, getChangelog, clearChangelog } from './apply';
import { undo } from '@/code/mutation/history';
import { initHistory } from '@/code/mutation/history';

const PAGE = (inner: string): string =>
  `'use client';\n/** @canvas { "viewports": [], "positions": {} } */\nimport React from 'react';\nexport default function Page() {\n  return (\n    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>\n${inner}\n    </div>\n  );\n}`;

const BASE_INNER = `      <p data-id="a" data-name="A" style={{ position: 'relative', color: 'red' }}>hi</p>`;
const BASE = PAGE(BASE_INNER);

function seedMain(): void {
  resetProjectFS(new Map([['app/page.client.tsx', BASE]]));
}

beforeEach(() => {
  seedMain();
  clearChangelog();
  initHistory('', () => {}, () => 'app/page.client.tsx');
});

afterEach(() => {
  resetProjectFS();
  clearChangelog();
});

describe('applyBranch — fast-forward', () => {
  it('takes the branch when main is untouched; rebases clean; changelogged', () => {
    expect(projectFS.createBranch('agent-a')).toBeNull();
    projectFS.switchBranch('agent-a');
    projectFS.writeFile('app/page.client.tsx', BASE.replace('hi', 'hello'));
    projectFS.switchBranch('main');
    const r = applyBranch('agent-a');
    expect(r.status).toBe('applied');
    expect(projectFS.readFile('app/page.client.tsx')).toContain('hello');
    // Rebases clean (files == new base).
    expect(projectFS.listBranches().find((b) => b.id === 'agent-a')?.status).toBe('clean');
    expect(r.files).toContain('app/page.client.tsx');
    const log = getChangelog('agent-a');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ branch: 'agent-a', kind: 'apply-fast-forward', status: 'applied' });
  });

  it('refuses unknown branches and main', () => {
    expect(applyBranch('nope').status).toBe('refused');
    expect(applyBranch('main').status).toBe('refused');
    expect(projectFS.readFile('app/page.client.tsx')).toBe(BASE);
  });
});

describe('applyBranch — merge + conflicts', () => {
  it('merges disjoint edits from both sides', () => {
    expect(projectFS.createBranch('agent-a')).toBeNull();
    // Main moves first (blue), then branch moves (hello).
    projectFS.writeFile('app/page.client.tsx', BASE.replace(`color: 'red'`, `color: 'blue'`));
    projectFS.switchBranch('agent-a');
    projectFS.writeFile('app/page.client.tsx', BASE.replace('hi', 'hello'));
    projectFS.switchBranch('main');
    const r = applyBranch('agent-a');
    // Same single-line element touched both sides with different keys...
    // color line (main) vs text on the same line (branch): intra-line merge
    // unions them (color blue + hello).
    expect(r.status).toBe('applied');
    const main = projectFS.readFile('app/page.client.tsx') ?? '';
    expect(main).toContain(`color: 'blue'`);
    expect(main).toContain('hello');
  });

  it('same-property conflict aborts with conflicts status; main intact; branch marked conflict', () => {
    expect(projectFS.createBranch('agent-a')).toBeNull();
    projectFS.writeFile('app/page.client.tsx', BASE.replace(`color: 'red'`, `color: 'blue'`));
    projectFS.switchBranch('agent-a');
    projectFS.writeFile('app/page.client.tsx', BASE.replace(`color: 'red'`, `color: 'green'`));
    projectFS.switchBranch('main');
    const r = applyBranch('agent-a');
    expect(r.status).toBe('conflicts');
    expect(r.conflicts.some((c) => c.kind === 'same-property')).toBe(true);
    expect(projectFS.readFile('app/page.client.tsx')).toContain(`color: 'blue'`);
    expect(projectFS.listBranches().find((b) => b.id === 'agent-a')?.status).toBe('conflict');
  });

  it('resolutions apply the chosen side per hunk', () => {
    expect(projectFS.createBranch('agent-a')).toBeNull();
    projectFS.writeFile('app/page.client.tsx', BASE.replace(`color: 'red'`, `color: 'blue'`));
    projectFS.switchBranch('agent-a');
    projectFS.writeFile('app/page.client.tsx', BASE.replace(`color: 'red'`, `color: 'green'`));
    projectFS.switchBranch('main');
    const r = applyBranch('agent-a', { resolutions: { 'app/page.client.tsx': ['theirs'] } });
    expect(r.status).toBe('applied');
    expect(projectFS.readFile('app/page.client.tsx')).toContain(`color: 'green'`);
  });
});

describe('applyBranch — validation + undo', () => {
  it('refuses a merge that fails the oracle gate; main intact', () => {
    expect(projectFS.createBranch('agent-a')).toBeNull();
    projectFS.switchBranch('agent-a');
    // Strip the data-id: MISSING_DATA_ID bounces at the gate.
    projectFS.writeFile('app/page.client.tsx', BASE.replace(' data-id="a"', ''));
    projectFS.switchBranch('main');
    const r = applyBranch('agent-a');
    expect(r.status).toBe('refused');
    expect(r.reason).toContain('MISSING_DATA_ID');
    expect(projectFS.readFile('app/page.client.tsx')).toBe(BASE);
  });

  it('one undo entry restores pre-apply main', async () => {
    const { initMutationQueue } = await import('@/code/mutation/mutation-queue');
    initMutationQueue(BASE, () => {}, () => {}, () => {});
    initMutationQueue(BASE, () => {}, () => {}, () => {});
    expect(projectFS.createBranch('agent-a')).toBeNull();
    projectFS.switchBranch('agent-a');
    projectFS.writeFile('app/page.client.tsx', BASE.replace('hi', 'hello'));
    projectFS.switchBranch('main');
    const r = applyBranch('agent-a');
    expect(r.status).toBe('applied');
    expect(projectFS.readFile('app/page.client.tsx')).toContain('hello');
    undo();
    expect(projectFS.readFile('app/page.client.tsx')).toBe(BASE);
  });
});

describe('applyBranch — run lock (P8-SCOPED-LOCK)', () => {
  it('refuses a branch with a run in flight; applies after release', async () => {
    const { lockBranch, unlockBranch } = await import('@/code/stores/agent-run-lock-store');
    expect(projectFS.createBranch('agent-a')).toBeNull();
    projectFS.switchBranch('agent-a');
    projectFS.writeFile('app/page.client.tsx', BASE.replace('hi', 'hello'));
    projectFS.switchBranch('main');
    lockBranch('agent-a');
    try {
      const r = applyBranch('agent-a');
      expect(r.status).toBe('refused');
      expect(r.reason).toContain('in flight');
      expect(projectFS.readFile('app/page.client.tsx')).toBe(BASE);
    } finally {
      unlockBranch('agent-a');
    }
    expect(applyBranch('agent-a').status).toBe('applied');
    expect(projectFS.readFile('app/page.client.tsx')).toContain('hello');
  });

  // PORT-PENDING: needs the branch-partitioned mutation queue (entries carrying {author,file,branchId}, grouped drain, lock gating, runtime-guarantee normalization on commit). Ported separately — see the branching port notes.
  it.skip('(vii) journey: concurrent agent-branch + human-main writes partition, review diffs, apply publishes main', async () => {
    const queue = await import('@/code/mutation/mutation-queue');
    const { lockBranch, unlockBranch, withAgentWriteAccess } = await import(
      '@/code/stores/agent-run-lock-store'
    );
    const { groupDiff } = await import('./diff');
    queue.setActiveFilePath('app/page.client.tsx');
    queue.initMutationQueue(BASE, (newCode) => {
      projectFS.writeFile('app/page.client.tsx', newCode);
    });
    queue.syncQueueCode(BASE);
    expect(projectFS.createBranch('agent-a')).toBeNull();
    lockBranch('agent-a');
    try {
      // Agent writes on its branch (window + explicit scope — the (vi) tool path).
      withAgentWriteAccess(() => {
        queue.queueMutation(
          { type: 'updateStyles', nodeId: 'a', styles: { backgroundColor: '#eef0ff' } },
          { author: 'agent', file: 'app/page.client.tsx', branchId: 'agent-a' },
        );
      });
      queue.flushNow({ branchId: 'agent-a' });
      // Human writes on main "at the same time" (no window, unlocked branch).
      queue.queueMutation({ type: 'updateStyles', nodeId: 'a', styles: { color: 'blue' } });
      queue.flushNow();
      // Partitioned landing: each map carries only its own edit.
      expect(projectFS.readFile('app/page.client.tsx')).toContain(`color: 'blue'`);
      const branchCode = projectFS.readBranchFile('agent-a', 'app/page.client.tsx') ?? '';
      expect(branchCode).toContain('#eef0ff');
      expect(branchCode).not.toContain(`color: 'blue'`);
      // Review: grouped diff of the branch vs its base is non-empty.
      const base = projectFS.readBranchBase('agent-a') ?? new Map<string, string>();
      const files = projectFS.readBranchFiles('agent-a') ?? new Map<string, string>();
      expect(groupDiff(base, files).length).toBeGreaterThan(0);
    } finally {
      unlockBranch('agent-a');
    }
    // Apply publishes main (branch + human edits united), undoable in one entry.
    const r = applyBranch('agent-a');
    expect(r.status).toBe('applied');
    const main = projectFS.readFile('app/page.client.tsx') ?? '';
    expect(main).toContain('#eef0ff');
    expect(main).toContain(`color: 'blue'`);
    undo();
    expect(projectFS.readFile('app/page.client.tsx')).toContain(`color: 'red'`);
  });
});

describe('applyBranch — a REAL project (cms json, server wrappers, css) applies', () => {
  it('gates only the changed page and carries the plain files through', async () => {
    const { FIXTURE_FILES, HOME } = await import('@/ai/agent/capability/fixture');
    const mod = await import('@/code/project/project-fs');
    mod.resetProjectFS(new Map(Object.entries(FIXTURE_FILES)));
    // `projectFS` is reassigned by the reset — read it through the module.
    const fs = mod.projectFS;
    expect(fs.createBranch('work', { from: fs.getSnapshot() })).toBeNull();
    fs.writeBranchFile('work', HOME, FIXTURE_FILES[HOME].replace('Plan, build and release', 'A bolder hero'));
    fs.writeBranchFile('work', 'cms/blog.json', FIXTURE_FILES['cms/blog.json'].replace('Hello world', 'Hello there'));
    const res = applyBranch('work');
    // Before: every unchanged server wrapper / json was judged as a page →
    // PROTECTED_PATH → nothing could ever apply.
    expect(res.status).toBe('applied');
    expect(res.files.sort()).toEqual([HOME, 'cms/blog.json'].sort());
    expect(fs.readBranchFile('main', HOME)).toContain('A bolder hero');
    expect(fs.readBranchFile('main', 'cms/blog.json')).toContain('Hello there');
  });
});
