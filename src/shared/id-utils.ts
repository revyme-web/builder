// id-utils.ts — Shared helpers to convert canvas node IDs into JS
// identifiers used by generated code.
//
// Generated effect code (scroll transforms, overlay state, scroll-variant
// specs, etc.) embeds the node ID into variable / function names —
// e.g. `frame-mpo91uhh-8` becomes `frameMpo91uhh_8Sec0Ref`,
// `handleFrameMpo91uhh_8Enter`, etc. This is THE canonical formula
//   nodeId.replace(/[^a-zA-Z0-9]/g, '_').replace(/_([a-z])/g, (_, c) => c.toUpperCase())
// — every generator/parser (generator-motion, overlay-gen, text-anim-gen,
// instance-fx-gen, scroll-variant-gen, scroll-parser, the paste-engine
// effects extractor + injector) must call the SAME function so
// name-derivation stays byte-identical across write and read sides.
// NOTE: slot-ops' `slotConstName` ('cn_' + underscores, no camel-casing)
// and component-ops' variants-var name are DIFFERENT conventions — not
// duplicates of this.

/**
 * Convert a canvas node ID to a JavaScript identifier prefix used by
 * generated effect code.
 *
 *   `frame-mpo91uhh-8` → `frameMpo91uhh_8`
 *   `hero`             → `hero`
 *   `nav-bar-2`        → `navBar_2`
 *
 * Rules:
 *  1. Every non-alphanumeric character becomes `_`.
 *  2. Each `_<lowercase-letter>` collapses into the uppercased letter
 *     (camel-case). `_<digit>` keeps the underscore (a digit can't
 *     start a fresh camel-case word).
 */
export function nodeIdToVarName(nodeId: string): string {
  return nodeId
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Same prefix but capitalised — used when the generated code splices the
 * prefix into the MIDDLE of another identifier (`set${Prefix}SecPositions`,
 * `handle${Prefix}Enter`). Mirrors what `generator-motion.ts` does inline:
 *   `cleanName[0].toUpperCase() + cleanName.slice(1)`
 */
export function nodeIdToVarNameCapitalised(nodeId: string): string {
  const name = nodeIdToVarName(nodeId);
  if (name.length === 0) return name;
  return name[0].toUpperCase() + name.slice(1);
}

// ─── Node ID generation ─────────────────────────────────────────────────────
// Moved verbatim from canvas/creators/creator-utils.ts (Phase 10.2) — the
// unique-ID factory every creation path (creators, paste, drag-insert, AI
// tools) shares.

let _counter = 0;

/** Generate a unique node ID with optional prefix. */
export function generateNodeId(prefix = 'frame'): string {
  return `${prefix}-${Date.now().toString(36)}-${(++_counter).toString(36)}`;
}

// ─── FIT text (SVG foreignObject) id convention ──────────────────────────────
// `wrapInFitSVGInCode` wraps a text node `<id>` in `<svg data-id="<id>-svg">` +
// foreignObject. Selection redirects to the WRAPPER (node-ops
// redirectToFitTextWrapper); this is the INVERSE for style previews/writes that
// must land on the inner TEXT node — on the wrapper, a text property like
// font-family only inherits and the inner <p>'s inline style wins (live find
// 2026-07-03: font hover-preview no-op'd on FIT text).

/** The inner text node id of a FIT wrapper (`frame-x-svg` → `frame-x`), or
 *  null when the id isn't a FIT wrapper. */
export function fitTextInnerId(nodeId: string): string | null {
  return nodeId.endsWith('-svg') ? nodeId.slice(0, -'-svg'.length) : null;
}

/** Make a node label safe to embed in a `data-name="…"` JSX attribute.
 *  Import pipelines derive names from arbitrary text (a Figma/website
 *  import named a node after a testimonial ending in `…without her."` —
 *  the embedded straight quote terminated the attribute early and the
 *  WHOLE page file stopped parsing, rendering as blank). Straight double
 *  quotes become typographic ones (visually identical in panels, no
 *  escaping questions anywhere downstream), newlines collapse to spaces,
 *  and backslashes are dropped. */
export function sanitizeDataName(name: string): string {
  return name.replace(/"/g, '”').replace(/\s*[\r\n]+\s*/g, ' ').replace(/\\/g, '').trim();
}
