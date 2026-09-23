// src/ai/agent/tools/action-layer-rich.ts
//
// Rich action-layer primitives (N1): motion presets, overlays, component
// variants, CMS binding, form state mapping, page creation. Same contract as
// action-layer.ts: thin wrappers over the SAME write path the UI panels use —
// every field maps to one mutation the real panel emits, nothing else.
//
// Parity sources (each payload below is the panel's literal write):
//   set_motion_preset   → AnimationTool/index.tsx handleAdd (hover/tap/appear/
//                         loop seeds, lines 647-704) + animation-scope-source
//                         getActiveAnimationScope for replica scoping
//   create_overlay      → OverlayTool handleCreate (lines 491-538), incl.
//                         generateOverlayId (line 109)
//   set_variant         → ControlProvider (updateVariantStyle / updateVariantText)
//   bind_cms_list       → CanvasDragOrchestrator CMS drop (bindToCmsCollection)
//   bind_cms_field      → BindButton handleBind (bindField)
//   set_form            → FormStateTool write (setFormStateMapping)
//   create_page         → FileExplorer / menu-builders (createPageFile)
//
// Like action-layer.ts, there are NO imports from src/editor: option enums and
// the two tiny helpers below are duplicated on purpose and pinned by the
// parity test (action-layer-rich.test.ts imports the editor side).

import { z } from 'zod';
import { getDefaultStore } from 'jotai';
import type { AgentTool, AgentToolResult } from '@/ai/agent';
import type { ToolContext } from '../types';
import { parseJSXToNodes } from '@/code/parsing/parser';
import { getEnclosingMapIteratorForNode, getEnclosingMapSourceForNode } from '@/code/generation/map-gen';
import { enclosingFormIdInCode, formStateVar, type FormStateMapping } from '@/code/generation/form-state-gen';
import type { SerScope } from '@/code/generation/generator-motion';
import { resolveScope, type ResolvedScope } from '@/code/animations/animation-scope';
import { getSortedBreakpointWidths, interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { detectHugAxes } from '@/code/components/master-root-sizing';
import { findNodeRect } from '@/canvas/node-ops';
import { DEFAULT_VIEWPORT_WIDTH } from '@/shared/constants';
import { createPageFile, buildNewPageFiles, slugToFilePath } from '@/code/project/active-file-store';
import { stateVarName } from '@/code/generation/overlay-gen';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { buildComponentRegistry } from '@/code/components/component-registry';
import { suggestComponentNames } from './read';
import { addVariant, addInteractionState, addVariantToCode } from '@/code/variants/variant-ops';
import { modifyProjectFile } from '@/code/project/modify-file';
import type { Mutation } from '@/code/mutation/mutation-queue';
import { updateMotionPropInCode, setMotionPropScopedValue } from '@/code/generation/generator-motion-props';
import { setLoopInCode } from '@/code/generation/generator-motion-loop';
import { isComponentFilePath } from '@/code/project/file-path-kind';
import { extractImports, resolveImportPath } from '@/code/components/import-resolver';
import { hasComponentControls } from '@/code/components/controls-parser';
import { parseVariantConfig } from '@/code/variants/variant-config';
import { updateVariantStyleInCode } from '@/code/generation/generator-styles';
import { updateVariantTextInCode } from '@/code/generation/generator-crud';
import {
  queueToolMutation,
  flushTool,
  resolveToolFile,
  resolveToolBranch,
  readToolFile,
  getToolCode,
  getToolNodes,
  toolFileExists,
  listToolPages,
  branchFsView,
  isBranchedRun,
} from '@/ai/agent/workspace';
import { inheritedFlowStyles } from './flow-placement';
import { getCollectionSchema, listCollections } from '@/code/project/cms-ops';

/** The collection slug the `.map()` around `nodeId` iterates — the bare
 *  identifier at the head of the source expression (`blog`, `blog.slice(0, 3)`,
 *  `__applyListConfig(blog, cfg)`), when it names a real collection. */
function collectionSlugForMap(code: string, nodeId: string, itemVar: string): string | null {
  const src = getEnclosingMapSourceForNode(code, nodeId);
  if (!src || src.iterVar !== itemVar) return null;
  const known = new Set(listCollections());
  for (const ident of src.sourceExpr.match(/[A-Za-z_$][\w$]*/g) ?? []) if (known.has(ident)) return ident;
  return null;
}
import { commitBranchFiles } from '@/code/branching/apply';
import { generateNodeId } from '@/shared/id-utils';
import { buildExtractedMaster } from '@/code/generation/extract-component-gen';
import { buildCreatedMaster, type CreateLayoutNode, type CreatePropSpec, type CreateVariantSpec } from '@/code/generation/create-component-gen';
import { analyzeEditability } from '@/code/oracle/extensions/editability';
import { gateTurnFiles, commitTurnFiles, formatBounce, type TurnFile } from '@/code/oracle/gate';
import { checkFile } from '@/code/oracle/check-file';
import { isBlockingModifyViolation } from '@/code/project/modify-file';
import { coerceRecord } from './coerce';
import { activatePageForAgent } from './set-page';
import { trace } from '@/shared/debug-trace';

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

/** Apply one motion mutation to `code` — the queue's own dispatch for these
 *  two kinds, for writes that land in a file other than the active one. */
function applyMotionMutation(code: string, m: Mutation): string {
  if (m.type === 'updateMotionProp') {
    return m.scope !== undefined
      ? setMotionPropScopedValue(code, m.nodeId, m.propName, m.props, m.scope)
      : updateMotionPropInCode(code, m.nodeId, m.propName, m.props);
  }
  if (m.type === 'updateLoop') return setLoopInCode(code, m.nodeId, m.spec);
  return code;
}

// ─── set_variant: master targeting ─────────────────────────────────────────
// A component's variant axis lives in the component MASTER file — the panel's
// variant write path only runs from the master's variant viewport (a page has
// no variant axis of its own; writing per-variant ternaries INTO the page would
// produce UNRESOLVABLE_TERNARY / INSTANCE_INTERNAL_STYLE oracle violations).
// So `set_variant` on a page-side component INSTANCE is redirected into the
// instance's master, using the same generators the panel runs there.

/** The design-component master FILE behind a page-side instance tag:
 *  'CtaButton' → '@/components/CtaButton' → 'components/CtaButton.tsx'.
 *  Existence resolves through the run's workspace (branch map when bound). */
function masterPathForTag(code: string, activePath: string, tag: string, ctx?: ToolContext): string | null {
  const spec = extractImports(code).get(tag);
  if (!spec) return null;
  const resolved = resolveImportPath(spec, activePath);
  if (!resolved) return null;
  return toolFileExists(ctx, resolved) ? resolved : null;
}

/** The node inside the master a variant write targets: the same data-id when
 *  present, else the master ROOT (the first data-id-bearing element). */
function masterTargetNodeId(masterCode: string, instanceId: string): string | null {
  const nodes = parseJSXToNodes(masterCode);
  if (nodes.has(instanceId)) return instanceId;
  for (const node of nodes.values()) {
    if (!node.parentId && !node.isCanvasNode) return node.id;
  }
  return null;
}

/** The variant NAMES a master supports: `variantConfig` entries plus the
 *  target node's `variants={...}` object keys ('default' is always valid). */
function variantNamesOnMaster(masterCode: string, targetNodeId: string): string[] {
  const names = new Set<string>(['default']);
  if (masterCode.includes('variantConfig')) {
    for (const v of parseVariantConfig(masterCode)) names.add(v.name);
  }
  const node = parseJSXToNodes(masterCode).get(targetNodeId);
  if (node?.motionVariants) for (const k of Object.keys(node.motionVariants)) names.add(k);
  return [...names];
}

const NODE_ID_DESCRIBE = 'data-id of the target node';

const recordSchema = z.preprocess(coerceRecord, z.record(z.string(), z.string()));

/** Live code for the run's file — the branch map when bound (committed
 *  branch state; every queue site below flushes before returning, so no
 *  pending-entry staleness), else the queue's current code incl. pending
 *  mutations (same source the panel's generateOverlayId probes). */
function currentCode(ctx?: ToolContext): string {
  try {
    return getToolCode(ctx);
  } catch {
    return '';
  }
}

// ─── set_motion_preset ─────────────────────────────────────────────────────
// Presets are the EXACT seeds of the Animation tool's add-effect dropdown
// (index.tsx handleAdd): hover scale 1.05, tap scale 0.95, appear
// (opacity 0 / y 30 → reveal), loop rotate 360 with its default transition.
// The panel's loop seed is a SPIN, not a pulse — mirror it.
// A replica viewport arg scopes value props exactly like the panel's
// getActiveAnimationScope (resolveScope banded query); desktop/base = no scope.

export const MOTION_PRESET_VALUES = ['appear', 'hover', 'tap', 'loop'] as const;

/** Mirror of TransitionPanel's easing dropdown (MOTION_EASING_OPTIONS); the
 *  'custom' bezier option is excluded — it writes a shorthand the schema
 *  cannot express. */
export const MOTION_EASE_VALUES = [
  'easeOut',
  'easeIn',
  'easeInOut',
  'linear',
  'backOut',
  'backIn',
  'circOut',
  'circIn',
  'anticipate',
] as const;

// ─── appear reveal (parity copy of AnimationTool/appear-utils.ts) ───────────
// The whileInView reveal animates back to the node's AUTHORED style when one
// exists (an aura authored at opacity 0.2 reveals to 0.2), else the neutral
// resting value (1 for opacity/scale, 0 for other transform keys).
const NEUTRAL_KEYS = new Set([
  'opacity', 'x', 'y', 'z', 'rotate', 'rotateX', 'rotateY', 'rotateZ',
  'scale', 'scaleX', 'scaleY', 'scaleZ', 'skew', 'skewX', 'skewY',
]);

export function appearRestingValue(k: string, styles?: Record<string, string>): string {
  const v = styles?.[k];
  if (v != null && v !== '') return String(v);
  if (NEUTRAL_KEYS.has(k) || k.startsWith('scale')) {
    return k === 'opacity' || k.startsWith('scale') ? '1' : '0';
  }
  return '0';
}

export function appearReveal(keys: string[], styles?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(keys.map(k => [k, appearRestingValue(k, styles)]));
}

function nodeStyles(code: string, nodeId: string): Record<string, string> {
  if (!code) return {};
  try {
    return parseJSXToNodes(code).get(nodeId)?.styles ?? {};
  } catch {
    return {};
  }
}

function scopeFor(viewport: number | undefined): ResolvedScope {
  if (viewport == null || viewport === DEFAULT_VIEWPORT_WIDTH) return null;
  return resolveScope({ kind: 'viewports', widths: [viewport] }, getSortedBreakpointWidths());
}

export const setMotionPresetTool: AgentTool = {
  name: 'set_motion_preset',
  description:
    "Add a motion preset to a node — the exact seeds of the Animation tool's add-effect dropdown. effect 'appear': enter on scroll-into-view (opacity 0, y 30 → the node's resting state). 'hover': scale up on hover (default 1.05). 'tap': scale down on press (default 0.95). 'loop': spins continuously (rotate 360, 2s linear, repeat Infinity). Optional viewport (breakpoint width in px) scopes the value props to that replica exactly like the panel's scoped add; omit for base/desktop. transition.duration is seconds; transition.ease is one of the Transition panel's eases. Pass viewport with effect 'hover'/'tap'/'appear'/'loop'.",
  inputSchema: {
    node_id: z.string().describe(NODE_ID_DESCRIBE),
    effect: z.enum(MOTION_PRESET_VALUES).describe("preset: 'appear' | 'hover' | 'tap' | 'loop'"),
    scale: z
      .number()
      .optional()
      .describe("scale target for effect 'hover' (default 1.05) or 'tap' (default 0.95); ignored for other effects"),
    viewport: z
      .number()
      .optional()
      .describe('breakpoint width in px (e.g. 768 for tablet) to scope the effect to that replica, like the panel does; omit for base/desktop'),
    transition: z
      .object({
        duration: z.number().positive().optional().describe('duration in seconds, e.g. 0.3'),
        ease: z.enum(MOTION_EASE_VALUES).optional().describe('easing curve, one of the Transition panel options'),
      })
      .optional()
      .describe("optional timing for the 'loop' preset (default 2s linear) — hover/tap/appear use their panel defaults"),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = args.node_id as string;
    const effect = args.effect as (typeof MOTION_PRESET_VALUES)[number];
    const valueScope = scopeFor(args.viewport as number | undefined);
    // updateLoop's spec takes the serializable scope form — the panel passes
    // getActiveAnimationScope with the same cast (AnimationTool/index.tsx:703).
    const loopScope = valueScope ? [valueScope as SerScope] : undefined;
    const t = args.transition as { duration?: number; ease?: string } | undefined;

    /** The preset as mutations against `code` for `target` — the same seeds
     *  whether they land on the active file or inside a master. */
    const presetMutations = (code: string, target: string): Mutation[] => {
      if (effect === 'hover') {
        return [{ type: 'updateMotionProp', nodeId: target, propName: 'whileHover', props: { scale: String(args.scale ?? 1.05) }, scope: valueScope }];
      }
      if (effect === 'tap') {
        return [{ type: 'updateMotionProp', nodeId: target, propName: 'whileTap', props: { scale: String(args.scale ?? 0.95) }, scope: valueScope }];
      }
      if (effect === 'appear') {
        return [
          { type: 'updateMotionProp', nodeId: target, propName: 'initial', props: { opacity: '0', y: '30' }, scope: valueScope },
          { type: 'updateMotionProp', nodeId: target, propName: 'whileInView', props: appearReveal(['opacity', 'y'], nodeStyles(code, target)) },
          { type: 'updateMotionProp', nodeId: target, propName: 'viewport', props: { once: 'true' } },
        ];
      }
      return [{
        type: 'updateLoop',
        nodeId: target,
        spec: {
          props: { rotate: '360' },
          transition: { duration: t?.duration != null ? String(t.duration) : '2', repeat: 'Infinity', ease: t?.ease ?? 'linear' },
          ...(loopScope ? { scope: loopScope } : {}),
        },
      }];
    };

    // A COMPONENT INSTANCE cannot carry motion props: `motion.<Component>` does
    // not exist and framer-motion ignores whileHover & co. on a plain React
    // component, so the generator skipped them — and this tool replied ok while
    // nothing on the page changed (audit V5; capability suite 2026-09-22). The
    // Animation panel animates an instance by animating its MASTER's root, which
    // every instance renders. Same routing as set_variant.
    const activePath = resolveToolFile(ctx);
    const code = currentCode(ctx);
    const node = getToolNodes(ctx).get(nodeId);
    const isInstance = !!node && /^[A-Z]/.test(node.type) && !node.type.startsWith('motion.') && node.type !== 'MotionLink';
    if (isInstance) {
      const masterPath = masterPathForTag(code, activePath, node.type, ctx);
      if (!masterPath) {
        return fail(`"${nodeId}" is an instance of ${node.type}, and motion cannot be set on an instance — it goes on the component's master, which could not be found (no import of ${node.type} in ${activePath}).`);
      }
      const masterCode = readToolFile(ctx, masterPath);
      if (!masterCode) return fail(`Master ${masterPath} is empty or missing.`);
      if (hasComponentControls(masterCode)) {
        return fail(`${node.type} is a CODE component — its motion lives in its own code (edit ${masterPath} with apply_file_edit); presets apply to design components and plain elements.`);
      }
      const masterNode = masterTargetNodeId(masterCode, nodeId);
      if (!masterNode) return fail(`Master ${masterPath} has no root node to animate.`);
      if (isBranchedRun(ctx)) {
        return fail(`Motion on an instance lands in its master (${masterPath}); on a branch, open the master with set_page and add the preset there.`);
      }
      ctx.ensureCheckpoint();
      const wrote = modifyProjectFile(masterPath, (master) => {
        let next = master;
        for (const m of presetMutations(next, masterNode)) next = applyMotionMutation(next, m);
        return next;
      });
      if (wrote === null) return fail(`Could not write the master file ${masterPath}.`);
      trace.action('agent-tool:set_motion_preset:routed-to-master', { nodeId, masterPath, masterNode, effect });
      return ok({ node_id: nodeId, effect, viewport: args.viewport ?? null, landed_on: { master_path: masterPath, node_id: masterNode }, note: `${node.type} is a component instance — the ${effect} effect was added to its master's root, so every ${node.type} on the site has it.` });
    }

    ctx.ensureCheckpoint();
    for (const m of presetMutations(code, nodeId)) queueToolMutation(ctx, m);
    flushTool(ctx);
    return ok({ node_id: nodeId, effect, viewport: args.viewport ?? null });
  },
};

// ─── create_overlay ────────────────────────────────────────────────────────
// Parity copy of OverlayTool: the overlay is created FROM an existing trigger
// node (the overlay node + runtime are generated by createOverlayInCode); the
// panel's option sets are type: Dropdown/Modal (relative/fixed), trigger
// click/hover and dismiss outside/click/escape. There is no open-delay at
// creation (the panel has none; close delays are a separate close-trigger
// feature). canvasNode false = a real published overlay (canvas roots are an
// editor-only artifact the agent never needs).

export const OVERLAY_TYPE_VALUES = ['relative', 'fixed'] as const;
export const OVERLAY_TRIGGER_VALUES = ['click', 'hover'] as const;
export const OVERLAY_DISMISS_VALUES = ['outside', 'click', 'escape'] as const;

let overlayIdCounter = 0;

/** Same id scheme as OverlayTool.generateOverlayId: `overlay-<trigger>-<n>`,
 *  skipping ids whose element or state variable still exists in the live code
 *  (half-removals count as taken). */
function generateOverlayId(code: string, triggerId: string): string {
  for (let attempt = 0; attempt < 500; attempt++) {
    overlayIdCounter++;
    const id = `overlay-${triggerId}-${overlayIdCounter}`;
    const taken = !!code && (code.includes(`data-id="${id}"`) || code.includes(stateVarName(id)));
    if (!taken) return id;
  }
  overlayIdCounter++;
  return `overlay-${triggerId}-${overlayIdCounter}`;
}

export const createOverlayTool: AgentTool = {
  name: 'create_overlay',
  description:
    "Create an overlay (Dropdown or Modal) OPENED FROM an existing trigger node — the same write as the Overlay tool's + button. type 'relative' is a dropdown anchored to the trigger (default: bottom, center, 10px offset); 'fixed' is a full-screen modal (default backdrop 'rgba(0,0,0,0.5)', escape/outside closes). trigger is how the overlay opens (click or hover); dismiss is how it closes (outside, click, or escape). The overlay node and its runtime are generated — returns the new overlay node id. There is no open delay (the panel has none).",
  inputSchema: {
    node_id: z.string().describe('data-id of the trigger node the overlay opens from'),
    type: z.enum(OVERLAY_TYPE_VALUES).optional().describe("overlay type: 'relative' (dropdown) | 'fixed' (modal), default 'relative'"),
    trigger: z.enum(OVERLAY_TRIGGER_VALUES).optional().describe("how the overlay opens: 'click' (default) | 'hover'"),
    dismiss: z.enum(OVERLAY_DISMISS_VALUES).optional().describe("how it closes: 'outside' (default) | 'click' | 'escape'"),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const triggerId = args.node_id as string;
    if (!getToolNodes(ctx).has(triggerId)) {
      return fail(`No node with data-id="${triggerId}" — create the trigger element first (add_node) or pass an existing node_id.`);
    }
    const overlayId = generateOverlayId(currentCode(ctx), triggerId);
    const overlayConfig = {
      type: (args.type as 'relative' | 'fixed' | undefined) ?? 'relative',
      triggerId,
      side: 'bottom' as const,
      align: 'center' as const,
      offsetX: 0,
      offsetY: 10,
    };
    const triggerConfig = {
      targetId: overlayId,
      trigger: (args.trigger as 'click' | 'hover' | undefined) ?? 'click',
      dismiss: (args.dismiss as 'outside' | 'click' | 'escape' | undefined) ?? 'outside',
    };
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'createOverlay', triggerId, overlayId, overlayConfig, triggerConfig, canvasNode: false });
    flushTool(ctx);
    return ok({ node_id: triggerId, overlay_id: overlayId, type: overlayConfig.type });
  },
};

// ─── set_variant ───────────────────────────────────────────────────────────
// Component-instance variant override — the panel's variant node write path
// (ControlProvider): styles via updateVariantStyle, text via updateVariantText.
// The variant is targeted by NAME (the names come from the component master —
// read it with get_component or read_file). '' removes a style property.
// On a page, node_id is a component INSTANCE and the write is redirected into
// its master file (variants live only in the master — the same restriction the
// panel enforces by gating variant edits on the master's variant viewport).

export const setVariantTool: AgentTool = {
  name: 'set_variant',
  description:
    "PREREQUISITE: the target must ALREADY be a component INSTANCE — if it is a plain page element, convert it FIRST (extract it with extract_component, or into a component file with apply_file_edit, then instantiate it with add_component_instance) and only then call set_variant on the instance. If the variant itself does not exist yet, declare it FIRST with create_variant. Never retry set_variant on a plain element. Set the styles or text of a COMPONENT INSTANCE's variant — the same write as the Styles tool on a non-default variant. variant is the variant NAME (e.g. 'hover', 'dark' — read the master with get_component or read_file). styles are camelCase CSS, '' removes a property. text replaces the variant's text content. At least one of styles or text is required. The write lands in the instance's component MASTER (variants only exist there) — pass the page instance's data-id. " +
    "To style an element INSIDE the component for that variant (a card's title, its notes — \"in the card's dark variant, the title is light\"), also pass `element`: that element's data-id in the master (get_component / read_file lists them); without it the write lands on the component's root.",
  inputSchema: {
    node_id: z.string().describe('data-id of the component instance node'),
    variant: z.string().describe("the variant NAME on the instance's master, e.g. 'hover'"),
    element: z.string().optional().describe("data-id of an element INSIDE the component master to style for this variant (default: the component's root)"),
    styles: recordSchema.optional().describe('camelCase CSS properties to write on that variant; pass "" to REMOVE a property'),
    text: z.string().optional().describe('new text content for that variant'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = args.node_id as string;
    const variant = args.variant as string;
    const styles = args.styles as Record<string, string> | undefined;
    const text = args.text as string | undefined;
    if ((!styles || Object.keys(styles).length === 0) && text === undefined) {
      return fail('set_variant needs at least one of styles or text.');
    }

    const code = getToolCode(ctx);
    const activePath = resolveToolFile(ctx);

    // Which FILE owns the variant axis? Only a component master does. On a
    // page, node_id must be a component INSTANCE and the write is redirected
    // into its master.
    let targetPath = activePath;
    let targetNodeId = nodeId;
    if (!isComponentFilePath(activePath)) {
      const node = code ? parseJSXToNodes(code).get(nodeId) : undefined;
      if (!node) {
        return fail(`No node with data-id="${nodeId}" in the active file.`);
      }
      const isInstance = typeof node.type === 'string' && node.type[0] === node.type[0].toUpperCase();
      if (!isInstance) {
        return fail(
          `"${nodeId}" is a plain element on the page — pages have no variant axis, only a component INSTANCE has one. ` +
            'To make it variant-capable: 1) extract it into a component file with apply_file_edit ' +
            '(create components/<Name>.tsx carrying the node with its data-ids), 2) place an instance on the page ' +
            'with add_component_instance, 3) call set_variant on the instance data-id. ' +
            'Do not retry set_variant on this plain element.',
        );
      }
      const masterPath = masterPathForTag(code, activePath, node.type, ctx);
      if (!masterPath) {
        return fail(`Could not resolve the master of "${node.type}" — it is not imported from a project component file.`);
      }
      const masterCode = readToolFile(ctx, masterPath);
      if (!masterCode) return fail(`Master ${masterPath} is empty or missing.`);
      if (hasComponentControls(masterCode)) {
        return fail(`"${node.type}" is a CODE component (@controls) — its variants are defined in code, not editable here.`);
      }
      // An element INSIDE the master (the panel's "select the card's title,
      // style it on the Dark variant") — the tool could only ever reach the
      // master's ROOT from a page, so a variant that recolours a card's text
      // was not expressible at all (found 2026-09-22 building a dark section).
      const element = typeof args.element === 'string' && args.element.trim() ? args.element.trim() : null;
      if (element) {
        const inner = parseJSXToNodes(masterCode).get(element);
        if (!inner) {
          const ids = [...parseJSXToNodes(masterCode).values()].filter((n) => !n.isCanvasNode).map((n) => n.id);
          return fail(`"${element}" is not an element of ${masterPath}. Its elements: ${ids.join(', ')}.`);
        }
      }
      const masterNode = element ?? masterTargetNodeId(masterCode, nodeId);
      if (!masterNode) {
        return fail(`Master ${masterPath} has no editable root node to host the variant write.`);
      }
      targetPath = masterPath;
      targetNodeId = masterNode;
    }

    // Anti-permissivity: the variant must actually exist on the master.
    const validVariants = variantNamesOnMaster(readToolFile(ctx, targetPath) ?? code, targetNodeId);
    if (!validVariants.includes(variant)) {
      const listed = validVariants.length > 1 ? validVariants.join(', ') : 'none';
      return fail(`"${variant}" is not a variant of the master (${targetPath}). Defined variants: ${listed}.`);
    }

    ctx.ensureCheckpoint();
    if (targetPath === activePath) {
      // Master is the ACTIVE file — the panel-parity write path.
      if (styles && Object.keys(styles).length > 0) {
        queueToolMutation(ctx, { type: 'updateVariantStyle', nodeId: targetNodeId, variantName: variant, styles });
      }
      if (text !== undefined) {
        queueToolMutation(ctx, { type: 'updateVariantText', nodeId: targetNodeId, variantName: variant, text });
      }
      flushTool(ctx);
      return ok({ node_id: nodeId, variant, written: Object.keys(styles ?? {}).length + (text !== undefined ? 1 : 0) });
    }

    //
    // Pre-flight the exact transform through the oracle so a rejection
    // returns the actionable violation codes (the S7-1 self-correction
    // pattern: the model retries on informative errors, stalls on generic
    // ones) instead of a generic failure. modifyProjectFile re-verifies
    // before writing — this never bypasses the gate, it only explains.
    const masterBefore = readToolFile(ctx, targetPath) ?? code;
    let preview = masterBefore;
    if (styles && Object.keys(styles).length > 0) {
      preview = updateVariantStyleInCode(preview, targetNodeId, variant, styles);
    }
    if (text !== undefined) {
      preview = updateVariantTextInCode(preview, targetNodeId, variant, text);
    }
    if (preview !== masterBefore) {
      const blocked = checkFile(preview, { kind: 'component', path: targetPath })
        .filter((v) => isBlockingModifyViolation(v.code));
      if (blocked.length > 0) {
        return fail(
          `Cannot write variant "${variant}" on ${targetPath}: ` +
          blocked.map((v) => `[${v.code}] ${v.message}`).join(' · '),
        );
      }
    }
    // Page-side on a branch: the preview above is pure over branch reads and
    // already passed the same blocking pre-flight, so commit it through the
    // branch twin (same write-time re-verification as modifyProjectFile)
    // instead of the active-map modifyProjectFile below — the page file
    // itself stays untouched on both paths.
    if (isBranchedRun(ctx)) {
      const branchId = resolveToolBranch(ctx);
      const turnFile: TurnFile = { path: targetPath, code: preview, kind: 'component' };
      const written = commitBranchFiles(branchId, [turnFile]);
      if (!written.includes(targetPath)) {
        return fail(`Could not write the variant on the branch master ${targetPath} (oracle re-verification at write time bounced it). Nothing was written — adjust the inputs and call again.`);
      }
      return ok({
        node_id: nodeId,
        variant,
        master_path: targetPath,
        branch: branchId,
        written: Object.keys(styles ?? {}).length + (text !== undefined ? 1 : 0),
      });
    }
    const wrote = modifyProjectFile(targetPath, (master) => {
      let next = master;
      if (styles && Object.keys(styles).length > 0) {
        next = updateVariantStyleInCode(next, targetNodeId, variant, styles);
      }
      if (text !== undefined) {
        next = updateVariantTextInCode(next, targetNodeId, variant, text);
      }
      return next;
    });
    if (wrote === null) {
      return fail(`Could not write the master file ${targetPath}.`);
    }
    return ok({
      node_id: nodeId,
      variant,
      master_path: targetPath,
      written: Object.keys(styles ?? {}).length + (text !== undefined ? 1 : 0),
    });
  },
};

// ─── create_variant ──────────────────────────────────────────────────────────
// The creation half of the variant axis: set_variant switches, create_variant
// declares. Parity with the editor's Add Variant / Add Interaction State
// actions (variant-ops addVariant / addInteractionState over the SAME
// variantConfig + variants-object + connections model) — the master the tool
// produces is exactly what the panels operate, so set_variant and the variant
// viewport work on it with no extra step.
//
// JUDGMENT (when a variant pays — not a default): create a variant when an
// element is destined to SWITCH visual state (hover/disabled/active/selected,
// per-variant content) — i.e. repetition with variation, or an interactive
// state the user will toggle. A single static occurrence stays inline: do NOT
// create variants "just in case".

const VARIANT_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

export const createVariantTool: AgentTool = {
  name: 'create_variant',
  description:
    "Declare a NEW variant on a project component's master (the creation half of set_variant, same action as the editor's Add Variant). Use it when an element must SWITCH visual state: hover/disabled/active/featured states, per-variant content — then drive it with set_variant or connections. Do NOT create variants for a single static occurrence (inline is correct there). component is the component NAME from list_components (e.g. 'CtaButton'); variant is the new variant NAME (e.g. 'featured', 'dark'). source_variant copies an existing variant's values as the starting point (default 'default'). interaction ('hover'|'pressed') instead creates a wired interaction state cascading from interaction_parent (default: source_variant) with the editor's connections auto-wired (chain rule). Variant styles need motion wiring on the master (motion.* elements) to RENDER — the result reports motion_wiring; without it the entry lands but stays visually inert until set_motion_preset runs on the master nodes. Fails if the component is missing, is a code component, or the variant already exists (then use set_variant).",
  inputSchema: {
    component: z.string().describe('component name from list_components, e.g. CtaButton'),
    variant: z.string().describe("new variant name, e.g. 'featured' — created when missing, failed when already defined"),
    source_variant: z.string().optional().describe("variant to copy values from, default 'default'"),
    interaction: z.enum(['hover', 'pressed']).optional().describe("instead of a plain variant, create a wired hover/pressed interaction state (editor connections auto-wired, chain rule)"),
    interaction_parent: z.string().optional().describe('source variant the interaction state cascades from, default: source_variant'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const store = getDefaultStore();
    const component = (args.component as string | undefined)?.trim();
    const variant = (args.variant as string | undefined)?.trim();
    if (!component) return fail('Missing component name.');
    if (!variant) return fail('Missing variant name.');
    if (!VARIANT_NAME_RE.test(variant)) {
      return fail(`Invalid variant name "${variant}" — use letters, digits, '_' or '-', starting with a letter.`);
    }
    // P8: auto-wired interaction states chain cross-file connection writes
    // (variant-ops + connection fan-out, active-map bound) — declare a plain
    // variant on the branch instead, or run unbranched for auto-wiring.
    const interaction = args.interaction as 'hover' | 'pressed' | undefined;
    if (interaction && isBranchedRun(ctx)) {
      return fail(
        `Interaction states auto-wire connections on the active branch only (this run is on "${ctx.workspace?.branchId}"). Declare a plain variant here (omit interaction) and drive it with set_variant, or run unbranched for auto-wired hover/pressed states.`,
      );
    }
    const registry = isBranchedRun(ctx)
      ? buildComponentRegistry(branchFsView(ctx.workspace!.branchId))
      : buildComponentRegistry(projectFS, store.get(projectVersionAtom));
    const info = registry.get(component);
    if (!info) {
      const hit = suggestComponentNames(Array.from(registry.keys()), component);
      return fail(
        hit.length > 0
          ? `No component named "${component}". Did you mean: ${hit.join(', ')}?`
          : `No component named "${component}". The project has ${registry.size} component(s) — call list_components to see them.`,
      );
    }
    const masterCode = readToolFile(ctx, info.filePath);
    if (!masterCode) return fail(`Master ${info.filePath} is empty or missing.`);
    if (hasComponentControls(masterCode)) {
      return fail(`"${component}" is a CODE component (@controls) — its states are defined in code, not creatable here.`);
    }
    // Anti-duplication: creating over an existing variant silently means
    // something else — point at the switcher instead.
    const existing = parseVariantConfig(masterCode).map((v) => v.name);
    if (existing.includes(variant)) {
      return fail(`"${variant}" is already a variant of ${info.filePath} — switch to it with set_variant instead of recreating it.`);
    }

    const source = ((args.source_variant as string | undefined)?.trim() || 'default');
    ctx.ensureCheckpoint();
    if (isBranchedRun(ctx)) {
      // Branch path: the pure declare-variant transform over the branch
      // master, committed through the branch twin (same write-time
      // re-verification as modifyProjectFile). The interaction arm above
      // already refused — only plain declares reach here.
      const branchId = resolveToolBranch(ctx);
      let declared: { code: string };
      try {
        declared = addVariantToCode(masterCode, { name: variant, sourceVariant: source });
      } catch (e) {
        return fail(`Could not create variant "${variant}" on ${info.filePath}: ${e instanceof Error ? e.message : String(e)}.`);
      }
      const turnFile: TurnFile = { path: info.filePath, code: declared.code, kind: 'component' };
      const written = commitBranchFiles(branchId, [turnFile]);
      if (!written.includes(info.filePath)) {
        return fail(`Could not create variant "${variant}" on the branch master ${info.filePath} (oracle re-verification at write time bounced it). Nothing was written — adjust the inputs and call again.`);
      }
      const landed = readToolFile(ctx, info.filePath) ?? '';
      const motionWiring = /<motion\.|variants=\{/.test(landed);
      return ok({
        component,
        variant,
        master_path: info.filePath,
        branch: branchId,
        source_variant: source,
        motion_wiring: motionWiring,
        ...(!motionWiring
          ? { note: 'The variant is declared. Style it with set_variant (node_id = an instance, element = the element inside the master) — each write also wires that element to follow the variant, so the state renders as soon as it has a style; then show it on instances with show_variant.' }
          : {}),
      });
    }
    if (interaction) {
      const parent = ((args.interaction_parent as string | undefined)?.trim() || source);
      const updated = addInteractionState(info.filePath, parent, interaction);
      if (!updated) {
        return fail(`Could not create the ${interaction} state on ${info.filePath} (source variant "${parent}" missing, or the state already exists).`);
      }
      return ok({ component, variant: `${parent}-${interaction}`, master_path: info.filePath, interaction, parent });
    }
    const updated = addVariant(info.filePath, variant, undefined, undefined, source);
    if (!updated) {
      return fail(`Could not create variant "${variant}" on ${info.filePath}.`);
    }
    // Honest boundary (spot S7): the writer declares a missing
    // `initialVariant` itself, so the variant entry is always writable —
    // but the state only RENDERS where motion wiring exists (motion.*
    // elements + variants object). On a plain master the entry lands and
    // lists, yet stays visually inert until motion exists: run
    // set_motion_preset on the master nodes for a live state.
    const landed = readToolFile(ctx, info.filePath) ?? '';
    const motionWiring = /<motion\.|variants=\{/.test(landed);
    return ok({
      component,
      variant,
      master_path: info.filePath,
      source_variant: source,
      motion_wiring: motionWiring,
      ...(!motionWiring
        ? { note: 'The variant is declared. Style it with set_variant (node_id = an instance, element = the element inside the master) — each write also wires that element to follow the variant, so the state renders as soon as it has a style; then show it on instances with show_variant.' }
        : {}),
    });
  },
};

// ─── extract_component ───────────────────────────────────────────────────────
// The human-parity extraction: turn a plain page subtree into a reusable
// component master + an instance in its place — the same outcome as the
// editor's convert-to-component action, without hand-authoring the file.
// The master is GENERATED (texts → props with current content as defaults,
// oracle-canonical shape), never hand-written by the model, so it carries
// the variantConfig + plumbing the panels operate: set_variant and the
// variant viewport work on it with no extra step.
//
// JUDGMENT (same rule as create_variant): extract when the section is
// destined for REPETITION (used twice or more), VARIATION (titles/prices per
// instance via props), or INTERACTIVE STATE (variants later). A single static
// occurrence stays inline.

const EXTRACT_NAME_RE = /^[A-Z][A-Za-z0-9]*$/;

export const extractComponentTool: AgentTool = {
  name: 'extract_component',
  description:
    "Turn a plain page element (and its subtree) into a reusable component: authors components/<Name>.tsx from the live markup (every literal text becomes a prop defaulting to the current content, data-ids kept) and replaces the original with an instance rendering identically with no props. Prefer this over hand-authoring a component file with apply_file_edit (no dialect bounces, variant plumbing included) and over stacking raw divs when a section repeats. Use it when the section will be REUSED (two or more instances), VARIED per instance (titles/prices via props), or given STATES later (create_variant + set_variant). A single static occurrence stays inline — do not extract. node_id is the data-id of the subtree root (not the page root). name is the PascalCase component name (e.g. 'Hero'); fails if the file already exists. The new master passes the same oracle gate as apply_file_edit — violations bounce back to fix.",
  inputSchema: {
    node_id: z.string().describe('data-id of the plain subtree root to extract (not the page root)'),
    name: z.string().describe("PascalCase component name, e.g. 'Hero' — authors components/<Name>.tsx"),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = (args.node_id as string | undefined)?.trim();
    const name = (args.name as string | undefined)?.trim();
    if (!nodeId) return fail('Missing node_id.');
    if (!name) return fail('Missing component name.');
    if (!EXTRACT_NAME_RE.test(name)) {
      return fail(`Invalid component name "${name}" — use PascalCase letters and digits, starting with a capital (e.g. Hero, PricingCard).`);
    }
    const branched = isBranchedRun(ctx);
    const branchId = branched ? resolveToolBranch(ctx) : undefined;
    const activePath = resolveToolFile(ctx);
    const code = getToolCode(ctx);
    if (!code) return fail('No active file content.');
    const nodes = getToolNodes(ctx);
    const node = nodes.get(nodeId);
    if (!node) return fail(`No node with data-id="${nodeId}" in the active file.`);
    if (!node.parentId) return fail('Cannot extract the page root — pick a section inside the page.');
    const masterPath = `components/${name}.tsx`;
    if (toolFileExists(ctx, masterPath)) {
      return fail(`${masterPath} already exists — pick another name, or edit the existing component instead of extracting over it.`);
    }

    // A master is an ARTBOARD with no parent box: a root sized by its parent
    // (width '100%', a Fill flex axis) must become a px value — what Make
    // Component bakes from the canvas measurement (master-root-sizing.ts). A
    // hugging axis stays as it is. Measured when the canvas is live, else the
    // primary viewport's width for a full-width section (auto for height).
    const parentNode = nodes.get(node.parentId);
    const nodeStyles = node.styles ?? {};
    const hug = detectHugAxes(nodeStyles, parentNode?.styles ?? null);
    const rect = findNodeRect(nodeId, getDefaultStore().get(interactingViewportIdAtom));
    const rootSize: Record<string, string> = {};
    const parentSized = (axis: 'width' | 'height') => {
      const v = (nodeStyles[axis] ?? '').trim();
      return /%|vw|vh$/.test(v) || (!hug[axis] && (v === '' || v === 'auto'));
    };
    if (parentSized('width')) rootSize.width = rect ? `${Math.round(rect.width)}px` : `${Math.max(...getSortedBreakpointWidths(), DEFAULT_VIEWPORT_WIDTH)}px`;
    if (parentSized('height')) rootSize.height = rect ? `${Math.round(rect.height)}px` : 'auto';
    const built = buildExtractedMaster(code, nodeId, name, { rootSize });
    if ('error' in built) return fail(built.error);

    // The master is model-derived code (not a human-parity static), so it
    // goes through the SAME oracle gate as apply_file_edit — never around it.
    // A bounce returns the violations: fix the inputs and call again. On a
    // branch the gate judges the branch map (branchFsView base) and the
    // commit lands in the branch map (commitBranchFiles twin).
    const turnFile: TurnFile = { path: masterPath, code: built.masterCode, kind: 'component' };
    const { files, violations } = gateTurnFiles([turnFile], activePath);
    if (violations.length > 0) {
      return { content: [{ type: 'text', text: JSON.stringify(formatBounce(violations)) }], isError: true };
    }
    const written = branchId ? commitBranchFiles(branchId, files) : commitTurnFiles(files);
    // Honest write (Porte 5 / D-T3): never swap an instance onto a master
    // whose commit bounced — report instead of building on a missing file.
    if (!written.includes(files[0].path)) {
      return fail(
        `The master passed the gate but the commit refused it (oracle re-verification at write time). Nothing was written — adjust the inputs and call again.`,
      );
    }

    // Swap in place: instance at the original index (defaults render
    // identically), then remove the original. Props are known from the
    // generator — no registry read, so no staleness window.
    const fresh = getToolNodes(ctx);
    const parent = fresh.get(node.parentId);
    const siblings = parent?.children ?? [];
    const index = siblings.indexOf(nodeId);
    const instanceId = generateNodeId('frame');
    queueToolMutation(ctx, {
      type: 'addNode',
      parentId: node.parentId,
      // The instance takes the ORIGINAL's slot: its position, `order`, flex and
      // insets. A bare `position: relative` dropped it out of the parent's order
      // sequence, so extracting a card both broke the oracle and moved the card.
      node: { id: instanceId, type: name, styles: { ...inheritedFlowStyles(fresh.get(nodeId) ?? node), ...Object.fromEntries(Object.keys(rootSize).map((k) => [k, nodeStyles[k]]).filter(([, v]) => v)) }, attrs: {}, name },
      ...(index >= 0 ? { index } : {}),
    });
    queueToolMutation(ctx, { type: 'removeNode', nodeId });
    flushTool(ctx);
    return ok({
      master: masterPath,
      instance_id: instanceId,
      props: built.props.map((p) => p.name),
      replaced: nodeId,
      ...(branchId ? { branch: branchId } : {}),
    });
  },
};

// ─── create_component ──────────────────────────────────────────────────────
// Greenfield component authoring: declare a master, the compiler authors
// components/<Name>.tsx (page untouched — unlike extract_component which
// converts a live subtree in place). Instantiate afterwards with
// add_component_instance (props are returned, no registry read).
//
// CAP-01 judgment (refusals, never silent): create when the section will be
// REUSED (two or more instances), VARIED per instance (titles/prices via
// props), or given STATES later (variants). A single static occurrence stays
// inline — do not create. `from` models the master on a live subtree you
// already built with divs; `layout` authors from scratch. One source only.

const CREATE_PROP_TYPES = ['string', 'number', 'boolean', 'color', 'image'] as const;

const createLayoutNodeSchema: z.ZodTypeAny = z.lazy(() =>
  z.object({
    tag: z.string(),
    text: z.string().optional(),
    style: z.record(z.string(), z.string()).optional(),
    dataId: z.string().optional(),
    children: z.array(createLayoutNodeSchema).optional(),
  }),
);

export const createComponentTool: AgentTool = {
  name: 'create_component',
  description:
    'Author a reusable component master from a DECLARATION (no code): authors components/<Name>.tsx with variant plumbing, typed props with defaults, literal data-ids and responsive export — then instantiate it with add_component_instance. Use it for GREENFIELD repeats: when the section will be REUSED (two or more instances), VARIED per instance (titles/prices via props), or given STATES later (variants + set_variant). A single static occurrence stays inline — do not create. `from` (a data-id) models the master on a live subtree you already built (its texts bind to props in document order, styles stay as sliced with no style bindings; the page is untouched — unlike extract_component, which converts in place); `layout` (explicit element list) authors from scratch with auto data-ids. Pass exactly one source. Props bind as {prop} in text and whole style values (literals otherwise — no expressions, no ternaries, no className, no imports, no nested component instances). Not batchable — call it alone, then instantiate. The new master passes the same oracle gate as apply_file_edit (violations bounce back to fix); the editability verdict (NATIVE/CUSTOM/…) is surfaced in the result, never silent.',
  inputSchema: {
    name: z.string().describe("PascalCase component name, e.g. 'PricingCard' — authors components/<Name>.tsx"),
    props: z
      .array(z.object({ name: z.string(), type: z.enum(CREATE_PROP_TYPES), default: z.unknown() }))
      .optional()
      .describe('Declared props with literal defaults, e.g. [{name: "title", type: "string", default: "Starter"}] — every text leaf binds one prop in document order (from) or by {prop} refs (layout). Omit for a static master.'),
    variants: z
      .array(z.object({ name: z.string(), label: z.string().optional() }))
      .optional()
      .describe('Extra states beyond the built-in default, e.g. [{name: "open"}] — lowercase-hyphen names; switch later with set_variant.'),
    from: z
      .string()
      .optional()
      .describe('data-id of a live plain subtree to model the master on (page untouched). Exclusive with layout.'),
    layout: z
      .array(createLayoutNodeSchema)
      .optional()
      .describe('Explicit element list for from-scratch authoring: [{tag, text?, style?, dataId?, children?}] — lowercase HTML or motion.* tags, string values only, {prop} refs must be declared. Exclusive with from.'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const name = (args.name as string | undefined)?.trim();
    if (!name) return fail('Missing component name.');
    if (!EXTRACT_NAME_RE.test(name)) {
      return fail(`Invalid component name "${name}" — use PascalCase letters and digits, starting with a capital (e.g. Hero, PricingCard).`);
    }
    const branched = isBranchedRun(ctx);
    const branchId = branched ? resolveToolBranch(ctx) : undefined;
    const activePath = resolveToolFile(ctx);
    const masterPath = `components/${name}.tsx`;
    if (toolFileExists(ctx, masterPath)) {
      return fail(`${masterPath} already exists — pick another name, or edit the existing component (set_variant, set_component_prop) instead of creating over it.`);
    }
    const props = (args.props as CreatePropSpec[] | undefined) ?? [];
    const variants = (args.variants as CreateVariantSpec[] | undefined) ?? undefined;
    const from = (args.from as string | undefined)?.trim() || undefined;
    const layout = (args.layout as CreateLayoutNode[] | undefined) ?? undefined;

    const built = buildCreatedMaster({ name, props, variants, from, layout }, { sourceCode: getToolCode(ctx) });
    if ('error' in built) return fail(built.error);

    // Same oracle gate as apply_file_edit / extract_component — never around
    // it. A bounce returns the violations: fix the inputs and call again.
    // Branch runs judge + commit the branch map (base + commitBranchFiles).
    const turnFile: TurnFile = { path: masterPath, code: built.masterCode, kind: 'component' };
    const { files, violations } = gateTurnFiles([turnFile], activePath);
    if (violations.length > 0) {
      return { content: [{ type: 'text', text: JSON.stringify(formatBounce(violations)) }], isError: true };
    }
    const written = branchId ? commitBranchFiles(branchId, files) : commitTurnFiles(files);
    if (!written.includes(files[0].path)) {
      return fail(
        `The master passed the gate but the commit refused it (oracle re-verification at write time). Nothing was written — adjust the inputs and call again.`,
      );
    }

    // I8': the editability verdict is surfaced at commit — a CUSTOM master is
    // seen before it can harm (warning, not bounce: the gate already judged).
    // Guarded: the analyzer is advisory — it must never fail a committed write.
    let editability: { verdict: string; findings: Array<{ capability: string }> };
    try {
      const report = analyzeEditability(built.masterCode);
      editability = { verdict: report.verdict, findings: report.findings.map((f) => ({ capability: f.capability })) };
    } catch (e) {
      trace.error('agent-tool:create_component', { master: masterPath, editability: 'unavailable', error: e instanceof Error ? e.message : String(e) });
      return ok({
        master: masterPath,
        ...(branchId ? { branch: branchId } : {}),
        props: built.props.map((p) => ({ name: p.name, type: p.type, default: p.defaultLiteral })),
        dataIds: built.dataIds,
        variants: ['default', ...(args.variants as CreateVariantSpec[] | undefined ?? []).map((v) => v.name)],
      });
    }
    const declaredVariants = (args.variants as CreateVariantSpec[] | undefined ?? []).map((v) => v.name);
    const warning =
      editability.verdict === 'CUSTOM' || editability.verdict === 'UNSUPPORTED'
        ? `Editability verdict is ${editability.verdict} (not fully panel-editable): ${editability.findings.map((f) => f.capability).join(', ')}. Prefer native shapes or accept CUSTOM explicitly.`
        : undefined;
    // M2: declared states without motion are visually inert — say so like
    // createVariantTool does (motion_wiring + note), never imply aliveness.
    const motionNote =
      declaredVariants.length > 0 && !built.needsMotion
        ? 'Declared variants carry no motion wiring yet — states switch (set_variant) but nothing animates until motion is added (set_motion_preset).'
        : undefined;
    trace.action('agent-tool:create_component', { master: masterPath, props: built.props.length, editability: editability.verdict });
    return ok({
      master: masterPath,
      ...(branchId ? { branch: branchId } : {}),
      props: built.props.map((p) => ({ name: p.name, type: p.type, default: p.defaultLiteral })),
      dataIds: built.dataIds,
      variants: ['default', ...declaredVariants],
      editability,
      ...(warning ? { warning } : {}),
      ...(motionNote ? { note: motionNote } : {}),
    });
  },
};

// ─── bind_cms_list + bind_cms_field ────────────────────────────────────────
// Collection list binding — the exact payloads of the Insert > CMS drop
// (bindToCmsCollection on the template row) and of BindButton (bindField).
// The template row (node_id) must be inside the container to repeat; the
// container itself does NOT get the mutation.

export const bindCmsListTool: AgentTool = {
  name: 'bind_cms_list',
  description:
    "Bind a CMS collection to a list: wraps the template row node in `collection.map(...)` with the collection import — the exact write of the Insert > CMS panel drop. node_id is the TEMPLATE ROW (the first child of the list container — the single repeated item), NOT the container. collection_slug comes from list_collections (e.g. 'blog'). Afterwards bind fields with bind_cms_field.",
  inputSchema: {
    node_id: z.string().describe('data-id of the template row node (the repeated item inside the list container)'),
    collection_slug: z.string().describe('collection slug from list_collections, e.g. blog'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, {
      type: 'bindToCmsCollection',
      nodeId: args.node_id as string,
      collectionSlug: args.collection_slug as string,
    });
    flushTool(ctx);
    return ok({ node_id: args.node_id, collection_slug: args.collection_slug });
  },
};

export const bindCmsFieldTool: AgentTool = {
  name: 'bind_cms_field',
  description:
    "Bind a CMS FIELD to a property of a node inside a bound collection list — the exact write of the binder buttons on the editor rows. property is 'text' for text content or an attribute/CSS property the row exposes (e.g. 'src', 'href', 'padding'). field_id comes from list_collections. The node must be INSIDE the collection's `.map()` (a bound list) — the item variable is resolved from the code automatically.",
  inputSchema: {
    node_id: z.string().describe('data-id of the node inside the bound list (e.g. the heading row of the template)'),
    field_id: z.string().describe('field id from list_collections, e.g. title'),
    property: z.string().min(1).describe("the property to bind: 'text', or an attribute/CSS property name like 'src' or 'padding'"),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = args.node_id as string;
    const itemVar = getEnclosingMapIteratorForNode(currentCode(ctx), nodeId);
    if (!itemVar) {
      return fail('bind_cms_field targets a node inside a bound collection list — this node is not inside any `.map(`. Bind the collection first (bind_cms_list on the template row).');
    }
    // The field's declared type decides HOW it binds — an image field on a
    // fill becomes `backgroundImage: url(...)`, not a colour slot the browser
    // ignores. The editor's binder button passes it; this tool never did, so
    // every agent image binding emitted dead CSS (audit V2). Resolved from the
    // collection the enclosing `.map()` reads; a field that is not in it is
    // refused here, with the list, rather than bound to nothing.
    const collectionSlug = collectionSlugForMap(currentCode(ctx), nodeId, itemVar);
    const schema = collectionSlug ? getCollectionSchema(collectionSlug) : null;
    const fieldId = args.field_id as string;
    const field = schema?.fields.find((f) => f.id === fieldId);
    if (schema && !field) {
      return fail(`No field "${fieldId}" in collection "${collectionSlug}". Its fields: ${schema.fields.map((f) => `${f.id} (${f.type})`).join(', ')}.`);
    }
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, {
      type: 'bindField',
      nodeId,
      property: args.property as string,
      fieldId,
      itemVar,
      ...(field ? { fieldType: field.type } : {}),
    });
    flushTool(ctx);
    return ok({ node_id: nodeId, field_id: fieldId, property: args.property, item_var: itemVar, ...(field ? { field_type: field.type } : {}) });
  },
};

// ─── set_form ──────────────────────────────────────────────────────────────
// Form lifecycle state mapping — the Form State tool's write on a form's
// submit instance: each lifecycle state (loading/success/error/disabled) maps
// to a VARIANT NAME of the instance master. The form's state variable is
// derived from the enclosing <form> automatically (same derivation as the
// panel: formStateVar(enclosingFormId)).

export const FORM_STATE_VALUES = ['loading', 'success', 'error', 'disabled'] as const;

export const setFormTool: AgentTool = {
  name: 'set_form',
  description:
    "Map a form's lifecycle states to the VARIANTS of its submit button instance — the exact write of the Form State tool. node_id is the form's submit-button INSTANCE (the component instance inside the form, e.g. a FormSubmit). states maps each lifecycle state (loading/success/error/disabled) to a VARIANT NAME of that instance's master; pass '' to UNmap a state. The form's lifecycle variable is derived from the enclosing form automatically.",
  inputSchema: {
    node_id: z.string().describe('data-id of the submit-button component instance INSIDE the form'),
    states: z
      .object({
        loading: z.string().optional().describe("variant name shown while submitting, e.g. 'loading'; '' unmaps"),
        success: z.string().optional().describe("variant name shown on success, e.g. 'success'; '' unmaps"),
        error: z.string().optional().describe("variant name shown on error, e.g. 'error'; '' unmaps"),
        disabled: z.string().optional().describe("variant name shown while disabled, e.g. 'disabled'; '' unmaps"),
      })
      .strict()
      .describe('lifecycle state → variant name mapping; at least one entry required'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = args.node_id as string;
    const states = args.states as Partial<Record<(typeof FORM_STATE_VALUES)[number], string>>;
    if (!states || Object.keys(states).length === 0) {
      return fail('set_form needs at least one state mapping (loading, success, error or disabled).');
    }
    const formId = enclosingFormIdInCode(currentCode(ctx), nodeId);
    if (!formId) {
      return fail('set_form targets the submit-button instance INSIDE a form — this node is not inside any <form>.');
    }
    const mapping: FormStateMapping = {};
    for (const s of FORM_STATE_VALUES) {
      if (states[s] !== undefined) {
        if (!(states[s] as string)) delete mapping[s as keyof FormStateMapping];
        else mapping[s as keyof FormStateMapping] = states[s] as string;
      }
    }
    if (Object.keys(mapping).length === 0) return fail('set_form needs at least one state mapped to a variant name (passing only "" unmaps everything).');
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'setFormStateMapping', nodeId, stateVar: formStateVar(formId), mapping });
    flushTool(ctx);
    return ok({ node_id: nodeId, form_id: formId, states: mapping });
  },
};

// ─── create_page ───────────────────────────────────────────────────────────
// Parity with the File Explorer / + New Page menu (createPageFile): emits the
// canonical page pair (server wrapper + canvas-editable client body), activates
// the route for list_pages. The body ships the app's own empty-root template —
// the same content the human action produces, so no oracle gate is needed;
// custom page content is apply_file_edit's contract (already oracle-gated).
//
// P1 (fiability audit 2026-08-19): the new page is ACTIVATED immediately (the
// same pointer the human flow moves — menuNewPage: flushNow → createPageFile →
// setActiveFilePathAtom). This closes observation A ("create → continue
// building with the semantic tools") — without it, add_node/set_styles after
// create_page wrote into the OLD active page.

export const createPageTool: AgentTool = {
  name: 'create_page',
  description:
    "Create a new page (the same action as the editor's + New Page): a server wrapper + a canvas-editable client body with an empty root. The new page becomes the ACTIVE file, so build on it with the semantic tools (add_node, set_styles, …) right away. name is the page title (a route slug is derived); dir defaults to 'app' (a route group like 'app/blog' nests the route).",
  inputSchema: {
    name: z.string().optional().describe('page title, e.g. About — a unique route slug is derived'),
    dir: z.string().optional().describe("route group dir, default 'app'; e.g. 'app/blog' nests the route under /blog"),
  },
  category: 'semantic',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    if (isBranchedRun(ctx)) {
      // Branch path: mint the same pair into the branch map (slug uniqueness
      // judged against the branch, same helper shape as uniqueRouteSlug),
      // then virtual-switch the run onto it — the set_page precedent, no
      // global nav, the human canvas is untouched. No locale-route sync here
      // (global op): single-locale projects need none; multi-locale projects
      // gain the wrappers when the branch applies through commitTurnFiles.
      const branchId = resolveToolBranch(ctx);
      const baseDir = (args.dir as string | undefined) || 'app';
      const title = (args.name as string | undefined)?.trim();
      const pageName = title || `Page ${listToolPages(ctx).length + 2}`;
      const baseSlug = pageName.toLowerCase().replace(/\s+/g, '-');
      const taken = (s: string) => projectFS.branchFileExists(branchId, slugToFilePath(s));
      let slug = baseSlug;
      if (taken(slug)) {
        let n = 2;
        while (taken(`${baseSlug}-${n}`)) n++;
        slug = `${baseSlug}-${n}`;
      }
      const { serverPath, clientPath, serverCode, clientCode } = buildNewPageFiles(pageName, slug, baseDir);
      if (projectFS.branchFileExists(branchId, serverPath) || projectFS.branchFileExists(branchId, clientPath)) {
        return fail(`Page route "${slug}" already exists on branch "${branchId}" — pick another name.`);
      }
      projectFS.writeBranchFile(branchId, serverPath, serverCode);
      projectFS.writeBranchFile(branchId, clientPath, clientCode);
      trace.action('agent-tool:create_page', { branch: branchId, clientPath, serverPath, pageName });
      const previous = ctx.workspace!.filePath;
      ctx.workspace!.filePath = clientPath;
      return ok({
        path: clientPath,
        route: clientPath.replace(/^app\//, '/').replace(/\/page\.client\.tsx$/, ''),
        previous,
        activated: true,
        branch: branchId,
        note: 'The run now works on this page (workspace switch); the human canvas still shows the active branch — verify with verify_effect or preview the branch.',
      });
    }
    const clientPath = createPageFile(args.name as string | undefined, args.dir as string | undefined);
    const previous = activatePageForAgent(clientPath);
    return ok({
      path: clientPath,
      route: clientPath.replace(/^app\//, '/').replace(/\/page\.client\.tsx$/, ''),
      previous,
      activated: true,
    });
  },
};

export const RICH_ACTION_TOOLS: AgentTool[] = [
  setMotionPresetTool,
  createOverlayTool,
  setVariantTool,
  createVariantTool,
  extractComponentTool,
  createComponentTool,
  bindCmsListTool,
  bindCmsFieldTool,
  setFormTool,
  createPageTool,
];

/**
 * Tools that exist but cannot run inside `batch`.
 *
 * `batch` is atomic: a failure rolls the whole thing back from a ProjectFS
 * snapshot, which only works while every op is a plain queued mutation. These
 * write component FILES, run the oracle gate mid-flight, create pages or
 * rewire CMS bindings — work a snapshot rollback cannot cleanly undo, so a
 * half-applied master could survive the rollback. Derived from the registry,
 * so it cannot drift as tools are added.
 */
export const NON_BATCHABLE_TOOL_NAMES: readonly string[] = RICH_ACTION_TOOLS.map((t) => t.name);

