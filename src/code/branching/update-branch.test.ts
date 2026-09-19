// branching/update-branch.test.ts — P8-UX: pull main into a branch.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { projectFS, resetProjectFS } from '@/code/project/project-fs';
import { lockBranch, unlockBranch, getLockedBranches } from '@/code/stores/agent-run-lock-store';
import { getBranchDrift, updateBranchFromMain } from './update-branch';

const PAGE = (inner: string): string =>
  `'use client';\n/** @canvas { "viewports": [], "positions": {} } */\nimport React from 'react';\nexport default function Page() {\n  return (\n    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>\n${inner}\n    </div>\n  );\n}`;
const INNER = `      <p data-id="a" data-name="A" style={{ position: 'relative', color: 'red' }}>hi</p>`;
const BASE = PAGE(INNER);

beforeEach(() => {
  resetProjectFS(new Map([['app/page.client.tsx', BASE]]));
  expect(projectFS.createBranch('agent-a')).toBeNull();
});

afterEach(() => {
  for (const b of getLockedBranches()) unlockBranch(b);
  resetProjectFS();
});

describe('getBranchDrift', () => {
  it('reports no drift on a fresh fork, drift after main moves', () => {
    expect(getBranchDrift('agent-a')).toEqual({ moved: false, changedPaths: [] });
    projectFS.writeFile('app/page.client.tsx', BASE.replace('hi', 'hello'));
    expect(getBranchDrift('agent-a')).toEqual({ moved: true, changedPaths: ['app/page.client.tsx'] });
  });

  it('reports nothing for unknown branches', () => {
    expect(getBranchDrift('nope')).toEqual({ moved: false, changedPaths: [] });
  });
});

describe('updateBranchFromMain', () => {
  it('refuses main, unknown and locked branches', () => {
    expect(updateBranchFromMain('main').status).toBe('refused');
    expect(updateBranchFromMain('nope').status).toBe('refused');
    lockBranch('agent-a');
    const r = updateBranchFromMain('agent-a');
    expect(r.status).toBe('refused');
    expect(r.reason).toContain('in flight');
  });

  it('is uptodate when main never moved (rebases clean)', () => {
    const r = updateBranchFromMain('agent-a');
    expect(r.status).toBe('uptodate');
    expect(getBranchDrift('agent-a').moved).toBe(false);
  });

  it('pulls main edits into the branch and advances the fork', () => {
    projectFS.writeFile('app/page.client.tsx', BASE.replace('hi', 'hello'));
    const r = updateBranchFromMain('agent-a');
    expect(r.status).toBe('updated');
    expect(r.files).toContain('app/page.client.tsx');
    expect(projectFS.readBranchFile('agent-a', 'app/page.client.tsx')).toContain('hello');
    // Fork advanced: no more drift, diff vs base is empty.
    expect(getBranchDrift('agent-a').moved).toBe(false);
  });

  it('records conflicts without writing when both sides diverge', () => {
    projectFS.writeFile('app/page.client.tsx', BASE.replace('hi', 'hello'));
    projectFS.switchBranch('agent-a');
    projectFS.writeFile('app/page.client.tsx', BASE.replace('hi', 'bye'));
    projectFS.switchBranch('main');
    const r = updateBranchFromMain('agent-a');
    expect(r.status).toBe('conflicts');
    expect(r.conflicts.length).toBeGreaterThan(0);
    // Nothing written: branch still carries its own edit only.
    const branch = projectFS.readBranchFile('agent-a', 'app/page.client.tsx') ?? '';
    expect(branch).toContain('bye');
    expect(branch).not.toContain('hello');
    expect(projectFS.readBranchConflicts('agent-a').length).toBeGreaterThan(0);
  });

  it('manual contents override merged files (validated like the rest)', () => {
    projectFS.writeFile('app/page.client.tsx', BASE.replace('hi', 'hello'));
    projectFS.switchBranch('agent-a');
    projectFS.writeFile('app/page.client.tsx', BASE.replace('hi', 'bye'));
    projectFS.switchBranch('main');
    const manual = BASE.replace('hi', 'manual');
    const r = updateBranchFromMain('agent-a', { manualContents: { 'app/page.client.tsx': manual } });
    expect(r.status).toBe('updated');
    expect(projectFS.readBranchFile('agent-a', 'app/page.client.tsx')).toContain('manual');
  });

  it('applies per-path resolutions (theirs takes main)', () => {    projectFS.writeFile('app/page.client.tsx', BASE.replace('hi', 'hello'));
    projectFS.switchBranch('agent-a');
    projectFS.writeFile('app/page.client.tsx', BASE.replace('hi', 'bye'));
    projectFS.switchBranch('main');
    const first = updateBranchFromMain('agent-a');
    expect(first.status).toBe('conflicts');
    const choices: Record<string, Array<'ours' | 'theirs'>> = {};
    for (const c of first.conflicts) {
      if (!choices[c.path]) choices[c.path] = [];
      choices[c.path][c.index] = 'theirs';
    }
    const r = updateBranchFromMain('agent-a', { resolutions: choices });
    expect(r.status).toBe('updated');
    expect(projectFS.readBranchFile('agent-a', 'app/page.client.tsx')).toContain('hello');
  });
});
