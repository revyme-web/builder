// sources/layers.ts — Nodes on the ACTIVE page.
//
// This is the source that makes cmd+K a "find anything" box rather than a
// command list: with it, typing a layer's name jumps straight to that
// layer instead of only matching files and commands.
//
// Scope is deliberately the active page only. `nodesAtom` is the parsed
// node map for the current file, so this is free; searching every page
// would mean parsing every page's JSX on each keystroke.
//
// Three things keep it cheap on a large page:
//   1. Nothing is emitted below MIN_CONTENT_QUERY chars, so the empty
//      palette never materialises thousands of rows.
//   2. Matching is a plain substring test over `node.name` — no
//      allocation per node beyond the lower-cased name.
//   3. Breadcrumbs walk `parentId` only for nodes that already matched.
//      Building them for every node is what would actually hurt.
//
// Reads the node map, never canvas DOM — the parent frame must not touch
// iframe elements (see CLAUDE.md invariant 1).

import { getDefaultStore } from 'jotai';
import { nodesAtom } from '@/code/stores/store';
import type { CanvasNode } from '@/code/parsing/parser';
import type { SearchableItem } from '../search-types';
import { type SearchSource, MIN_CONTENT_QUERY } from './types';

const store = getDefaultStore();

/** Cap on emitted rows. The ranker still sorts these against everything
 *  else, so this only bounds how many candidates compete — a page with
 *  400 divs named "Container" shouldn't drown out components and pages. */
const MAX_LAYER_RESULTS = 30;

/** Depth guard for the ancestor walk. A cycle in `parentId` would
 *  otherwise hang the palette; the parser shouldn't produce one, but this
 *  runs on every keystroke and a hang here is unrecoverable for the user. */
const MAX_BREADCRUMB_DEPTH = 12;

/**
 * SVG geometry and sketch strokes. To the user these are paint, not layers:
 * you can't meaningfully select one stroke of a 50-stroke sketch, and a
 * Triangle's `<polygon>` isn't a thing you target. LayersPanel forces the
 * same nodes to be leaves (`isSvgShapeLeaf` / `isSketch`); the parser still
 * emits them for the Renderer, so the palette has to skip them explicitly.
 */
const SVG_GEOMETRY_TYPES = new Set([
  'path', 'polygon', 'polyline', 'circle', 'ellipse', 'rect', 'line', 'g',
  'defs', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'stop', 'use',
]);

/**
 * Is this node part of the page, or internal machinery of a component
 * instance placed on it?
 *
 * `nodesAtom` contains every instance EXPANDED — `expandComponent` inlines
 * each master's subtree so the Renderer can paint it. Those inlined nodes
 * carry `componentInstanceId` (documented on CanvasNode as "I'm inside SOME
 * other component's expansion"), and they are not editable from this page:
 * they belong to the master. Surfacing them meant searching a page showed
 * every variant of every component on it — three "Tools" rows from inside
 * the Header's mobile menu, none of them reachable from the page.
 *
 * A top-level instance keeps `componentInstanceId === null` (it isn't inside
 * anything), so `<Header/>` itself stays findable. Open the master file and
 * its own nodes have a null id too, so they become searchable exactly there
 * — which is where they're editable.
 */
function belongsToThisPage(node: CanvasNode): boolean {
  return node.componentInstanceId === null;
}

/**
 * Ancestor names, outermost first, excluding the node itself. Stops at
 * the root (`parentId === null`).
 */
function buildBreadcrumb(node: CanvasNode, nodes: Map<string, CanvasNode>): string[] {
  const trail: string[] = [];
  let current = node.parentId ? nodes.get(node.parentId) : undefined;
  let depth = 0;
  while (current && depth < MAX_BREADCRUMB_DEPTH) {
    trail.unshift(current.name || current.type);
    current = current.parentId ? nodes.get(current.parentId) : undefined;
    depth++;
  }
  return trail;
}

export const layersSource: SearchSource = ({ query }) => {
  if (query.length < MIN_CONTENT_QUERY) return [];

  const nodes = store.get(nodesAtom);
  if (!nodes || nodes.size === 0) return [];

  // Pass 1 — cheap filter, no breadcrumb work.
  const matches: CanvasNode[] = [];
  for (const node of nodes.values()) {
    // The root is the page itself; "select the page" isn't a useful
    // result and it always matches broad queries.
    if (node.parentId === null) continue;
    // Inlined component internals — not editable from this page.
    if (!belongsToThisPage(node)) continue;
    // Paint, not structure.
    if (SVG_GEOMETRY_TYPES.has(node.type)) continue;
    const name = node.name || node.type;
    if (name.toLowerCase().includes(query)) {
      matches.push(node);
      if (matches.length >= MAX_LAYER_RESULTS) break;
    }
  }

  // Pass 2 — breadcrumbs for survivors only.
  return matches.map((node): SearchableItem => {
    const name = node.name || node.type;
    // Same predicate LayersPanel uses for "this is an instance on the page"
    // (LayersPanel.tsx:258). Labelling it Component rather than its tag name
    // tells the user this row is a whole component, not a plain element.
    const isInstance = !!node.componentFile;
    return {
      id: `layer:${node.id}`,
      name,
      category: 'layers',
      subcategory: isInstance ? 'Component' : node.type,
      breadcrumb: buildBreadcrumb(node, nodes),
      // `name` already matched to get here; the tag name lets someone
      // find every `img` or `section` on the page by element type.
      keywords: [
        name.toLowerCase(),
        node.type.toLowerCase(),
        'layer', 'node', 'element',
        ...(isInstance ? ['component', 'instance'] : []),
      ],
      action: { type: 'select-node', nodeId: node.id },
    };
  });
};
