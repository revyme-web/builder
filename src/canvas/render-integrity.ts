// render-integrity.ts — guard for mid-gesture forced renders.
//
// During the deferred-drag-flush gesture window the force-render wiring ships
// the IMPERATIVE node cache (nodesAtom is intentionally stale — see
// Canvas.tsx). That cache is maintained by the interaction paths
// (moveNodeInCache, commit seeds) — but a STRUCTURAL ADD (frame/text creator,
// paste) reaches the cache only via the next parse. A forced render racing
// into that ~50ms window rebuilds the canvas from a map that's missing the
// just-committed node: the element vanishes from the canvas while the code
// and the Layers panel (parse-driven) still have it. Live find 2026-07-29:
// a freshly drawn frame disappeared after ~2s, ~1 time in 50 (race odds).

import { trace } from '@/shared/debug-trace';
import type { CanvasNode } from '@/code/parsing/parser';

/** JSX-attribute data-ids only. The negative lookbehind for `[` excludes CSS
 *  selectors inside generated `<style>` blocks (`[data-id="x"] { … }`) and
 *  querySelector strings — those ids are NOT nodes and must never count as
 *  "missing" (a false positive here would skip renders forever on pages with
 *  responsive style blocks). */
const JSX_DATA_ID_RE = /(?<!\[)data-id="([^"]+)"/g;

/** First data-id present in `code` but absent from `nodes`, or null when the
 *  map covers every id the code declares. Pure — unit tested. */
export function findCodeIdMissingFromMap(code: string, nodes: ReadonlyMap<string, CanvasNode>): string | null {
  for (const m of code.matchAll(JSX_DATA_ID_RE)) {
    if (!nodes.has(m[1])) return m[1];
  }
  return null;
}

/** True when a mid-gesture forced render should be SKIPPED because the node
 *  map lags the committed code (see module header). Traces the decision. */
export function shouldSkipLaggingForcedRender(code: string, nodes: ReadonlyMap<string, CanvasNode>): boolean {
  const missing = findCodeIdMissingFromMap(code, nodes);
  if (missing == null) return false;
  trace.action('canvas:force-render-skip-cache-lag', { missingId: missing, mapSize: nodes.size });
  return true;
}
