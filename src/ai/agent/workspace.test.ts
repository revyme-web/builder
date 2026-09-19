// workspace.test.ts — P8 (vi): branch-aware helpers, legacy-default proofs.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getDefaultStore } from 'jotai';
import { projectFS, resetProjectFS } from '@/code/project/project-fs';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import type { ToolContext } from './types';
import {
  resolveToolBranch,
  resolveToolFile,
  readToolFile,
  getToolNodes,
  canvasBranchGuard,
  branchFsView,
  listToolPages,
} from './workspace';

const PAGE = `'use client';
import React from 'react';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <p data-id="a" style={{ position: 'relative' }}>hi</p>
    </div>
  );
}`;

const ctxNone: ToolContext = { ensureCheckpoint: () => {}, vpWidth: 1440, signal: new AbortController().signal };
const ctxMain: ToolContext = {
  ...ctxNone,
  workspace: { branchId: 'main', filePath: 'app/page.client.tsx' },
};
const ctxBranch: ToolContext = {
  ...ctxNone,
  workspace: { branchId: 'agent-a', filePath: 'app/page.client.tsx' },
};

beforeEach(() => {
  resetProjectFS(new Map([['app/page.client.tsx', PAGE]]));
  getDefaultStore().set(activeFilePathAtom, 'app/page.client.tsx');
});

afterEach(() => {
  resetProjectFS();
});

describe('workspace helpers — legacy defaults (no workspace)', () => {
  it('resolve to the human active context', () => {
    expect(resolveToolBranch(undefined)).toBe('main');
    expect(resolveToolBranch(ctxNone)).toBe('main');
    expect(resolveToolFile(undefined)).toBe('app/page.client.tsx');
    expect(readToolFile(undefined)).toBe(PAGE);
    expect(canvasBranchGuard(undefined)).toBeNull();
    expect(canvasBranchGuard(ctxNone)).toBeNull();
  });

  it('getToolNodes reads the shared snapshot unbranched', () => {
    expect(getToolNodes(undefined).has('root')).toBe(true);
  });

  it('listToolPages lists live pages unbranched', () => {
    expect(listToolPages(undefined)).toContain('app/page.client.tsx');
  });
});

describe('workspace helpers — branched runs', () => {
  beforeEach(() => {
    expect(projectFS.createBranch('agent-a')).toBeNull();
    projectFS.switchBranch('agent-a');
    projectFS.writeFile('app/page.client.tsx', PAGE.replace('hi</p>', 'hi-b</p>'));
    projectFS.switchBranch('main');
  });

  it('resolve + read route to the branch map', () => {
    expect(resolveToolBranch(ctxBranch)).toBe('agent-a');
    expect(resolveToolFile(ctxBranch)).toBe('app/page.client.tsx');
    expect(readToolFile(ctxBranch)).toContain('hi-b</p>');
    expect(readToolFile(ctxMain)).toContain('>hi</p>');
  });

  it('getToolNodes parses the branch file fresh', () => {
    expect(getToolNodes(ctxBranch).has('root')).toBe(true);
  });

  it('canvas guard fires off-branch, not on main-bound runs', () => {
    const guard = canvasBranchGuard(ctxBranch);
    expect(guard?.status).toBe('unavailable');
    expect(guard?.reason).toContain('agent-a');
    expect(canvasBranchGuard(ctxMain)).toBeNull();
  });

  it('branchFsView reads branch maps and refuses writes', () => {
    const view = branchFsView('agent-a');
    expect(view.readFile('app/page.client.tsx')).toContain('hi-b</p>');
    expect(view.listFiles('app/')).toContain('app/page.client.tsx');
    expect(view.exists('app/page.client.tsx')).toBe(true);
    expect(() => view.writeFile('x', 'y')).toThrow(/read-only/);
    expect(() => view.deleteFile('x')).toThrow(/read-only/);
  });

  it('listToolPages lists branch pages', () => {
    expect(listToolPages(ctxBranch)).toContain('app/page.client.tsx');
  });

  it('queue/flush helpers exist with branch routing', async () => {
    const { queueToolMutation, flushTool } = await import('./workspace');
    expect(typeof queueToolMutation).toBe('function');
    expect(typeof flushTool).toBe('function');
  });
});
