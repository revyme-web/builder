// cms-style-format.ts — Shared formatter for CMS-bound style values.
//
// CMS image fields store a bare URL (`/images/alice.jpg`). CSS properties
// like `background-image`, `mask-image`, `cursor` need `url(...)` to render
// — so we wrap on the apply side and keep the parser shape simple.
//
// Used by:
//   - Renderer (.map() ghost rendering, inline-map per-item rendering)
//   - applyDetailPageBindings (canvas substitution for `@cmsPage` detail
//     pages — same parser shape as a .map() template, same formatting
//     needs at apply time)

/** URL-bearing CSS properties that need `url("...")` wrapping. */
const URL_WRAPPED_STYLE_PROPS = new Set([
  'backgroundImage',
  'maskImage',
  'WebkitMaskImage',
  'listStyleImage',
  'borderImageSource',
  'cursor', // `cursor: url(...)` for custom cursors
]);

/** Format a CMS-bound style value for the given style property. Wraps in
 *  `url("...")` for URL-bearing props if the value isn't already wrapped.
 *  Other props pass through as a plain string. */
export function formatBoundStyleValue(styleProp: string, raw: unknown): string {
  const s = String(raw);
  if (URL_WRAPPED_STYLE_PROPS.has(styleProp) && !/^url\(/i.test(s.trim())) {
    return `url("${s.replace(/"/g, '\\"')}")`;
  }
  return s;
}
