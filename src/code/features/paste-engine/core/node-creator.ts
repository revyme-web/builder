// node-creator.ts — Single-function node creation.
//
// Builder version handles desktop/replica/instance branching. Canvas-poc
// has none of that — one mutation per node, the renderer handles viewports.
//
// Two responsibilities:
//   1. Apply style transforms + layout-aware position fixup
//   2. Emit the right mutation (addNode | addCanvasNode) via the queue
//
// Children are created recursively with `styleTransform: 'preserve'` so
// nested abs-in-frame children keep their offsets relative to their parent.

import { generateNodeId } from '@/shared/id-utils';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { trace } from '@/shared/debug-trace';
import type { CanvasNode } from '@/code/parsing/parser';
import type { ClipboardNode, PasteContext, PasteTarget, StyleTransform } from '../types';
import { IdMapper } from './id-mapper';
import { hasLayout } from './target-resolver';
import { buildIdRenamePairs, renameVarStyleValues } from './id-renames';
import { stripDeadFxStyleRefs } from '@/code/generation/instance-fx-gen';
import { stripTranslateTransforms } from '@/shared/position-utils';

const POSITION_KEYS = ['left', 'top', 'right', 'bottom'] as const;

/**
 * Turn a node RELATIVE: drop the pin anchors, the abs-in-frame marker, the
 * `data-pinned` intent — and any `translate(...)` in its transform.
 *
 * The translate is the part that's easy to miss. A percentage-pinned absolute
 * node carries `translate(-50%, -50%)` purely to compensate for `left/top` being
 * its CENTRE; once the node flows in a flex/grid parent those anchors are gone,
 * so the translate has nothing to compensate for and just shoves the element half
 * its own size up and left. Copying a centred absolute frame and pasting it as a
 * flex sibling produced exactly that (live find 2026-07-25).
 *
 * ROTATE / SCALE / SKEW are visual intent and MUST survive —
 * `stripTranslateTransforms` keeps them, and an empty result clears the property.
 */
/** @internal Exported for testing. */
export function makeRelative(out: Record<string, string>): void {
  out.position = 'relative';
  for (const k of POSITION_KEYS) delete out[k];
  delete out.isAbsoluteInFrame;
  if (out.transform !== undefined) {
    const visualOnly = stripTranslateTransforms(out.transform);
    if (visualOnly) out.transform = visualOnly;
    else delete out.transform;
  }
}

/**
 * Ensure an abs-in-frame node keeps at least one anchor per axis, but ONLY add
 * a default `left/top: 0` when that axis is UNANCHORED. A node positioned via
 * `right`/`bottom` must keep that anchor — blindly adding `left: 0` sets BOTH
 * left and right, and with a fixed width `left` wins, so the node snaps to the
 * left/top edge instead of staying exactly where it was copied from (the
 * "pastes at top-left" bug for right-anchored frames).
 */
export function ensureDefaultAnchors(out: Record<string, string>): void {
  if (!out.left && !out.right) out.left = '0px';
  if (!out.top && !out.bottom) out.top = '0px';
}

// ─── Style transforms ────────────────────────────────────────────────────────

function applyStyleTransform(
  styles: Record<string, string>,
  transform: StyleTransform,
): Record<string, string> {
  const out = { ...styles };

  switch (transform) {
    case 'strip-absolute':
      makeRelative(out);
      break;

    case 'force-relative':
      // Convert absolute/fixed to relative UNLESS the user explicitly marked
      // the node as `isAbsoluteInFrame: 'true'` (their intent — keep it absolute).
      if (
        (out.position === 'absolute' || out.position === 'fixed') &&
        out.isAbsoluteInFrame !== 'true'
      ) {
        makeRelative(out);
      }
      break;

    case 'to-canvas':
      out.position = 'absolute';
      break;

    case 'to-absolute-in-frame':
      out.position = 'absolute';
      out.isAbsoluteInFrame = 'true';
      ensureDefaultAnchors(out);
      break;

    case 'preserve':
    case 'none':
    default:
      break;
  }

  return out;
}

// ─── Layout-aware fixup (root-node only) ─────────────────────────────────────

/**
 * After the rule-driven transform, root pasted nodes still need position
 * sanity passes based on the *target parent* — flex parents shouldn't get
 * absolute children, no-layout parents shouldn't get static children, etc.
 */
function fixupPositionForParent(
  styles: Record<string, string>,
  parentNode: CanvasNode | undefined,
  positionOverride?: { x: number; y: number },
): Record<string, string> {
  const out = { ...styles };
  if (!parentNode) return out;

  const parentLayout = hasLayout(parentNode);
  const isAbsOrFixed = out.position === 'absolute' || out.position === 'fixed';
  const wasAbsInFrame = out.isAbsoluteInFrame === 'true';

  if (parentLayout && isAbsOrFixed && !wasAbsInFrame) {
    // Flex/grid parent + absolute child (not explicitly abs-in-frame) → make it flow.
    makeRelative(out);
  } else if (parentLayout && isAbsOrFixed && wasAbsInFrame) {
    // Flex/grid parent BUT child was explicitly abs-in-frame → keep absolute.
    out.position = 'absolute';
    out.isAbsoluteInFrame = 'true';
    ensureDefaultAnchors(out);
  } else if (!parentLayout) {
    // No-layout parent → ALL children must be absolute-in-frame.
    out.position = 'absolute';
    out.isAbsoluteInFrame = 'true';
    delete out.isFakeFixed;

    if (positionOverride) {
      out.left = `${positionOverride.x}px`;
      out.top = `${positionOverride.y}px`;
    } else if (!isAbsOrFixed) {
      // Was static — center in parent.
      const pw = parseFloat(parentNode.styles.width || '0') || 0;
      const ph = parseFloat(parentNode.styles.height || '0') || 0;
      const nw = parseFloat(out.width || '0') || 0;
      const nh = parseFloat(out.height || '0') || 0;
      out.left = pw > 0 && nw > 0 ? `${Math.round((pw - nw) / 2)}px` : '0px';
      out.top = ph > 0 && nh > 0 ? `${Math.round((ph - nh) / 2)}px` : '0px';
    } else {
      ensureDefaultAnchors(out);
    }
  }

  return out;
}

// ─── Canvas-mode dimension fixup ─────────────────────────────────────────────

/**
 * Canvas paste with auto/%/fill width or height collapses (no flex parent
 * to size against). Resolve to px via clipboard's computedDimensions
 * (captured at copy time) before emitting the mutation.
 */
function resolveCanvasDimensions(
  styles: Record<string, string>,
  clipboardNode: ClipboardNode,
): Record<string, string> {
  const out = { ...styles };
  const w = out.width;
  const h = out.height;
  const needsW = !w || w === 'auto' || w.includes('%');
  const needsH = !h || h === 'auto' || h.includes('%');

  if (clipboardNode.computedDimensions) {
    if (needsW && clipboardNode.computedDimensions.width) out.width = clipboardNode.computedDimensions.width;
    if (needsH && clipboardNode.computedDimensions.height) out.height = clipboardNode.computedDimensions.height;
  }

  // Strip viewport-only props that don't belong on canvas-level nodes.
  delete out.isAbsoluteInFrame;
  delete out.isFakeFixed;

  return out;
}

// ─── AddNodeDef construction ─────────────────────────────────────────────────

interface AddNodeDef {
  id: string;
  type: string;
  styles: Record<string, string>;
  attrs?: Record<string, string>;
  name?: string;
  textContent?: string;
  children?: AddNodeDef[];
}

/**
 * Build a recursive AddNodeDef tree from a clipboard root + descendants.
 * Children always get `preserve` style transform (the parent's transform is
 * a one-shot reframing, not a deep mutation).
 */
function buildAddNodeDef(
  root: ClipboardNode,
  allClipboard: ClipboardNode[],
  rootStyles: Record<string, string>,
  newId: string,
  idMapper: IdMapper,
): AddNodeDef {
  const childrenClipboard = allClipboard.filter(n => n.parentId === root.id);
  const childrenDefs: AddNodeDef[] = childrenClipboard.map(child => {
    const childNewId = generateNodeId(child.type);
    idMapper.mapClipboardToNew(child.id, childNewId);
    return buildAddNodeDef(child, allClipboard, child.styles, childNewId, idMapper);
  });

  return {
    id: newId,
    type: root.type,
    styles: stripInternalStyleFlags(rootStyles),
    attrs: root.attrs,
    name: root.name,
    textContent: root.textContent,
    children: childrenDefs.length > 0 ? childrenDefs : undefined,
  };
}

/**
 * Drop paste-internal pseudo-styles that must NEVER reach the JSX. These steer
 * paste's own position logic (`applyStyleTransform`/`fixupPositionForParent`)
 * but are not real CSS — the parser re-derives `isAbsoluteInFrame` from computed
 * styles (PositionTool), so emitting it pollutes the style object (seen leaking
 * into pasted overlays/triggers). `resolveCanvasDimensions` already strips these
 * on the canvas path; this covers the in-parent path + every descendant.
 */
function stripInternalStyleFlags(styles: Record<string, string>): Record<string, string> {
  if (!('isAbsoluteInFrame' in styles) && !('isFakeFixed' in styles)) return styles;
  const out = { ...styles };
  delete out.isAbsoluteInFrame;
  delete out.isFakeFixed;
  return out;
}

/**
 * Recursively strip DEAD instance-fx motion-value style refs for a canvas
 * (module-scope) paste — per node, against that node's OWN id (the fx var
 * prefix is derived from it). Returns a new tree only when something was
 * stripped. See step 5c in `createNode`.
 */
function stripFxStyleRefsDeep(def: AddNodeDef): AddNodeDef {
  // stripDeadFxStyleRefs flags dead refs by setting them to '' (the UPDATE
  // path's remove-property sentinel). This is an ADD def — omit the keys
  // entirely instead of emitting empty style entries.
  const marked = stripDeadFxStyleRefs(def.styles, def.id);
  const deadKeys = Object.keys(marked).filter((k) => marked[k] === '' && def.styles[k] !== '');
  const newChildren = def.children?.map(stripFxStyleRefsDeep);
  const changedKids = newChildren?.some((c, i) => c !== def.children![i]) ?? false;
  if (deadKeys.length === 0 && !changedKids) return def;
  let newStyles = def.styles;
  if (deadKeys.length > 0) {
    newStyles = { ...def.styles };
    for (const k of deadKeys) delete newStyles[k];
    trace.action('paste:strip-dead-fx-refs', { nodeId: def.id, keys: deadKeys });
  }
  return { ...def, styles: newStyles, children: changedKids ? newChildren : def.children };
}

/**
 * Recursively rename `var:<oldPrefix>X` references throughout the tree.
 * Runs AFTER every descendant has been mapped in the idMapper, so any
 * cross-reference between siblings inside the copied subtree is
 * resolvable. Cross-references that point OUTSIDE the copied set stay
 * verbatim — same contract as the effects-injector.
 *
 * Returns a new tree only if any rename was needed; otherwise returns
 * the input. Lets callers identity-check.
 */
function applyVarRenamesToTree(
  def: AddNodeDef,
  idMapper: IdMapper,
): AddNodeDef {
  const flatIdMap = new Map<string, string>();
  for (const [oldId, newIds] of idMapper.getAllMappings()) {
    if (newIds.length > 0) flatIdMap.set(oldId, newIds[0]);
  }
  if (flatIdMap.size === 0) return def;
  const pairs = buildIdRenamePairs(flatIdMap);

  const renameOne = (d: AddNodeDef): AddNodeDef => {
    const newStyles = renameVarStyleValues(d.styles, pairs);
    // Same rename pass on `attrs` — the `var:` sentinel covers `ref={X}`
    // identifier references in addition to style values. Without this,
    // a pasted node whose source had `ref={fooRef}` would carry over
    // `attrs.ref = "var:fooRef"`, which the generator emits as
    // `ref={fooRef}` — but `fooRef` is the SOURCE page's hook name,
    // not the destination's. The injected destination hook is named
    // after the pasted prefix, so the JSX ref reference would be
    // undefined and React would throw "ReferenceError: fooRef is not
    // defined".
    const newAttrs = d.attrs ? renameVarStyleValues(d.attrs, pairs) : d.attrs;
    const newChildren = d.children?.map(renameOne);
    if (newStyles === d.styles && newAttrs === d.attrs && newChildren === d.children) return d;
    return {
      ...d,
      styles: newStyles,
      attrs: newAttrs,
      children: newChildren,
    };
  };
  return renameOne(def);
}

// ─── Public ──────────────────────────────────────────────────────────────────

export interface CreateNodeOptions {
  clipboardNode: ClipboardNode;
  allClipboardNodes: ClipboardNode[];
  target: PasteTarget;
  ctx: PasteContext;
  idMapper: IdMapper;
  styleTransform: StyleTransform;
  /** Override left/top after transforms (used by drop-into-no-layout-frame). */
  positionOverride?: { x: number; y: number };
  /** Canvas-mode position (for parentId === null, applied to root styles). */
  canvasPosition?: { x: number; y: number };
}

/**
 * Create a node (and its descendants). Returns the new node ID.
 * Emits exactly one queueMutation per root — descendants ride along inside
 * AddNodeDef.children which the generator expands into nested JSX.
 */
export function createNode(opts: CreateNodeOptions): string {
  const {
    clipboardNode,
    allClipboardNodes,
    target,
    ctx,
    idMapper,
    styleTransform,
    positionOverride,
    canvasPosition,
  } = opts;

  const newId = generateNodeId(clipboardNode.type);
  const parentNode = target.parentId ? ctx.nodes.get(target.parentId) : undefined;

  // 1. Apply style transform from the rule.
  let styles = applyStyleTransform(clipboardNode.styles, styleTransform);

  // 2. Layout-aware fixup against target parent (root only).
  if (target.parentId !== null) {
    styles = fixupPositionForParent(styles, parentNode, positionOverride);
  }

  // 3. Canvas-mode: no parent — set absolute + clipboard's computed dims + position.
  if (target.parentId === null) {
    styles = resolveCanvasDimensions(styles, clipboardNode);
    styles.position = 'absolute';
    if (canvasPosition) {
      styles.left = `${canvasPosition.x}px`;
      styles.top = `${canvasPosition.y}px`;
      // Canvas nodes anchor via left/top. A source pinned via right/bottom would
      // otherwise keep those anchors and conflict with the freshly-set left/top
      // (any right/bottom-anchored node copied ONTO the canvas — e.g. from a
      // canvas-node selection paste).
      delete styles.right;
      delete styles.bottom;
    }
  }

  // 4. position-override after layout fixup (e.g. at-selected-position siblings).
  if (positionOverride && target.parentId !== null) {
    styles.left = `${positionOverride.x}px`;
    styles.top = `${positionOverride.y}px`;
  }

  // 5. Build the AddNodeDef tree.
  idMapper.mapClipboardToNew(clipboardNode.id, newId);
  const rawDef = buildAddNodeDef(clipboardNode, allClipboardNodes, styles, newId, idMapper);

  // 5b. Rename `var:<oldPrefix>X` style references throughout the
  //     tree to match the freshly-allocated paste IDs. The clipboard
  //     captured these references with the SOURCE page's prefixes; on
  //     paste the effects-injector emits hooks under the NEW prefixes,
  //     so the JSX style values must follow or the binding breaks
  //     (visible symptom: pasted node renders without the scroll-
  //     bound opacity / scale / etc. it had on the source page).
  let def = applyVarRenamesToTree(rawDef, idMapper);

  // 5c. CANVAS paste = module scope (`const canvasNodes`), where NO hooks
  //     exist — a node's instance-fx motion-value style bindings
  //     (`opacity: <cn>FxAppOpacity`, renamed to the NEW prefix in 5b)
  //     would reference undefined identifiers and crash the whole page
  //     module at import time (blank canvas, no error). Strip each
  //     node's OWN dead fx refs across the tree — the `data-instance-fx`
  //     attr stays, so `rehydrateInstanceFx` regenerates the hooks when
  //     the node moves into a viewport (same dormant contract as the
  //     drag-to-canvas path in mutation-queue).
  if (target.parentId === null) {
    def = stripFxStyleRefsDeep(def);
  }

  // 6. Emit the right mutation.
  if (target.parentId === null) {
    trace.action('paste:addCanvasNode', { newId, type: def.type });
    queueMutation({ type: 'addCanvasNode', node: def });
  } else {
    trace.action('paste:addNode', { newId, parentId: target.parentId, insertIndex: target.insertIndex });
    queueMutation({
      type: 'addNode',
      parentId: target.parentId,
      node: def,
      index: target.insertIndex,
    });
  }

  return newId;
}
