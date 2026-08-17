// animation-scope.ts — Pure logic for scoping animations per breakpoint (pages)
// or per variant (components). No DOM, no React — fully testable.
//
// THE MODEL:
//   - PAGE animations gate on WIDTH. There are no runtime viewport ids on the
//     live site — only the `@media` blocks have effect — so a page animation is
//     scoped to a SET of viewport widths, compiled to ONE media-query string
//     (banded exactly like the @media style overrides: a viewport at width W
//     owns `(max-width: W) and (min-width: nextSmaller+1)`). motion reads the
//     query through a `useMediaQuery` hook.
//   - COMPONENT animations gate on the runtime `variant` / `initialVariant`
//     variable — a NAME, so they're immune to resize/infinite (no px).
//
// GRANULARITY: motion props + standalone GSAP calls scope per-element; GSAP
// TIMELINES scope as a whole (a "runs-on" viewport set → one matchMedia wrap),
// NEVER per-step. The px in page queries is machine-written and re-stamped by
// the breakpoint-rewrite pass on resize — the editor owns it, never the user.

export type AnimationScope =
  | { kind: 'all' }
  // Pages: the set of viewport max-widths this animation runs on. Stored as the
  // SAME max-width keys the @media override system uses (container-query-store).
  | { kind: 'viewports'; widths: number[] }
  // Components: the variant name this animation runs in.
  | { kind: 'variant'; name: string };

// ─── Banding (pages) ────────────────────────────────────────────────────────

/**
 * The media-query band a single viewport width owns, given the full sorted
 * (descending) viewport-width list. The min edge is the next-smaller width
 * + 0.02 — the same fractional seam the @media style bands use (and the
 * media-band-dialect oracle rule mandates). An integer `+ 1` bound leaves a
 * 1px-wide hole: real Android phones report FRACTIONAL CSS widths (1080
 * physical / DPR 2.875 = 375.65px), which matched neither `(max-width:
 * 375px)` nor `(min-width: 376px)` — so a scroll-variant's banded gate fell
 * through to the DESKTOP target mid-scroll (the rapid-studio-345 nav,
 * 2026-08-17). The LARGEST width (primary) has no max edge (open top band).
 *
 *   widths [1470, 768, 375]:
 *     1470 → { min: 768.02 }              (desktop / primary — open top)
 *      768 → { min: 375.02, max: 768 }    (tablet)
 *      375 → { max: 375 }                 (mobile — open bottom)
 */
export function viewportBand(width: number, allWidths: number[]): { min?: number; max?: number } {
  const sorted = [...allWidths].sort((a, b) => b - a);
  const idx = sorted.indexOf(width);
  if (idx === -1) return {};
  const band: { min?: number; max?: number } = {};
  // Not the largest → has a max edge at its own width.
  if (idx > 0) band.max = width;
  // Not the smallest → min edge fractionally above the next-smaller width.
  if (idx < sorted.length - 1) band.min = sorted[idx + 1] + 0.02;
  return band;
}

function bandToQuery(band: { min?: number; max?: number }): string {
  const parts: string[] = [];
  if (band.max !== undefined) parts.push(`(max-width: ${band.max}px)`);
  if (band.min !== undefined) parts.push(`(min-width: ${band.min}px)`);
  return parts.join(' and ');
}

/**
 * One media-query string covering a SET of viewport widths (a timeline's
 * "runs-on" set, or a per-element page scope). Contiguous sets collapse to a
 * single `(min)…(max)` range; non-contiguous sets comma-join (CSS media OR).
 * The full set (all widths) returns '' — meaning "no wrapper, runs everywhere".
 */
export function viewportSetToQuery(widths: number[], allWidths: number[]): string {
  const sorted = [...allWidths].sort((a, b) => b - a);
  const enabled = sorted.filter(w => widths.includes(w));
  if (enabled.length === 0) return 'none';            // never runs (a disabled animation)
  if (enabled.length === sorted.length) return '';    // runs everywhere → no wrapper

  // Group enabled widths into contiguous runs (by index in `sorted`).
  const idxs = enabled.map(w => sorted.indexOf(w)).sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const i of idxs) {
    const last = runs[runs.length - 1];
    if (last && i === last[last.length - 1] + 1) last.push(i);
    else runs.push([i]);
  }
  // Each contiguous run → one band: min = lowest-index member's max+? ... compute
  // from the run's widest (lowest index) and narrowest (highest index) members.
  const queries = runs.map(run => {
    const widest = sorted[run[0]];       // lowest index = largest width
    const narrowest = sorted[run[run.length - 1]];
    const top = viewportBand(widest, sorted);        // open or maxed at widest
    const bottom = viewportBand(narrowest, sorted);  // open or minned at narrowest
    return bandToQuery({ max: top.max, min: bottom.min });
  });
  return queries.join(', ');
}

/**
 * Parse a media-query string back to the set of viewport widths it covers
 * (inverse of viewportSetToQuery) so the tool can show an animation on the
 * right tiles + drive Reset. '' (no wrapper) = every width.
 */
export function queryToViewportSet(query: string, allWidths: number[]): number[] {
  const sorted = [...allWidths].sort((a, b) => b - a);
  const q = query.trim();
  if (q === '' ) return [...sorted];
  if (q === 'none') return [];
  const out = new Set<number>();
  for (const clause of q.split(',')) {
    const maxM = clause.match(/max-width:\s*(\d+)px/);
    const minM = clause.match(/min-width:\s*([\d.]+)px/);
    const max = maxM ? parseInt(maxM[1], 10) : Infinity;
    const min = minM ? parseFloat(minM[1]) : 0;
    // A width belongs to this clause when its OWN band sits inside [min, max].
    // The min comparison carries a sub-1px tolerance so LEGACY integer bounds
    // still resolve: an old `min-width: 376px` and the current fractional seam
    // `min-width: 375.02px` both encode "just above the 375 breakpoint", and
    // rewriteAnimationBreakpoints must keep recognising wild files written
    // before the seam migration. Viewport widths are ≥1px apart, so the
    // tolerance can never leak a width into a neighbouring band.
    for (const w of sorted) {
      const b = viewportBand(w, sorted);
      const wTop = b.max ?? Infinity;     // the width's upper edge
      const wBottom = b.min ?? 0;          // the width's lower edge
      if (wBottom >= min - 0.99 && wTop <= max) out.add(w);
    }
  }
  return sorted.filter(w => out.has(w));
}

/**
 * Re-stamp animation media-query gates after a viewport is RESIZED, so the
 * responsive whileHover/whileTap (and any `useMediaQuery('…')`) overrides keep
 * matching the viewport they belong to. Mirrors `rewriteContainerBreakpoints`
 * for `@media`, but for the `__mqN = useMediaQuery('…')` consts.
 *
 * `newWidths` is the viewport list AFTER the resize (the resized vp is `newWidth`).
 * For each gate: find which viewport widths its query covered (under the OLD
 * widths), move the resized one (oldWidth → newWidth), and recompute the query
 * with the new widths. Re-stamps ALL gates, so a neighbour's min-width floor
 * shifts too (resizing mobile widens tablet's lower bound). Pure — no store access.
 */
export function rewriteAnimationBreakpoints(
  code: string, oldWidth: number, newWidth: number, newWidths: number[],
): string {
  if (oldWidth === newWidth) return code;
  // Widths as they were BEFORE the resize (the resized vp was `oldWidth`).
  const oldWidths = newWidths.map(w => (w === newWidth ? oldWidth : w));
  const mapQuery = (query: string): string | null => {
    if (!query) return null;
    let covered = queryToViewportSet(query, oldWidths);
    // ORPHAN heal (drift): a query whose widths match NO current viewport
    // (stale from an earlier unsynced resize) covers nothing — claim it for
    // the resized viewport when its max bound buckets there (smallest old
    // width ≥ the query's max is the resized one). Mirrors the @media
    // orphan-band claim in rewriteContainerBreakpoints.
    if (covered.length === 0) {
      const maxM = query.match(/max-width:\s*(\d+)px/);
      if (maxM) {
        const m = parseInt(maxM[1], 10);
        const owner = oldWidths.filter(w => w >= m).sort((a, b) => a - b)[0];
        if (owner === oldWidth) covered = [oldWidth];
      }
      if (covered.length === 0) return null;
    }
    const newCovered = covered.map(w => (w === oldWidth ? newWidth : w));
    const newQuery = viewportSetToQuery(newCovered, newWidths);
    if (!newQuery || newQuery === 'none') return null;   // empty/degenerate → leave as-is
    return newQuery;
  };
  // 1. `useMediaQuery('…')` hook consts (responsive hover/tap gates, scroll-variant gates).
  let out = code.replace(/useMediaQuery\(\s*'([^']*)'\s*\)/g, (full, query: string) => {
    const nq = mapQuery(query);
    return nq ? `useMediaQuery('${nq}')` : full;
  });
  // 2. `"query":"…"` strings inside JSON spec attrs (data-scroll-variant
  //    responsive scopes, instance-fx, glide). These are the SOURCE the
  //    generators rebuild the gates from — leaving them stale meant the next
  //    re-save of the effect regenerated the OLD (pre-resize) queries.
  out = out.replace(/"query":"((?:[^"\\]|\\.)*)"/g, (full, query: string) => {
    const nq = mapQuery(query);
    return nq ? `"query":"${nq}"` : full;
  });
  return out;
}

// ─── motion prop wrapping ─────────────────────────────────────────────────────

/**
 * Wrap a motion prop VALUE expression for a scope. The `initial`/entry prop uses
 * `false` off-scope (no entrance); other props use `undefined`.
 *
 *   variant   → `variant === 'variant-2' ? <value> : <off>`
 *   viewport  → `<gateVar> ? <value> : <off>`   (gateVar = a useMediaQuery bool)
 *   all       → `<value>` unchanged
 */
export function scopeMotionPropValue(
  valueExpr: string,
  scope: AnimationScope,
  opts: { variantVar?: string; gateVar?: string; off?: 'false' | 'undefined' } = {},
): string {
  const off = opts.off ?? 'undefined';
  if (scope.kind === 'all') return valueExpr;
  if (scope.kind === 'variant') {
    const v = opts.variantVar ?? 'variant';
    return `${v} === '${scope.name}' ? ${valueExpr} : ${off}`;
  }
  // viewport scope is driven by a boolean the caller computed via useMediaQuery.
  return `${opts.gateVar ?? 'inScope'} ? ${valueExpr} : ${off}`;
}

// ─── Resolved scope (what the generators consume) ────────────────────────────
//
// The generators are pure (no store access), so the TOOL resolves an
// AnimationScope → ResolvedScope first: a variant NAME, or an already-banded
// media-query string, or null = "all" (no scope). `resolveScope` does the
// banding via viewportSetToQuery so the generators never need the width list.

export type ResolvedScope = { variant: string } | { query: string } | null;

export function resolveScope(scope: AnimationScope, allWidths: number[]): ResolvedScope {
  if (scope.kind === 'all') return null;
  if (scope.kind === 'variant') return { variant: scope.name };
  const q = viewportSetToQuery(scope.widths, allWidths);
  return q === '' ? null : { query: q };   // full set → no scope
}

/**
 * Wrap a motion prop VALUE for a resolved scope. `gateVar` is the boolean a
 * useMediaQuery hook produced for a viewport scope (the caller injects it).
 *   variant  → `variant === 'x' ? <value> : <off>`
 *   viewport → `<gateVar> ? <value> : <off>`
 *   null     → <value> unchanged
 */
export function scopeMotionValueResolved(
  valueExpr: string,
  scope: ResolvedScope,
  opts: { variantVar?: string; gateVar?: string; off?: 'false' | 'undefined' } = {},
): string {
  if (!scope) return valueExpr;
  const off = opts.off ?? 'undefined';
  if ('variant' in scope) return `${opts.variantVar ?? 'variant'} === '${scope.variant}' ? ${valueExpr} : ${off}`;
  // Page viewport: gate on a `useMediaQuery` boolean (REACTIVE — re-renders on
  // resize so the prop updates when you cross a breakpoint). `undefined`/`false`
  // off-band is a TRUE removal of the prop, which CSS vars can't express. The
  // caller injects the hook + const and passes its var as `gateVar`; the inline
  // matchMedia fallback is only for when no gateVar is supplied (NOT reactive).
  const gate = opts.gateVar ?? `(typeof window !== 'undefined' && window.matchMedia('${scope.query}').matches)`;
  return `${gate} ? ${valueExpr} : ${off}`;
}

// ─── GSAP per-prop responsive SCALAR values ──────────────────────────────────
//
// GSAP hover gates each individual prop value (not the whole prop object like
// motion): `scale: <gate> ? <override> : <base>`. The gate is INLINE matchMedia
// (the handler runs on each hover → naturally re-evaluated, no hook needed) or a
// `variant === 'x'` test. Chained for multiple viewports:
