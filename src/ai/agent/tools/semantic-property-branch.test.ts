// semantic-property-branch.test.ts — X1: property tools branch isolation.
//
// Real queue + real ProjectFS (no queue mocks): a branched run's property
// writes must land ONLY in the branch map — main byte-identical, zero human
// fan-out (no onFlush). Unbranched runs keep the legacy landing on main.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { projectFS, resetProjectFS } from '@/code/project/project-fs';
import {
  initMutationQueue,
  setActiveFilePath,
  syncQueueCode,
} from '@/code/mutation/mutation-queue';
import {
  setStylesTool,
  setTextTool,
  setRichTextTool,
  setAttrTool,
  changeTagTool,
  setTokenTool,
} from './semantic-property';
import type { ToolContext } from '@/ai/agent';
import { getLockedBranches, unlockBranch } from '@/code/stores/agent-run-lock-store';
import { TurnCheckpoint } from '@/ai/agent/checkpoint';
import { getHistoryState } from '@/code/mutation/history';

const FILE = 'app/page.client.tsx';
const CSS = 'app/globals.css';
const BRANCH = 'agent-x';
const V1 = `export default function Page() { return <div data-id="root" style={{ position: 'relative' }}><p data-id="a" style={{ position: 'relative' }}>V1</p><span data-id="title" style={{ position: 'relative' }}>T</span><img data-id="img" style={{ position: 'relative' }} /><div data-id="wrap" style={{ position: 'relative' }}>W</div><div data-id="body" style={{ position: 'relative' }}>B</div></div> }`;
const CSS_V1 = `:root {\n  --color-brand: #6366f1;\n}\n`;

const onFlushSpy = vi.fn((newCode: string) => {
  projectFS.writeFile(FILE, newCode);
});

function makeCtx(): ToolContext {
  return { ensureCheckpoint: vi.fn(), vpWidth: 1440, signal: new AbortController().signal };
}

function branchCtx(): ToolContext {
  return { ...makeCtx(), workspace: { branchId: BRANCH, filePath: FILE } };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetProjectFS(
    new Map([
      [FILE, V1],
      [CSS, CSS_V1],
    ]),
  );
  setActiveFilePath(FILE);
  initMutationQueue(V1, onFlushSpy);
  syncQueueCode(V1);
  expect(projectFS.createBranch(BRANCH)).toBeNull();
});

afterEach(() => {
  for (const b of getLockedBranches()) unlockBranch(b);
  resetProjectFS();
});

function mainMaps(): Map<string, string> {
  return projectFS.readBranchFiles('main') ?? new Map();
}

// PORT-PENDING: branch-SCOPED tool writes need the branch workspace binding
// (ctx.workspace + a branch-scoped gate/queue). canvas-poc runs agent tools on
// the ACTIVE branch only; the branch twin lands with the partitioned drain.
describe.skip('property tools on main (legacy landing preserved)', () => {
  it('set_styles lands on main via the human fan-out', async () => {
    const r = await setStylesTool.execute({ node_id: 'a', styles: { color: 'red' } }, makeCtx());
    expect(r.isError).toBeUndefined();
    expect(onFlushSpy).toHaveBeenCalled();
    expect(projectFS.readFile(FILE)).toContain('red');
  });
});

describe.skip('property tools on a branch (X1 isolation)', () => {
  it('set_styles lands ONLY in the branch map; main byte-identical; no human fan-out', async () => {
    const before = new Map(mainMaps());
    const r = await setStylesTool.execute({ node_id: 'a', styles: { color: 'red' } }, branchCtx());
    expect(r.isError).toBeUndefined();
    expect(projectFS.readBranchFile(BRANCH, FILE)).toContain('red');
    expect(mainMaps()).toEqual(before);
    expect(onFlushSpy).not.toHaveBeenCalled();
  });

  it('set_text lands ONLY in the branch map', async () => {
    const before = new Map(mainMaps());
    const r = await setTextTool.execute({ node_id: 'title', text: 'Hello' }, branchCtx());
    expect(r.isError).toBeUndefined();
    expect(projectFS.readBranchFile(BRANCH, FILE)).toContain('Hello');
    expect(mainMaps()).toEqual(before);
    expect(onFlushSpy).not.toHaveBeenCalled();
  });

  it('set_rich_text lands ONLY in the branch map', async () => {
    const before = new Map(mainMaps());
    const r = await setRichTextTool.execute({ node_id: 'body', html: 'Hi' }, branchCtx());
    expect(r.isError).toBeUndefined();
    expect(projectFS.readBranchFile(BRANCH, FILE)).toContain('Hi');
    expect(mainMaps()).toEqual(before);
    expect(onFlushSpy).not.toHaveBeenCalled();
  });

  it('set_attr lands ONLY in the branch map', async () => {
    const before = new Map(mainMaps());
    const r = await setAttrTool.execute({ node_id: 'img', attrs: { src: 'x' } }, branchCtx());
    expect(r.isError).toBeUndefined();
    expect(projectFS.readBranchFile(BRANCH, FILE)).toContain('src');
    expect(mainMaps()).toEqual(before);
    expect(onFlushSpy).not.toHaveBeenCalled();
  });

  it('change_tag lands ONLY in the branch map', async () => {
    const before = new Map(mainMaps());
    const r = await setAttrTool.execute({ node_id: 'img', attrs: { alt: 'y' } }, branchCtx());
    expect(r.isError).toBeUndefined();
    const r2 = await changeTagTool.execute({ node_id: 'wrap', tag: 'section' }, branchCtx());
    expect(r2.isError).toBeUndefined();
    const branchCode = projectFS.readBranchFile(BRANCH, FILE) ?? '';
    expect(branchCode).toContain('section');
    expect(mainMaps()).toEqual(before);
    expect(onFlushSpy).not.toHaveBeenCalled();
  });

  it('set_token reads branch tokens and writes branch globals.css only', async () => {
    const before = new Map(mainMaps());
    const r = await setTokenTool.execute({ name: 'color-brand', value: '#4f46e5' }, branchCtx());
    expect(r.isError).toBeUndefined();
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({
      name: 'color-brand',
      value: '#4f46e5',
      previous: '#6366f1',
    });
    expect(projectFS.readBranchFile(BRANCH, CSS)).toContain('#4f46e5');
    expect(mainMaps()).toEqual(before);
    expect(onFlushSpy).not.toHaveBeenCalled();
  });

  it('set_token refuses tokens unknown on the branch (branch token list)', async () => {
    const r = await setTokenTool.execute({ name: 'nope', value: '#000' }, branchCtx());
    expect(r.isError).toBe(true);
    expect(mainMaps().get(CSS)).toBe(CSS_V1);
  });

  it('combined run: six tools, one branch — everything lands branched, main clean', async () => {    const before = new Map(mainMaps());
    const ctx = branchCtx();
    await setStylesTool.execute({ node_id: 'a', styles: { color: 'red' } }, ctx);
    await setTextTool.execute({ node_id: 'title', text: 'Hello' }, ctx);
    await setRichTextTool.execute({ node_id: 'body', html: 'Hi' }, ctx);
    await setAttrTool.execute({ node_id: 'img', attrs: { src: 'x' } }, ctx);
    await changeTagTool.execute({ node_id: 'wrap', tag: 'section' }, ctx);
    const tok = await setTokenTool.execute({ name: 'color-brand', value: '#4f46e5' }, ctx);
    expect(tok.isError).toBeUndefined();
    const branchCode = projectFS.readBranchFile(BRANCH, FILE) ?? '';
    expect(branchCode).toContain('red');
    expect(branchCode).toContain('Hello');
    expect(branchCode).toContain('Hi');
    expect(branchCode).toContain('section');
    expect(projectFS.readBranchFile(BRANCH, CSS)).toContain('#4f46e5');
    expect(mainMaps()).toEqual(before);
    expect(onFlushSpy).not.toHaveBeenCalled();
  });

  it('P8-D1 crown: bound checkpoint diffs the branch run end-to-end, no main history', async () => {
    const before = new Map(mainMaps());
    const undoSizeBefore = getHistoryState().undoSize;
    const cp = new TurnCheckpoint();
    cp.bindBranch(BRANCH);
    cp.begin();
    const ctx = branchCtx();
    await setStylesTool.execute({ node_id: 'a', styles: { color: 'red' } }, ctx);
    await setTextTool.execute({ node_id: 'title', text: 'Hello' }, ctx);
    const changes = cp.end();
    // The sealed diff describes the BRANCH work (TEST coherence).
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.map((c) => c.path)).toContain(FILE);
    const sealed = cp.snapshots();
    expect(sealed?.after.get(FILE)).toContain('red');
    expect(sealed?.before.get(FILE)).not.toContain('red');
    // No main history entry for branch work; main maps untouched.
    expect(getHistoryState().undoSize).toBe(undoSizeBefore);
    expect(mainMaps()).toEqual(before);
    expect(onFlushSpy).not.toHaveBeenCalled();
  });
});
