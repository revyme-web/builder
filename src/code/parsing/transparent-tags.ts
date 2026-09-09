// transparent-tags.ts — JSX tags the parser looks THROUGH: they never become
// CanvasNodes, so a `data-id` on them is never in the node map. Shared by the
// data-id healer (must not stamp them) and the forced-render integrity guard
// (must not treat their ids as "missing from the map" — a healed
// `<RevymeSplitText data-id=…>` made every forced render on the page skip,
// which is how a collection list's ghost rows stayed displaced after a drop,
// 2026-09-09).
export const PARSER_TRANSPARENT_TAGS: ReadonlySet<string> = new Set([
  'LayoutGroup', 'MotionConfig', 'AnimatePresence', 'Fragment', 'React.Fragment',
  // Text-effect wrapper — see parser.ts findSplitTextWrapper.
  'RevymeSplitText',
  // Page-transition wrapper in LayoutClient templates (runtime import).
  'PageTransitions',
]);

/** Name of the JSX tag whose opening tag contains offset `idx` (best effort:
 *  the nearest `<Tag` before the offset), or null. */
export function enclosingTagName(code: string, idx: number): string | null {
  for (let i = idx - 1; i >= 0; i--) {
    if (code[i] !== '<') continue;
    const m = /^<([A-Za-z][\w.]*)/.exec(code.slice(i, i + 80));
    if (m) return m[1];
    return null;
  }
  return null;
}
