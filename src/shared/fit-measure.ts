// fit-measure.ts — the ONE fit-text measurement algorithm, as a LEAF module.
//
// FIT text = `<svg viewBox="0 0 W H"><foreignObject><p fontSize=…>` — the box
// width W is fixed (the user sized it); everything else derives from the text
// metrics. Re-fitting = binary-search the font size so the LONGEST line fits W,
// then recompute the height from the line count.
//
// Leaf on purpose: the sandbox bundle (text-edit-host live re-fit while
// typing) must import this WITHOUT dragging in fit-text-gen's generator-utils
// (@babel) dependency chain. Parent-side callers (fit-text-gen.calculateFitRefit,
// CanvasTextEditController) delegate here.
//
// `doc` = the document to measure in. THIS MATTERS: fonts load per-document.
// The canvas iframe always has the page's fonts (the text renders with them);
// the PARENT document only has faces some panel interaction happened to load —
// measuring there with an unloaded family meters the FALLBACK font and
// produces a garbage fit (live find 2026-07-03: commit wrote fontSize 140 for
// a line 3× wider than the box).

import { trace } from '@/shared/debug-trace';

export interface FitRefitResult {
  fontSize: number;
  height: number;
  /** Offset (px = viewBox units) that places the text's INK dead-center in the
   *  box — written as `marginTop` on the inner <p>. Fonts position their glyph
   *  ink asymmetrically around the line box (display fonts like Koulen hang
   *  low), so line-box math alone leaves the ink off-center; this is measured
   *  from the actual ink rect (Range API). */
  marginTop: number;
}

/** Fold fit-text HTML to plain multi-line text. `<br>` AND TipTap `</p><p>`
 *  paragraph boundaries are line breaks; every other tag drops. The paragraph
 *  case is load-bearing: a multi-line TipTap commit arrives as `<p>A</p><p>B</p>`,
 *  and stripping the tags WITHOUT the boundary→\n step measured it as the single
 *  line "AB" — the re-fit then solved a one-line viewBox for three-line content
 *  and the text hung out the bottom of the box (live find 2026-07-12). */
export function fitHtmlToPlainLines(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .trim();
}

/** Fold TipTap paragraph HTML to the fit wrapper's CANONICAL child form —
 *  `<br />` line breaks inside the ONE styled `<p>`. Inline marks (styled
 *  `<span>` runs) and entity encoding pass through untouched. Writing the
 *  paragraphs as real children instead nested `<p>` inside the fit `<p>` —
 *  invalid HTML whose unstyled inner paragraphs carry UA margins, so the
 *  layout box outgrew the viewBox and the center-origin scale pushed the
 *  text out the bottom. */
export function foldFitParagraphsToBr(html: string): string {
  return html
    .replace(/<\/p>\s*<p[^>]*>/gi, '<br />')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<\/p>/gi, '');
}

/** Re-fit for `html` (TipTap output or plain text; `<br>` = line break) at the
 *  frozen box width `vbWidth`. Returns null when the text is empty.
 *  `styles.lineHeight` = the element's AUTHORED line-height (unitless ratio or
 *  px — both correct verbatim). The height calc must use it: the old hardcoded
 *  `line-height: 1` made the box taller/shorter than the rendered text whenever
 *  the node's lineHeight ≠ 1 — e.g. 0.7 left a fat whitespace band under the
 *  ink and the text read as top-aligned, not centered (live find 2026-07-03). */
export function measureFitRefit(
  html: string,
  styles: { fontFamily?: string; fontWeight?: string; letterSpacing?: string; fontStyle?: string; lineHeight?: string },
  vbWidth: number,
  doc: Document = document,
): FitRefitResult | null {
  // Convert HTML to lines: <br> AND </p><p> boundaries are line breaks, other tags strip
  const plainText = fitHtmlToPlainLines(html);
  const allLines = plainText.split('\n'); // ALL lines including empty
  const textLines = allLines.filter((l) => l.length > 0); // non-empty for width
  if (textLines.length === 0) return null;
  const measure = doc.createElement('div');
  // position:FIXED (not absolute): an absolute div with no `top` lands in
  // FLOW position at the bottom of the body and, at binary-search font sizes
  // up to 2000px, GROWS THE DOCUMENT'S SCROLL AREA every call. In the canvas
  // iframe that scrollable overflow let caret-into-view scroll the window →
  // every getBoundingClientRect the sandbox emits shifted → all parent
  // overlays/headers offset until reload (live find 2026-07-03). Fixed
  // elements never extend the scroll area.
  measure.style.cssText = 'position:fixed;left:-9999px;top:0;visibility:hidden;pointer-events:none;white-space:nowrap;margin:0;padding:0;line-height:1';
  if (styles.fontFamily) measure.style.fontFamily = styles.fontFamily;
  if (styles.fontWeight) measure.style.fontWeight = styles.fontWeight;
  if (styles.letterSpacing) measure.style.letterSpacing = styles.letterSpacing;
  if (styles.fontStyle) measure.style.fontStyle = styles.fontStyle;
  doc.body.appendChild(measure);
  let lo = 1, hi = 2000, bestSize = 16;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    measure.style.fontSize = `${mid}px`;
    let maxW = 0;
    for (const line of textLines) {
      measure.textContent = line;
      if (measure.scrollWidth > maxW) maxW = measure.scrollWidth;
    }
    if (maxW <= vbWidth) { bestSize = mid; lo = mid; } else { hi = mid; }
  }
  // FLOOR, not round: the binary search's largest PASSING size is a float;
  // rounding UP makes the integer size overflow the box (54 glyphs × <0.5px
  // rounding = the ~8px right-edge spill the user saw). Floor is ≤1px under —
  // invisible, and textAlign centers the slack.
  const solved = Math.floor(bestSize);
  measure.style.fontSize = `${solved}px`;
  // Height + centering from the ACTUAL INK RECT at the element's REAL
  // line-height (the width solve above is line-height-independent). The box
  // hugs the ink; marginTop shifts the <p> so the ink centers in it. Line-box
  // arithmetic (fontSize × lineHeight) is NOT enough: glyph ink sits
  // asymmetrically around the line box per font metrics — Koulen at
  // line-height 0.7 hung ~60% of its ink below the box (live find 2026-07-03).
  if (styles.lineHeight) measure.style.lineHeight = styles.lineHeight;
  measure.style.whiteSpace = 'pre';
  measure.textContent = allLines.join('\n');
  let inkTop = 0;
  let inkHeight = 0;
  try {
    const range = doc.createRange();
    range.selectNodeContents(measure);
    const inkRect = range.getBoundingClientRect();
    const divRect = measure.getBoundingClientRect();
    inkTop = inkRect.top - divRect.top;   // can be NEGATIVE (ink above the block top)
    inkHeight = inkRect.height;
  } catch { /* jsdom has no Range.getBoundingClientRect — contract tests only */ }
  doc.body.removeChild(measure);
  const PAD = 4;
  const height = Math.ceil(inkHeight + PAD);
  const marginTop = Math.round(((height - inkHeight) / 2 - inkTop) * 100) / 100;
  trace.fn('fit-measure:refit', { vbWidth, fontSize: solved, height, marginTop, lines: allLines.length });
  return { fontSize: solved, height, marginTop };
}
