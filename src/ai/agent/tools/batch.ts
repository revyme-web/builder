// src/ai/agent/tools/batch.ts
//
// Meta tool: runs up to 20 semantic operations in one call, with cross-tool
// references. `ref_id` on a creating op (add_node / add_canvas_node /
// duplicate_node) makes its created node_id referenceable as "$ref:<ref_id>"
// by later operations — useful to build a tree in one turn (create a
// container, then add children into it).
//
// ATOMICITY: the batch is transactional. Every nested operation mutates
// immediately (each semantic tool ends with flushNow()), so the batch takes a
// ProjectFS snapshot first and rolls it back if any op fails — a nested tool
// error OR a queue-level failure where the generator wrote code the builder
// cannot parse (validateGeneratedCode). Remaining ops are then marked
// "skipped (bulk rolled back)" instead of running. On success it reports
// per-file id changes plus a best-effort rendered-layout audit of the nodes
// the batch touched. Turn-level atomicity (single-gesture undo) is still
// guaranteed by the checkpoint the runtime arms via ctx.ensureCheckpoint() —
// batch calls it once, first.

import { z } from 'zod';
import { getDefaultStore } from 'jotai';
import type { AgentTool, AgentToolResult } from '@/ai/agent';
import { buildToolMap } from './registry';
import { PROPERTY_TOOLS } from './semantic-property';
import { STRUCTURE_TOOLS } from './semantic-structure';
import { ACTION_TOOLS } from './action-layer';
import { NON_BATCHABLE_TOOL_NAMES } from './action-layer-rich';
import { projectFS } from '@/code/project/project-fs';
import { validateGeneratedCode } from '@/code/mutation/mutation-queue';
import { checkFile, isAgentBlockingOracleViolation } from '@/code/oracle/check-file';
import { recordOracleBounce } from '@/code/oracle/telemetry';
import { restoreSnapshot, restoreBranchSnapshot } from '@/code/mutation/history';
import {
  resolveToolFile,
  resolveToolBranch,
  isBranchedRun,
  readToolFile,
  getToolNodes,
} from '@/ai/agent/workspace';
import { activeFilePathAtom, isLayoutFile } from '@/code/project/active-file-store';
import { bumpProjectVersion } from '@/code/project/modify-file';
import { interactingViewportIdAtom, viewportWidthsAtom, viewportsConfigAtom } from '@/code/stores/viewport-store';
import { getNodesSnapshot } from '@/code/stores/store';
import { diffTurnChanges } from '../checkpoint';
import { buildViewportTile, runDesignAudit } from './design-audit';
import { collectEpochSnapshot, formatEpochEnvelope } from './observation-epoch';
import { waitForRender, settleObservation } from './wait-for-render';
import { resolveViewportQuery } from './read';
import { verifyEffect } from './verify-effect';
import { coerceBatchOps } from './coerce';
import { formatToolError, formatUnknownTool } from '../error-format';
import { trace } from '@/shared/debug-trace';

interface BatchOperation {
  tool: string;
  args: Record<string, unknown>;
  ref_id?: string;
}

interface BatchResultItem {
  tool: string;
  ok: boolean;
  node_id?: string;
  error?: string;
}

/**
 * Schéma des opérations — PERMISSIF sur la forme : les modèles inventent des
 * variantes du shape canonique `{tool, args, ref_id}` (observées en E2E réel
 * 2026-08-15 avec glm-4.7-flash : `{op: ...}`, `{operation: ...}`,
 * `{add_node: {...}}`, args aplatis). Le preprocess normalise vers la forme
 * canonique ; les styles/attrs JSON-stringifiés sont réparés (coerce.ts —
 * le pattern « réparer comme un navigateur » de the reference builder). Une forme non
 * inférable reste telle quelle : zod la rejette avec un message clair.
 */
const operationsSchema = z
  .preprocess(
    coerceBatchOps,
    z
      .array(
        z.object({
          tool: z
            .string()
            .describe(
              'Name of a semantic tool: set_styles, set_text, set_rich_text, set_attr, change_tag, add_node, add_canvas_node, delete_node, move_node, reorder_node, duplicate_node, set_layout, set_size, set_position, set_typography',
            ),
          args: z
            .record(z.string(), z.unknown())
            .describe(
              'Arguments for that tool. Use "$ref:<ref_id>" as a value to reference a node created by an earlier operation that declared that ref_id.',
            ),
          ref_id: z
            .string()
            .optional()
            .describe(
              'Declare this only on add_node/add_canvas_node/duplicate_node — its created node_id becomes referenceable as $ref:<ref_id> by later ops.',
            ),
        }),
      )
      .max(20),
  )
  .describe(
    'Up to 20 semantic operations, executed in order, in canonical form {tool, args} plus optional ref_id — e.g. {tool: "add_node", args: {parent_id: "root", tag: "section", styles: {padding: "64px"}}, ref_id: "sec1"}.',
  );

/** Optional `request` arg — see below: when the model declares the user request
 *  this batch fulfils, the success result also carries an `effect` verdict. */
const batchRequestSchema = z
  .string()
  .optional()
  .describe('Optional — the user request this batch fulfils, in the user\'s wording (e.g. "Add a testimonials section with 2-3 cards, each with a quote and the name of the person"). When present, the success result ALSO returns an `effect` verdict — a headless (code-only) check of whether the request now reads as satisfied in the active file — plus a `nodes` write-path check (an IDS exists pass over the ids THIS batch created/modified: did its own writes land?). Informational: never a gate, never a rollback trigger.')

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

/** Deep copy without structuredClone (plain data only — tool args). */
function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(deepClone) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepClone(v);
    return out as T;
  }
  return value;
}

/**
 * P6 (M3 review) — per-viewport render rule for the batch audit, pure and
 * unit-tested: ready requires EVERY touched id that still exists to be
 * measured. One measured node on a partial snapshot is pending, exactly like
 * audit_design. Ids that no longer exist (deleted by the batch) need no
 * layout; ids unknown to the map (stale map) stay pending, never ready.
 */
export function isBatchViewportRendered(
  touchedIds: string[],
  nodeIds: Set<string>,
  measuredIds: Set<string>,
): boolean {
  const measurable = touchedIds.filter((id) => nodeIds.has(id));
  return measurable.length > 0 && measurable.every((id) => measuredIds.has(id));
}

/**
 * P6 (T1b) — end-of-batch FULL file gate, pure and unit-tested: returns the
 * rollback reason when the FINAL code carries agent-blocking violations the
 * batch INTRODUCED, null otherwise. Grandfathered like the drains: violations
 * already present in the pre-batch code never bounce. The caller rolls back
 * and records the bounce; this function only judges.
 */
export function checkBatchEndGate(beforeCode: string, endCode: string, activePath: string): string | null {
  // Same kind derivation as the whole-file gate (gateTurnFiles): the model
  // can't dodge file-kind rules, and neither can the batch.
  const endKind = activePath.startsWith('components/')
    ? (/@controls\s*\{/.test(endCode) ? 'code-component' : 'component')
    : isLayoutFile(activePath)
      ? 'template'
      : 'page';
  const endBlocking = checkFile(endCode, { kind: endKind, path: activePath }).filter((v) =>
    isAgentBlockingOracleViolation(v.code),
  );
  if (endBlocking.length === 0) return null;
  const beforeCodes = new Set(
    checkFile(beforeCode, { kind: endKind, path: activePath })
      .filter((v) => isAgentBlockingOracleViolation(v.code))
      .map((v) => v.code),
  );
  const fresh = endBlocking.filter((v) => !beforeCodes.has(v.code));
  if (fresh.length === 0) return null;
  return `Oracle file gate blocked batch: ${fresh.map((v) => `[${v.code}]`).join(' ')}`;
}

/**
 * Headless effect verdict for the batch result: when the batch declared the
 * `request` it fulfils, re-run the pure verifyEffect engine over the ACTIVE
 * file code (projectFS, no canvas) and attach the verdict. Informational only
 * — never affects the batch's own ok/rollback outcome. Never throws: an
 * unreadable file yields a not-satisfied verdict.
 *
 * P6 (iv): the batch KNOWS the ids it created/modified, so the verdict also
 * carries a `nodes` write-path check — an IDS `exists` pass over those ids
 * in the final code (did the batch's own writes land?). Concept verdict
 * stays the `effect`; `nodes` is attached alongside, never merged.
 */
function effectVerdict(activePath: string, request: string, nodeIds: string[] = [], ctx?: Parameters<AgentTool['execute']>[1]) {
  const code = readToolFile(ctx, activePath) ?? '';
  const verdict = verifyEffect(code, request, {}, activePath);
  trace.action('agent-tool:batch', { request, effect: verdict.satisfied ? 'satisfied' : 'not_satisfied', file: activePath });
  if (nodeIds.length === 0) return verdict;
  const idsVerdict = verifyEffect(code, request, { node_ids: nodeIds, checks: ['exists'] }, activePath);
  trace.action('agent-tool:batch', {
    request,
    nodesChecked: nodeIds.length,
    nodesMissing: idsVerdict.missing.length,
    file: activePath,
  });
  return {
    ...verdict,
    nodes: {
      checked: nodeIds,
      missing: idsVerdict.missing,
    },
  };
}

/**
 * Recursively replace "$ref:<id>" strings with the real node_id recorded for
 * that ref_id. Unknown refs are left as-is — the nested tool's own validation
 * then surfaces the natural error.
 */
/** Shared with chain.ts (declared multi-phase flows reuse refs + id extraction). */
export function resolveRefs(value: unknown, refIds: Map<string, string>): unknown {
  if (typeof value === 'string' && value.startsWith('$ref:')) {
    const resolved = refIds.get(value.slice('$ref:'.length));
    return resolved ?? value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, refIds));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveRefs(v, refIds);
    }
    return out;
  }
  return value;
}

/** Pull the created node_id out of a tool's JSON result text, if any. Shared with chain.ts. */
export function extractNodeId(result: AgentToolResult): { nodeId?: string; text: string } {
  const text = result.content.filter((c): c is Extract<(typeof result.content)[number], { type: 'text' }> => c.type === 'text').map((c) => c.text).join('\n');
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.node_id === 'string') return { nodeId: parsed.node_id, text };
  } catch {
    // Non-JSON content — no node_id to extract.
  }
  return { text };
}

/**
 * Hint d'identité déclaré par le MODÈLE sur une op de création : le paramètre
 * `id` ou l'attribut HTML `id` (add_node les traduit en data-id). Enregistré
 * comme référence résolvable — le modèle référence ensuite le nœud par
 * "$ref:<ce nom>" SANS avoir déclaré `ref_id` (son schéma naturel, observé en
 * E2E réel 2026-08-15 : attrs:{id:"hero-section"} + parent_id:"$ref:hero-section").
 */
export function extractIdHint(args: Record<string, unknown>): string | null {
  if (typeof args.id === 'string' && args.id !== '') return args.id;
  const attrs = args.attrs;
  if (attrs !== null && typeof attrs === 'object' && !Array.isArray(attrs)) {
    const id = (attrs as Record<string, unknown>).id;
    if (typeof id === 'string' && id !== '') return id;
  }
  return null;
}

export const batchTool: AgentTool = {
  name: 'batch',
  description:
    "Run up to 20 semantic operations (set_styles, add_node, set_layout, set_size, set_position, set_typography, ...) as one ATOMIC bulk update: any error — a nested tool failure or the file being left in code the builder can't parse — rolls the WHOLE batch back, and the remaining ops are skipped. Reports per-file created/modified/removed ids plus a best-effort rendered-layout audit of the nodes the batch touched. Use ref_id on a creating op + \"$ref:<ref_id>\" in a later op's args to chain (e.g. create a container, then add children into it). Whole-file rewrites are NOT allowed here — use apply_file_edit instead. batch executes Revyme semantic tools ONLY: there is no shell, no command execution, no web search inside it. The rendered-layout audit in the result carries status (\"ready\" | \"pending\" | \"unavailable\" | \"error\") with a reason plus epoch/coverage/unmeasured — \"ready\" only when the touched nodes are measured on a fresh epoch — the turn is not finished while status is not \"ready\". When the optional `request` arg is passed, the success result ALSO carries an `effect` verdict block: whether the request reads as satisfied (section present + content filled) in the active file — headless, informational, never a gate.",
  inputSchema: { operations: operationsSchema, request: batchRequestSchema },
  category: 'meta',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    const store = getDefaultStore();
    const ops = (args.operations as BatchOperation[]) ?? [];
    const requestArg = typeof args.request === 'string' ? args.request.trim() : '';
    trace.action('agent-tool:batch', { ops: ops.length, request: requestArg ? true : false });

    // A. Pre-batch snapshot for the transactional rollback (branch map when
    //    branched — a rollback rewinds the run's branch, never main).
    const branchId = resolveToolBranch(ctx);
    const branched = isBranchedRun(ctx);
    const before = branched
      ? (projectFS.readBranchFiles(branchId) ?? new Map<string, string>())
      : projectFS.getSnapshot();

    // B. Baseline guard — a file that was ALREADY broken before the batch is
    //    never blamed on the batch. Read fresh from ProjectFS (the queue's
    //    onFlush writes it synchronously).
    const activePath = resolveToolFile(ctx);
    const baselineInvalid = validateGeneratedCode(readToolFile(ctx, activePath) ?? '') !== null;

    // Deliberately no whole-file and no read tools inside the batch. The pure
    // ACTION_TOOLS (set_layout/set_size/set_position/set_typography) are
    // transactional (queueMutation + flushNow only) so they batch safely; the
    // rich primitives (set_motion_preset, create_overlay, set_variant, bind_*,
    // set_form, create_page, set_page) are NOT batchable.
    const toolMap = buildToolMap([...PROPERTY_TOOLS, ...STRUCTURE_TOOLS, ...ACTION_TOOLS]);
    // Names that EXIST but cannot run here. Derived from the registry rather
    // than hand-listed, so a new rich tool is explained correctly the day it
    // is added instead of being reported as unknown.
    const notBatchable = new Set(NON_BATCHABLE_TOOL_NAMES);
    const validToolNames = Array.from(toolMap.keys());
    const refIds = new Map<string, string>();
    const results: BatchResultItem[] = [];
    let failure: string | null = null;
    let i = 0;
    for (; i < ops.length; i++) {
      // D-T5: stop/timeout finishes the drain, never starts new work — an
      // aborted batch stops BEFORE the next op and rolls back (same path as
      // any other failure). The signal is re-checked per op: an abort racing
      // op N must not let op N+1 start.
      if (ctx.signal.aborted) {
        failure = 'Aborted mid-batch — bulk rolled back.';
        results.push({ tool: ops[i].tool, ok: false, error: failure });
        trace.action('agent-tool:batch', { op: ops[i].tool, result: 'aborted' });
        break;
      }
      const op = ops[i];
      const resolvedArgs = resolveRefs(deepClone(op.args), refIds) as Record<string, unknown>;
      const tool = toolMap.get(op.tool);
      if (!tool) {
        // A rich primitive EXISTS — it just cannot run inside a transaction
        // (it writes component files / runs the gate, which a snapshot
        // rollback cannot cleanly undo). Reporting it as "Unknown tool" sent
        // the model looking for a name that was right all along; naming the
        // real constraint lets it recover in one step.
        results.push({
          tool: op.tool,
          ok: false,
          error: notBatchable.has(op.tool)
            ? `${op.tool} cannot run inside batch — call it directly, on its own`
            : 'Unknown tool',
        });
        failure = formatUnknownTool(op.tool, validToolNames);
        trace.action('agent-tool:batch', { op: op.tool, result: 'unknown-tool' });
        break;
      }
      let res: AgentToolResult;
      try {
        res = await tool.execute(resolvedArgs, ctx);
      } catch (e) {
        const msg = formatToolError(e);
        res = { content: [{ type: 'text', text: msg }], isError: true };
      }
      const { nodeId, text } = extractNodeId(res);
      if (nodeId) {
        if (op.ref_id) refIds.set(op.ref_id, nodeId);
        // Le hint d'identité du modèle (id / attrs.id) devient une référence
        // résolvable — "$ref:<hint>" fonctionne sans ref_id déclaré.
        const hint = extractIdHint(resolvedArgs);
        if (hint !== null) refIds.set(hint, nodeId);
      }
      const item: BatchResultItem = { tool: op.tool, ok: !res.isError };
      if (nodeId) item.node_id = nodeId;
      if (res.isError) item.error = text;
      results.push(item);
      if (res.isError) {
        failure = text;
        trace.action('agent-tool:batch', { op: op.tool, result: 'error', error: failure });
        break;
      }

      // C. Per-operation queue-level validation: the op succeeded at the tool
      //    level, but did the generator write code the builder can parse? A
      //    clean baseline means any invalid code now is THIS op's fault.
      if (!baselineInvalid) {
        const code = readToolFile(ctx, activePath) ?? '';
        const validationErr = validateGeneratedCode(code);
        if (validationErr !== null) {
          item.ok = false;
          item.error = validationErr;
          delete item.node_id;
          failure = validationErr;
          trace.action('agent-tool:batch', { op: op.tool, result: 'validation-failed', error: validationErr });
          break;
        }
      }
    }

    // P6 (T1b) — end-of-batch FULL file gate (pure helper above): file-global
    // rules only read correctly on the final code. A hit rolls the batch back
    // through the same path as any other failure.
    if (failure === null && !baselineInvalid) {
      const gateReason = checkBatchEndGate(
        before.get(activePath) ?? '',
        readToolFile(ctx, activePath) ?? '',
        activePath,
      );
      if (gateReason !== null) {
        failure = gateReason;
        recordOracleBounce();
        trace.error('agent-tool:batch', {
          result: 'oracle-gate-failed',
          error: failure,
          ops: ops.length,
        });
      }
    }

    // D. Transactional rollback on any failure: restore the pre-batch state
    //    through the unique `restoreSnapshot` primitive (Porte 5 / D-T3) — a
    //    raw `loadSnapshot` rewinds the FS but leaves the queue base stale, so
    //    the next flush resurrects the rolled-back ops (batch-ressuscité).
    //    Remaining not-yet-run ops are marked as skipped.
    if (failure !== null) {
      if (branched) {
        const err = restoreBranchSnapshot(branchId, before, { activeFile: activePath, reason: 'batch-rollback' });
        if (err) trace.error('agent-tool:batch', { result: 'rollback-failed', error: err });
      } else {
        restoreSnapshot(before, { activeFile: activePath, reason: 'batch-rollback' });
      }
      for (let j = i + 1; j < ops.length; j++) {
        results.push({ tool: ops[j].tool, ok: false, error: `skipped (bulk rolled back after "${failure}")` });
      }
      trace.action('agent-tool:batch', {
        result: 'rolled_back', reason: failure, ops: ops.length, skipped: ops.length - i - 1,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              bulk: 'rolled_back',
              reason: failure,
              results,
              ref_ids: Object.fromEntries(refIds),
            }),
          },
        ],
        isError: true,
      };
    }

    // E. Success diagnostics: per-file id diffs + a best-effort design audit.
    const after = branched
      ? (projectFS.readBranchFiles(branchId) ?? new Map<string, string>())
      : projectFS.getSnapshot();
    const changes = diffTurnChanges(before, after);
    const createdIds: string[] = [];
    const modifiedIds: string[] = [];
    const removedIds: string[] = [];
    const createdSeen = new Set<string>();
    const modifiedSeen = new Set<string>();
    const removedSeen = new Set<string>();
    for (const c of changes) {
      for (const id of c.addedIds) if (!createdSeen.has(id)) { createdSeen.add(id); createdIds.push(id); }
      for (const id of c.changedIds) if (!modifiedSeen.has(id)) { modifiedSeen.add(id); modifiedIds.push(id); }
      for (const id of c.removedIds) if (!removedSeen.has(id)) { removedSeen.add(id); removedIds.push(id); }
    }

    // Design audit against the rendered canvas. Never throws — the rect
    // caches may be empty (render pending) or the bridge missing entirely.
    // The observation contract: status tells the model WHY the audit has no
    // measurements — unavailable (batch touched nothing / never a pending
    // mask), pending (render still filling the cache), error (audit crashed).
    // MULTI-VIEWPORT (CHANTIER C): besides the interacting viewport, every
    // viewport the batch WROTE is audited too — viewports named by an op's
    // `viewport` arg (set_styles breakpoint px), or, when no op names one but
    // the batch touched responsive code (@media / __mq ternaries in the
    // active file), the other breakpoints as well. `viewports` lists what was
    // checked; the top-level fields mirror the FIRST (interacting viewport).
    interface VpAuditEntry {
      id: string;
      width: number | null;
      checked: number;
      render_pending: boolean;
      violations: string[];
      status: 'ready' | 'pending' | 'unavailable' | 'error';
      reason: string;
      /** P6 (T4) — the epoch + coverage this viewport was audited against. */
      epoch: {
        renderSeq: number | null;
        projectVersionAtFill: number | null;
        projectVersionNow: number | null;
        stale: boolean;
      };
      coverage: { withRect: number; total: number };
      unmeasured: string[];
      unmeasuredTotal: number;
    }
    let audit: {
      viewport: string;
      viewport_width: number | null;
      checked: number;
      render_pending: boolean;
      violations: string[];
      status: 'ready' | 'pending' | 'unavailable' | 'error';
      reason: string;
      viewports: VpAuditEntry[];
      epoch: VpAuditEntry['epoch'];
      coverage: { withRect: number; total: number };
      unmeasured: string[];
      unmeasuredTotal: number;
    };
    // P6 (iv): ids the batch touched — shared by the rendered audit AND the
    // headless effect verdict's `nodes` write-path check below.
    let touchedIds: string[] = [];
    try {
      const interactingVpId = store.get(interactingViewportIdAtom);
      const widths = store.get(viewportWidthsAtom);
      const vpConfigs = store.get(viewportsConfigAtom);
      touchedIds = [...createdIds];
      for (const id of modifiedIds) if (!touchedIds.includes(id)) touchedIds.push(id);
      for (const r of results) if (r.node_id && !touchedIds.includes(r.node_id)) touchedIds.push(r.node_id);
      // P8 (vi): off-canvas-branch — bridge rects would describe the WRONG
      // tree (same data-ids on main). No measurement, honestly unavailable.
      if (branched && branchId !== projectFS.getActiveBranchId()) {
        audit = {
          viewport: interactingVpId,
          viewport_width: widths[interactingVpId] ?? null,
          checked: 0,
          render_pending: false,
          violations: [],
          status: 'unavailable',
          reason: `The canvas shows branch "${projectFS.getActiveBranchId()}", not this run's branch "${branchId}" — no live render exists here. Verify with verify_effect (code).`,
          viewports: [],
          epoch: { renderSeq: null, projectVersionAtFill: null, projectVersionNow: null, stale: false },
          coverage: { withRect: 0, total: touchedIds.length },
          unmeasured: [...touchedIds],
          unmeasuredTotal: touchedIds.length,
        };
        trace.action('agent-tool:batch', { result: 'ok', ops: ops.length, audit: 'unavailable: off-canvas-branch' });
        return ok({
          bulk: 'ok',
          results,
          ref_ids: Object.fromEntries(refIds),
          changes,
          created_ids: createdIds,
          modified_ids: modifiedIds,
          removed_ids: removedIds,
          audit,
          ...(requestArg ? { effect: effectVerdict(activePath, requestArg, touchedIds, ctx) } : {}),
        });
      }
      if (touchedIds.length === 0) {
        audit = {
          viewport: interactingVpId,
          viewport_width: widths[interactingVpId] ?? null,
          checked: 0,
          render_pending: false,
          violations: [],
          status: 'unavailable',
          reason: 'No nodes were created or modified by this batch — there is nothing to audit. Audit the rendered layout with audit_design / get_layout instead.',
          viewports: [],
          epoch: { renderSeq: null, projectVersionAtFill: null, projectVersionNow: null, stale: false },
          coverage: { withRect: 0, total: 0 },
          unmeasured: [],
          unmeasuredTotal: 0,
        };
        trace.action('agent-tool:batch', { result: 'ok', ops: ops.length, audit: 'unavailable: nothing-touched' });
        return ok({
          bulk: 'ok',
          results,
          ref_ids: Object.fromEntries(refIds),
          changes,
          created_ids: createdIds,
          modified_ids: modifiedIds,
          removed_ids: removedIds,
          audit,
          ...(requestArg ? { effect: effectVerdict(activePath, requestArg, touchedIds, ctx) } : {}),
        });
      }

      // Viewports the ops explicitly wrote: set_styles' `viewport` arg is a
      // breakpoint width in px — reverse-resolve it to a viewport id.
      const opViewports = new Set<string>();
      for (const op of ops) {
        const args = op.args;
        const raw = args !== null && typeof args === 'object' ? (args as Record<string, unknown>).viewport : undefined;
        if (typeof raw === 'number') {
          const resolved = resolveViewportQuery(raw, interactingVpId, widths);
          if (resolved.width !== null) opViewports.add(resolved.id);
        }
      }
      // Responsive work without explicit viewports (e.g. a base edit on a
      // page that already carries responsive code) → cover the breakpoints
      // too: a mobile override the batch didn't name still needs auditing.
      if (opViewports.size === 0 && /@media|__mq\d/.test(readToolFile(ctx, activePath) ?? '')) {
        for (const [id, w] of Object.entries(widths)) {
          if (w > 0 && id !== interactingVpId) opViewports.add(id);
        }
      }
      const vpIds = [
        interactingVpId,
        ...[...opViewports]
          .filter((id) => id !== interactingVpId)
          .sort((a, b) => (widths[b] ?? 0) - (widths[a] ?? 0)),
      ];

      // Wait for the canvas rect cache of every target viewport to fill —
      // through the SHARED waitForRender primitive (P6 (i)), one bounded
      // wait per viewport over the touched ids. A viewport that never fills
      // stays 'pending' and is reported as such, never silently skipped.
      // The renderer populates the caches asynchronously after the file
      // write; break early as soon as each target has its touched nodes.
      // Off-canvas-branch: waitForRender reports unavailable immediately
      // (no render will fill these) and the audit below stays unavailable.
      const waitBranch = branched ? branchId : undefined;
      for (const vpId of vpIds) {
        if (widths[vpId] == null) continue;
        await waitForRender({ nodeIds: touchedIds, vpId, timeoutMs: 1200, intervalMs: 100, branchId: waitBranch });
        // Rendered but measured against an older version (the batch's own
        // writes, a panel refresh) → re-measure and wait for a fresh epoch.
        if (!branched) await settleObservation({ vpId, nodeIds: touchedIds, onlyIfStale: true });
      }
      const vpAudits: VpAuditEntry[] = [];
      for (const vpId of vpIds) {
        if (widths[vpId] == null) {
          vpAudits.push({
            id: vpId,
            width: null,
            checked: 0,
            render_pending: false,
            violations: [],
            status: 'unavailable',
            reason: `Unknown viewport id "${vpId}" — no width match.`,
            epoch: { renderSeq: null, projectVersionAtFill: null, projectVersionNow: null, stale: false },
            coverage: { withRect: 0, total: 0 },
            unmeasured: [],
            unmeasuredTotal: 0,
          });
          continue;
        }
        const nodeMap = getToolNodes(ctx);
        const { nodes: snapshot, epoch } = collectEpochSnapshot(nodeMap, vpId);
        const config = vpConfigs.find((c) => c.id === vpId);
        const tile = buildViewportTile(snapshot, widths[vpId] ?? 0, config?.height);
        const findings = runDesignAudit(snapshot, tile);
        // P6 (M3 review): ready requires EVERY touched id that still exists
        // to be measured — one measured node on a partial snapshot is
        // pending, exactly like audit_design (see isBatchViewportRendered).
        const measured = new Set(snapshot.filter((n) => n.rect !== null).map((n) => n.id));
        const rendered = isBatchViewportRendered(touchedIds, new Set(nodeMap.keys()), measured);
        const envelope = formatEpochEnvelope(epoch);
        vpAudits.push({
          id: vpId,
          width: widths[vpId] ?? null,
          checked: snapshot.filter((n) => n.rect !== null).length,
          render_pending: !rendered,
          violations: findings.map((f) => `${f.rule}: ${f.message}`),
          // P6 (T4): ready = touched nodes rendered AND the epoch fresh —
          // a measurement that predates the batch's own writes is stale.
          status: rendered && !epoch.stale ? 'ready' : 'pending',
          reason: rendered
            ? epoch.stale
              ? 'The project changed since this measurement — wait a moment, then call audit_design / get_layout to re-check.'
              : 'Rendered layout measured — fix any violation above, then re-audit.'
            : 'The canvas may be mid-render — wait a moment, then call audit_design / get_layout to re-check.',
          ...envelope,
        });
      }
      const primary = vpAudits[0];
      audit = {
        viewport: primary.id,
        viewport_width: primary.width,
        checked: primary.checked,
        render_pending: primary.render_pending,
        violations: primary.violations,
        status: primary.status,
        reason: primary.reason,
        viewports: vpAudits,
        epoch: primary.epoch,
        coverage: primary.coverage,
        unmeasured: primary.unmeasured,
        unmeasuredTotal: primary.unmeasuredTotal,
      };
    } catch (e) {
      trace.error('agent-tool:batch', e);
      const vpId = store.get(interactingViewportIdAtom);
      audit = {
        viewport: vpId,
        viewport_width: store.get(viewportWidthsAtom)[vpId] ?? null,
        checked: 0,
        render_pending: false,
        violations: [],
        status: 'error',
        reason: `The rendered-layout audit failed: ${(e as Error).message || String(e)}. The batch itself succeeded — check the layout with audit_design.`,
        viewports: [],
        epoch: { renderSeq: null, projectVersionAtFill: null, projectVersionNow: null, stale: false },
        coverage: { withRect: 0, total: 0 },
        unmeasured: [],
        unmeasuredTotal: 0,
      };
    }

    trace.action('agent-tool:batch', {
      result: 'ok', ops: ops.length, changedFiles: changes.length,
      created: createdIds.length, modified: modifiedIds.length, removed: removedIds.length,
      auditedViewports: audit.viewports.map((v) => v.id).join(','),
    });
    return ok({
      bulk: 'ok',
      results,
      ref_ids: Object.fromEntries(refIds),
      changes,
      created_ids: createdIds,
      modified_ids: modifiedIds,
      removed_ids: removedIds,
      audit,
      ...(requestArg ? { effect: effectVerdict(activePath, requestArg, touchedIds, ctx) } : {}),
    });
  },
};