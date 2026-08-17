// viewport-width-rewrite.ts — ONE entry point for "a viewport's breakpoint
// width changed": re-stamps every width-keyed artifact in the ACTIVE file.
// Shared by both width-change surfaces (the SizeTool breakpoint input and
// the SelectionOverlay tile drag) so they cannot drift apart.
//
// THE ACTIVE FILE ONLY — deliberately. A templated page's LayoutClient
// carries its own `/** @canvas */` widths, bands and gates, and those key
// off the TEMPLATE's breakpoints by design: on canvas AND on the published
// site the template chrome evaluates against the actual width with its own
// keys, so a page tile resized to 1110 correctly shows desktop chrome
// (1110 IS desktop for the template). An earlier version propagated the
// resize into the LayoutClient to "converge" the two files — which
// silently resized the template's own editing viewports ("when I increase
// the page's mobile it increases the width of the TEMPLATE, the template
// should be completely intact", 2026-08-18). The bug that motivated the
// propagation was actually the normalize-ordering destruction, fixed at
// the call sites (rewrite BEFORE the @canvas config write).

import { modifyProjectFile } from '@/code/project/modify-file';
import { getSortedBreakpointWidths } from '@/code/stores/viewport-store';
import {
  rewriteContainerBreakpoints,
  rewriteResponsiveBreakpoints,
  rewriteResponsiveTextBreakpoints,
} from '@/code/generation/generator-styles';
import { rewriteAnimationBreakpoints } from '@/code/animations/animation-scope';

/** The four width-keyed rewrites every width change needs, in one place:
 *  @media style bands, animation media-query gates (useMediaQuery consts +
 *  spec-attr `"query"` strings), component-instance `data-responsive`
 *  (per-viewport values + `_bp`), and width-keyed `useResponsiveText`. */
export function rewriteWidthKeyedArtifacts(code: string, oldWidth: number, newWidth: number): string {
  const widths = getSortedBreakpointWidths();
  return rewriteResponsiveTextBreakpoints(
    rewriteResponsiveBreakpoints(
      rewriteAnimationBreakpoints(
        rewriteContainerBreakpoints(code, oldWidth, newWidth),
        oldWidth, newWidth, widths),
      oldWidth, newWidth, widths),
    oldWidth, newWidth, widths);
}

/**
 * Apply a viewport width change to the active file. Callers keep their own
 * atom updates (viewportWidthsAtom / viewportsConfigAtom) — this owns only
 * the source rewrite, and MUST run before the @canvas config write (see the
 * call-site comments: normalize keys off the file's own config).
 */
export function applyViewportWidthChange(activeFilePath: string, vpId: string, oldWidth: number, newWidth: number): void {
  void vpId; // kept for call-site symmetry with the drag path's resizedVpId
  if (oldWidth === newWidth) return;
  modifyProjectFile(activeFilePath, code => rewriteWidthKeyedArtifacts(code, oldWidth, newWidth));
}
