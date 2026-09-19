// src/ai/agent/tools/whole-file.ts
//
// Whole-file escape hatch: the model rewrites an ENTIRE file, judged by the
// SAME oracle gate the freeform loop and the MCP bridge share (gateTurnFiles +
// commitTurnFiles). Reserved for large/structural changes; small edits should
// go through the targeted tools (set_styles, add_node, …).

import { z } from 'zod';
import { getDefaultStore } from 'jotai';
import type { AgentTool, AgentToolResult } from '@/ai/agent';
import { projectFS } from '@/code/project/project-fs';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import {
  gateTurnFiles,
  commitTurnFiles,
  formatBounce,
  type TurnFile,
} from '@/code/oracle/gate';

const store = getDefaultStore();

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

export const applyFileEditTool: AgentTool = {
  name: 'apply_file_edit',
  description:
    "Rewrite an entire page or component file. Use ONLY when the semantic tools and batch CANNOT express the change: creating or modifying a COMPONENT that needs real code, complex refactors, or changes no semantic tool covers. Do NOT use it to build or edit page SECTIONS — a section is always buildable with semantic tools and batch (the default path: atomic, visible on canvas, audited per bulk). NEVER use it to wire interactivity on a page — that is set_page_variable + set_page_interaction. The file is validated by the project's strict oracle; you receive violations to fix. Known oracle rules you would hit on page rewrites: DISPLAY_TOGGLE_VISIBILITY (never toggle visibility with display:'none' — conditional rendering inside AnimatePresence), TEXT_EXPRESSION (text must be a literal, not a computed expression), UNRESOLVABLE_TERNARY (no inline x ? a : b in text content). Prefer specific tools (set_styles, add_node...) for small edits.",
  inputSchema: {
    code: z.string(),
    path: z.string().optional(),
    kind: z.enum(['page', 'component']).optional(),
  },
  category: 'wholefile',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    // P8 (vi) + isolation A: whole-file rewrites are unbound-context only —
    // the gate/commit path below is active-map bound (P5 invariant). Bound
    // runs always refuse here (even when the human visits their branch): use
    // batch/chain of semantic tools. Explicit refusal, never a silent write
    // to whatever branch the human happens to stand on.
    if (ctx.workspace) {
      return fail(
        `Whole-file rewrites target the active branch only (this run is on "${ctx.workspace.branchId}"). Build with batch/chain of semantic tools, or run unbranched.`,
      );
    }
    const activePagePath = store.get(activeFilePathAtom);
    const filePath = (args.path as string | undefined) ?? activePagePath;
    if (!filePath) return fail('No active file and no path provided.');
    const code = args.code as string | undefined;
    if (!code) return fail('Missing code.');
    const turnFile: TurnFile = {
      path: filePath,
      code,
      kind: (args.kind as 'page' | 'component' | undefined) ?? (filePath === activePagePath ? 'page' : 'component'),
    };
    // The gate remaps phantom page paths, runs the per-kind oracle, and runs
    // the stateful guards — all before anything is written. Violations bounce
    // back to the model, which fixes them and calls the tool again.
    const { files, violations } = gateTurnFiles([turnFile], activePagePath);
    if (violations.length > 0) {
      const bounced = formatBounce(violations);
      // Coaching oracle → modèle (le chemin le plus informatif pour corriger le
      // COMPORTEMENT, pas seulement le code) : un rewrite de PAGE rebondi est
      // le signal que la construction sémantique était le bon chemin.
      if (Array.isArray(bounced) && turnFile.kind === 'page') {
        bounced.push({
          code: 'SEMANTIC_PATH_AVAILABLE',
          message:
            'Hint: building or editing a page section is normally done with the semantic tools and batch (the default path) — apply_file_edit is the fallback for components and refactors.',
        });
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(bounced) }],
        isError: true,
      };
    }
    // Clean gate → commit. `written` is honest (Porte 5 / D-T3): if the
    // commit-time re-verification bounced the file, report the bounce instead
    // of a false success.
    const written = commitTurnFiles(files);
    if (!written.includes(files[0].path)) {
      return fail(
        `The file passed the gate but the commit refused it (oracle re-verification at write time). Nothing was written — adjust the code and resubmit.`,
      );
    }
    return ok({ committed: filePath });
  },
};
