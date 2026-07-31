// cms-page-bindings.ts — Apply previewed-item data to a detail page's
// node tree at canvas-render time.
//
// Detail-page templates use JSX bindings like `{item.title}` /
// `<img src={item.cover}>` that the parser detects (when the file has
// `/** @cmsPage { kind: 'detail' } */`) and stores on each node as
// `binding`, `attrBindings`, `styleBindings` — same shape inline `.map()`
// templates use.
//
// This helper takes the parser's node map + the previewed item record and
// returns a NEW map where binding-bearing nodes are shallow-cloned with
// their `textContent` / `attrs` / `styles` substituted. Nodes without
// bindings are passed through by reference; cloning is per-node so
// switching previewed slugs is cheap.

import type { CanvasNode } from '../parsing/parser';
import { formatBoundStyleValue } from './cms-style-format';
import { trace } from '@/shared/debug-trace';

/**
 * Walk the node map and apply field substitutions for any node whose
 * parser-detected bindings reference fields present on `item`. Returns a
 * new Map; the input map is left untouched (Canvas re-renders on slug
 * change get the fresh substitution without mutating the parser cache).
 */
export function applyDetailPageBindings(
  nodes: Map<string, CanvasNode>,
  item: Record<string, unknown> | null,
): Map<string, CanvasNode> {
  if (!item) return nodes;
  const out = new Map(nodes);
  let mutatedCount = 0;

  for (const [id, node] of out) {
    let cloned: CanvasNode | null = null;

    // Text / single-attribute binding.
    if (node.binding && item[node.binding.field] !== undefined) {
      const resolved = String(item[node.binding.field] ?? '');
      cloned = { ...node };
      if (node.binding.property === 'text') {
        cloned.textContent = resolved;
      } else {
        cloned.attrs = { ...cloned.attrs, [node.binding.property]: resolved };
      }
    }

    // Multi-attribute bindings (src + alt etc.).
    if (node.attrBindings) {
      for (const ab of node.attrBindings) {
        if (item[ab.field] === undefined) continue;
        const resolved = String(item[ab.field] ?? '');
        if (!cloned) cloned = { ...node };
        cloned.attrs = { ...cloned.attrs, [ab.property]: resolved };
      }
    }

    // Style bindings — `{ backgroundColor: item.bgColor }` etc.
    // For URL-bearing props (`backgroundImage`, `maskImage`, …) the JSON
    // holds a bare URL, but CSS needs `url(...)`; `formatBoundStyleValue`
    // wraps when needed. Same helper the Renderer uses for .map() ghosts so
    // detail-page substitution and per-item rendering stay byte-identical.
    if (node.styleBindings) {
      for (const sb of node.styleBindings) {
        if (item[sb.field] === undefined) continue;
        const resolved = formatBoundStyleValue(sb.styleProp, item[sb.field] ?? '');
        if (!cloned) cloned = { ...node };
        cloned.styles = { ...cloned.styles, [sb.styleProp]: resolved };
      }
    }

    if (cloned) {
      out.set(id, cloned);
      mutatedCount++;
    }
  }

  trace.fn('cms-page-bindings:apply', { mutatedCount, totalNodes: out.size });
  return out;
}
