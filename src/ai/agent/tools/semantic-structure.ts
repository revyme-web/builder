// src/ai/agent/tools/semantic-structure.ts
//
// Structure (semantic) agent tools. Each tool follows the write path:
// ensureCheckpoint() → build a Mutation → queueToolMutation(ctx) → flushTool(ctx).
// Branch-aware (P8): queue/reads route through ctx.workspace when bound, else
// the exact legacy globals. All tools are category 'semantic' and return
// JSON-serialized text content.
// Never writes ProjectFS directly — the mutation queue owns the write path.
// The CALLER generates node ids via generateNodeId() and passes them into the
// mutation, because the add-node generators do not regenerate ids.

import { z } from 'zod';
import { getDefaultStore } from 'jotai';
import { type Mutation } from '@/code/mutation/mutation-queue';
import { generateNodeId } from '@/shared/id-utils';
import { selectedIdsAtom } from '@/code/stores/store';
import type { CanvasNode } from '@/code/parsing/parser';
import { trace } from '@/shared/debug-trace';
import { buildComponentRegistry, STRUCTURAL_PROPS, type ComponentInfo } from '@/code/components/component-registry';
import { wouldCreateComponentCycle } from '@/code/components/component-cycle';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import type { AgentTool, AgentToolResult, ToolContext } from '@/ai/agent';
import { queueToolMutation, flushTool, getToolNodes, isBranchedRun, branchFsView, resolveToolFile, getToolCode, modifyToolFile } from '@/ai/agent/workspace';
import { resolveInstancePropWrite, writeInstancePropInCode, readInstancePropAttr, type InstancePropWrite } from './instance-prop-write';
import { detectPropAsLinkAttr } from '@/editor/tools/ComponentPropsTool/helpers';
import { parseVariantConfig } from '@/code/variants/variant-config';
import { findJSXDataIdIndex } from '@/code/generation/generator-utils';
import { isComponentFilePath } from '@/code/project/file-path-kind';
import { coerceRecord } from './coerce';
import { formatNodeNotFound } from '../error-format';
import { seedFlowChild, planReorder, isLayoutParent, isOutOfFlow, visualFlowChildren, type OrderWrite } from './flow-placement';

/** Queue the sibling `order` writes a placement needs (see flow-placement.ts). */
export function queueOrderWrites(ctx: ToolContext, writes: readonly OrderWrite[]): void {
  for (const w of writes) queueToolMutation(ctx, { type: 'updateStyles', nodeId: w.id, styles: { order: w.order } });
}

const store = getDefaultStore();

/** Record styles/attrs tolérant (coercition modèle) — voir coerce.ts. */
const recordSchema = z.preprocess(coerceRecord, z.record(z.string(), z.string()));

const stylesSchema = recordSchema.describe(
  'camelCase CSS properties, e.g. { padding: "64px", backgroundColor: "#6366f1" }; pass "" as a value to REMOVE that property',
);
const attrsSchema = recordSchema.describe('HTML attributes as {name: value} strings — src, href, alt, ...');

const NODE_ID_DESCRIBE = 'data-id of the target node';
const PARENT_ID_DESCRIBE = 'data-id of the parent node in the page tree';
const INDEX_DESCRIBE = '0-based position among siblings';

/**
 * Shape of a cloned node's `addNode` payload — exactly what the queue's
 * `addNode` mutation contract can write (mutation-queue.ts). Every CanvasNode
 * field beyond these (bindings, motion, CMS refs, responsibility) cannot be
 * recreated by the add-node generator and is intentionally NOT cloned.
 */
export type ClonedNode = {
  id: string;
  type: string;
  styles: Record<string, string>;
  attrs?: Record<string, string>;
  name?: string;
  textContent?: string;
  children?: ClonedNode[];
};

/**
 * Recursively clone a node and its whole subtree into an `addNode` payload.
 *
 * Every node (including descendants) gets a FRESH `generateNodeId()` — the
 * parser requires unique data-ids, so reusing source ids would collide with
 * the original still in the tree. Styles/attrs are copied as fresh objects.
 *
 * `textContent` is copied as-is, BUT a `textIsLiteral` node's text was
 * wrapped in `{"…"}` on the source: its raw value may contain JSX-unsafe
 * `{` / `<` characters, so it is re-wrapped in a string literal here to keep
 * the cloned JSX parseable (re-parses to the same literal text).
 *
 * Non-cloned CanvasNode fields (safe static drop, see execute's doc):
 *   - `parentId` / `order` / `children[]` — implicit in the addNode parent
 *     + index; descendants are carried as nested `children` defs instead.
 *   - `styleVariables` / `textContentVariable` / `binding` / markups
 *     (CMS/component variable refs, overlay triggers, text overrides,
 *     imported-graphic markup) — the generator cannot recreate the
 *     referenced declarations; the clone keeps the resolved literal values
 *     only. Same static-frozen semantics as copy-paste.
 *   - `motionVariants` / `motionVariantsRef` / `responsive*` — instance /
 *     variant-state wiring the generator cannot rebuild.
 *   - A child id missing from the snapshot (orphan) is skipped — the clone
 *     never fabricates a node the builder cannot render.
 */
export function cloneSubtree(src: CanvasNode, sources: Map<string, CanvasNode>): ClonedNode {
  const children: ClonedNode[] = [];
  for (const childId of src.children ?? []) {
    const child = sources.get(childId);
    if (child) children.push(cloneSubtree(child, sources));
  }
  const textContent = src.textIsLiteral ? `{${JSON.stringify(src.textContent)}}` : src.textContent;
  const clone: ClonedNode = {
    id: generateNodeId('frame'),
    type: src.type,
    styles: { ...src.styles },
    attrs: { ...src.attrs },
    ...(src.name ? { name: src.name } : {}),
    ...(textContent ? { textContent } : {}),
  };
  if (children.length > 0) clone.children = children;
  return clone;
}

/** Total node count of a cloned subtree (for the duplicate trace). */
function countNodes(node: ClonedNode): number {
  return 1 + (node.children ?? []).reduce((sum, c) => sum + countNodes(c), 0);
}

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

/**
 * Attributs RÉSERVÉS que l'éditeur possède — jamais acceptés depuis le modèle
 * sur un nœud EN CRÉATION. `data-id` est l'identité : le tool génère lui-même
 * l'id du nœud, un data-id fourni par le modèle serait ÉCRIT EN DOUBLE par le
 * générateur (l'auto-id + l'attribut) → « Duplicate JSX attribute » → le
 * validateGeneratedCode rejette la page et le batch entier est rollbacké
 * (observé en E2E réel 2026-08-15 : glm-4.7-flash envoyait
 * attrs:{data-id:"agency-section"} et répétait l'erreur). `data-name` suit :
 * le nom est dérivé du paramètre `name` s'il est voulu.
 *
 * `id` (HTML) est traité À PART : le modèle le confond avec l'identité du
 * nœud (le schéma « nommer l'élément » de the reference builder) — il devient donc le
 * data-id du nœud créé (extractNodeIdHint), jamais un attribut HTML.
 */
const RESERVED_CREATE_ATTRS = ['data-id', 'data-name'] as const;

/**
 * Retire les attributs réservés d'un payload add_* et retourne ceux retirés
 * (signalés au modèle dans `ignored_attrs` — l'éditeur reste propriétaire).
 * L'attribut `id` est EXTRACTÉ (il nomme le nœud, cf. resolveCreateId) et
 * retiré des attrs.
 */
function stripReservedAttrs(attrs: Record<string, string>): { attrs: Record<string, string>; ignored: string[]; idHint?: string } {
  const ignored: string[] = [];
  const next: Record<string, string> = { ...attrs };
  let idHint: string | undefined;
  if (typeof next.id === 'string' && next.id !== '') {
    idHint = next.id;
    delete next.id;
  }
  for (const key of RESERVED_CREATE_ATTRS) {
    if (key in next) {
      delete next[key];
      ignored.push(key);
    }
  }
  return { attrs: next, ignored, ...(idHint !== undefined ? { idHint } : {}) };
}

/** Format d'un data-id fourni par le modèle (comme le builder de référence où le modèle nomme
 *  les layers). Unique par nœud — la validation ci-dessous le garantit. */
const MODEL_ID_RE = /^[a-z0-9][a-z0-9-]{0,59}$/i;

/**
 * Résout l'id d'un nœud EN CRÉATION : celui fourni par le modèle (il le
 * référence ensuite directement dans d'autres ops — pas d'indirection $ref,
 * le mode d'échec des modèles flash observé en E2E réel) OU un id généré.
 * Le modèle ne doit jamais réutiliser un id existant : collision → erreur
 * claire (l'oracle rejetterait la page avec « Duplicate data-id »).
 */
function resolveCreateId(requested: unknown, sources: Map<string, CanvasNode>): { id: string } | { error: string } {
  if (requested === undefined || requested === null || requested === '') {
    return { id: generateNodeId('frame') };
  }
  const raw = typeof requested === 'string' ? requested.trim() : '';
  if (raw === '') return { id: generateNodeId('frame') };
  if (!MODEL_ID_RE.test(raw)) {
    return { error: `Invalid data-id "${raw}": use lowercase letters, digits and dashes only (max 60 chars). NEXT ACTION: choose a kebab-case id like "hero-section" and re-issue the call.` };
  }
  if (sources && sources.has(raw)) {
    return { error: `data-id "${raw}" already exists — choose another id.` };
  }
  return { id: raw };
}

export const addNodeTool: AgentTool = {
  name: 'add_node',
  description:
    "Create a new element node inside a parent. Returns the new node's data-id. Optional `id`: choose a stable data-id yourself so later operations can reference it directly (must be unique) — omit it to let the tool generate one.",
  inputSchema: {
    parent_id: z.string().describe(PARENT_ID_DESCRIBE),
    tag: z.string().default('div').describe('HTML tag, e.g. div, section, p'),
    styles: stylesSchema.default({}),
    text: z.string().optional().describe('plain text content, no HTML'),
    attrs: attrsSchema.default({}),
    name: z.string().optional().describe('display name in the page tree'),
    index: z.number().optional().describe(INDEX_DESCRIBE),
    id: z
      .string()
      .optional()
      .describe('stable unique data-id of your choice: lowercase letters, digits and hyphens only, max 60 chars — e.g. "hero-section". IMPORTANT: name it with the element\'s ROLE words (faq-item-1, faq-answer-1, testi-quote-1, pricing-tier-2) — verification and later reads match on these words, generated frame-* ids and role-less names (a1, q2) are invisible to them.'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    const { attrs, ignored, idHint } = stripReservedAttrs((args.attrs as Record<string, string>) ?? {});
    // L'id du nœud : le paramètre `id` prime, puis l'attribut HTML `id`
    // (le modèle nomme ses éléments — schéma the reference builder), sinon génération.
    const resolved = resolveCreateId(args.id ?? idHint, getToolNodes(ctx));
    if ('error' in resolved) return fail(resolved.error);
    const id = resolved.id;
    // A child of a layout needs a position, a no-shrink flex and its place in
    // the `order` sequence — see flow-placement.ts. Filled in, never overridden.
    const nodesNow = getToolNodes(ctx);
    const placed = seedFlowChild(
      (args.styles as Record<string, string>) ?? {},
      nodesNow.get(args.parent_id as string),
      nodesNow,
      typeof args.index === 'number' ? args.index : undefined,
    );
    const node = {
      id,
      type: (args.tag as string) ?? 'div',
      styles: placed.styles,
      attrs,
      ...(args.name ? { name: args.name as string } : {}),
      ...(args.text != null ? { textContent: args.text as string } : {}),
    };
    queueOrderWrites(ctx, placed.siblings);
    queueToolMutation(ctx, {
      type: 'addNode',
      parentId: args.parent_id as string,
      node,
      ...(typeof args.index === 'number' ? { index: args.index } : {}),
    });
    flushTool(ctx);
    return ok({ node_id: id, ...(ignored.length > 0 ? { ignored_attrs: ignored } : {}) });
  },
};

export const addCanvasNodeTool: AgentTool = {
  name: 'add_canvas_node',
  description: 'Create a free-canvas node (not in a viewport tree).',
  inputSchema: {
    tag: z.string().default('div').describe('HTML tag, e.g. div, section, p'),
    styles: stylesSchema.default({}),
    text: z.string().optional().describe('plain text content, no HTML'),
    attrs: attrsSchema.default({}),
    name: z.string().optional().describe('display name in the page tree'),
    id: z
      .string()
      .optional()
      .describe('stable unique data-id of your choice: lowercase letters, digits and hyphens only, max 60 chars — e.g. "hero-section"'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    const { attrs, ignored, idHint } = stripReservedAttrs((args.attrs as Record<string, string>) ?? {});
    const resolved = resolveCreateId(args.id ?? idHint, getToolNodes(ctx));
    if ('error' in resolved) return fail(resolved.error);
    const id = resolved.id;
    const node = {
      id,
      type: (args.tag as string) ?? 'div',
      styles: (args.styles as Record<string, string>) ?? {},
      attrs,
      ...(args.name ? { name: args.name as string } : {}),
      ...(args.text != null ? { textContent: args.text as string } : {}),
    };
    queueToolMutation(ctx, { type: 'addCanvasNode', node });
    flushTool(ctx);
    return ok({ node_id: id, ...(ignored.length > 0 ? { ignored_attrs: ignored } : {}) });
  },
};

export const deleteNodeTool: AgentTool = {
  name: 'delete_node',
  description:
    'Delete a node and its subtree. If the node does not exist, this is a silent no-op: verify the id with get_selection/get_node first.',
  inputSchema: { node_id: z.string().describe(NODE_ID_DESCRIBE) },
  category: 'semantic',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'removeNode', nodeId: args.node_id as string });
    flushTool(ctx);
    return ok({});
  },
};

export const moveNodeTool: AgentTool = {
  name: 'move_node',
  description:
    "Move a node to a NEW parent (to reorder within the same parent use reorder_node). parent_id null = move to free canvas. Optional before_id (sibling data-id) preferred over index — index is the 0-based position among the new parent's children. If the node or parent does not exist, this is a silent no-op: verify ids with get_selection/get_node first.",
  inputSchema: {
    node_id: z.string().describe(NODE_ID_DESCRIBE),
    parent_id: z.string().nullable().describe('target parent data-id, or null for free canvas'),
    index: z.number().optional().describe("0-based position among the new parent's children"),
    before_id: z.string().optional().describe('data-id of a sibling to insert before'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    const m: Mutation = { type: 'move', nodeId: args.node_id as string, newParentId: args.parent_id as string | null };
    if (typeof args.index === 'number') m.index = args.index;
    if (args.before_id) m.insertBeforeId = args.before_id as string;
    queueToolMutation(ctx, m);
    // Arriving in a layout, the node takes a slot in the NEW parent's `order`
    // sequence — the value it carried was its place among its OLD siblings, and
    // kept as-is it collides with one of the new ones.
    const nodesNow = getToolNodes(ctx);
    const moved = nodesNow.get(args.node_id as string);
    const target = args.parent_id ? nodesNow.get(args.parent_id as string) : undefined;
    if (moved && target && isLayoutParent(target) && !isOutOfFlow(moved.styles)) {
      const siblings = visualFlowChildren(target, nodesNow).filter((id) => id !== moved.id);
      const beforeAt = args.before_id ? siblings.indexOf(args.before_id as string) : -1;
      const at = beforeAt >= 0 ? beforeAt : (typeof args.index === 'number' ? args.index : undefined);
      const { order: _old, ...own } = (moved.styles ?? {}) as Record<string, string>;
      const placed = seedFlowChild(own, { ...target, children: siblings }, nodesNow, at);
      queueOrderWrites(ctx, placed.siblings);
      queueToolMutation(ctx, { type: 'updateStyles', nodeId: moved.id, styles: { order: placed.styles.order, flex: placed.styles.flex, position: placed.styles.position } });
    }
    flushTool(ctx);
    return ok({});
  },
};

export const reorderNodeTool: AgentTool = {
  name: 'reorder_node',
  description:
    'Reorder a node within its CURRENT parent by 0-based index. To move a node to a different parent, use move_node. If the node does not exist, this is a silent no-op: verify the id first.',
  inputSchema: {
    node_id: z.string().describe(NODE_ID_DESCRIBE),
    parent_id: z.string().describe(PARENT_ID_DESCRIBE),
    index: z.number().describe(INDEX_DESCRIBE),
  },
  category: 'semantic',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    // In a layout the VISIBLE order is CSS `order`; the JSX position is only
    // the tie-break. Writing the JSX alone replied ok and moved nothing.
    const nodesNow = getToolNodes(ctx);
    const writes = planReorder(nodesNow.get(args.parent_id as string), nodesNow, args.node_id as string, args.index as number);
    queueOrderWrites(ctx, writes);
    queueToolMutation(ctx, {
      type: 'reorder',
      nodeId: args.node_id as string,
      parentId: args.parent_id as string,
      index: args.index as number,
    });
    flushTool(ctx);
    return ok({ reordered: writes.length });
  },
};

export const duplicateNodeTool: AgentTool = {
  name: 'duplicate_node',
  description:
    "Duplicate a node (and its subtree) into a parent (default: same parent). Returns the new node's data-id. The duplicated subtree receives fresh auto-generated data-ids.",
  inputSchema: {
    node_id: z.string().describe(NODE_ID_DESCRIBE),
    parent_id: z.string().optional().describe(PARENT_ID_DESCRIBE),
    index: z.number().optional().describe(INDEX_DESCRIBE),
  },
  category: 'semantic',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    const sources = getToolNodes(ctx);
    const src = sources.get(args.node_id as string);
    if (!src) return fail(formatNodeNotFound(String(args.node_id), sources.keys()));
    const clone = cloneSubtree(src, sources);
    const parentId = (args.parent_id as string | undefined) ?? src.parentId ?? '';
    trace.action('agent:duplicate-node', { srcId: src.id, dstId: clone.id, nodeCount: countNodes(clone) });
    // A copy carries its source's `order` — two children on one slot. It lands
    // right AFTER its source (what a user expects of "duplicate"), or where
    // `index` says, and the siblings behind it move down.
    const target = sources.get(parentId);
    let at = typeof args.index === 'number' ? args.index : undefined;
    if (at === undefined && target && parentId === src.parentId && isLayoutParent(target)) {
      const seen = visualFlowChildren(target, sources).indexOf(src.id);
      if (seen >= 0) at = seen + 1;
    }
    const { order: _srcOrder, ...cloneStyles } = (clone.styles ?? {}) as Record<string, string>;
    const placed = seedFlowChild(cloneStyles, target, sources, at);
    clone.styles = placed.styles;
    queueOrderWrites(ctx, placed.siblings);
    queueToolMutation(ctx, {
      type: 'addNode',
      parentId,
      node: clone,
      ...(typeof args.index === 'number' ? { index: args.index } : {}),
    });
    flushTool(ctx);
    return ok({ node_id: clone.id });
  },
};

// ─── Component instances ────────────────────────────────────────────────────
//
// A component instance is a node whose `type` is the component's PascalCase
// name — `<Hero data-id="…" title="Hello" />`. Its props are plain JSX
// attributes on that tag: the `addNode` generator emits `attrs` verbatim via
// serializeJSXAttr (generator-crud.ts buildNodeJSX), and the parser reads them
// back as `attrs` — so props are written AT ADD TIME via the node's attrs map,
// and later edits go through the `updateHtmlAttrs` mutation (the same path the
// editor's Link/Image/Input tools use).
//
// NOT via `updateInstancePropBase`: that mutation only rewrites the BASE branch
// of a per-viewport/per-locale ternary attr and returns the code UNCHANGED for
// a plain attr (responsive-instance-prop-vars-gen.ts setInstancePropBaseInCode:
// `if (responsive.length === 0) return code`). It is not a plain-prop setter.

/** Serialize one user-supplied prop value to the string form attrs carry. */
function serializePropValue(v: unknown): string {
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/**
 * Filter raw user props against the component's DECLARED props. Structural
 * props (style/ref/children/className/key — STRUCTURAL_PROPS) and undeclared
 * names are dropped (reported in `dropped`); the rest become string attrs.
 */
export function filterDeclaredProps(
  info: ComponentInfo,
  raw: Record<string, unknown>,
): { attrs: Record<string, string>; dropped: string[] } {
  const declared = new Set(info.props.map((p) => p.name));
  const attrs: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (STRUCTURAL_PROPS.has(k)) {
      dropped.push(k);
      continue;
    }
    if (!declared.has(k)) {
      dropped.push(k);
      continue;
    }
    attrs[k] = serializePropValue(v);
  }
  return { attrs, dropped };
}

/** Declared props with no default (REQUIRED) that the user did not supply. */
export function missingRequiredProps(info: ComponentInfo, supplied: Record<string, unknown>): string[] {
  return info.props
    .filter((p) => p.defaultValue === null && !(p.name in supplied))
    .map((p) => p.name);
}

/** Parent id when the caller omits it: the last selected node, else the first root of the page tree.
 *  Branched runs never see the human selection (read.ts get_selection precedent) —
 *  straight to the first root of the branch map. */
function resolveDefaultParentId(ctx?: ToolContext): string | null {
  const nodes = getToolNodes(ctx);
  if (!ctx?.workspace) {
    const selected = store.get(selectedIdsAtom);
    for (let i = selected.length - 1; i >= 0; i--) {
      if (nodes.has(selected[i])) return selected[i];
    }
  }
  for (const [id, node] of nodes) {
    if (!node.parentId || !nodes.has(node.parentId)) return id;
  }
  return null;
}

export const addComponentInstanceTool: AgentTool = {
  name: 'add_component_instance',
  description:
    "Place an instance of an existing project component (e.g. <Hero />) inside a parent — instead of rebuilding it with raw divs. The instance's tag is the component name, its props are written as JSX attributes. Only props DECLARED by the component (read get_component) are applied — structural props (style, ref, children, className, key) and unknown names are dropped and reported. Required props (no default) you omit are listed in missing_required — follow up with set_component_prop. parent_id defaults to the selected element, else the page root. Props example: {title: \"Build\", theme: \"primary\"}.",
  inputSchema: {
    name: z.string().describe('component name as shown in the page tree, e.g. Hero'),
    parent_id: z.string().optional().describe(PARENT_ID_DESCRIBE),
    props: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('props of the component — only declared ones are applied, e.g. {title: "Build", theme: "primary"}'),
    index: z.number().optional().describe(INDEX_DESCRIBE),
  },
  category: 'semantic',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    const name = (args.name as string | undefined)?.trim();
    if (!name) return fail('Missing component name.');
    const info = (isBranchedRun(ctx)
      ? buildComponentRegistry(branchFsView(ctx.workspace!.branchId))
      : buildComponentRegistry(projectFS, store.get(projectVersionAtom))).get(name);
    if (!info) return fail(`No component named "${name}" in the project. Call list_components to see what exists. NEXT ACTION: call list_components (names + paths) or get_component (full prop signature) first, then re-issue with a real component name.`);
    const parentId = (args.parent_id as string | undefined) ?? resolveDefaultParentId(ctx);
    if (!parentId) return fail('No parent to insert into: pass parent_id (the data-id of the target element).');
    // A master must never render itself, directly or through its import
    // chain — the parser recurses and the page goes blank. Same guard as the
    // library drag and the paste engine (components/component-cycle.ts).
    const targetFile = resolveToolFile(ctx);
    if (isComponentFilePath(targetFile) && wouldCreateComponentCycle(info.filePath, targetFile, (p) => getToolCode(ctx, p) || null)) {
      return fail(`Cannot place ${name} inside ${targetFile}: the component would render itself (${info.filePath} is, or imports, this master). Place it on a page or in another component instead.`);
    }
    const rawProps = (args.props as Record<string, unknown> | undefined) ?? {};
    const { attrs: declaredAttrs, dropped } = filterDeclaredProps(info, rawProps);
    const missing = missingRequiredProps(info, rawProps);
    // Typed props (number / toggle / list / transition / formatted text) are
    // written in their declared type after the insert — the same write as
    // set_component_prop — instead of as string attributes (`count="60"` is a
    // string, `open="false"` is truthy). A value of the wrong type is refused
    // per prop and reported, never written as a string.
    const masterCode = getToolCode(ctx, info.filePath) || null;
    const attrs: Record<string, string> = {};
    const typed: Array<{ prop: string; write: InstancePropWrite }> = [];
    const invalid: Array<{ prop: string; error: string }> = [];
    for (const [prop, value] of Object.entries(declaredAttrs)) {
      const resolved = resolveInstancePropWrite({ prop, value, info, linkKind: masterCode ? detectPropAsLinkAttr(prop, masterCode) : null });
      if (!resolved.ok) invalid.push({ prop, error: resolved.error });
      else if (resolved.write.expression) typed.push({ prop, write: resolved.write });
      else attrs[prop] = value;
    }
    const id = generateNodeId('frame');
    // Every newly-inserted node must carry explicit positioning — the oracle
    // bounces position-less nodes (NODE_MISSING_POSITION) and the editor's
    // own drop path writes `position: 'relative'` (canvas/commands.ts). A
    // component instance especially needs it: the master's absolute root
    // leaks through the `...style` spread otherwise. In a layout it also needs
    // its `order` slot and a no-shrink flex (flow-placement.ts).
    const nodesNow = getToolNodes(ctx);
    const placed = seedFlowChild({ position: 'relative' }, nodesNow.get(parentId), nodesNow, typeof args.index === 'number' ? args.index : undefined);
    const node = {
      id,
      type: name,
      styles: placed.styles,
      attrs,
      name,
    };
    queueOrderWrites(ctx, placed.siblings);
    trace.action('agent:add-component-instance', {
      component: name, nodeId: id, parentId,
      propsApplied: Object.keys(attrs).length, dropped: dropped.length, missingRequired: missing.length,
    });
    queueToolMutation(ctx, {
      type: 'addNode',
      parentId,
      node,
      ...(typeof args.index === 'number' ? { index: args.index } : {}),
    });
    flushTool(ctx);
    if (typed.length > 0) {
      modifyToolFile(ctx, targetFile, (code) => typed.reduce(
        (c, t) => writeInstancePropInCode(c, { nodeId: id, componentName: name, prop: t.prop }, t.write),
        code,
      ));
    }
    return ok({
      node_id: id,
      component: name,
      props_applied: [...Object.keys(attrs), ...typed.map((t) => t.prop)],
      dropped_props: dropped,
      ...(invalid.length > 0 ? { invalid_props: invalid } : {}),
      missing_required: missing,
    });
  },
};

export const setComponentPropTool: AgentTool = {
  name: 'set_component_prop',
  description:
    "Set one prop of an existing component instance (the prop on its JSX tag) — the same write as the instance's properties panel: the existing value is replaced IN PLACE whatever its form (string, {expression}, bare boolean), never duplicated. Pass \"\" as value to REMOVE the prop. Only props DECLARED by the component (read get_component for the signature) can be set; structural props (style, ref, children, className, key) are rejected — use set_styles for styles. The value is written in the prop's DECLARED type: a Number prop \"60\" becomes count={60}, a Toggle \"false\" becomes open={false} (never the truthy string \"false\"), a list takes a JSON array, a transition a JSON object, anything else a string. To pass JavaScript — a variable, an array/object literal, a call, a template literal — set expression: true and give the code WITHOUT the outer braces (value \"items.slice(0, 3)\" → items={items.slice(0, 3)}); it is parse-checked first. The reply's `written` shows the exact attribute now in the source. Optional variant applies ONLY when the instance sits INSIDE a component master: it scopes the value to that master's variant (other variants keep theirs; \"\" with a variant removes just that variant's value). Pages have no variants — to choose which variant an instance SHOWS, use show_variant.",
  inputSchema: {
    node_id: z.string().describe(NODE_ID_DESCRIBE),
    component_name: z
      .string()
      .describe('component tag as shown in the page tree — used only to validate the target; does not affect the edit'),
    prop: z.string().describe('prop name as declared by the component'),
    value: z
      .string()
      .describe('the value: text for a string prop, "60" for a number, "true"/"false" for a toggle, JSON for a list/transition; with expression: true, JavaScript source without the outer braces. "" removes the prop (or only the given variant\'s value when variant is set)'),
    expression: z
      .boolean()
      .optional()
      .describe('true = value is a JavaScript expression written as prop={value} (e.g. a variable, array, object, call). Omit for literal values — their type is taken from the prop declaration'),
    variant: z
      .string()
      .optional()
      .describe('ONLY for an instance inside a component master: the master\'s variant name to scope the value to (e.g. "hover"); omit or pass "default" for the base value on all variants'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    ctx.ensureCheckpoint();
    const nodeId = args.node_id as string;
    const componentName = (args.component_name as string) ?? '';
    const prop = (args.prop as string) ?? '';
    const value = (args.value as string) ?? '';
    const expression = args.expression === true;
    const variant = (args.variant as string | undefined)?.trim() || undefined;
    if (STRUCTURAL_PROPS.has(prop)) return fail(`"${prop}" is a structural prop and cannot be set as a component prop. Use set_styles for style, or pass children through add_node into the instance.`);
    if (!prop) return fail('Missing prop name.');
    const registry = isBranchedRun(ctx)
      ? buildComponentRegistry(branchFsView(ctx.workspace!.branchId))
      : buildComponentRegistry(projectFS, store.get(projectVersionAtom));
    const info = registry.get(componentName);
    if (info && !info.props.some((p) => p.name === prop)) {
      const declared = info.props.map((p) => p.name).join(', ') || '(none)';
      return fail(`"${prop}" is not a declared prop of ${componentName}. Declared: ${declared}. NEXT ACTION: call get_component (${componentName}) to read its declared props, then re-issue with one of them.`);
    }
    const host = resolveToolFile(ctx);
    flushTool(ctx);
    const hostCode = getToolCode(ctx, host);
    const target = { nodeId, componentName, prop };
    // The instance must be addressed by its data-id: the tag-name fallback of
    // the instance lookup would otherwise pick the FIRST <Name> in the file.
    if (findJSXDataIdIndex(hostCode, nodeId) === -1) {
      return fail(formatNodeNotFound(nodeId, getToolNodes(ctx).keys()));
    }

    // Variant scoping is a per-variant value INSIDE a component master — the
    // ternary keys on the master's own `initialVariant`. On a page there is no
    // such variable: the old write produced `initialVariant === 'x' ? …` in a
    // page, a ReferenceError the moment it rendered.
    const scoped = variant && variant !== 'default' ? variant : undefined;
    if (scoped) {
      const hostVariants = isComponentFilePath(host) ? parseVariantConfig(hostCode).map((v) => v.name) : [];
      if (!isComponentFilePath(host) || hostVariants.length === 0) {
        return fail(`variant "${scoped}" cannot apply here: ${host} is ${isComponentFilePath(host) ? 'a component without variants' : 'a page'}, and per-variant values exist only inside a component master with variants. Omit variant to set the value; to choose which variant this instance SHOWS, use show_variant.`);
      }
      if (!hostVariants.includes(scoped)) {
        return fail(`"${scoped}" is not a variant of ${host}. Its variants: ${hostVariants.join(', ')}.`);
      }
      if (expression) {
        return fail('A per-variant value must be a literal (text, number or true/false) — an expression cannot be scoped to one variant. Omit variant to set the expression on every variant.');
      }
    }

    let write: InstancePropWrite | null = null;
    if (value !== '') {
      const masterCode = info ? (isBranchedRun(ctx) ? projectFS.readBranchFile(ctx.workspace!.branchId, info.filePath) : projectFS.readFile(info.filePath)) : null;
      const resolved = resolveInstancePropWrite({
        prop, value, expression, info,
        linkKind: masterCode ? detectPropAsLinkAttr(prop, masterCode) : null,
      });
      if (!resolved.ok) return fail(resolved.error);
      write = resolved.write;
    }
    if (scoped && write?.expression && !/^(-?\d+(?:\.\d+)?|true|false)$/.test(write.value)) {
      return fail(`"${prop}" takes a ${write.value.startsWith('[') ? 'list' : 'structured'} value, which cannot be scoped to one variant. Omit variant to set it on every variant.`);
    }

    trace.action('agent:set-component-prop', {
      nodeId, componentName, prop, variant: scoped ?? null, removed: value === '',
      expression: write?.expression ?? null, registryKnown: !!info,
    });
    const defaultSeed = info?.props.find((p) => p.name === prop)?.defaultValue ?? undefined;
    const written = modifyToolFile(ctx, host, (code) => writeInstancePropInCode(code, target, write, { parentVariant: scoped, defaultSeed }));
    if (written === null) return fail(`Could not write ${host} — the editor refused the write (busy or missing file). Retry in a moment.`);

    // Honest reply: read back what the source now holds for this prop.
    const after = readInstancePropAttr(written, target);
    if (write && !scoped && after.text === null) {
      return fail(`The write did not land: no "${prop}" on ${nodeId} in ${host} afterwards. Check node_id (read get_node_tree) and component_name.`);
    }
    return ok({
      node_id: nodeId, component: componentName, prop, variant: scoped ?? null,
      removed: value === '', written: after.text,
    });
  },
};

export const STRUCTURE_TOOLS: AgentTool[] = [
  addNodeTool,
  addCanvasNodeTool,
  deleteNodeTool,
  moveNodeTool,
  reorderNodeTool,
  duplicateNodeTool,
  addComponentInstanceTool,
  setComponentPropTool,
];
