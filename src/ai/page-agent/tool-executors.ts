// tool-executors.ts — Browser-side executors for the page-agent tool surface.
//
// Each name here matches a schema in tool-schemas.ts. Mutation executors build
// a `Mutation` object and route it through queueMutation + flushNow — the EXACT
// same validated path the human UI drives — so the AI cannot break the
// opinionated file format. Read executors pull from the parsed node cache
// (nodesAtom), projectFS, and preset-ops.
//
// Every executor is wrapped by `executeTool()` in a try/catch that turns a
// thrown error into `{ error: string }` — that becomes the functionResponse
// fed back to Gemini, so the AI sees the failure and can correct itself.

import { getDefaultStore } from 'jotai';
import { nodesAtom } from '@/code/stores/store';
import { activeFilePathAtom, isComponentFilePath } from '@/code/project/active-file-store';
import { queueMutation, flushNow, type Mutation } from '@/code/mutation/mutation-queue';
import { projectFS } from '@/code/project/project-fs';
import { getPresetTokens } from '@/code/project/preset-ops';
import { checkFile } from '@/code/oracle/check-file';
import { isCodeComponentSource } from '@/code/oracle/checks/shared';
import { generateNodeId } from '@/shared/id-utils';
import type { CanvasNode } from '@/code/parsing/parser';
import { addVariant, removeVariant } from '@/code/variants/variant-ops';
import { addConnection, removeConnection, parseConnections } from '@/code/variants/connection-config';
import { parseVariantConfig } from '@/code/variants/variant-config';
import { parseJSX, traverse } from '@/code/parsing/ast-utils';
import { FRAME_TAGS, TEXT_TAGS, CONDITIONAL_LAYOUT_PROPS } from '@/shared/constants';
import { trace } from '@/shared/debug-trace';

const store = getDefaultStore();

// ─── Helpers ────────────────────────────────────────────────────────────────

function getNodes(): Map<string, CanvasNode> {
  return store.get(nodesAtom);
}

/** Throw a clear error if a node id isn't on the current page — gives the AI
 *  a useful functionResponse instead of a cryptic mutation failure. */
function assertNode(nodeId: string): CanvasNode {
  const node = getNodes().get(nodeId);
  if (!node) {
    throw new Error(
      `No node with data-id "${nodeId}" on the current page. Call get_node_tree to see valid ids.`,
    );
  }
  return node;
}

/** Queue a mutation and flush synchronously so the next read tool sees the
 *  updated tree. flushNow() applies the mutation, writes the code, and bumps
 *  the project version — nodesAtom re-derives on the next get. */
function applyMutation(m: Mutation): void {
  queueMutation(m);
  flushNow();
}

/**
 * Convert a JS value (number / boolean / array / string) to the string form
 * that `updateMotionPropInCode`'s value formatter expects.
 *
 * The generator's `isJsxLiteral` check writes the value UNQUOTED into JSX
 * when it can be recognised as a JS literal (numbers, arrays, booleans,
 * Infinity, object literals). Everything else gets single-quoted as a
 * string. So our job here is to serialise typed inputs into a canonical
 * string form the generator can recognise.
 *
 * Examples (input → output → JSX):
 *   0.5            → '0.5'         → `0.5`
 *   Infinity       → 'Infinity'    → `Infinity`
 *   [0, 360]       → '[0, 360]'    → `[0, 360]`
 *   ['#fff','#000']→ '["#fff","#000"]' → `["#fff","#000"]`
 *   true           → 'true'        → `true`
 *   '#ff3366'      → '#ff3366'     → `'#ff3366'` (quoted by generator)
 *   'easeOut'      → 'easeOut'     → `'easeOut'`
 */
function formatMotionValue(value: any): string {
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    // JSON.stringify gives strings double-quotes, numbers/booleans bare —
    // matches what JSX expects inside an array literal.
    const items = value.map(item => {
      if (typeof item === 'number' || typeof item === 'boolean') return String(item);
      if (item === Infinity) return 'Infinity';
      if (item === -Infinity) return '-Infinity';
      return JSON.stringify(typeof item === 'string' ? stripWrappingQuotes(item) : item);
    });
    return `[${items.join(', ')}]`;
  }
  if (typeof value === 'string') return stripWrappingQuotes(value);
  return String(value);
}

/**
 * Guard against a recurring model mistake: the AI intermittently wraps a
 * value in an extra pair of double quotes — `"relative"` instead of
 * `relative`, `"#fff"` instead of `#fff` — which breaks every style /
 * text / motion value it touches (the value ends up as the literal
 * string `"relative"`, invalid CSS). This strips a matched outer pair.
 *
 * Safe by construction: a real CSS value is never itself a `"…"` string
 * — the only exceptions are the `content` / `quotes` properties, which
 * `normalizeStyles` leaves alone.
 */
function stripWrappingQuotes(v: string): string {
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"')
    ? v.slice(1, -1)
    : v;
}

/** Strip the model's bogus outer double-quotes from every value of a
 *  styles object. `content` / `quotes` are skipped — their value IS
 *  legitimately a quoted string. */
function normalizeStyles(styles: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(styles)) {
    out[k] = typeof v === 'string' && k !== 'content' && k !== 'quotes'
      ? stripWrappingQuotes(v)
      : v;
  }
  return out;
}

// ─── Guard: a design-component variant root can't size in '%' ───────────────

/** Sizing props that must be px / auto on a design-component variant ROOT —
 *  it has no sizing parent on the canvas, so a '%' is meaningless and breaks
 *  variant sizing. */
const ROOT_SIZING_PROPS = new Set([
  'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
]);

/** Drop any '%'-valued sizing prop when the target is the ROOT of a design-
 *  component master. The design-component prompt forbids the AI from emitting
 *  these — this is the safety net for when it does anyway. */
function stripRootPercentSizing(nodeId: string, styles: Record<string, string>): Record<string, string> {
  if (!isComponentFilePath(store.get(activeFilePathAtom))) return styles;
  const node = getNodes().get(nodeId);
  const isRoot = !!node && node.parentId == null && !node.isCanvasNode;
  if (!isRoot) return styles;
  let stripped = false;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(styles)) {
    if (ROOT_SIZING_PROPS.has(k) && typeof v === 'string' && v.includes('%')) {
      stripped = true;
      continue;
    }
    out[k] = v;
  }
  if (stripped) trace.action('tool-exec:stripped-root-percent-sizing', { nodeId });
  return out;
}

// ─── edit_file guard: frame-of-spans → text node ────────────────────────────

/** Inline text-formatting tags. A frame whose element-children are ALL of
 *  these — and include at least one <span> — is really a rich-text node the
 *  AI mis-tagged as a container. <a> is excluded on purpose: a row of <a> is
 *  a nav, not a paragraph. */
const TEXT_RUN_TAGS = new Set([
  'span', 'strong', 'em', 'b', 'i', 'u', 's', 'mark', 'sub', 'sup', 'small', 'code', 'br',
]);

/** Base tag word of a JSX element name: 'div' from both `div` and `motion.div`. */
function jsxBaseTag(name: any): string | null {
  if (name?.type === 'JSXIdentifier') return name.name;
  if (name?.type === 'JSXMemberExpression' && name.property?.type === 'JSXIdentifier') {
    return name.property.name;
  }
  return null;
}

/** The JSXIdentifier carrying the tag word — `.property` for `motion.div`,
 *  the name itself for `div`. Splicing this renames the tag and leaves the
 *  `motion.` namespace intact. */
function jsxTagIdentifier(name: any): any {
  if (name?.type === 'JSXIdentifier') return name;
  if (name?.type === 'JSXMemberExpression') return name.property;
  return null;
}

/**
 * Guard for edit_file content: the AI sometimes builds multi-styled text as a
 * FRAME (`<div>`) wrapping a flat list of styled `<span>` runs. The editor
 * only treats a TEXT tag (`<p>`, `<h1>`, …) as an editable rich-text node — a
 * frame-of-spans parses as a plain container, so the text can't be edited or
 * restyled as text.
 *
 * This rewrites any pure frame element whose element-children are ALL inline
 * text runs (and include at least one `<span>`) into a `<p>`. Only the tag
 * word is spliced — `motion.div` → `motion.p`, all other formatting untouched.
 * A child carrying a `data-id` is a real structural node, so such frames are
 * left alone. Parse failure (the AI mid-edit) returns the content unchanged.
 */
export function normalizeTextContainers(content: string): string {
  const ast = parseJSX(content);
  if (!ast) return content;

  // [start, end) offsets of each tag word to overwrite with 'p'.
  const edits: { start: number; end: number }[] = [];

  traverse(ast, {
    JSXElement(path) {
      const el = path.node;
      const baseTag = jsxBaseTag(el.openingElement.name);
      // Pure frame only — skip text tags (incl. blockquote), media, svg.
      if (!baseTag || !FRAME_TAGS.has(baseTag) || TEXT_TAGS.has(baseTag)) return;
      if (!el.closingElement) return;

      const elementKids = el.children.filter((c: any) => c.type === 'JSXElement');
      if (elementKids.length === 0) return;

      let hasSpan = false;
      const allRuns = elementKids.every((c: any) => {
        const childTag = jsxBaseTag(c.openingElement.name);
        if (!childTag || !TEXT_RUN_TAGS.has(childTag)) return false;
        if (childTag === 'span') hasSpan = true;
        // A data-id marks a real structural node, not a text run.
        return !c.openingElement.attributes.some(
          (a: any) => a.type === 'JSXAttribute' && a.name?.name === 'data-id',
        );
      });
      if (!allRuns || !hasSpan) return;

      const openId = jsxTagIdentifier(el.openingElement.name);
      const closeId = jsxTagIdentifier(el.closingElement.name);
      if (
        openId?.start == null || openId.end == null ||
        closeId?.start == null || closeId.end == null
      ) return;
      edits.push({ start: openId.start, end: openId.end });
      edits.push({ start: closeId.start, end: closeId.end });
    },
  });

  if (edits.length === 0) return content;

  // Splice from the end so earlier offsets stay valid.
  edits.sort((a, b) => b.start - a.start);
  let out = content;
  for (const e of edits) out = out.slice(0, e.start) + 'p' + out.slice(e.end);

  trace.action('page-agent:normalize-text-containers', { rewrites: edits.length / 2 });
  return out;
}

/**
 * Apply formatMotionValue to every entry of a motion state, skipping
 * empty / nullish entries. The returned shape is the `Record<string, string>`
 * the `updateMotionProp` mutation expects.
 */
function buildMotionProps(state: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(state ?? {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value === '') continue;
    out[key] = formatMotionValue(value);
  }
  return out;
}

/** Compact serialization of one node for read tools — omits empty fields to
 *  keep the payload (and the AI's token budget) small. */
function serializeNode(node: CanvasNode): Record<string, any> {
  const out: Record<string, any> = { id: node.id, tag: node.type };
  if (node.name) out.name = node.name;
  if (node.textContent) out.text = node.textContent;
  if (node.styles && Object.keys(node.styles).length > 0) out.styles = node.styles;
  if (node.attrs && Object.keys(node.attrs).length > 0) out.attrs = node.attrs;
  return out;
}

// ─── Executor registry ──────────────────────────────────────────────────────

type Executor = (args: any) => any;

const EXECUTORS: Record<string, Executor> = {
  // ── Read tools ────────────────────────────────────────────────────────────

  get_node_tree: () => {
    const nodes = getNodes();
    const build = (id: string): Record<string, any> => {
      const node = nodes.get(id)!;
      const out = serializeNode(node);
      const kids = (node.children ?? []).filter(c => nodes.has(c));
      if (kids.length > 0) out.children = kids.map(build);
      return out;
    };
    const roots = [...nodes.values()].filter(n => !n.parentId || !nodes.has(n.parentId));
    return { activeFile: store.get(activeFilePathAtom), tree: roots.map(r => build(r.id)) };
  },

  find_nodes: (args: { tag?: string; nameContains?: string; textContains?: string; hasStyleProp?: string }) => {
    const nodes = getNodes();
    const tag = args.tag?.toLowerCase();
    const nameSub = args.nameContains?.toLowerCase();
    const textSub = args.textContains?.toLowerCase();
    const styleProp = args.hasStyleProp;
    const matches = [...nodes.values()].filter(n => {
      if (tag && n.type.toLowerCase() !== tag) return false;
      if (nameSub && !(n.name ?? '').toLowerCase().includes(nameSub)) return false;
      if (textSub && !(n.textContent ?? '').toLowerCase().includes(textSub)) return false;
      if (styleProp && !(n.styles && styleProp in n.styles)) return false;
      return true;
    });
    return { count: matches.length, nodes: matches.map(serializeNode) };
  },

  get_node_styles: (args: { nodeId: string }) => {
    const node = assertNode(args.nodeId);
    return {
      id: node.id,
      tag: node.type,
      name: node.name ?? '',
      text: node.textContent ?? '',
      styles: node.styles ?? {},
      attrs: node.attrs ?? {},
    };
  },

  list_files: () => ({ files: projectFS.listFiles().sort() }),

  read_file: (args: { path: string }) => {
    const content = projectFS.readFile(args.path);
    if (content == null) return { error: `File not found: ${args.path}` };
    return { content };
  },

  get_design_tokens: () => ({ tokens: getPresetTokens() }),

  // ── Mutation tools — each wraps a Mutation variant ────────────────────────

  update_node_styles: (args: { nodeId: string; styles: Record<string, string> }) => {
    assertNode(args.nodeId);
    applyMutation({
      type: 'updateStyles',
      nodeId: args.nodeId,
      styles: stripRootPercentSizing(args.nodeId, normalizeStyles(args.styles ?? {})),
    });
    return { success: true, nodeId: args.nodeId };
  },

  update_node_text: (args: { nodeId: string; text: string }) => {
    assertNode(args.nodeId);
    applyMutation({ type: 'updateText', nodeId: args.nodeId, text: stripWrappingQuotes(args.text ?? '') });
    return { success: true, nodeId: args.nodeId };
  },

  add_node: (args: {
    parentId: string;
    nodeType: string;
    styles?: Record<string, string>;
    name?: string;
    textContent?: string;
    attrs?: Record<string, string>;
    index?: number;
  }) => {
    assertNode(args.parentId);
    const id = generateNodeId(args.nodeType || 'node');
    applyMutation({
      type: 'addNode',
      parentId: args.parentId,
      index: args.index,
      node: {
        id,
        type: args.nodeType,
        styles: normalizeStyles(args.styles ?? {}),
        attrs: args.attrs,
        name: args.name,
        textContent: args.textContent != null ? stripWrappingQuotes(args.textContent) : args.textContent,
      },
    });
    return { success: true, newNodeId: id };
  },

  remove_node: (args: { nodeId: string }) => {
    assertNode(args.nodeId);
    applyMutation({ type: 'removeNode', nodeId: args.nodeId });
    return { success: true, removed: args.nodeId };
  },

  move_node: (args: { nodeId: string; newParentId: string; index?: number }) => {
    assertNode(args.nodeId);
    assertNode(args.newParentId);
    applyMutation({ type: 'move', nodeId: args.nodeId, newParentId: args.newParentId, index: args.index });
    return { success: true, nodeId: args.nodeId, newParentId: args.newParentId };
  },

  reorder_node: (args: { nodeId: string; parentId: string; index: number }) => {
    assertNode(args.nodeId);
    assertNode(args.parentId);
    applyMutation({ type: 'reorder', nodeId: args.nodeId, parentId: args.parentId, index: args.index });
    return { success: true, nodeId: args.nodeId, index: args.index };
  },

  rename_node: (args: { nodeId: string; name: string }) => {
    assertNode(args.nodeId);
    applyMutation({ type: 'renameNode', nodeId: args.nodeId, name: args.name });
    return { success: true, nodeId: args.nodeId, name: args.name };
  },

  update_html_attrs: (args: { nodeId: string; attrs: Record<string, string> }) => {
    assertNode(args.nodeId);
    applyMutation({ type: 'updateHtmlAttrs', nodeId: args.nodeId, attrs: args.attrs ?? {} });
    return { success: true, nodeId: args.nodeId };
  },

  change_tag: (args: { nodeId: string; newTag: string }) => {
    assertNode(args.nodeId);
    applyMutation({ type: 'changeTag', nodeId: args.nodeId, newTag: args.newTag });
    return { success: true, nodeId: args.nodeId, newTag: args.newTag };
  },

  // ── Animation tools (typed) ──────────────────────────────────────────────
  // add_appear / add_hover / add_loop accept typed inputs (numbers, arrays,
  // enum strings) and convert them via formatMotionValue into the string
  // map that the underlying `updateMotionProp` mutation expects. The mutation
  // generator (`updateMotionPropInCode`) already knows how to emit numbers,
  // arrays, and booleans as JSX literals — see the widened `isJsxLiteral`
  // check there. CSS-shorthand strings get quoted automatically.
  //
  // Splitting the legacy `set_motion_prop` into three named effects means the
  // schema is fully typed (Gemini sees exactly which properties are valid for
  // an animation state, with their actual types) — eliminating the comma-
  // string keyframes, `repeat: null`, over-quoted colors, and invented
  // properties we used to see in AI output.

  add_appear: (args: {
    nodeId: string;
    from?: Record<string, any>;
    to: Record<string, any>;
    transition?: Record<string, any>;
  }) => {
    assertNode(args.nodeId);
    // `from` is optional — without it, the element animates from its base
    // styles to `to`, which is occasionally what the user wants ("brighten
    // when it scrolls into view" without a starting offset).
    if (args.from && Object.keys(args.from).length > 0) {
      applyMutation({
        type: 'updateMotionProp',
        nodeId: args.nodeId,
        propName: 'initial',
        props: buildMotionProps(args.from),
      });
    }
    applyMutation({
      type: 'updateMotionProp',
      nodeId: args.nodeId,
      propName: 'whileInView',
      props: buildMotionProps(args.to ?? {}),
    });
    if (args.transition && Object.keys(args.transition).length > 0) {
      applyMutation({
        type: 'updateMotionProp',
        nodeId: args.nodeId,
        propName: 'transition',
        props: buildMotionProps(args.transition),
      });
    }
    return { success: true, nodeId: args.nodeId, effect: 'appear' };
  },

  remove_appear: (args: { nodeId: string }) => {
    assertNode(args.nodeId);
    applyMutation({ type: 'removeMotionProp', nodeId: args.nodeId, propName: 'initial' });
    applyMutation({ type: 'removeMotionProp', nodeId: args.nodeId, propName: 'whileInView' });
    // Leave `transition` alone — it's the shared timing config for whichever
    // other effects (hover/loop) remain on the same node. Touching it here
    // would silently break those.
    return { success: true, nodeId: args.nodeId };
  },

  add_hover: (args: {
    nodeId: string;
    to: Record<string, any>;
    transition?: Record<string, any>;
  }) => {
    assertNode(args.nodeId);
    applyMutation({
      type: 'updateMotionProp',
      nodeId: args.nodeId,
      propName: 'whileHover',
      props: buildMotionProps(args.to ?? {}),
    });
    if (args.transition && Object.keys(args.transition).length > 0) {
      applyMutation({
        type: 'updateMotionProp',
        nodeId: args.nodeId,
        propName: 'transition',
        props: buildMotionProps(args.transition),
      });
    }
    return { success: true, nodeId: args.nodeId, effect: 'hover' };
  },

  remove_hover: (args: { nodeId: string }) => {
    assertNode(args.nodeId);
    applyMutation({ type: 'removeMotionProp', nodeId: args.nodeId, propName: 'whileHover' });
    return { success: true, nodeId: args.nodeId };
  },

  add_loop: (args: {
    nodeId: string;
    keyframes: Record<string, any[]>;
    transition?: Record<string, any>;
  }) => {
    assertNode(args.nodeId);
    // Convert each keyframes entry from an actual JS array to its JSX-literal
    // string form. Single-value entries (length 1) are silently dropped —
    // a loop needs at least 2 keyframes to be meaningful.
    const animateProps: Record<string, string> = {};
    for (const [key, value] of Object.entries(args.keyframes ?? {})) {
      if (Array.isArray(value) && value.length >= 2) {
        animateProps[key] = formatMotionValue(value);
      }
    }
    if (Object.keys(animateProps).length === 0) {
      throw new Error('add_loop requires `keyframes` with at least one property containing ≥ 2 values.');
    }
    applyMutation({
      type: 'updateMotionProp',
      nodeId: args.nodeId,
      propName: 'animate',
      props: animateProps,
    });
    // Loop semantics: `repeat: Infinity` is baked in regardless of what the
    // AI sent — the whole point of `add_loop` is "play forever". `repeatType`
    // defaults to "loop" (restart from frame 0); the AI can override to
    // "reverse" or "mirror" via the transition.
    const transitionProps: Record<string, string> = {
      ...buildMotionProps(args.transition ?? {}),
      repeat: 'Infinity',
    };
    if (!transitionProps.repeatType) transitionProps.repeatType = 'loop';
    applyMutation({
      type: 'updateMotionProp',
      nodeId: args.nodeId,
      propName: 'transition',
      props: transitionProps,
    });
    return { success: true, nodeId: args.nodeId, effect: 'loop' };
  },

  remove_loop: (args: { nodeId: string }) => {
    assertNode(args.nodeId);
    applyMutation({ type: 'removeMotionProp', nodeId: args.nodeId, propName: 'animate' });
    // Don't drop `transition` — the node may still have hover or appear that
    // share it. The user can call remove_hover/remove_appear separately if
    // they want a full reset.
    return { success: true, nodeId: args.nodeId };
  },

  add_preset_token: (args: { name: string; value: string; category: string; label?: string }) => {
    applyMutation({
      type: 'addPresetToken',
      token: {
        name: args.name,
        value: args.value,
        category: (args.category as any) ?? 'other',
        label: args.label,
      },
    });
    return { success: true, token: args.name, reference: `var(--${args.name})` };
  },

  update_preset_token: (args: { name: string; value: string }) => {
    applyMutation({ type: 'updatePresetToken', name: args.name, value: args.value });
    return { success: true, token: args.name, value: args.value };
  },

  // ── Design-component tools (variant state machine) ────────────────────────
  // Only meaningful on a component master. add/remove variant + connection go
  // through variant-ops / connection-config (they modifyProjectFile the active
  // file); per-variant style/text go through the mutation queue.

  get_variants: () => {
    const code = projectFS.readFile(store.get(activeFilePathAtom)) ?? '';
    return { variants: parseVariantConfig(code), connections: parseConnections(code) };
  },

  add_variant: (args: { name: string; label?: string }) => {
    if (!args.name) throw new Error('add_variant requires a name');
    const filePath = store.get(activeFilePathAtom);
    // Lay AI-added variants out left-to-right in a ROW (like the manual
    // "add variant" button), not stacked below. The new variant is anchored
    // to the right of the current rightmost one, on the same row; the column
    // step is inferred from the existing spacing, with a default for the
    // first variant added. Without this `addVariant` falls back to stacking
    // each new variant below the last.
    const existing = parseVariantConfig(projectFS.readFile(filePath) ?? '');
    let pos: { x: number; y: number } | undefined;
    if (existing.length > 0) {
      const sorted = [...existing].sort((a, b) => a.x - b.x);
      const rightmost = sorted[sorted.length - 1];
      const step = sorted.length >= 2
        ? rightmost.x - sorted[sorted.length - 2].x
        : 600;
      pos = { x: rightmost.x + (step > 0 ? step : 600), y: rightmost.y };
    }
    const result = addVariant(filePath, args.name, pos, args.label);
    if (!result) return { error: `Could not add variant "${args.name}" — it may already exist.` };
    return { success: true, variant: args.name, variants: result };
  },

  remove_variant: (args: { name: string }) => {
    if (!args.name) throw new Error('remove_variant requires a name');
    const result = removeVariant(store.get(activeFilePathAtom), args.name);
    if (!result) return { error: `Could not remove variant "${args.name}".` };
    return { success: true, removed: args.name };
  },

  add_connection: (args: { from: string; to: string; trigger: string; sourceNode?: string }) => {
    if (!args.from || !args.to || !args.trigger) {
      throw new Error('add_connection requires from, to, and trigger');
    }
    addConnection(
      store.get(activeFilePathAtom),
      args.from,
      args.to,
      args.trigger as any,
      undefined,
      args.sourceNode,
    );
    return { success: true, from: args.from, to: args.to, trigger: args.trigger, sourceNode: args.sourceNode };
  },

  remove_connection: (args: { from: string; to: string }) => {
    if (!args.from || !args.to) throw new Error('remove_connection requires from and to');
    removeConnection(store.get(activeFilePathAtom), args.from, args.to);
    return { success: true, from: args.from, to: args.to };
  },

  set_variant_style: (args: { nodeId: string; variantName: string; styles: Record<string, string> }) => {
    assertNode(args.nodeId);
    if (!args.variantName) throw new Error('set_variant_style requires a variantName');
    const styles = stripRootPercentSizing(args.nodeId, normalizeStyles(args.styles ?? {}));
    // Split layout-affecting props (flexDirection/gap/width/height/…) into inline
    // `style` ternaries instead of the variants object — same routing the editor's
    // manual variant writes use (replica-context). A size/layout value in the
    // variants object VALUE-TWEENS on motion's own clock, out of sync with the
    // children's `layout` FLIP, so a resizing root with an entering/exiting child
    // shoves its siblings. The ternary makes React apply it synchronously so the
    // whole transition is one coordinated layout pass.
    const variantStyles: Record<string, string> = {};
    for (const [prop, value] of Object.entries(styles)) {
      if (CONDITIONAL_LAYOUT_PROPS.has(prop)) {
        applyMutation({ type: 'setConditionalStyle', nodeId: args.nodeId, prop, variantName: args.variantName, value });
      } else {
        variantStyles[prop] = value;
      }
    }
    if (Object.keys(variantStyles).length > 0) {
      applyMutation({ type: 'updateVariantStyle', nodeId: args.nodeId, variantName: args.variantName, styles: variantStyles });
    }
    return { success: true, nodeId: args.nodeId, variantName: args.variantName };
  },

  set_variant_text: (args: { nodeId: string; variantName: string; text: string }) => {
    assertNode(args.nodeId);
    if (!args.variantName) throw new Error('set_variant_text requires a variantName');
    applyMutation({
      type: 'updateVariantText',
      nodeId: args.nodeId,
      variantName: args.variantName,
      text: stripWrappingQuotes(args.text ?? ''),
    });
    return { success: true, nodeId: args.nodeId, variantName: args.variantName };
  },

  // ── Escape hatch ──────────────────────────────────────────────────────────

  edit_file: (args: { path: string; content: string }) => {
    if (!args.path) throw new Error('edit_file requires a path');
    const raw = args.content ?? '';
    // Guard: AI sometimes builds multi-styled text as <div><span>…</span></div>.
    // Only JSX files can carry it — .css / .ts skip the parse.
    const content = /\.(tsx|jsx)$/.test(args.path) ? normalizeTextContainers(raw) : raw;
    // ORACLE FENCE (2026-08-11): this executor is a dormant whole-file escape
    // hatch with no UI caller — but it stays exported and one rewiring away
    // from being an ungated writer again. Builder-dialect files (pages,
    // templates, components) must pass the same checkFile the submit gate
    // runs; everything else (css, config, plugin scratch) stays free.
    const isPage = /(^|\/)page(\.client)?\.tsx$/.test(args.path);
    const isTemplate = /LayoutClient\.tsx$/.test(args.path);
    const isComponent = /^components\/[A-Za-z0-9_]+\.tsx$/.test(args.path);
    if (isPage || isTemplate || isComponent) {
      const kind = isTemplate ? 'template' as const
        : isComponent ? (isCodeComponentSource(content) ? 'code-component' as const : 'component' as const)
        : 'page' as const;
      const vs = checkFile(content, { kind, path: args.path });
      if (vs.length > 0) {
        throw new Error(
          `edit_file: ${args.path} fails ${vs.length} builder check(s) — the content would not resolve in the editor. ` +
          vs.slice(0, 3).map((x) => `[${x.code}] ${x.message.slice(0, 160)}`).join(' | '),
        );
      }
    }
    applyMutation({ type: 'writeFile', filePath: args.path, content });
    return { success: true, path: args.path, bytes: content.length };
  },
};

// ─── Public dispatch ────────────────────────────────────────────────────────

export interface ToolResult {
  /** The result object fed back to Gemini as the functionResponse. */
  response: Record<string, any>;
  /** True when the executor threw — surfaced to the UI tool log. */
  isError: boolean;
}

/** Names of all registered tools — useful for validation/tests. */
export const REGISTERED_TOOLS = Object.keys(EXECUTORS);

/**
 * Execute one tool call against the real mutation layer. Never throws — a
 * thrown error becomes `{ error }` so the agentic loop can feed it back to
 * the model and let it self-correct.
 */
export function executeTool(name: string, args: any): ToolResult {
  trace.action('page-agent:tool-call', { name, args });
  const executor = EXECUTORS[name];
  if (!executor) {
    trace.error('page-agent:unknown-tool', { name });
    return { response: { error: `Unknown tool: ${name}` }, isError: true };
  }
  try {
    const response = executor(args ?? {}) ?? { success: true };
    const isError = 'error' in response;
    trace.action('page-agent:tool-result', { name, isError, response });
    return { response, isError };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    trace.error('page-agent:tool-error', { name, message });
    return { response: { error: message }, isError: true };
  }
}
