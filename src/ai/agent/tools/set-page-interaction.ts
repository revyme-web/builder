// src/ai/agent/tools/set-page-interaction.ts
//
// Chantier D — interactive content primitives, tool 2/2: set_page_interaction.
//
// Wires a "Set Variable" trigger onto a node: the node's event handler
// becomes `onClick={() => setOpen(true)}` etc. — the SAME mutation the
// editor's InteractionsTool queues (`addPageInteraction` →
// addPageInteractionInCode in page-interactions-gen.ts). The variable must be
// a declared PAGE variable (set_page_variable), and the target file must be a
// page (templates/components declare variables as function params — a
// Set-Variable handler there would crash on an undefined setter; the editor's
// InteractionsTool gates them too).
//
// Hook ensure: a Set-Variable handler references `setOpen`, whose useState
// pair `syncPageVariableHooks` only emits for variables referenced as a BARE
// identifier (`{open}`, a style binding) — a setter-only reference is enough
// to write the handler but not the hook, which would leave the page crashing
// at click time ("setOpen is not defined"). So after the mutation lands, the
// tool routes the file through modifyProjectFile + ensurePageVariableHookInCode
// (idempotent; also self-heals variables created by other means without a
// hook), and modifyProjectFile's syncImports pass adds the React useState
// import. The variable's hook then shows up in the editor's InteractionsTool
// list (it filters variables by setter presence in the code).

import { z } from 'zod';
import type { AgentTool, AgentToolResult } from '@/ai/agent';
import {
  queueToolMutation,
  flushTool,
  resolveToolFile,
  readToolFile,
  getToolNodes,
  isBranchedRun,
} from '@/ai/agent/workspace';
import { modifyProjectFile } from '@/code/project/modify-file';
import { isLayoutFile, isComponentFilePath } from '@/code/project/file-path-kind';
import { getPageVariables } from '@/code/features/page-variables';
import {
  INTERACTION_TRIGGERS,
  attrForTrigger,
  setterName,
  type InteractionTrigger,
} from '@/code/features/page-interactions';
import { ensurePageVariableHookInCode } from './set-page-variable';
import { trace } from '@/shared/debug-trace';

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

/** Mirror of the editor's trigger option set (page-interactions.ts
 *  INTERACTION_TRIGGERS: click / mouseEnter / mouseLeave). The parity test
 *  asserts this tuple ≡ INTERACTION_TRIGGERS + attrForTrigger mapping. */
export const INTERACTION_TRIGGER_VALUES: readonly InteractionTrigger[] = [
  'click',
  'mouseEnter',
  'mouseLeave',
];

export const setPageInteractionTool: AgentTool = {
  name: 'set_page_interaction',
  description:
    "Attach a click/enter/leave handler that sets a page variable on a node. Inputs: node_id (data-id of the target node), trigger (click/mouseEnter/mouseLeave), variable (name of a declared page variable), value (literal value e.g. true/false/0.5). Example: {node_id:faq-title, trigger:click, variable:faqOpen, value:true}. Errors: variable must exist (create with set_page_variable first), value must match variable type. Does NOT write conditional rendering ({open && ...}) - use apply_file_edit for JSX changes.",
  inputSchema: {
    node_id: z.string().describe('data-id of the node whose event fires the setter'),
    trigger: z.enum(INTERACTION_TRIGGER_VALUES).describe("trigger event: 'click' | 'mouseEnter' | 'mouseLeave'"),
    variable: z.string().describe('the page variable to set (created with set_page_variable), e.g. "open"'),
    value: z
      .string()
      .describe("the literal value to assign, in string form — 'true'/'false' for booleans, '0.5' for numbers, text as-is"),
  },
  category: 'semantic',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    // P8: the hook-ensure below writes through modifyProjectFile (active-map
    // bound, P5 invariant) — refusing BEFORE the queue half runs, so a
    // branched run never lands a hook-less interaction (a flushed
    // addPageInteraction without its useState would crash on click).
    // Whole-file precedent: explicit refusal, never a silent main write.
    if (isBranchedRun(ctx)) {
      return fail(
        `Set-variable interactions target the active branch only (this run is on "${ctx.workspace?.branchId}"). Build with batch/chain of semantic tools, or run unbranched.`,
      );
    }
    const nodeId = args.node_id as string;
    const trigger = args.trigger as InteractionTrigger;
    const varName = args.variable as string;
    const value = args.value as string;

    const activePath = resolveToolFile(ctx);
    if (!activePath) return fail('No active file — set_page is needed first.');
    if (isLayoutFile(activePath) || isComponentFilePath(activePath)) {
      return fail(
        'Set-Variable interactions are PAGE-only. Templates and components declare variables as function props, not useState — a Set-Variable handler there would reference an undefined setter. Switch to a page with set_page first.',
      );
    }
    if (!getToolNodes(ctx).has(nodeId)) {
      return fail(`No node with data-id="${nodeId}" in the active file.`);
    }
    const code = readToolFile(ctx, activePath);
    if (!code) return fail(`Active file "${activePath}" is missing from the project.`);

    const varDef = getPageVariables(code).find((v) => v.name === varName);
    if (!varDef) {
      const declared = getPageVariables(code).map((v) => v.name).join(', ') || '(none)';
      return fail(
        `Page variable "${varName}" is not declared. Create it first with set_page_variable (declared now: ${declared}).`,
      );
    }

    // Literal-kind validation — the generator emits the argument by the
    // variable's type (buildArgumentLiteral); a mismatched string would be
    // silently coerced (boolean: '1' → false). Fail early instead.
    if (varDef.type === 'boolean' && value !== 'true' && value !== 'false') {
      return fail(`variable "${varName}" is a boolean — value must be 'true' or 'false', got "${value}".`);
    }
    if (varDef.type === 'number' && !Number.isFinite(parseFloat(value))) {
      return fail(`variable "${varName}" is a number — value must be a number, got "${value}".`);
    }

    queueToolMutation(ctx, { type: 'addPageInteraction', nodeId, trigger, varName, value });
    flushTool(ctx);

    // Hook ensure + React import (idempotent). modifyProjectFile re-reads the
    // flushed file, applies the transform, runs syncImports, and re-syncs the
    // mutation queue — so the setUp of the duo is complete in one turn.
    const before = readToolFile(ctx, activePath) ?? '';
    const after = modifyProjectFile(activePath, (c) => ensurePageVariableHookInCode(c, varName));
    const hookPresent = (after ?? before).includes(`const [${varName}, ${setterName(varName)}] = useState(`);

    trace.action('agent-tool:set_page_interaction', { nodeId, trigger, varName, value, hookPresent });
    return ok({
      node_id: nodeId,
      trigger,
      variable: varName,
      value,
      handler: `${attrForTrigger(trigger)}={() => ${setterName(varName)}(${value})}`,
      hook: hookPresent ? 'useState present' : 'useState ensure skipped (template/param variable)',
    });
  },
};