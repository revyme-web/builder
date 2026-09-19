// src/ai/agent/tools/chain.ts
//
// Meta tool: a DECLARED multi-phase chain (I3' — Porte 7 §9(iv)). Unlike
// `batch` (one ATOMIC bulk: any fault rolls everything back silently as a
// unit), a chain declares its manifest upfront and commits LINK BY LINK —
// each link lands through the normal write path (gate + flush included).
// On a mid-chain fault the chain COMPENSATES (committed links rewound,
// manifest states committed→compensated in reverse, unrun links pending)
// and reports the manifest honestly: a fault is an explicit compensated
// failure with per-link states + epochs, never a pseudo-success.
//
// When to use which: `batch` for a single-phase atomic bulk (one section,
// one gesture); `chain` for multi-phase greenfield flows whose phases must
// each land to be inspected (create_component master → add_component_instance
// → set_variant), where a mid-way fault must name the link and rewind.
//
// Mechanically it mirrors batch (same $ref: chaining, same per-op queue
// validation, same abort discipline D-T5) minus atomicity: snapshots are
// taken PER LINK, and compensation rewinds through the unique
// `restoreSnapshot` primitive (D-T3) — the only other tool allowed by the
// G2 CI-grep besides batch.ts, for exactly this system-owned rollback.

import { z } from 'zod';
import { getDefaultStore } from 'jotai';
import type { AgentTool, AgentToolResult } from '@/ai/agent';
import { buildToolMap } from './registry';
import { PROPERTY_TOOLS } from './semantic-property';
import { STRUCTURE_TOOLS } from './semantic-structure';
import { ACTION_TOOLS } from './action-layer';
import {
  extractComponentTool,
  createVariantTool,
  setVariantTool,
  createComponentTool,
} from './action-layer-rich';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { validateGeneratedCode } from '@/code/mutation/mutation-queue';
import { restoreSnapshot, restoreBranchSnapshot } from '@/code/mutation/history';
import {
  resolveToolFile,
  resolveToolBranch,
  isBranchedRun,
  readToolFile,
} from '@/ai/agent/workspace';
import { coerceBatchOps } from './coerce';
import { resolveRefs, extractNodeId, extractIdHint } from './batch';
import { formatToolError, formatUnknownTool } from '../error-format';
import { trace } from '@/shared/debug-trace';

interface ChainStep {
  tool: string;
  args: Record<string, unknown>;
  ref_id?: string;
}

type LinkState = 'committed' | 'compensated' | 'failed' | 'pending';

interface ChainLink {
  step: number;
  tool: string;
  state: LinkState;
  node_id?: string;
  error?: string;
  /** Project version before/after the link — pending links stay visible. */
  versionBefore: number | null;
  versionAfter: number | null;
}

interface ChainResultItem {
  tool: string;
  ok: boolean;
  node_id?: string;
  error?: string;
}

/** Max links: chains are heavier than batches (one snapshot per link). */
export const CHAIN_MAX_STEPS = 10;

/** Same canonical {tool, args, ref_id} shape as batch (shared coerce). */
const stepsSchema = z
  .preprocess(
    coerceBatchOps,
    z
      .array(
        z.object({
          tool: z.string().describe('Name of an allowed chain tool (semantic, structural, action-layer, or component tool — no whole-file rewrites, no reads, no nested batch/chain).'),
          args: z.record(z.string(), z.unknown()).describe('Arguments for that tool. Use "$ref:<ref_id>" to reference a node created by an earlier link.'),
          ref_id: z.string().optional().describe('Declare on a creating link — its node_id becomes referenceable as $ref:<ref_id> by later links.'),
        }),
      )
      .min(1)
      .max(CHAIN_MAX_STEPS),
  )
  .describe(
    '1-10 ordered links, executed in order with per-link commits: e.g. [{tool: "create_component", args: {...}, ref_id: "m"}, {tool: "add_component_instance", args: {...}}].',
  );

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

export const chainTool: AgentTool = {
  name: 'chain',
  description:
    'Run 1-10 tool calls as a DECLARED multi-phase chain with per-link commits: each link lands through the normal write path (gate + flush), the manifest records every link (committed + project versions), and a mid-chain fault COMPENSATES (committed links rewound to the pre-chain state, unrun links pending) — an explicit compensated failure, never a pseudo-success. Use $ref:<ref_id> to chain links. Use it for multi-phase greenfield flows (create_component → add_component_instance → set_variant); use batch for single-phase atomic bulks. Whole-file rewrites, reads and nested batch/chain are NOT allowed here.',
  inputSchema: { steps: stepsSchema },
  category: 'meta',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    const store = getDefaultStore();
    const steps = (args.steps as ChainStep[]) ?? [];
    trace.action('agent-tool:chain', { steps: steps.length });

    // A. Pre-chain snapshot for compensation + baseline guard (never blame
    //    the chain for a file that was already broken). Branch map when
    //    branched (compensation rewinds the run's branch, never main).
    const branchId = resolveToolBranch(ctx);
    const branched = isBranchedRun(ctx);
    const before = branched
      ? (projectFS.readBranchFiles(branchId) ?? new Map<string, string>())
      : projectFS.getSnapshot();
    const activePath = resolveToolFile(ctx);
    const baselineInvalid = validateGeneratedCode(readToolFile(ctx, activePath) ?? '') !== null;

    const toolMap = buildToolMap([
      ...PROPERTY_TOOLS,
      ...STRUCTURE_TOOLS,
      ...ACTION_TOOLS,
      extractComponentTool,
      createVariantTool,
      setVariantTool,
      createComponentTool,
    ]);
    const validToolNames = Array.from(toolMap.keys());
    const refIds = new Map<string, string>();
    const results: ChainResultItem[] = [];
    const manifest: ChainLink[] = [];
    const versionOf = (): number | null => {
      try {
        return store.get(projectVersionAtom);
      } catch {
        return null;
      }
    };

    let failure: { step: number; reason: string } | null = null;
    let i = 0;
    for (; i < steps.length; i++) {
      // D-T5: abort finishes the drain, never starts new work.
      if (ctx.signal.aborted) {
        failure = { step: i, reason: 'Aborted mid-chain — committed links compensated.' };
        results.push({ tool: steps[i].tool, ok: false, error: failure.reason });
        manifest.push({ step: i, tool: steps[i].tool, state: 'failed', error: failure.reason, versionBefore: versionOf(), versionAfter: versionOf() });
        trace.action('agent-tool:chain', { link: steps[i].tool, result: 'aborted' });
        break;
      }
      const step = steps[i];
      const versionBefore = versionOf();
      const resolvedArgs = resolveRefs(deepClone(step.args), refIds) as Record<string, unknown>;
      const tool = toolMap.get(step.tool);
      if (!tool) {
        const reason = formatUnknownTool(step.tool, validToolNames);
        failure = { step: i, reason };
        results.push({ tool: step.tool, ok: false, error: 'Unknown tool' });
        manifest.push({ step: i, tool: step.tool, state: 'failed', error: reason, versionBefore, versionAfter: versionOf() });
        trace.action('agent-tool:chain', { link: step.tool, result: 'unknown-tool' });
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
        if (step.ref_id) refIds.set(step.ref_id, nodeId);
        const hint = extractIdHint(resolvedArgs);
        if (hint !== null) refIds.set(hint, nodeId);
      }
      const item: ChainResultItem = { tool: step.tool, ok: !res.isError };
      if (nodeId) item.node_id = nodeId;
      if (res.isError) item.error = text;
      results.push(item);
      if (res.isError) {
        failure = { step: i, reason: text };
        manifest.push({ step: i, tool: step.tool, state: 'failed', ...(nodeId ? { node_id: nodeId } : {}), error: text, versionBefore, versionAfter: versionOf() });
        trace.action('agent-tool:chain', { link: step.tool, result: 'error', error: text });
        break;
      }

      // Per-link queue-level validation (mirror batch): the link succeeded,
      // but did its write leave parseable code? Only against a clean baseline.
      if (!baselineInvalid) {
        const code = readToolFile(ctx, activePath) ?? '';
        const validationErr = validateGeneratedCode(code);
        if (validationErr !== null) {
          item.ok = false;
          item.error = validationErr;
          delete item.node_id;
          failure = { step: i, reason: validationErr };
          manifest.push({ step: i, tool: step.tool, state: 'failed', error: validationErr, versionBefore, versionAfter: versionOf() });
          trace.action('agent-tool:chain', { link: step.tool, result: 'validation-failed', error: validationErr });
          break;
        }
      }
      manifest.push({ step: i, tool: step.tool, state: 'committed', ...(nodeId ? { node_id: nodeId } : {}), versionBefore, versionAfter: versionOf() });
    }

    // B. Mid-chain fault → COMPENSATE. Committed links rewind in reverse
    //    (manifest states committed→compensated, one trace per link); unrun
    //    links are pending with their epoch. Physically a single restore to
    //    the pre-chain snapshot — whole-FS snapshots make sequential restores
    //    observationally identical, with one re-render instead of N.
    if (failure !== null) {
      for (let j = i - 1; j >= 0; j--) {
        if (manifest[j]?.state === 'committed') {
          manifest[j].state = 'compensated';
          trace.action('agent-tool:chain', { link: manifest[j].tool, result: 'compensated' });
        }
      }
      if (branched) {
        // Branch compensation rewinds the branch map (never main).
        const err = restoreBranchSnapshot(branchId, before, { activeFile: activePath, reason: 'chain-compensate' });
        if (err) trace.error('agent-tool:chain', { result: 'compensate-failed', error: err });
      } else {
        restoreSnapshot(before, { activeFile: activePath, reason: 'chain-compensate' });
      }
      for (let j = i + 1; j < steps.length; j++) {
        results.push({ tool: steps[j].tool, ok: false, error: `skipped (chain compensated after link ${failure.step}: "${failure.reason}")` });
        manifest.push({ step: j, tool: steps[j].tool, state: 'pending', error: 'not run — chain compensated', versionBefore: versionOf(), versionAfter: versionOf() });
      }
      trace.action('agent-tool:chain', {
        result: 'compensated', reason: failure.reason, failedStep: failure.step, steps: steps.length,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              chain: 'compensated',
              reason: failure.reason,
              failed_step: failure.step,
              results,
              ref_ids: Object.fromEntries(refIds),
              manifest,
            }),
          },
        ],
        isError: true,
      };
    }

    trace.action('agent-tool:chain', { result: 'ok', steps: steps.length });
    return ok({
      chain: 'ok',
      results,
      ref_ids: Object.fromEntries(refIds),
      manifest,
    });
  },
};
