import { trace } from '@/shared/debug-trace';
import { isFitSize } from '@/shared/constants';
import { splitStyleProps } from '@/shared/css-utils';
import { findMatchingCloseTagIndex } from './generator-utils';
import { measureFitRefit, fitHtmlToPlainLines } from '@/shared/fit-measure';

/**
 * Calculate the optimal viewBox dimensions for FIT text.
 * Uses binary search with a hidden measurement element to find the largest
 * font-size where text fits within a reference width, then returns the
 * text's intrinsic dimensions at that size.
 */
export function calculateFitViewBox(
  text: string,
  styles: Record<string, string>,
  referenceWidth: number = 1000,
): { width: number; height: number; fontSize: number; marginTop: number } {
  const measure = document.createElement('div');
  measure.style.position = 'absolute';
  measure.style.left = '-9999px';
  measure.style.top = '-9999px';
  measure.style.visibility = 'hidden';
  measure.style.whiteSpace = 'nowrap';
  measure.style.margin = '0';
  measure.style.padding = '0';
  measure.style.lineHeight = '1';
  if (styles.fontFamily) measure.style.fontFamily = styles.fontFamily;
  // (height re-measures below with the AUTHORED line-height — see the note there)
  if (styles.fontWeight) measure.style.fontWeight = styles.fontWeight;
  if (styles.fontStyle) measure.style.fontStyle = styles.fontStyle;
  if (styles.letterSpacing) measure.style.letterSpacing = styles.letterSpacing;
  // Multi-line text fits by its LONGEST line — fold <br>/</p><p> boundaries to
  // \n and search per line (the old strip-everything join measured "A B C" as
  // one long line and solved a too-small font / too-wide box).
  const fitLines = fitHtmlToPlainLines(text).split('\n').map((l) => l.trim()).filter(Boolean);
  if (fitLines.length === 0) fitLines.push('Ag');
  document.body.appendChild(measure);

  const maxLineWidth = (): number => {
    let maxW = 0;
    for (const line of fitLines) {
      measure.textContent = line;
      if (measure.scrollWidth > maxW) maxW = measure.scrollWidth;
    }
    return maxW;
  };

  // Binary search: find largest font-size where the longest line fits referenceWidth
  let lo = 1, hi = 2000, bestSize = 16;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    measure.style.fontSize = `${mid}px`;
    if (maxLineWidth() <= referenceWidth) {
      bestSize = mid;
      lo = mid;
    } else {
      hi = mid;
    }
  }

  // Intrinsic WIDTH at the optimal size, then delegate the final numbers
  // (fontSize / ink-hugging height / ink-centering marginTop) to the ONE
  // shared measurer so toggle-time and re-fit-time can never disagree.
  measure.style.fontSize = `${bestSize}px`;
  const width = Math.ceil(maxLineWidth() + 10);
  document.body.removeChild(measure);

  const refit = measureFitRefit(text, styles, width);
  const fontSize = refit?.fontSize ?? Math.round(bestSize);
  const height = refit?.height ?? Math.ceil(bestSize + 5);
  const marginTop = refit?.marginTop ?? 0;
  trace.fn('fit-text:calculateViewBox', { text: text.slice(0, 30), fontSize, width, height, marginTop });
  return { width, height, fontSize, marginTop };
}

/**
 * Re-fit an EXISTING FIT text after a metric-changing edit (text content or a
 * font family / weight / letter-spacing commit): keep the frozen viewBox WIDTH
 * (the box the user sized) and binary-search the font size so the LONGEST line
 * fits it again, recomputing the height for the line count. The stale-viewBox
 * failure mode is an off-center look: the new font's line no longer matches the
 * box it's centered in, so `textAlign: center` overflows asymmetrically (live
 * find 2026-07-03). Returns null when the text is empty.
 *
 * Thin wrapper over the LEAF `measureFitRefit` (shared/fit-measure.ts) — the
 * sandbox live-typing re-fit imports the leaf directly (this module's
 * generator-utils import would drag @babel into the sandbox bundle).
 * Pass `doc` = the canvas IFRAME's document when measuring canvas text —
 * fonts load per-document and the parent may not have the family (see
 * fit-measure.ts header).
 */
export function calculateFitRefit(
  html: string,
  styles: { fontFamily?: string; fontWeight?: string; letterSpacing?: string; fontStyle?: string; lineHeight?: string },
  vbWidth: number,
  doc: Document = document,
): { fontSize: number; height: number; marginTop: number } | null {
  return measureFitRefit(html, styles, vbWidth, doc);
}

/**
 * Wrap a text element in SVG foreignObject for FIT mode.
 * The inner element's fontSize is updated to the calculated optimal size.
 * The SVG viewBox matches the text's intrinsic dimensions at that size.
 * width:100% on the SVG scales it to fill the parent.
 */

// ─── Layout-participation props: WRAPPER owns them ──────────────────────────
//
// The `<svg data-id="X-svg">` wrapper is the element that takes part in the
// parent's layout — hover/click/layers/size all redirect the inner to it. So
// everything that positions or lays the node out must live ON the wrapper,
// not on the inner <p> inside the foreignObject: an `absolute` text switched to
// FIT kept `position/left/top/transform` on the inner while the wrapper became
// a plain flow child (`width: 100%` + `order`) — the text dropped behind its
// siblings and drag treated it as a layout child, yet the Position tool (still
// reading the inner) said "absolute" (live find 2026-09-06). The reference builder keeps an
// absolute text absolute when it goes Fit; so do we: lift on wrap, lower on
// unwrap, and the panels read/write these keys through the wrapper.
const FIT_LIFT_KEYS = new Set([
  'position', 'left', 'top', 'right', 'bottom', 'inset', 'zIndex',
  'flex', 'flexGrow', 'flexShrink', 'flexBasis', 'order', 'alignSelf', 'justifySelf',
  'gridColumn', 'gridRow', 'width', 'minWidth', 'maxWidth',
]);
/** Fit% scale is fit-OWNED and stays on the inner; any other transform (a
 *  centering pin's translate) participates in layout → lifts. */
const isFitOwnedTransform = (raw: string) => /^['"]scale\([\d.]+\)['"]$/.test(raw.trim());

/** Top-level `key: value` pairs of a style-object body (bracket/quote aware). */
function parseStylePairs(body: string): Array<{ key: string; raw: string }> {
  const out: Array<{ key: string; raw: string }> = [];
  for (const part of splitStyleProps(body, ',')) {
    const m = part.match(/^\s*(['"]?)([A-Za-z_$][\w$-]*)\1\s*:\s*([\s\S]+?)\s*$/);
    if (m) out.push({ key: m[2], raw: m[3] });
  }
  return out;
}
const serializePairs = (pairs: Array<{ key: string; raw: string }>) =>
  pairs.map(({ key, raw }) => `${/^--/.test(key) ? `'${key}'` : key}: ${raw}`).join(', ');
const isPositioned = (raw: string | undefined) => !!raw && /['"](absolute|fixed)['"]/.test(raw);

/** Split an inner style body into { keep (inner), lift (wrapper) }. */
function partitionForFitWrap(body: string): { keep: string; lift: Array<{ key: string; raw: string }>; positioned: boolean } {
  const pairs = parseStylePairs(body);
  const lift: Array<{ key: string; raw: string }> = [];
  const keep: Array<{ key: string; raw: string }> = [];
  for (const pr of pairs) {
    if (FIT_LIFT_KEYS.has(pr.key) || (pr.key === 'transform' && !isFitOwnedTransform(pr.raw))) lift.push(pr);
    else keep.push(pr);
  }
  const positioned = isPositioned(lift.find(x => x.key === 'position')?.raw);
  // The inner is a flow child of the foreignObject now; keep an explicit,
  // harmless position (every node carries one) when we took absolute/fixed.
  if (positioned) keep.push({ key: 'position', raw: "'relative'" });
  return { keep: serializePairs(keep), lift, positioned };
}

export function wrapInFitSVGInCode(
  code: string,
  nodeId: string,
  viewBox: { width: number; height: number; fontSize: number; marginTop?: number },
  /** `width`: the painted px width to bake when the text's own width is a HUG
   *  keyword (auto / fit-content / min-content / max-content). A FIT wrapper's
   *  width can only be Fixed (px) or Relative (%) — like the reference — since
   *  the fit scales the text INTO the box; a hug box has nothing to scale into
   *  (the text collapsed to a sliver, live find 2026-09-06). */
  opts: { width?: string } = {},
): string {
  const idPattern = `data-id="${nodeId}"`;
  const idIdx = code.indexOf(idPattern);
  if (idIdx === -1) return code;

  const openStart = code.lastIndexOf('<', idIdx);
  if (openStart === -1) return code;

  const tagMatch = code.slice(openStart + 1, idIdx).match(/^(\w+)/);
  if (!tagMatch) return code;
  const tagName = tagMatch[1];

  // Find matching close tag (nesting + self-closing same-tag children
  // handled by the shared depth matcher).
  const closeTag = `</${tagName}>`;
  const closeStart = findMatchingCloseTagIndex(code, tagName, code.indexOf('>', idIdx) + 1);
  if (closeStart === -1) return code;
  const closePos = closeStart + closeTag.length;

  let elementCode = code.slice(openStart, closePos);

  // Update style block: set fontSize to calculated optimal, add whiteSpace/margin/lineHeight
  const styleMatch = elementCode.match(/style=\{\{([^}]*)\}\}/);
  let lifted: Array<{ key: string; raw: string }> = [];
  if (styleMatch) {
    // Layout-participation props move to the WRAPPER (see FIT_LIFT_KEYS).
    const part = partitionForFitWrap(styleMatch[1]);
    lifted = part.lift;
    let s = part.keep;
    // Replace existing fontSize with the calculated optimal size
    s = s.replace(/fontSize:\s*['"][^'"]*['"]/, `fontSize: '${viewBox.fontSize}px'`);
    // Remove width/height from inner element — SVG wrapper controls sizing
    s = s.replace(/,?\s*width:\s*['"][^'"]*['"]/, '');
    s = s.replace(/,?\s*height:\s*['"][^'"]*['"]/, '');
    // A removed FIRST pair leaves its trailing comma behind (`{{, fontSize…`
    // — a SyntaxError that blanked the page, agent suite 2026-09-22).
    s = s.replace(/^\s*,\s*/, '').replace(/,\s*,/g, ',');
    // Add margin, lineHeight for FIT (no whiteSpace:'nowrap' — FIT supports multi-line)
    if (!s.includes('margin:') && !s.includes('margin :')) {
      s = s.trimEnd();
      if (!s.endsWith(',')) s += ',';
      s += ` margin: '0'`;
    }
    if (!s.includes('lineHeight')) {
      s = s.trimEnd();
      if (!s.endsWith(',')) s += ',';
      s += ` lineHeight: '1'`;
    }
    // VERTICAL CENTERING: the box hugs the text's INK, but fonts place their
    // ink asymmetrically around the line box (Koulen at lh 0.7 hung ~60% of
    // its ink BELOW) — a plain <p> at the top of the foreignObject shows ink
    // poking out the top + a whitespace band below (live find 2026-07-03).
    // `marginTop` is the MEASURED ink-centering offset (fit-measure Range
    // math); every re-fit rewrites it alongside fontSize.
    if (viewBox.marginTop !== undefined) {
      s = s.replace(/,?\s*marginTop:\s*['"][^'"]*['"]/, '');
      s = s.trimEnd();
      if (!s.endsWith(',')) s += ',';
      s += ` marginTop: '${viewBox.marginTop}px'`;
    }
    elementCode = elementCode.replace(styleMatch[0], `style={{${s}}}`);
  }

  // Wrapper style: the fit contract's own keys + everything lifted from the
  // inner. A lifted `width` REPLACES the default 100% (an absolute text keeps
  // its own box); `height` stays 'auto' (derived from the viewBox aspect).
  const liftedWidth = lifted.find(x => x.key === 'width');
  const liftedRest = lifted.filter(x => x.key !== 'width');
  const liftedIsHug = !!liftedWidth && isFitSize(liftedWidth.raw.trim().replace(/^['"]|['"]$/g, ''));
  const bakedWidth = (opts.width && (liftedIsHug || !liftedWidth)) ? `'${opts.width}'` : null;
  if (bakedWidth) trace.action('fit-text:bake-hug-width', { nodeId, from: liftedWidth?.raw ?? '(none)', to: opts.width });
  const wrapperStyle = [
    `width: ${bakedWidth ?? (liftedWidth && !liftedIsHug ? liftedWidth.raw : "'100%'")}`,
    "height: 'auto'", "overflow: 'visible'", "display: 'block'", "whiteSpace: 'pre'",
    ...(liftedRest.length ? [serializePairs(liftedRest)] : []),
  ].join(', ');
  if (lifted.length) trace.action('fit-text:lift-to-wrapper', { nodeId, keys: lifted.map(x => x.key) });
  const svgWrapper = `<svg data-id="${nodeId}-svg" data-name="FIT" xmlns="http://www.w3.org/2000/svg" style={{${wrapperStyle}}} viewBox="0 0 ${viewBox.width} ${viewBox.height}">
  <foreignObject width="100%" height="100%" style={{overflow: 'visible'}}>
    ${elementCode}
  </foreignObject>
</svg>`;

  trace.fn('fit-text:wrapInSVG', { nodeId, viewBox, wrappedLength: svgWrapper.length });
  return code.slice(0, openStart) + svgWrapper + code.slice(closePos);
}

/**
 * Unwrap a text element from its SVG foreignObject FIT wrapper.
 * Restores the original fontSize and removes FIT-specific style additions.
 */
export function unwrapFitSVGInCode(
  code: string,
  nodeId: string,
): string {
  const svgId = `${nodeId}-svg`;
  const svgIdPattern = `data-id="${svgId}"`;
  const svgIdIdx = code.indexOf(svgIdPattern);
  if (svgIdIdx === -1) return code;

  const svgOpenStart = code.lastIndexOf('<', svgIdIdx);
  if (svgOpenStart === -1) return code;

  const svgCloseTag = '</svg>';
  const svgCloseIdx = code.indexOf(svgCloseTag, svgIdIdx);
  if (svgCloseIdx === -1) return code;
  const svgEnd = svgCloseIdx + svgCloseTag.length;

  const innerIdPattern = `data-id="${nodeId}"`;
  const innerIdIdx = code.indexOf(innerIdPattern, svgOpenStart);
  if (innerIdIdx === -1 || innerIdIdx >= svgEnd) return code;

  const innerOpenStart = code.lastIndexOf('<', innerIdIdx);
  const innerTagMatch = code.slice(innerOpenStart + 1, innerIdIdx).match(/^(\w+)/);
  if (!innerTagMatch) return code;
  const innerTag = innerTagMatch[1];

  const innerCloseTag = `</${innerTag}>`;
  const innerCloseIdx = code.indexOf(innerCloseTag, innerIdIdx);
  if (innerCloseIdx === -1) return code;
  const innerEnd = innerCloseIdx + innerCloseTag.length;

  let innerElement = code.slice(innerOpenStart, innerEnd);
  // Remove FIT-specific style additions
  innerElement = innerElement.replace(/,?\s*whiteSpace:\s*'nowrap'/, '');
  innerElement = innerElement.replace(/,?\s*margin:\s*'0'/, '');
  innerElement = innerElement.replace(/,?\s*lineHeight:\s*'1'/, '');
  // Strip the FIT ink-centering offset added at wrap / re-fit time.
  innerElement = innerElement.replace(/,?\s*marginTop:\s*'-?[\d.]+px'/, '');
  // Strip the Fit% scale (fit-owned — the control writes `scale(x)` + center
  // origin; leaving it would render the unwrapped text visibly scaled).
  innerElement = innerElement.replace(/,?\s*transform:\s*'scale\([\d.]+\)'/, '');
  innerElement = innerElement.replace(/,?\s*transformOrigin:\s*'center'/, '');

  // LOWER the wrapper's layout-participation props back onto the inner (the
  // wrapper is about to disappear). Read the wrapper's CURRENT style — later
  // writes (order commits, Size tool width) land there, not on the inner.
  const wrapperOpenEnd = code.indexOf('>', svgIdIdx);
  const wrapperStyleMatch = code.slice(svgOpenStart, wrapperOpenEnd + 1).match(/style=\{\{([^}]*)\}\}/);
  if (wrapperStyleMatch) {
    const FIT_WRAPPER_OWN: Record<string, string> = { height: "'auto'", overflow: "'visible'", display: "'block'", whiteSpace: "'pre'" };
    const lower = parseStylePairs(wrapperStyleMatch[1]).filter(({ key, raw }) => {
      if (key in FIT_WRAPPER_OWN && FIT_WRAPPER_OWN[key] === raw.trim()) return false;
      if (key === 'width' && /^['"]100%['"]$/.test(raw.trim())) return false; // the default we minted
      return FIT_LIFT_KEYS.has(key) || key === 'transform';
    });
    if (lower.length) {
      const innerStyleMatch = innerElement.match(/style=\{\{([^}]*)\}\}/);
      const innerPairs = innerStyleMatch ? parseStylePairs(innerStyleMatch[1]) : [];
      const map = new Map(innerPairs.map(pr => [pr.key, pr] as const));
      for (const pr of lower) map.set(pr.key, pr);     // wrapper wins (it was the live one)
      const merged = serializePairs([...map.values()]);
      innerElement = innerStyleMatch
        ? innerElement.replace(innerStyleMatch[0], `style={{${merged}}}`)
        : innerElement.replace(/^<(\w+)/, `<$1 style={{${merged}}}`);
      trace.action('fit-text:lower-from-wrapper', { nodeId, keys: lower.map(x => x.key) });
    }
  }

  trace.fn('fit-text:unwrapSVG', { nodeId, restored: true });
  return code.slice(0, svgOpenStart) + innerElement + code.slice(svgEnd);
}
