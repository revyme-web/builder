import { trace } from '@/shared/debug-trace';
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
export function wrapInFitSVGInCode(
  code: string,
  nodeId: string,
  viewBox: { width: number; height: number; fontSize: number; marginTop?: number },
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
  if (styleMatch) {
    let s = styleMatch[1];
    // Replace existing fontSize with the calculated optimal size
    s = s.replace(/fontSize:\s*['"][^'"]*['"]/, `fontSize: '${viewBox.fontSize}px'`);
    // Remove width/height from inner element — SVG wrapper controls sizing
    s = s.replace(/,?\s*width:\s*['"][^'"]*['"]/, '');
    s = s.replace(/,?\s*height:\s*['"][^'"]*['"]/, '');
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

  const svgWrapper = `<svg data-id="${nodeId}-svg" data-name="FIT" xmlns="http://www.w3.org/2000/svg" style={{width: '100%', height: 'auto', overflow: 'visible', display: 'block', whiteSpace: 'pre'}} viewBox="0 0 ${viewBox.width} ${viewBox.height}">
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

  trace.fn('fit-text:unwrapSVG', { nodeId, restored: true });
  return code.slice(0, svgOpenStart) + innerElement + code.slice(svgEnd);
}
