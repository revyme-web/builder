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
import { flushTool } from '@/ai/agent/workspace';
import { applySourceEdits, type SourceEdit } from '@/ai/agent/source-edits';
import { trace } from '@/shared/debug-trace';

const store = getDefaultStore();

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

/** Files at least this large are edited with edit_source, never rewritten whole. */
export const LARGE_SOURCE_CHARS = 40_000;

/**
 * When a whole-file rewrite of an EXISTING file bounces, say what most likely
 * happened: a large file does not fit in one response, so the rewrite arrives
 * cut off — the bare SYNTAX_ERROR / CANVAS_CONFIG_DESTROYED it produced never
 * told the model that, and it resent the same truncated file (agent report
 * 2026-10-15). Null when the rewrite does not look truncated and the file is
 * not large.
 */
export function truncatedRewriteHint(prev: string, next: string): { code: string; message: string } | null {
  const prevLines = prev.split('\n').length;
  const nextLines = next.split('\n').length;
  const kb = Math.round(prev.length / 1024);
  const shorter = next.length < prev.length * 0.85;
  if (shorter && prevLines > 150) {
    return {
      code: 'TRUNCATED_REWRITE',
      message: `The current file is ${prevLines} lines (${kb} KB) and you sent ${nextLines} — the rewrite looks CUT OFF (a file this size does not fit in one response). Do not resend the whole file: change it with edit_source (old_text → new_text anchors), which sends only the lines that change.`,
    };
  }
  if (prev.length >= LARGE_SOURCE_CHARS) {
    return {
      code: 'LARGE_FILE_USE_EDIT_SOURCE',
      message: `This file is ${prevLines} lines (${kb} KB) — too large to rewrite whole reliably. Change it with edit_source (old_text → new_text anchors); find the lines with read_source (node_id or query).`,
    };
  }
  return null;
}

export const applyFileEditTool: AgentTool = {
  name: 'apply_file_edit',
  description:
    "Rewrite an entire page or component file — the COMPLETE file, every line. For an EXISTING file, change it with edit_source instead (old_text → new_text anchors): a large file does not fit in one response, and a cut-off rewrite is rejected. apply_file_edit is for NEW files and small ones. Use ONLY when the semantic tools and batch CANNOT express the change: creating or modifying a COMPONENT that needs real code, complex refactors, or changes no semantic tool covers. Do NOT use it to build or edit page SECTIONS — a section is always buildable with semantic tools and batch (the default path: atomic, visible on canvas, audited per bulk). NEVER use it to wire interactivity on a page — that is set_page_variable + set_page_interaction. The file is validated by the project's strict oracle; you receive violations to fix. Known oracle rules you would hit on page rewrites: DISPLAY_TOGGLE_VISIBILITY (never toggle visibility with display:'none' — conditional rendering inside AnimatePresence), TEXT_EXPRESSION (text must be a literal, not a computed expression), UNRESOLVABLE_TERNARY (no inline x ? a : b in text content). Prefer specific tools (set_styles, add_node...) for small edits.",
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
      const prevCode = projectFS.readFile(turnFile.path);
      const truncated = prevCode != null ? truncatedRewriteHint(prevCode, code) : null;
      if (truncated && Array.isArray(bounced)) {
        trace.action('agent-tool:apply-file-edit-truncated', { path: turnFile.path, prev: prevCode!.length, sent: code.length });
        bounced.unshift(truncated);
      }
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

// ─── edit_source — partial edits of an existing file ────────────────────────

export const editSourceTool: AgentTool = {
  name: 'edit_source',
  description:
    'Change an EXISTING page or component file by anchored find/replace — THE way to edit code in a file you are not creating: send only the lines that change, never the whole file (a large page does not fit in one response). Each edit is {old_text, new_text}: old_text must match the current file EXACTLY (copy it from read_source — indentation, line breaks and quotes included) and be UNIQUE, or the call is rejected with the line numbers of every match (extend the anchor with a neighbouring line, or pass replace_all: true). Edits apply IN ORDER, all or nothing; new_text "" deletes. The resulting file goes through the same oracle gate as apply_file_edit (only what YOUR edit introduces is judged); nothing is written unless it passes. The reply gives the changed line range — re-read it with read_source to check. Use apply_file_edit only to create a NEW file.',
  inputSchema: {
    path: z.string().optional().describe('existing project file, e.g. app/(site)/page.client.tsx or components/Card.tsx (default: the active file)'),
    edits: z
      .array(z.object({
        old_text: z.string().describe('exact current text to replace — unique in the file unless replace_all'),
        new_text: z.string().describe('replacement text ("" deletes old_text)'),
        replace_all: z.boolean().optional().describe('replace every occurrence of old_text'),
      }))
      .min(1)
      .describe('one or more edits, applied in order'),
    kind: z.enum(['page', 'component']).optional().describe('file kind — inferred from the path (components/ = component) when omitted'),
  },
  category: 'wholefile',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    // Same isolation rule as apply_file_edit: the gate/commit path is bound to
    // the active map, so a branch-bound run refuses rather than writing to
    // whatever branch the human stands on.
    if (ctx.workspace) {
      return fail(
        `Source edits target the active branch only (this run is on "${ctx.workspace.branchId}"). Build with batch/chain of semantic tools, or run unbranched.`,
      );
    }
    const activePagePath = store.get(activeFilePathAtom);
    const rawPath = (args.path as string | undefined)?.trim();
    const filePath = (rawPath || activePagePath || '').replace(/^\.\//, '').replace(/^\//, '');
    if (!filePath) return fail('No active file and no path provided.');
    // Read AFTER flushing queued writes, so anchors match what is really there.
    flushTool(ctx);
    const current = projectFS.readFile(filePath);
    if (current == null) {
      return fail(`No such file "${filePath}". edit_source changes EXISTING files — check the path (list_pages / list_components), or create a new file with apply_file_edit.`);
    }
    const applied = applySourceEdits(current, (args.edits as SourceEdit[]) ?? []);
    if (!applied.ok) {
      trace.action('agent-tool:edit-source-anchor-failed', { path: filePath });
      return fail(`${applied.error} Nothing was written.`);
    }
    const kind = (args.kind as 'page' | 'component' | undefined) ?? (filePath.startsWith('components/') ? 'component' : 'page');
    const { files, violations } = gateTurnFiles([{ path: filePath, code: applied.code, kind }], activePagePath);
    if (violations.length > 0) {
      trace.action('agent-tool:edit-source-bounced', { path: filePath, codes: violations.map((v) => v.code) });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'The edits applied, but the resulting file fails these checks. Nothing was written — fix them with another edit_source call (the file is unchanged).',
            violations: formatBounce(violations),
          }),
        }],
        isError: true,
      };
    }
    const written = commitTurnFiles(files);
    if (!written.includes(files[0].path)) {
      return fail('The edited file passed the gate but the commit refused it (oracle re-verification at write time). Nothing was written.');
    }
    const after = projectFS.readFile(files[0].path) ?? applied.code;
    trace.action('agent-tool:edit-source-committed', { path: files[0].path, edits: applied.counts.length, ...applied.changed });
    return ok({
      committed: files[0].path,
      edits: applied.counts.length,
      replacements: applied.counts,
      changed_lines: applied.changed,
      total_lines: after.split('\n').length,
    });
  },
};
