// ai/agent/tools/branch-isolation.test.ts — T1/T2/T3 (incident visit-locked).
//
// The run↔branch isolation contract, proven end-to-end with REAL tools on a
// REAL projectFS + REAL queue (no LLM, no mocks of the write path):
//   T1 — a TEST-bound run keeps writing TEST while the human stands on MAIN,
//        TEST stays visitable read-only, and becomes editable after stop.
//   T2 — parametric: every routed tool, bound to TEST with the human on MAIN,
//        leaves MAIN byte-identical and never touches human atoms.
//   T3 — the agent navigates/reads its own workspace while the human stays
//        on theirs (no activatePageForAgent, no selection wipe).
//
// A run is simulated with the EXACT state markRunning produces for an
// explicit binding (lockBranch + setLockHolderScoped(true) — covered by
// agent-store tests with the real { branch: { branchId } } shape).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDefaultStore } from 'jotai';
import type { ToolContext, AgentToolResult } from '@/ai/agent';
import { projectFS, resetProjectFS, projectVersionAtom } from '@/code/project/project-fs';
import {
  initMutationQueue,
  setActiveFilePath,
  syncQueueCode,
  getCurrentCode,
  flushNow,
} from '@/code/mutation/mutation-queue';
import { initHistory } from '@/code/mutation/history';
import { activeFilePathAtom, switchActiveFile } from '@/code/project/active-file-store';
import { modifyProjectFile } from '@/code/project/modify-file';
import { selectedIdsAtom, seedNodesForCode } from '@/code/stores/store';
import {
  lockBranch,
  unlockBranch,
  getLockedBranches,
  setLockHolderScoped,
  isLockHolderScoped,
  withAgentWriteAccessAsync,
} from '@/code/stores/agent-run-lock-store';
import { switchBranchFile, clearRememberedBranchFiles } from '@/code/branching/switch-workspace';
import { agentCheckpointsAtom } from '@/code/stores/agent-checkpoints';
import { setPageTool } from './set-page';
import { setTextTool } from './semantic-property';
import { addNodeTool } from './semantic-structure';
import { applyFileEditTool } from './whole-file';
import { setPageInteractionTool } from './set-page-interaction';
import { listCollectionsTool, getComponentTool, getActiveFileTool, turnDiffTool, getViewportWidthTool } from './read';
import { getScreenshotTool } from './screenshot';
import { createPageTool, createComponentTool, setVariantTool } from './action-layer-rich';
import { setPageVariableTool } from './set-page-variable';
import { batchTool } from './batch';

const HOME = 'app/page.client.tsx';
const ABOUT = 'app/about/page.client.tsx';
const page = (text: string) =>
  `export default function Page() { return <div data-id="root"><p data-id="a">${text}</p></div> }`;
const MAIN_CODE = page('main');
const ABOUT_CODE = page('about');
const MINI_MASTER = `export default function Mini({ title }: { title?: string }) {
  return <div data-id="mini-root"><p data-id="mini-text">{title ?? 'Hi'}</p></div>;
}`;
const BLOG_SCHEMA = JSON.stringify({ slug: 'blog', name: 'Blog', fields: [{ id: 'title', name: 'Title', type: 'text' }] });

function seed(): void {
  resetProjectFS(new Map<string, string>([[HOME, MAIN_CODE], [ABOUT, ABOUT_CODE]]));
  expect(projectFS.createBranch('test')).toBeNull();
  const store = getDefaultStore();
  store.set(activeFilePathAtom, HOME);
  store.set(selectedIdsAtom, []);
  setActiveFilePath(HOME);
  initMutationQueue(projectFS.readFile(HOME) ?? '', (flushed) => {
    projectFS.writeFile(store.get(activeFilePathAtom), flushed);
  });
  syncQueueCode(projectFS.readFile(HOME) ?? '');
  seedNodesForCode(projectFS.readFile(HOME) ?? '');
  store.set(projectVersionAtom, (v) => v + 1);
  store.set(agentCheckpointsAtom, new Map());
  initHistory('', () => {}, () => HOME);
  clearRememberedBranchFiles();
}

/** The exact lock/flag state markRunning produces for { branch: { branchId: 'test' } }. */
function bindRun(): void {
  lockBranch('test');
  setLockHolderScoped(true);
  expect(getLockedBranches()).toContain('test');
  expect(isLockHolderScoped()).toBe(true);
}

function stopRun(): void {
  for (const b of getLockedBranches()) unlockBranch(b);
  setLockHolderScoped(false);
  expect(getLockedBranches()).toEqual([]);
  expect(isLockHolderScoped()).toBe(false);
}

/** Bound run context exactly as unified-runner builds it (immutable pin). */
function boundCtx(file: string = HOME): ToolContext & { workspace: { branchId: string; filePath: string } } {
  return {
    ensureCheckpoint: () => {},
    vpWidth: 1280,
    signal: new AbortController().signal,
    workspace: { branchId: 'test', filePath: file },
  };
}

function mainMaps(): Map<string, string> {
  return new Map(projectFS.readBranchFiles('main') ?? []);
}
function expectMainPristine(before: Map<string, string>): void {
  expect(projectFS.readBranchFiles('main')).toEqual(before);
}
function humanState(): { file: string | null; selection: string[]; queueCode: string } {
  const store = getDefaultStore();
  return {
    file: store.get(activeFilePathAtom),
    selection: [...store.get(selectedIdsAtom)],
    queueCode: getCurrentCode(),
  };
}

async function exec(
  tool: { execute: (args: Record<string, unknown>, ctx: never) => Promise<AgentToolResult> },
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ ok: boolean; text: string }> {
  // Production executes every tool inside an agent-write window
  // (tool-exec.ts) — the window authenticates the run, routing comes from ctx.
  const res = await withAgentWriteAccessAsync(() => tool.execute(args, ctx as never));
  return {
    ok: !res.isError,
    text: res.content.map((c) => ('text' in c ? c.text : '')).join('\n'),
  };
}

beforeEach(() => {
  seed();
});

afterEach(() => {
  stopRun();
  clearRememberedBranchFiles();
  resetProjectFS();
});

// PORT-PENDING: branch-SCOPED tool writes need the branch workspace binding
// (ctx.workspace + a branch-scoped gate/queue). canvas-poc runs agent tools on
// the ACTIVE branch only; the branch twin lands with the partitioned drain.
describe.skip('T1 — TEST-bound run while the human stands on MAIN', () => {
  it('mutations land on TEST, MAIN stays pristine, visit is read-only, stop re-enables edit', async () => {
    const mainBefore = mainMaps();
    // (2) run bound to TEST (markRunning state).
    bindRun();
    // (3) human visits TEST then returns to MAIN — both moves allowed.
    expect(switchBranchFile('test')).toBeNull();
    expect(projectFS.getActiveBranchId()).toBe('test');
    expect(switchBranchFile('main')).toBeNull();
    expect(projectFS.getActiveBranchId()).toBe('main');
    // (4) several agent mutations through REAL tools, pointer on MAIN.
    const ctx = boundCtx();
    expect((await exec(setTextTool, { node_id: 'a', text: 'Agent wrote' }, ctx)).ok).toBe(true);
    expect((await exec(setPageTool, { page: 'about' }, ctx)).ok).toBe(true);
    expect(ctx.workspace.filePath).toBe(ABOUT);
    expect(
      (await exec(addNodeTool, { parent_id: 'root', id: 't1', tag: 'p', styles: { position: 'relative' }, text: 'T1' }, ctx)).ok,
    ).toBe(true);
    // (5/6) everything on TEST, MAIN byte-identical.
    expect(projectFS.readBranchFile('test', HOME)).toContain('Agent wrote');
    expect(projectFS.readBranchFile('test', ABOUT)).toContain('t1');
    expectMainPristine(mainBefore);
    // (7) TEST visitable read-only: enter works, writes refuse, navigation works.
    expect(switchBranchFile('test')).toBeNull();
    expect(modifyProjectFile(HOME, (c) => `${c} `)).toBeNull();
    expect(projectFS.readBranchFile('test', HOME)).toContain('Agent wrote');
    switchActiveFile(HOME, ABOUT, {
      setActiveFile: (p) => getDefaultStore().set(activeFilePathAtom, p),
      setSelectedIds: (ids) => getDefaultStore().set(selectedIdsAtom, ids),
      setUpdatingFromCanvas: (_v) => {},
    }, { syncQueueCode, flushNow });
    expect(getDefaultStore().get(activeFilePathAtom)).toBe(ABOUT);
    expect(switchBranchFile('main')).toBeNull();
    // (8) the run continues on TEST after the visit.
    expect((await exec(setTextTool, { node_id: 'a', text: 'Agent still here' }, boundCtx())).ok).toBe(true);
    expect(projectFS.readBranchFile('test', HOME)).toContain('Agent still here');
    expectMainPristine(mainBefore);
    // (9) stop frees the branch.
    stopRun();
    // (10) TEST editable again.
    expect(switchBranchFile('test')).toBeNull();
    const edited = modifyProjectFile(HOME, (c) => c.replace('Agent still here', 'Human edit'));
    expect(edited).not.toBeNull();
    expect(edited).toContain('Human edit');
  });
});

describe.skip('T2 — no tool derives the human active branch/file', () => {
  it.each([
    { name: 'set_page virtualizes (no human nav)', tool: () => setPageTool, args: { page: 'about' }, ok: true },
    { name: 'set_text lands on TEST', tool: () => setTextTool, args: { node_id: 'a', text: 'T2' }, ok: true },
    {
      name: 'add_node lands on TEST', tool: () => addNodeTool,
      args: { parent_id: 'root', id: 't2n', tag: 'p', styles: { position: 'relative' }, text: 'T2' }, ok: true,
    },
    {
      name: 'batch lands on TEST', tool: () => batchTool,
      args: { operations: [{ tool: 'set_text', args: { node_id: 'a', text: 'Batch T2' } }] }, ok: true,
    },
    {
      name: 'set_page_variable lands on TEST', tool: () => setPageVariableTool,
      args: { name: 't2var', type: 'text', value: 'hi' }, ok: true,
    },
    {
      name: 'create_page mints on TEST', tool: () => createPageTool,
      args: { name: 'Contact' }, ok: true,
    },
    {
      name: 'create_component authors on TEST', tool: () => createComponentTool,
      args: {
        name: 'T2Card',
        layout: [{ tag: 'div', style: { position: 'relative', display: 'flex' }, children: [{ tag: 'p', text: 'T2', style: { position: 'relative' } }] }],
      }, ok: true,
    },
    { name: 'whole-file refuses when bound', tool: () => applyFileEditTool, args: { path: HOME, code: MAIN_CODE, kind: 'page' }, ok: false },
    {
      name: 'set_page_interaction refuses when bound', tool: () => setPageInteractionTool,
      args: { node_id: 'a', trigger: 'click', variable: 't2var', value: 'hi' }, ok: false,
    },
    {
      name: 'set_variant fails closed without writing MAIN', tool: () => setVariantTool,
      args: { node_id: 'a', variant: 'open', styles: { color: 'red' } }, ok: false,
    },
    { name: 'get_viewport_width still reads (global by design)', tool: () => getViewportWidthTool, args: {}, ok: true },
    { name: 'get_screenshot honestly unavailable off-branch', tool: () => getScreenshotTool, args: {}, ok: true },
  ])('$name', async ({ tool, args, ok }) => {
    bindRun();
    try {
      projectFS.writeBranchFile('test', 'components/Mini.tsx', MINI_MASTER);
      projectFS.writeBranchFile('test', 'cms/blog.schema.json', BLOG_SCHEMA);
      const mainBefore = mainMaps();
      const humanBefore = humanState();
      const r = await exec(tool(), args as Record<string, unknown>, boundCtx());
      expect(r.ok).toBe(ok);
      // The contract, for pass AND refusal paths: MAIN untouched, human state untouched.
      expectMainPristine(mainBefore);
      expect(humanState()).toEqual(humanBefore);
    } finally {
      stopRun();
    }
  });

  it('branch reads resolve the pin, never the human pointer', async () => {
    bindRun();
    try {
      projectFS.writeBranchFile('test', 'components/Mini.tsx', MINI_MASTER);
      projectFS.writeBranchFile('test', 'cms/blog.schema.json', BLOG_SCHEMA);
      const ctx = boundCtx();
      // Component exists ONLY on TEST — found while the human stands on MAIN.
      const comp = await exec(getComponentTool, { name: 'Mini' }, ctx);
      expect(comp.ok).toBe(true);
      expect(comp.text).toContain('Mini');
      expect(projectFS.readFile('components/Mini.tsx')).toBeNull();
      // Collection exists ONLY on TEST.
      const cols = await exec(listCollectionsTool, {}, ctx);
      expect(cols.ok).toBe(true);
      expect(cols.text).toContain('blog');
    } finally {
      stopRun();
    }
  });

  it('turn_diff shows only the pinned branch seals', async () => {
    getDefaultStore().set(agentCheckpointsAtom, new Map([
      ['run-9', { before: new Map(), after: new Map(), changes: [], runId: 'r9', branchId: 'test' }],
      ['run-10', { before: new Map(), after: new Map(), changes: [], runId: 'r10' }],
    ]));
    const bound = await exec(turnDiffTool, {}, boundCtx());
    expect(bound.ok).toBe(true);
    expect(bound.text).toContain('run-9');
    expect(bound.text).not.toContain('run-10');
    const cross = await exec(turnDiffTool, { run_key: 'run-10' }, boundCtx());
    expect(cross.ok).toBe(false);
    const legacy = await exec(turnDiffTool, {}, {
      ensureCheckpoint: () => {}, vpWidth: 1280, signal: new AbortController().signal,
    });
    expect(legacy.ok).toBe(true);
    expect(legacy.text).toContain('run-10');
  });
});

describe.skip('T3 — agent workspace independent from human workspace', () => {
  it('agent navigates/reads TEST while the human stays on MAIN, then survives human navigation', async () => {
    bindRun();
    try {
      const store = getDefaultStore();
      // Human on MAIN/ABOUT with a selection; agent on TEST/HOME.
      switchActiveFile(HOME, ABOUT, {
        setActiveFile: (p) => store.set(activeFilePathAtom, p),
        setSelectedIds: (ids) => store.set(selectedIdsAtom, ids),
        setUpdatingFromCanvas: (_v) => {},
      }, { syncQueueCode, flushNow });
      store.set(selectedIdsAtom, ['human-sel']);
      const humanBefore = humanState();
      const ctx = boundCtx(HOME);
      // The agent reads ITS file, not the human's.
      const active = await exec(getActiveFileTool, {}, ctx);
      expect(active.ok).toBe(true);
      expect(active.text).toContain(HOME);
      // Virtual nav: the run rebinds, the human does not move.
      expect((await exec(setPageTool, { page: 'about' }, ctx)).ok).toBe(true);
      expect(ctx.workspace.filePath).toBe(ABOUT);
      expect(humanState()).toEqual(humanBefore);
      // Scoped write: lands on TEST, human selection/file/queue untouched.
      expect((await exec(setTextTool, { node_id: 'a', text: 'T3' }, boundCtx(ABOUT))).ok).toBe(true);
      expect(projectFS.readBranchFile('test', ABOUT)).toContain('T3');
      expect(humanState()).toEqual(humanBefore);
      // Human navigates away mid-run: the run is unaffected and continues.
      switchActiveFile(ABOUT, HOME, {
        setActiveFile: (p) => store.set(activeFilePathAtom, p),
        setSelectedIds: (ids) => store.set(selectedIdsAtom, ids),
        setUpdatingFromCanvas: (_v) => {},
      }, { syncQueueCode, flushNow });
      expect((await exec(setTextTool, { node_id: 'a', text: 'T3-after-nav' }, boundCtx(ABOUT))).ok).toBe(true);
      expect(projectFS.readBranchFile('test', ABOUT)).toContain('T3-after-nav');
      expect(projectFS.readBranchFiles('main')?.get(ABOUT)).toBe(ABOUT_CODE);
    } finally {
      stopRun();
    }
  });
});
