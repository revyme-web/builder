// src/ai/agent/tools/set-page.ts
//
// P1 — PAGE TARGETING (fiability audit, found broken 2026-08-19).
//
// A project-level agent must be able to point its WRITE path at a page other
// than the one that happens to be active — specifically, right after
// `create_page` it must be able to keep building the NEW page with the
// semantic tools (add_node, set_text, set_styles, …). Before this tool there
// was no way to do that: `createPageFile` writes the page pair but never
// touches `activeFilePathAtom`, no agent tool ever sets it, and the
// mutation-queue's own `_activeFilePath` tracker is only synced to the atom
// by a Canvas effect (Canvas.tsx:563) that does not exist in the agent
// runtime. Consequence: every `add_node`/`set_styles` after a page creation
// silently wrote into the OLD active page.
//
// The contract this module implements (a real product contract, not a
// create_page hack):
//   1. resolve a target page identifier (ProjectFS path or route slug) to
//      the canonical `page.client.tsx` path;
//   2. validate it exists in ProjectFS — a missing page is a CLEAR failure,
//      never a silent fallback, never a crash;
//   3. flush pending mutations (they belong to the CURRENT page — invariant
//      #2: the queue owns the write path);
//   4. switch the active file: `activeFilePathAtom` (the editor context the
//      injectors/reads see) AND the mutation-queue's `_activeFilePath`
//      tracker (what generators' `getCurrentCode`/write target);
//   5. re-seed the node cache (`seedNodesForCode`) + re-sync the queue code
//      so node reads (`get_node_tree`, getNodesSnapshot) and code reads
//      (`getCurrentCode`) reflect the NEW page in the SAME turn;
//   6. bump the project version so derived atoms re-evaluate.
//
// No accidental write to the old page: after activation `currentCode` and the
// queue's active path ARE the new page, so any subsequent semantic tool
// targets it. The helper is shared with `create_page` (activation right after
// creation — observation A "create → continue building immediately").

import { z } from 'zod';
import { getDefaultStore } from 'jotai';
import type { AgentTool, AgentToolResult } from '@/ai/agent';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { getHomePageFilePath, listPageFiles, filePathToSlug } from '@/code/project/active-file-store';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { setActiveFilePath, flushNow, syncQueueCode } from '@/code/mutation/mutation-queue';
import { seedNodesForCode } from '@/code/stores/store';
import { bumpProjectVersion } from '@/code/project/modify-file';
import { flushSaveNow } from '@/backend/autosave';
import { selectedIdsAtom } from '@/code/stores/store';
import { trace } from '@/shared/debug-trace';
import { listToolPages, isBranchedRun } from '@/ai/agent/workspace';

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

/**
 * Resolve a target page identifier to the canonical `page.client.tsx` path.
 * Accepts:
 *   - a ProjectFS path: `app/about/page.client.tsx` (client half), the server
 *     wrapper `app/about/page.tsx`, or a directory `app/about`;
 *   - a route slug: `about`, `/about`, `home`, `/`, `` (home).
 * Returns null when the identifier cannot be matched to an existing page.
 */
export function resolvePageTarget(page: string, pages?: string[]): string | null {
  const list = pages ?? listPageFiles();
  const trimmed = page.trim().replace(/^\/+/, '');
  if (trimmed === '' || trimmed.toLowerCase() === 'home') {
    return list.find((p) => filePathToSlug(p) === 'home') ?? 'app/page.client.tsx';
  }
  if (trimmed.startsWith('app/')) {
    let p = trimmed;
    // Server wrapper → client half (the canvas-editable body).
    if (p.endsWith('/page.tsx')) p = p.slice(0, -'/page.tsx'.length) + '/page.client.tsx';
    // A template's layout (app/(name)/LayoutClient.tsx) is editable like a page.
    else if (/\/LayoutClient\.tsx$/.test(p)) return projectFS.exists(p) ? p : null;
    else if (p.endsWith('.tsx') && !p.endsWith('/page.client.tsx')) return null; // not a page file
    else if (!p.endsWith('.tsx')) p = p.replace(/\/?$/, '/page.client.tsx');
    return list.includes(p) ? p : null;
  }
  // Route slug.
  return list.find((fp) => filePathToSlug(fp) === trimmed) ?? null;
}

/**
 * The P1 activation primitive: point the project's write/read path at an
 * EXISTING page (canonical `page.client.tsx` path). Safe in headless AND in
 * the browser (it does both halves of the sync the Canvas effect does: the
 * atom and the mutation-queue tracker). Returns the previous active file.
 * No-op when already active. Caller must have validated `clientPath`.
 */
export function activatePageForAgent(clientPath: string): string | null {
  const store = getDefaultStore();
  const previous = store.get(activeFilePathAtom);
  if (previous === clientPath) return previous;

  // 3. Pending mutations belong to the CURRENT page — flush them to ProjectFS
  //    before the pointer moves (invariant #2: the queue owns the write path).
  flushNow();
  // D-T5: persist the flushed pre-switch state before the pointer moves, so a
  // crash/refresh in the switch window cannot lose it (flushSaveNow never
  // rejects — fire-and-forget is safe).
  void flushSaveNow();

  // 4. Switch BOTH halves of the active-file identity.
  store.set(selectedIdsAtom, []);
  store.set(activeFilePathAtom, clientPath);
  setActiveFilePath(clientPath);

  // 5. Re-sync the queue's currentCode + the node cache so reads in the SAME
  //    turn reflect the new page (getCurrentCode / get_node_tree).
  const freshCode = projectFS.readFile(clientPath) ?? '';
  syncQueueCode(freshCode);
  seedNodesForCode(freshCode);

  // 6. Derived atoms re-evaluate after the switch.
  bumpProjectVersion();

  trace.action('agent-tool:set_page', { from: previous, to: clientPath });
  return previous;
}

export const setPageTool: AgentTool = {
  name: 'set_page',
  description:
    "Make a page the ACTIVE file so the semantic tools (add_node, set_styles, set_text, …) write into it. Use it after create_page to continue building the new page, or to switch to any existing page before editing it. page is a ProjectFS path ('app/about/page.client.tsx' or 'app/about/page.tsx') or a route slug ('about', '/about', 'home', '/'). Fails clearly if the page does not exist. Already-active is a no-op. On a branch-bound run this only rebinds the run's own workspace (virtualized) — it never navigates the human editor.",
  inputSchema: {
    page: z.string().describe("page to activate: path ('app/about/page.client.tsx'), route slug ('about', 'home'), or a template layout ('app/(site)/LayoutClient.tsx')"),
  },
  category: 'semantic',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    // P8 (vi) + isolation A: virtualized navigation for bound runs —
    // validate against the branch map and rebind the run's workspace ONLY
    // (global atoms, queue base, node cache, version all stay on the human
    // context). Presence-based: bound even when the human visits the run's
    // branch — the agent NEVER navigates the human. The run's own entries
    // settle first through a scoped flush.
    if (isBranchedRun(ctx)) {
      const ws = ctx.workspace!;
      const pages = listToolPages(ctx);
      const clientPath = resolvePageTarget(args.page as string, pages);
      if (clientPath === null) {
        const listed = pages.map((p) => `${filePathToSlug(p)} (${p})`).join(', ');
        return fail(`No page found for "${args.page}" on branch "${ws.branchId}". Existing pages: ${listed || '(none)'}.`);
      }
      if (projectFS.readBranchFile(ws.branchId, clientPath) == null) {
        return fail(`No page found for "${args.page}" on branch "${ws.branchId}".`);
      }
      flushNow({ branchId: ws.branchId });
      const previous = ws.filePath;
      ws.filePath = clientPath;
      trace.action('agent-tool:set_page', { from: previous, to: clientPath, branch: ws.branchId, virtualized: true });
      return ok({ page: clientPath, previous, route: filePathToSlug(clientPath), branch: ws.branchId });
    }
    const clientPath = resolvePageTarget(args.page as string);
    if (clientPath === null) {
      const pages = listPageFiles().map((p) => `${filePathToSlug(p)} (${p})`).join(', ');
      return fail(`No page found for "${args.page}". Existing pages: ${pages}`);
    }
    const previous = activatePageForAgent(clientPath);
    return ok({ page: clientPath, previous, route: filePathToSlug(clientPath) });
  },
};
