// cms-row-resolve.ts — Which collection ROW does a node inside a collection-list
// `.map()` display, and what are its field values?
//
// Companion to cms-detach-gen: dormantizing a binding on detach leaves a
// placeholder (the humanized field name, `url()`, an absent `src`) — right for
// the "Missing" pill, wrong for the node itself. A heading detached from a
// collection list should still SAY what it said (copy: user report 2026-07-25;
// drag: 2026-07-28). These resolvers supply the values the bake helpers
// (`bakeCmsValuesOnClone` / `bakeCmsOrphanValuesInCode` /
// `detachCmsSubtreeWithValues`) write over the placeholders.
//
// Split from cms-detach-gen so THAT module stays pure string transforms —
// resolving rows needs the store (`mapItemIndexAtom`) and the project's
// collection JSON (`getCollectionData`).

import { getDefaultStore } from 'jotai';
import { getEnclosingMapSourceForNode } from './map-gen';
import { getCollectionData } from '@/code/project/cms-ops';
import { mapItemIndexAtom } from '@/code/stores/store';
import type { CanvasNode } from '@/code/parsing/parser';
import { trace } from '@/shared/debug-trace';

/**
 * Resolved CMS field values for a node inside a collection-list `.map()`,
 * keyed the same way the `data-cms-orphan` stash is (`__text`,
 * `__style.<cssProp>`, `<attr>`). MODEL-based — walks the node's parent chain
 * to the owning collection list, so it must run while the model still reflects
 * the pre-detach tree (copy, clone-descriptor build).
 *
 * Which row: `mapItemIndexAtom` — the row the user has stepped into on canvas
 * (display-relative) — offset by the list's `.slice()` start, since the primary
 * template row renders the FIRST item the slice lets through, not items[0].
 */
export function resolveCmsRowValues(node: CanvasNode, nodes: Map<string, CanvasNode>): Record<string, string> {
  const bindings: Array<{ prop: string; field: string }> = [
    ...(node.binding?.property === 'text' ? [{ prop: '__text', field: node.binding.field }] : []),
    ...(node.attrBindings ?? []).map(b => ({ prop: b.property, field: b.field })),
    ...(node.styleBindings ?? []).map(b => ({ prop: `__style.${b.styleProp}`, field: b.field })),
    ...(node.propBindings ?? []).map(b => ({ prop: b.prop, field: b.field })),
  ];
  if (bindings.length === 0) return {};

  // Walk up to the collection list that owns this template row.
  let list: CanvasNode | undefined = node.parentId ? nodes.get(node.parentId) : undefined;
  while (list && !list.collectionList) list = list.parentId ? nodes.get(list.parentId) : undefined;
  const source = list?.collectionList?.source;
  if (!source) return {};

  let row: Record<string, any> | undefined;
  try {
    const rowIndex = getDefaultStore().get(mapItemIndexAtom) ?? 0;
    const offset = list!.collectionList!.offset ?? 0;
    const items = source.startsWith('__inline:')
      ? (list!.inlineMapData ?? [])
      : getCollectionData(source);
    row = items[offset + rowIndex] ?? items[offset] ?? items[0];
  } catch (err) {
    trace.error('cms-detach:row-resolve-failed', err);
    return {};
  }
  if (!row) return {};

  const values: Record<string, string> = {};
  for (const b of bindings) {
    const v = row[b.field];
    if (v != null && v !== '') values[b.prop] = String(v);
  }
  trace.action('cms-detach:row-values-resolved', { nodeId: node.id, source, props: Object.keys(values) });
  return values;
}

/**
 * The CODE-path row resolver (move mutations): at flush time the node cache is
 * already post-move (parent chain points at the DESTINATION), so the enclosing
 * list must come from the pre-move CODE instead of the model. Resolves the
 * `.map()` source expression → the imported CMS collection → the row the
 * dragged template element was displaying. Returns null for inline maps or
 * unresolvable sources (callers keep the placeholder-only behavior).
 */
export function resolveCmsRowForNodeInCode(code: string, nodeId: string): Record<string, any> | null {
  const src = getEnclosingMapSourceForNode(code, nodeId);
  if (!src) return null;
  // The mapped source must reference a CMS collection import
  // (`import collection1 from '@/cms/collection-1.json'`).
  let slug: string | null = null;
  const importRe = /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]@\/cms\/([\w-]+)\.json['"]/g;
  let im: RegExpExecArray | null;
  while ((im = importRe.exec(code)) !== null) {
    if (new RegExp(`(?:^|[^\\w$])${im[1]}(?:[^\\w$]|$)`).test(src.sourceExpr)) { slug = im[2]; break; }
  }
  if (!slug) return null;
  let items: Array<Record<string, any>>;
  try { items = getCollectionData(slug); } catch { return null; }
  if (!items.length) return null;
  // First displayed row = the slice start; the user may have stepped INTO a
  // later ghost row (mapItemIndexAtom, display-relative) before dragging.
  const sliceStart = parseInt(/\.slice\(\s*(\d+)/.exec(src.sourceExpr)?.[1] ?? '0', 10) || 0;
  let displayIdx = 0;
  try { displayIdx = getDefaultStore().get(mapItemIndexAtom) ?? 0; } catch { /* headless callers */ }
  const row = items[sliceStart + displayIdx] ?? items[sliceStart] ?? items[0] ?? null;
  trace.action('cms-detach:resolve-row-in-code', { nodeId, slug, iterVar: src.iterVar, sliceStart, displayIdx, found: !!row });
  return row;
}
