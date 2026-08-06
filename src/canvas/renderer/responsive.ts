// responsive.ts — the Renderer's responsive-override cache: @media /
// @container parsing plus per-node override resolution. Extracted verbatim
// from Renderer.ts (Phase 7 split). The cache is refreshed once per
// renderNodes pass through the setters at the bottom; readers use the live
// ESM bindings (assigning to an imported binding is illegal).

import { pinnedResolveWidth } from '../resize/viewport-band-pin-store';

// ─── Responsive Override Cache ────────────────────────────────────────────
// Parsed once per renderNodes call. Used by patchElement to merge @media overrides
// into inline styles, preventing the flicker caused by CSS !important fighting
// with Renderer-applied inline styles.

interface ResponsiveBreakpoint {
  maxWidth: number;
  minWidth: number; // 0 if no min-width specified
  nodes: Map<string, Map<string, string>>; // nodeId → prop (kebab) → value
}

export let _responsiveBreakpoints: ResponsiveBreakpoint[] = [];

// True while the current renderNodes pass is painting a COMPONENT MASTER (a file with `variantConfig`).
// A master has one narrow viewport (e.g. 462px) and shows every variant side by side — but a typography
// preset's responsive @container rules (`max-width: 1199` / `599`) would then BOTH match that narrow
// width and resolve to the SMALLEST tier (8px), even though the live site / component preview renders the
// DESKTOP (largest) tier. So on the master we ignore max-width overrides and fall back to the base
// (desktop / highest-breakpoint) styles. Per-viewport resolution still applies on real page tiles.
export let _isComponentMaster = false;

/**
 * All configured viewport widths, ascending. Refreshed on every renderNodes
 * pass (mirrors `_responsiveBreakpoints`). The text-override resolution in
 * `patchElement` uses this to bucket each render pass's `vpWidth` into the
 * smallest viewport whose width is >= vpWidth, then looks up that bucket's
 * override (if any). Without this, an override at width 768 would also fire
 * for a mobile viewport at 375 because `375 ≤ 768`.
 */
export let _allViewportWidthsAsc: number[] = [];

/** Parse @media rules from CSS, capturing BOTH max-width and min-width */
export function parseResponsiveBreakpoints(css: string): ResponsiveBreakpoint[] {
  const breakpoints: ResponsiveBreakpoint[] = [];
  const regex = /@(?:media|container)\s*\(max-width:\s*(\d+)px\)(?:\s*and\s*\(min-width:\s*([\d.]+)px\))?\s*\{/g;
  let match;

  while ((match = regex.exec(css)) !== null) {
    const maxWidth = parseInt(match[1]);
    const minWidth = match[2] ? parseFloat(match[2]) : 0;
    const blockStart = match.index + match[0].length;

    let depth = 1, blockEnd = blockStart;
    while (depth > 0 && blockEnd < css.length) {
      if (css[blockEnd] === '{') depth++;
      if (css[blockEnd] === '}') depth--;
      blockEnd++;
    }

    const blockContent = css.slice(blockStart, blockEnd - 1);
    const nodes = new Map<string, Map<string, string>>();
    const selectorRegex = /\[data-id="([^"]+)"\]\s*\{([^}]*)\}/g;
    let selMatch;
    while ((selMatch = selectorRegex.exec(blockContent)) !== null) {
      // Skip :lang()-scoped rules — locale overrides paint via the injected
      // @container CSS gated on the container's lang attr; merging them here
      // would apply one locale's values inline on EVERY locale.
      const before = blockContent.slice(Math.max(0, selMatch.index - 80), selMatch.index);
      if (/:lang\([^)]*\)\s*(?:\[data-variant="[^"]*"\]\s*)?$/.test(before)) continue;
      const id = selMatch[1];
      const props = nodes.get(id) ?? new Map<string, string>();
      for (const decl of selMatch[2].split(';').filter(d => d.trim())) {
        const colonIdx = decl.indexOf(':');
        if (colonIdx === -1) continue;
        const prop = decl.slice(0, colonIdx).trim();
        const val = decl.slice(colonIdx + 1).trim().replace(/\s*!important\s*$/, '').trim();
        props.set(prop, val);
      }
      nodes.set(id, props);
    }

    breakpoints.push({ maxWidth, minWidth, nodes });
  }

  return breakpoints;
}

/** Remove every @media / @container block (balanced braces) from a CSS string. Used on the component
 *  master, where typography-preset responsive rules (`@media … { font-size: … !important }`) would
 *  otherwise override the inline desktop value on the narrow master tiles. The master must always paint
 *  the highest breakpoint, so we drop the responsive CSS entirely (the inline base/desktop value wins). */
export function stripResponsiveBlocks(css: string): string {
  if (!css.includes('@media') && !css.includes('@container')) return css;
  const re = /@(?:media|container)\b[^{]*\{/g;
  let result = '';
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    result += css.slice(lastIndex, m.index);
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    lastIndex = j;
    re.lastIndex = j;
  }
  result += css.slice(lastIndex);
  return result;
}

/** Resolve @media overrides for a node at a given viewport width */
export function getResponsiveOverridesForNode(nodeId: string, vpWidth: number | undefined): Record<string, string> {
  if (!vpWidth || _responsiveBreakpoints.length === 0) return {};
  // During a viewport-width drag, page nodes on the dragged tile resolve at
  // the gesture's START width (template chrome stays live) — see
  // viewport-band-pin-store. No-op outside the gesture.
  vpWidth = pinnedResolveWidth(nodeId, vpWidth);
  // Component master → always the highest breakpoint (base/desktop). See `_isComponentMaster`.
  if (_isComponentMaster) return {};
  const overrides: Record<string, string> = {};

  // Apply matching breakpoints — most specific (smallest range) wins.
  // Sort by maxWidth ascending so smaller breakpoints override larger ones.
  const sorted = [..._responsiveBreakpoints].sort((a, b) => a.maxWidth - b.maxWidth);

  for (const bp of sorted) {
    // Check BOTH max-width AND min-width conditions
    if (vpWidth <= bp.maxWidth && vpWidth >= bp.minWidth) {
      const nodeOverrides = bp.nodes.get(nodeId);
      if (nodeOverrides) {
        for (const [prop, val] of nodeOverrides) {
          const camelProp = prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
          overrides[camelProp] = val; // smaller breakpoints override larger ones
        }
      }
    }
  }

  return overrides;
}

export function setResponsiveBreakpoints(bps: ResponsiveBreakpoint[]): void {
  _responsiveBreakpoints = bps;
}

export function setIsComponentMaster(v: boolean): void {
  _isComponentMaster = v;
}

export function setAllViewportWidthsAsc(widths: number[]): void {
  _allViewportWidthsAsc = widths;
}

// ─── Template (layout) CSS pushed from the parent ───────────────────────────
// renderNodes runs in the SANDBOX iframe, where projectFS is a stub — its own
// fs-based LayoutClient CSS merge reads nothing there. The parent computes the
// prefixed layout CSS (useRendererSync) and ships it with the render command;
// renderNodes prefers this pushed value and only falls back to the fs path
// when it was never pushed (parent-side DirectBridge renders, tests).
let _pushedLayoutCss: string | null = null;

export function setPushedLayoutCss(css: string | null): void {
  _pushedLayoutCss = css;
}

export function getPushedLayoutCss(): string | null {
  return _pushedLayoutCss;
}
