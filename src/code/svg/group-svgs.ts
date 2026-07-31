// group-svgs.ts — Wrap multiple selected `<svg>` elements into a single
// composite SVG ("Group" / Cmd+G). Mirrors the reference "Group → Vector Set"
// gesture: pick N positioned SVGs that share a parent, compute the union
// bounding box, build ONE wrapping `<svg>` at that bbox, and nest each
// original SVG inside as a child `<svg x y width height viewBox>` so the
// original coordinate spaces stay intact (no need to rewrite path-d
// coordinates per shape).
//
// Why nested SVG instead of `<g>` + `transform="translate()"` like the
// the reference example: each input SVG already declares its own `viewBox` +
// `preserveAspectRatio` so the inner shapes are interpreted in that
// local coord system. Switching to `<g transform>` would require parsing
// every path/rect/etc. and rewriting absolute coords — far more code,
// and it loses the per-shape preserveAspectRatio. Nested-SVG produces
// pixel-identical output with one wrapping shell per input.
//
// All work happens through `modifyProjectFile` so the mutation queue +
// project-fs stay coherent. The new SVG gets a fresh node id; the parser
// re-runs and the canvas selects/renders it. No DOM access.

import { modifyProjectFile } from '../project/modify-file';
import { generateNodeId } from '@/shared/id-utils';
import { trace } from '@/shared/debug-trace';
import type { CanvasNode } from '../parsing/parser';

export interface BoundingBox { left: number; top: number; width: number; height: number }

interface SvgSourcePart {
  /** Original node id (for trace + range matching). */
  nodeId: string;
  /** Absolute start/end indices of the `<svg ...>...</svg>` block in code. */
  start: number;
  end: number;
  /** The full source slice. */
  source: string;
  /** Position from the source style attr (px). Falls back to node styles. */
  bbox: BoundingBox;
  /** viewBox attr; empty when absent. */
  viewBox: string;
  /** preserveAspectRatio attr; empty when absent. */
  preserveAspectRatio: string;
  /** Inner content (between `>` and `</svg>`). */
  inner: string;
  /** `data-name` attr for the layers panel. Falls back to "Vector" when
   *  the source omits it (older shape-creator output didn't always
   *  include data-name, and tests / external SVG paste don't either). */
  dataName: string;
}

/**
 * Group N selected `<svg>` nodes into a single composite SVG. Returns the
 * new SVG's node id on success, `null` when the selection isn't valid
 * (less than 2 SVGs, mixed parents, or source ranges can't be resolved).
 *
 * Selection requirements:
 *   • 2 or more nodes
 *   • Every node is `type === 'svg'`
 *   • All share the same `parentId` (mixed-parent grouping is undefined)
 *   • Every node has parsable `left/top/width/height` styles (px)
 */
export interface GroupSvgsOpts {
  /** Parent-relative px boxes derived from RENDERED rects, keyed by nodeId. Used
   *  to group shapes that have no inline left/top — i.e. LAYOUT (flex/grid)
   *  children, whose position comes from the layout, not inline styles. */
  boxOverrides?: Map<string, BoundingBox>;
  /** True when the grouped shapes are layout children — the resulting group is
   *  emitted as a flex/flow child (`position: relative; flex: 0 0 auto`, no
   *  left/top) so it takes their slot, instead of an absolute box. */
  asFlexChild?: boolean;
}

export function groupSvgs(
  nodeIds: string[],
  nodesMap: Map<string, CanvasNode>,
  filePath: string,
  opts: GroupSvgsOpts = {},
): string | null {
  if (nodeIds.length < 2) {
    trace.action('group-svgs:too-few', { count: nodeIds.length });
    return null;
  }

  const nodes = nodeIds
    .map(id => nodesMap.get(id))
    .filter((n): n is CanvasNode => !!n);
  if (nodes.length !== nodeIds.length) {
    trace.action('group-svgs:missing-nodes', { nodeIds });
    return null;
  }
  if (!nodes.every(n => n.type === 'svg')) {
    trace.action('group-svgs:not-all-svg', { types: nodes.map(n => n.type) });
    return null;
  }
  const parentId = nodes[0].parentId;
  if (!nodes.every(n => n.parentId === parentId)) {
    trace.action('group-svgs:mixed-parents', { parents: nodes.map(n => n.parentId) });
    return null;
  }

  // Compute the union bbox from the parsed node styles. We use this as a
  // pre-flight check so we can bail before touching source on a malformed
  // selection (e.g. an SVG with `width: '100%'` that can't be unioned).
  const nodeBoxes = nodes.map(n => readNodeBox(n) ?? opts.boxOverrides?.get(n.id) ?? null);
  if (nodeBoxes.some(b => b === null)) {
    trace.action('group-svgs:unreadable-bbox', { nodeIds });
    return null;
  }
  const unionFromNodes = unionBoxes(nodeBoxes as BoundingBox[]);
  if (!unionFromNodes) return null;

  const newId = generateNodeId('vector');

  let success = false;
  modifyProjectFile(filePath, (code) => {
    // Resolve each node's source range. Done from source (not the parsed
    // node) so we get the exact text to slice + delete.
    const parts: SvgSourcePart[] = [];
    for (const n of nodes) {
      const part = extractSvgPart(code, n.id, n, opts.boxOverrides?.get(n.id) ?? null);
      if (!part) {
        trace.action('group-svgs:source-not-found', { nodeId: n.id });
        return code;
      }
      parts.push(part);
    }

    // Re-compute union from source-parsed bbox (more authoritative than
    // node styles when the source has just been edited and the node
    // cache hasn't re-parsed yet).
    const union = unionBoxes(parts.map(p => p.bbox));
    if (!union) return code;

    // Sort parts by source position so we know which one is the topmost
    // (replaced in place by the new SVG). Non-topmost parts are deleted.
    const partsByPos = [...parts].sort((a, b) => a.start - b.start);
    const insertionPart = partsByPos[0];
    const deletionParts = partsByPos.slice(1);

    // Build the composite SVG markup. Each original SVG becomes a nested
    // `<svg x y width height viewBox preserveAspectRatio>` so its inner
    // coords keep painting the same shape — just at the offset that
    // places it correctly inside the new union viewBox.
    const newMarkup = buildGroupedSvg(newId, union, parts, opts.asFlexChild ?? false);

    // Mutate from the BACK forward so earlier-deleted slices don't shift
    // indices for later ones. Replacing the topmost happens last — its
    // start index is the smallest, so it's stable through the deletes.
    let mutated = code;
    for (let i = deletionParts.length - 1; i >= 0; i--) {
      const p = deletionParts[i];
      // Eat trailing whitespace/newline so we don't leave gaps.
      let endCut = p.end;
      while (endCut < mutated.length && /[\s\n\r]/.test(mutated[endCut])) endCut++;
      mutated = mutated.slice(0, p.start) + mutated.slice(endCut);
    }
    mutated = mutated.slice(0, insertionPart.start)
      + newMarkup
      + mutated.slice(insertionPart.end);

    success = true;
    trace.action('group-svgs:committed', {
      newId, count: nodeIds.length, parentId, union,
    });
    return mutated;
  });

  return success ? newId : null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function readNodeBox(node: CanvasNode): BoundingBox | null {
  const s = node.styles ?? {};
  const left = parseFloat(s.left ?? '');
  const top = parseFloat(s.top ?? '');
  const width = parseFloat(s.width ?? '');
  const height = parseFloat(s.height ?? '');
  if (![left, top, width, height].every(n => Number.isFinite(n))) return null;
  return { left, top, width, height };
}

function unionBoxes(boxes: BoundingBox[]): BoundingBox | null {
  if (boxes.length === 0) return null;
  let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
  for (const b of boxes) {
    minL = Math.min(minL, b.left);
    minT = Math.min(minT, b.top);
    maxR = Math.max(maxR, b.left + b.width);
    maxB = Math.max(maxB, b.top + b.height);
  }
  return { left: minL, top: minT, width: maxR - minL, height: maxB - minT };
}

/** Locate `<svg ... data-id="${nodeId}" ...>...</svg>` in `code` and return
 *  the slice + parsed attrs needed for grouping. Brace-walks `<svg>/</svg>`
 *  so nested svgs (which the icon-set system produces) are handled. */
function extractSvgPart(code: string, nodeId: string, node: CanvasNode, boxOverride: BoundingBox | null = null): SvgSourcePart | null {
  const marker = `data-id="${nodeId}"`;
  const markerIdx = code.indexOf(marker);
  if (markerIdx === -1) return null;
  // Walk back to the '<' that opens the tag containing the marker. The shape may
  // be a plain `<svg>` (canvas / page) OR a `<motion.svg>` (component file, where
  // every element is motion.*). Accept BOTH — without this, grouping shapes that
  // live inside a component silently no-ops, because `lastIndexOf('<svg')` never
  // matches `<motion.svg`.
  const openIdx = code.lastIndexOf('<', markerIdx);
  if (openIdx === -1) return null;
  const openName = code.slice(openIdx, openIdx + 14).match(/^<((?:motion\.)?svg)\b/);
  if (!openName) return null;
  const tagName = openName[1]; // 'svg' or 'motion.svg'
  // Guard: the marker must belong to THIS tag's opening, not a child element.
  const tagEnd = code.indexOf('>', openIdx);
  if (tagEnd === -1 || markerIdx > tagEnd) return null;

  // Brace-walk to the matching close, counting nested svg / motion.svg of EITHER
  // form (icon-set masters can nest plain <svg> inside a motion.svg, etc.).
  const tagScan = /<(\/?)(?:motion\.)?svg\b/g;
  tagScan.lastIndex = tagEnd + 1;
  let depth = 1;
  let closeIdx = -1;
  let mm: RegExpExecArray | null;
  while ((mm = tagScan.exec(code)) !== null) {
    if (mm[1] === '/') {
      if (--depth === 0) { closeIdx = mm.index; break; }
    } else {
      depth++;
    }
  }
  if (closeIdx === -1) return null;
  const closeGt = code.indexOf('>', closeIdx);
  if (closeGt === -1) return null;

  const end = closeGt + 1;
  const source = code.slice(openIdx, end);
  const attrChunk = code.slice(openIdx + 1 + tagName.length, tagEnd);
  const inner = code.slice(tagEnd + 1, closeIdx);

  // Parse the JSX `style={{...}}` for left/top/width/height. Falls back
  // to the node's parsed styles when the source style is missing/uses
  // non-numeric values (e.g. `width: '100%'`).
  const styleMatch = attrChunk.match(/style=\{\{([^}]+)\}\}/);
  const styleBody = styleMatch ? styleMatch[1] : '';
  const sourceLeft = parseStyleNum(styleBody, 'left');
  const sourceTop = parseStyleNum(styleBody, 'top');
  const sourceWidth = parseStyleNum(styleBody, 'width');
  const sourceHeight = parseStyleNum(styleBody, 'height');

  // Fallback chain: inline style → parsed node styles → rendered-rect override
  // (for layout children that carry no inline left/top).
  const fallback = readNodeBox(node) ?? boxOverride;
  const bbox: BoundingBox = {
    left: sourceLeft ?? fallback?.left ?? 0,
    top: sourceTop ?? fallback?.top ?? 0,
    width: sourceWidth ?? fallback?.width ?? 0,
    height: sourceHeight ?? fallback?.height ?? 0,
  };
  if (bbox.width <= 0 || bbox.height <= 0) return null;

  const vbMatch = attrChunk.match(/viewBox="([^"]+)"/);
  const parMatch = attrChunk.match(/preserveAspectRatio="([^"]+)"/);
  const nameMatch = attrChunk.match(/data-name="([^"]+)"/);

  return {
    nodeId, start: openIdx, end, source, bbox,
    viewBox: vbMatch ? vbMatch[1] : '',
    preserveAspectRatio: parMatch ? parMatch[1] : '',
    inner,
    dataName: nameMatch ? nameMatch[1] : 'Vector',
  };
}

/** Parse a numeric pixel value out of a JSX style body. Returns null when
 *  the key is absent or its value isn't a finite number. */
function parseStyleNum(styleBody: string, key: string): number | null {
  const re = new RegExp(`${key}\\s*:\\s*["']([^"']+)["']`);
  const m = styleBody.match(re);
  if (!m) return null;
  const num = parseFloat(m[1]);
  return Number.isFinite(num) ? num : null;
}

/** Build the composite `<svg>` JSX. Each input SVG becomes a nested
 *  `<svg x y width height viewBox preserveAspectRatio>` so its inner
 *  geometry continues to render identically — just translated into the
 *  union viewBox. The wrapper inherits position from the union bbox. */
function buildGroupedSvg(
  newId: string,
  union: BoundingBox,
  parts: SvgSourcePart[],
  asFlexChild: boolean,
): string {
  const W = Math.round(union.width);
  const H = Math.round(union.height);
  const L = Math.round(union.left);
  const T = Math.round(union.top);
  // Layout child: emit a flex/flow group (no left/top — the parent layout
  // positions it). Otherwise an absolute group anchored at the union bbox.
  const wrapperStyle = asFlexChild
    ? `style={{ position: "relative", width: "${W}px", height: "${H}px", overflow: "visible", flex: "0 0 auto" }}`
    : `style={{ position: "absolute", left: "${L}px", top: "${T}px", width: "${W}px", height: "${H}px", overflow: "visible" }}`;

  const children = parts.map(p => {
    const dx = Math.round(p.bbox.left - union.left);
    const dy = Math.round(p.bbox.top - union.top);
    const w = Math.round(p.bbox.width);
    const h = Math.round(p.bbox.height);
    const vb = p.viewBox ? ` viewBox="${p.viewBox}"` : '';
    const par = p.preserveAspectRatio ? ` preserveAspectRatio="${p.preserveAspectRatio}"` : '';
    // Nested SVG renders the original inner content at its own coord
    // system. `overflow="visible"` mirrors what shape-creator-produced
    // SVGs use so paths painting outside their declared box still show.
    //
    // Each child keeps its ORIGINAL data-id + data-name. The parser then
    // registers them as named children of the new group SVG, which is
    // what enables Figma-style "isolation" — double-clicking the group
    // lets the user select / edit individual shapes by id without
    // ungrouping. Without preserved ids the children would be anonymous
    // SVG nodes the parser surfaces only positionally, defeating
    // group-edit selection.
    return `<svg data-id="${p.nodeId}" data-name="${p.dataName}" x="${dx}" y="${dy}" width="${w}" height="${h}"${vb}${par} overflow="visible">${p.inner}</svg>`;
  }).join('');

  return `<svg data-id="${newId}" data-name="Group" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" ${wrapperStyle}>${children}</svg>`;
}

// ─── Ungroup ─────────────────────────────────────────────────────────────

/** A direct child `<svg>` of a group, parsed from the group's inner source. */
interface ChildSvgPart {
  x: number;
  y: number;
  width: number;
  height: number;
  viewBox: string;
  preserveAspectRatio: string;
  dataId: string;
  dataName: string;
  /** Content between the child's opening `>` and its `</svg>`. */
  inner: string;
}

/** Parse the direct child `<svg>` blocks out of a group's inner source.
 *  Brace-walks each `<svg>…</svg>` so a child that itself contains nested
 *  svgs is still consumed as one block. Exported for unit testing. */
export function parseChildSvgs(inner: string): ChildSvgPart[] {
  const out: ChildSvgPart[] = [];
  let scan = 0;
  while (scan < inner.length) {
    const openIdx = inner.indexOf('<svg', scan);
    if (openIdx === -1) break;
    const tagEnd = inner.indexOf('>', openIdx);
    if (tagEnd === -1) break;
    let depth = 1;
    let cursor = tagEnd + 1;
    let closeStart = -1;
    while (cursor < inner.length && depth > 0) {
      const nextOpen = inner.indexOf('<svg', cursor);
      const nextClose = inner.indexOf('</svg>', cursor);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        cursor = nextOpen + 4;
      } else {
        depth--;
        if (depth === 0) { closeStart = nextClose; break; }
        cursor = nextClose + 6;
      }
    }
    if (closeStart === -1) break;

    const openTag = inner.slice(openIdx, tagEnd + 1);
    const attr = (name: string): string =>
      openTag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? '';
    out.push({
      x: parseFloat(attr('x')) || 0,
      y: parseFloat(attr('y')) || 0,
      width: parseFloat(attr('width')) || 0,
      height: parseFloat(attr('height')) || 0,
      viewBox: attr('viewBox'),
      preserveAspectRatio: attr('preserveAspectRatio'),
      dataId: attr('data-id'),
      dataName: attr('data-name'),
      inner: inner.slice(tagEnd + 1, closeStart),
    });
    scan = closeStart + '</svg>'.length;
  }
  return out;
}

/**
 * Pure source transform for ungroup — replaces a group `<svg>` in `code`
 * with its direct child SVGs lifted to independent top-level SVGs at the
 * same source location. Each child's `x/y` (in the group's viewBox user
 * space) becomes a CSS `left/top` = `groupOrigin + childXY · viewBoxScale`;
 * `viewBox` / `preserveAspectRatio` / `data-id` / `data-name` and the inner
 * geometry are preserved verbatim. Returns the mutated code + the freed
 * children's ids, or `null` on a miss (caller keeps `code` unchanged).
 * Exported for unit testing.
 */
export function ungroupSvgsInSource(
  code: string,
  groupId: string,
  groupNode: CanvasNode,
): { code: string; resultIds: string[] } | null {
  const group = extractSvgPart(code, groupId, groupNode);
  if (!group) {
    trace.action('ungroup-svgs:source-not-found', { groupId });
    return null;
  }
  const children = parseChildSvgs(group.inner);
  if (children.length === 0) {
    trace.action('ungroup-svgs:no-children', { groupId });
    return null;
  }

  // viewBox→box scale of the group. `groupSvgs` + the refit pass keep groups
  // 1:1, but resolve it generally so a non-1:1 group still ungroups to the
  // correct visual positions.
  const vbParts = group.viewBox.split(/[\s,]+/).map(Number);
  const vbW = vbParts.length === 4 && vbParts[2] > 0 ? vbParts[2] : group.bbox.width;
  const vbH = vbParts.length === 4 && vbParts[3] > 0 ? vbParts[3] : group.bbox.height;
  const sx = vbW > 0 ? group.bbox.width / vbW : 1;
  const sy = vbH > 0 ? group.bbox.height / vbH : 1;

  const independent = children.map((c) => {
    const absLeft = Math.round(group.bbox.left + c.x * sx);
    const absTop = Math.round(group.bbox.top + c.y * sy);
    const w = Math.round(c.width * sx);
    const h = Math.round(c.height * sy);
    const vb = c.viewBox ? ` viewBox="${c.viewBox}"` : '';
    const par = c.preserveAspectRatio ? ` preserveAspectRatio="${c.preserveAspectRatio}"` : '';
    const dataId = c.dataId ? ` data-id="${c.dataId}"` : '';
    const dataName = c.dataName ? ` data-name="${c.dataName}"` : '';
    const style = `style={{ position: "absolute", left: "${absLeft}px", top: "${absTop}px", width: "${w}px", height: "${h}px", overflow: "visible" }}`;
    return `<svg${dataId}${dataName}${vb}${par} ${style}>${c.inner}</svg>`;
  }).join('\n  ');

  const mutated = code.slice(0, group.start) + independent + code.slice(group.end);
  const resultIds = children.map(c => c.dataId).filter((id): id is string => !!id);
  trace.action('ungroup-svgs:committed', { groupId, count: children.length, resultIds });
  return { code: mutated, resultIds };
}

/**
 * Ungroup a composite SVG — the inverse of `groupSvgs`. Detects that the
 * node IS a group (an `<svg>` whose children are ALL nested `<svg>`
 * wrappers — a plain SVG shape's children are `<path>`/`<polygon>`/etc),
 * then replaces it with N independent top-level SVGs in one
 * `modifyProjectFile` transaction. Returns the freed children's ids (=
 * their preserved data-ids), or `null` when the node isn't a group.
 */
export function ungroupSvgs(
  groupId: string,
  nodesMap: Map<string, CanvasNode>,
  filePath: string,
): string[] | null {
  const groupNode = nodesMap.get(groupId);
  if (!groupNode || groupNode.type !== 'svg') {
    trace.action('ungroup-svgs:not-svg', { groupId, type: groupNode?.type });
    return null;
  }
  const childIds = groupNode.children ?? [];
  if (childIds.length === 0 || !childIds.every(id => nodesMap.get(id)?.type === 'svg')) {
    trace.action('ungroup-svgs:not-a-group', { groupId, childCount: childIds.length });
    return null;
  }

  let resultIds: string[] | null = null;
  modifyProjectFile(filePath, (code) => {
    const result = ungroupSvgsInSource(code, groupId, groupNode);
    if (!result) return code;
    resultIds = result.resultIds;
    return result.code;
  });
  return resultIds;
}
