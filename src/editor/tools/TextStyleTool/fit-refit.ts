// fit-refit.ts — re-fit a FIT text's frozen viewBox after a font-metric change.
//
// A FIT text's `viewBox="0 0 W H"` + inner fontSize were measured for the font
// that was active when Fit was toggled. Committing a different FAMILY (or any
// metric-changing property) leaves the box stale: the new font's line is wider
// or narrower than the W it's centered in, so `textAlign: center` overflows the
// box asymmetrically and the text LOOKS off-center (live find 2026-07-03).
// This re-runs the shared re-fit (calculateFitRefit — same algorithm the
// TipTap text-commit uses): keep the box WIDTH, re-solve the font size for the
// new metrics, update the viewBox height + inner fontSize.

import { getDefaultStore } from 'jotai';
import { nodesAtom } from '@/code/stores/store';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { calculateFitRefit } from '@/code/generation/fit-text-gen';
import { loadGoogleFont } from '@/shared/font-loader';
import { forceCanvasRender } from '@/canvas/node-ops';
import { fitTextInnerId } from '@/shared/id-utils';
import { trace } from '@/shared/debug-trace';

/**
 * Re-fit the FIT text behind `selectedId` (the `-svg` wrapper or the inner
 * text node) for a just-committed style change. `styleOverrides` carries the
 * NEW value(s) (e.g. `{ fontFamily }`) — merged over the node's parsed styles
 * because the commit may not have round-tripped into nodesAtom yet.
 *
 * Waits for the font face to actually LOAD before measuring — a
 * `document.fonts.load()` for the family forces the fetch (display=swap faces
 * only download on first use, so measuring immediately would meter the
 * FALLBACK font and produce a wrong box all over again).
 *
 * No-op when the selection isn't a FIT text. Fire-and-forget async.
 */
export async function refitFitTextForStyles(
  selectedId: string,
  styleOverrides: Record<string, string>,
): Promise<void> {
  const innerId = fitTextInnerId(selectedId) ?? selectedId;
  const svgId = `${innerId}-svg`;
  const store = getDefaultStore();
  const nodes = store.get(nodesAtom);
  const textNode = nodes.get(innerId);
  const svgNode = nodes.get(svgId);
  if (!textNode || !svgNode) return; // not a FIT text — nothing to do
  const vbParts = String((svgNode.attrs as any)?.viewBox ?? '').split(/\s+/).map(Number);
  const vbWidth = vbParts.length === 4 && Number.isFinite(vbParts[2]) ? vbParts[2] : 0;
  if (!vbWidth) {
    trace.error('fit-refit:no-viewbox', { svgId, viewBox: (svgNode.attrs as any)?.viewBox });
    return;
  }

  const styles = { ...(textNode.styles as Record<string, string>), ...styleOverrides };
  const family = styles.fontFamily?.split(',')[0]?.trim().replace(/['"]/g, '');
  if (family) {
    try {
      await loadGoogleFont(family);
      // Force the face fetch — the stylesheet alone doesn't download
      // display=swap faces until first use.
      await document.fonts.load(`100px "${family}"`);
    } catch { /* measure with whatever loaded — better than nothing */ }
  }

  const refit = calculateFitRefit(textNode.textContent ?? '', {
    fontFamily: styles.fontFamily,
    fontWeight: styles.fontWeight,
    letterSpacing: styles.letterSpacing,
    fontStyle: styles.fontStyle,
    // Authored value, verbatim — the height calc must match the rendered
    // line height (unitless or px both correct as written).
    lineHeight: styles.lineHeight,
  }, vbWidth);
  if (!refit) return;

  // Base-preserving viewBox write — a plain updateHtmlAttrs would replace a
  // per-viewport responsive ternary (replica overrides) with the bare string.
  queueMutation({ type: 'setResponsiveAttrBase', nodeId: svgId, attr: 'viewBox', value: `0 0 ${vbWidth} ${refit.height}` });
  queueMutation({ type: 'updateStyles', nodeId: innerId, styles: { fontSize: `${refit.fontSize}px`, marginTop: `${refit.marginTop}px` } });
  // FIT contract: wrapper height AUTO (viewBox owns the aspect) — normalize a
  // fixed px height left by a canvas drag round-trip.
  const svgHeight = (svgNode.styles as Record<string, string> | undefined)?.height;
  if (svgHeight && svgHeight !== 'auto') {
    queueMutation({ type: 'updateStyles', nodeId: svgId, styles: { height: 'auto' } });
  }
  flushNow();
  forceCanvasRender();
  trace.action('fit-refit:done', { svgId, innerId, vbWidth, height: refit.height, fontSize: refit.fontSize, overrides: styleOverrides });
}
