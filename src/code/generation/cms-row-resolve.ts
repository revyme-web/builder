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
import { cmsPageMetaAtom, activePreviewItemAtom } from '@/code/stores/cms-page-store';
import { parseCmsPageMeta } from '@/code/project/cms-page-meta';
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

  // Walk up to the collection list that owns this template row — but ONLY for
  // a node the parser marked as living inside the `.map()` callback. A bare
  // ancestor walk also succeeds for a node that is merely a DESCENDANT of the
  // list container (a sibling of the `.map()` expression), which on a detail
  // page holding a related-items list would resolve that list's row for a node
  // actually bound to the page's own `item`. Same rule as `findCmsListScope`.
  let list: CanvasNode | undefined = node.isCollectionTemplate && node.parentId ? nodes.get(node.parentId) : undefined;
  while (list && !list.collectionList) list = list.parentId ? nodes.get(list.parentId) : undefined;
  const source = list?.collectionList?.source;

  let row: Record<string, any> | undefined;
  if (source) {
    try {
      const rowIndex = getDefaultStore().get(mapItemIndexAtom) ?? 0;
      const offset = list!.collectionList!.offset ?? 0;
      const items = getCollectionData(source);
      row = items[offset + rowIndex] ?? items[offset] ?? items[0];
    } catch (err) {
      trace.error('cms-detach:row-resolve-failed', err);
      return {};
    }
  } else {
    // DETAIL ([slug]) PAGE — the bindings come from the page's `@cmsPage`
    // context, so there is no `.map()` ancestor to walk to and this used to
    // return {}. Every caller then had NO values: unbinding a field on a slug
    // page injected an empty string and the text vanished from the canvas
    // (user report 2026-09-09), and a detach/copy baked placeholders instead
    // of what the node was showing. The row is the item the page is
    // PREVIEWING — the same one the canvas paints from, so the baked value is
    // exactly the text on screen.
    const store = getDefaultStore();
    if (store.get(cmsPageMetaAtom)?.kind !== 'detail') return {};
    row = store.get(activePreviewItemAtom) ?? undefined;
    trace.action('cms-detach:detail-page-row', { nodeId: node.id, hasRow: !!row });
  }
  if (!row) return {};

  const values: Record<string, string> = {};
  for (const b of bindings) {
    const v = row[b.field];
    if (v != null && v !== '') values[b.prop] = String(v);
  }
  trace.action('cms-detach:row-values-resolved', { nodeId: node.id, source: source ?? 'detail-page', props: Object.keys(values) });
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

/**
 * The row a CMS DETAIL (`[slug]`) page is showing, resolved from the FILE — the
 * companion of `resolveCmsRowForNodeInCode` for pages that have no `.map()`.
 *
 * Used at flush time by the dangling-binding heal: a node dragged out of a
 * detail page's body lands in `canvasNodes` at MODULE scope, where `item` is
 * not declared, so its `{item.field}` must be dormantized. Without a row the
 * heal wrote the humanized field name and the user watched their heading turn
 * into "Untitled" (report 2026-09-09); with it, the detached node keeps the
 * words it was showing.
 *
 * Falls back to the collection's first row when no slug is being previewed —
 * the same fallback `activePreviewSlugAtom` and the generated page itself use.
 */
export function resolveDetailPageRow(code: string): Record<string, any> | null {
  const meta = parseCmsPageMeta(code);
  if (meta?.kind !== 'detail') return null;
  try {
    const previewed = getDefaultStore().get(activePreviewItemAtom);
    if (previewed) return previewed;
    return getCollectionData(meta.collection)[0] ?? null;
  } catch (err) {
    trace.error('cms-detach:detail-page-row-failed', err);
    return null;
  }
}

