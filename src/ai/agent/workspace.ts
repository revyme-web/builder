// ai/agent/workspace.ts — P8 (vi): branch-aware tool helpers.
//
// Every helper degrades to the EXACT pre-P8 global read when ctx.workspace
// is absent (unbranched runs + all unit tests): the migration is behavior-
// identical unless a run is explicitly bound to a branch. Bound runs route
// file/node/queue operations to their branch map; the canvas (human truth),
// the global atoms and the UI fan-out are never touched by these paths.
//
// Layering: tools/* already import code/stores + code/project (batch.ts,
// read.ts precedent) — no new edges.

import { getDefaultStore } from 'jotai';
import type { CanvasNode } from '@/code/parsing/parser';
import { parseJSXToNodes } from '@/code/parsing/parser';
import { projectFS, MAIN_BRANCH_ID } from '@/code/project/project-fs';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { getNodesSnapshot } from '@/code/stores/store';
import { getQueueActiveFilePath, getCurrentCode, queueMutation, flushNow, type Mutation } from '@/code/mutation/mutation-queue';
import { trace } from '@/shared/debug-trace';
import type { ToolContext } from './types';
import type { ProjectFS } from '@/code/project/project-fs';
import type { PresetToken } from '@/shared/types';
import { parsePresetTokens } from '@/code/generation/preset-gen';
import { getPresetTokens } from '@/code/project/preset-ops';
import { listPageFiles as listPagesLive } from '@/code/project/active-file-store';

/** True when the run is explicitly bound to a branch (isolation A).
 * Presence, never position: a bound run stays bound even when the human
 * pointer stands on (or leaves) its branch. Unbound runs (no workspace)
 * keep the exact pre-P8 global behavior. */
export function isBranchedRun(ctx?: ToolContext): boolean {
  return !!ctx?.workspace;
}

/** Branch the run works on (bound branch, else the active/human branch). */
export function resolveToolBranch(ctx?: ToolContext): string {
  return ctx?.workspace?.branchId ?? projectFS.getActiveBranchId();
}

/** File the run works on (bound file, else the human active file). */
export function resolveToolFile(ctx?: ToolContext): string {
  if (ctx?.workspace) return ctx.workspace.filePath;
  return getDefaultStore().get(activeFilePathAtom);
}

/** Read a file through the run's workspace (branch map or active map). */
export function readToolFile(ctx: ToolContext | undefined, path?: string): string | null {
  const branchId = resolveToolBranch(ctx);
  const filePath = path ?? resolveToolFile(ctx);
  if (ctx?.workspace) {
    return projectFS.readBranchFile(branchId, filePath);
  }
  return projectFS.readFile(filePath);
}

/**
 * Node map for the run's file: live parse of the branch file when branched
 * (code-fresh, never the drag cache), else the shared snapshot (legacy).
 */
export function getToolNodes(ctx?: ToolContext): Map<string, CanvasNode> {
  if (ctx?.workspace) {
    const code = projectFS.readBranchFile(ctx.workspace.branchId, ctx.workspace.filePath);
    if (code == null) return new Map();
    try {
      return parseJSXToNodes(code);
    } catch {
      return new Map();
    }
  }
  // Never undefined: a snapshot that is not there yet (boot, a test without
  // one) is an EMPTY map, not a crash in the first tool that reads it.
  return getNodesSnapshot() ?? new Map();
}

/** Queue one mutation on the run's branch (author agent, file resolved). */
export function queueToolMutation(ctx: ToolContext | undefined, mutation: Mutation): void {
  const branchId = resolveToolBranch(ctx);
  const file =
    (mutation.type === 'writeFile' || mutation.type === 'deleteFile') &&
    typeof (mutation as { filePath?: unknown }).filePath === 'string'
      ? (mutation as { filePath: string }).filePath
      : (ctx?.workspace?.filePath ?? getQueueActiveFilePath());
  queueMutation(mutation, { author: 'agent', file, branchId });
  trace.fn('agent-workspace:queue', { type: mutation.type, branch: branchId, file });
}

/**
 * Flush the run's writes. Branched runs flush scoped (their group only —
 * human entries stay queued for the human path); unbranched runs flush bare
 * (legacy exact).
 */
export function flushTool(ctx?: ToolContext): void {
  if (ctx?.workspace) {
    flushNow({ branchId: ctx.workspace.branchId });
    return;
  }
  flushNow();
}

/**
 * Canvas-branch guard for observation tools (P6 epoch honesty on P8): the
 * canvas renders the HUMAN branch. Off-branch, measurements would describe
 * the wrong tree — report unavailable (verify via verify_effect instead).
 * Null when the canvas serves this run (proceed normally).
 */
export function canvasBranchGuard(ctx?: ToolContext): { status: 'unavailable'; reason: string } | null {
  if (!ctx?.workspace) return null;
  const canvasBranch = projectFS.getActiveBranchId();
  if (ctx.workspace.branchId === canvasBranch) return null;
  return {
    status: 'unavailable',
    reason: `The canvas shows branch "${canvasBranch}", not this run's branch "${ctx.workspace.branchId}" — no live render exists here. Verify with verify_effect (code) or preview the branch.`,
  };
}

/** Tokens visible to the run (branch globals.css or live presets). */
export function getToolTokens(ctx?: ToolContext): PresetToken[] {
  // getPresetTokens is store-free (reads globals.css); branch override below.
  if (ctx?.workspace) {
    const css = projectFS.readBranchFile(ctx.workspace.branchId, 'app/globals.css') ?? '';
    try {
      return parsePresetTokens(css);
    } catch {
      return [];
    }
  }
  // Live path: same presets the prompt embeds.
  return getPresetTokens();
}

/**
 * Read-mostly ProjectFS view over a branch map (for readers taking an FS:
 * component registry, prop-meta). Writes throw — routing writes through a
 * view would bypass gates/telemetry; use queue/commit paths instead.
 */
export function branchFsView(branchId: string): ProjectFS {
  const read = (path: string): Map<string, string> | null => projectFS.readBranchFiles(branchId);
  return {
    readFile: (path: string) => read(path)?.get(path) ?? null,
    writeFile: () => {
      throw new Error('branch FS view is read-only (route writes through queue/commit paths)');
    },
    deleteFile: () => {
      throw new Error('branch FS view is read-only (route writes through queue/commit paths)');
    },
    moveFile: () => {
      throw new Error('branch FS view is read-only (route writes through queue/commit paths)');
    },
    listFiles: (dir?: string) => {
      const prefix = dir ? (dir.endsWith('/') ? dir : `${dir}/`) : '';
      const out: string[] = [];
      for (const path of read('')?.keys() ?? []) {
        if (!prefix || path.startsWith(prefix)) out.push(path);
      }
      return out.sort();
    },
    exists: (path: string) => read(path)?.has(path) ?? false,
  };
}

/** Page files visible to the run (branch map or live list). */
export function listToolPages(ctx?: ToolContext): string[] {
  if (ctx?.workspace) {
    const files = projectFS.readBranchFiles(ctx.workspace.branchId);
    if (!files) return [];
    return [...files.keys()].filter((f) => f.startsWith('app/') && f.endsWith('page.client.tsx')).sort();
  }
  // Live path lives next to listPageFiles (imported lazily to avoid a
  // module-eval edge into active-file-store from here).
  return listPagesLive();
}

/**
 * Live code for the run's file: the branch map when branched (committed
 * branch state — a tool reads before it writes within one execute, and
 * batch steps flush between ops, so no pending-entry staleness), else the
 * queue's current code (may include un-flushed human-path mutations).
 */
export function getToolCode(ctx?: ToolContext, path?: string): string {
  if (ctx?.workspace) {
    return projectFS.readBranchFile(ctx.workspace.branchId, path ?? ctx.workspace.filePath) ?? '';
  }
  if (path === undefined) return getCurrentCode();
  return projectFS.readFile(path) ?? '';
}

/** Existence probe through the run's workspace (branch map or active map). */
export function toolFileExists(ctx: ToolContext | undefined, path: string): boolean {
  if (ctx?.workspace) {
    return projectFS.branchFileExists(ctx.workspace.branchId, path);
  }
  return projectFS.exists(path);
}

