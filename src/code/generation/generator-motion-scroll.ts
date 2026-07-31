// generator-motion-scroll.ts — scroll-linked animation (useScroll + useTransform
// + useMotionTemplate), multi-section milestones, and direction-triggered scroll.
// All code moved VERBATIM from generator-motion.ts (Phase 7.4 god-file split).
import { escapeRegExp } from '@/shared/regex-utils';
import { nodeIdToVarName } from '@/shared/id-utils';
import { parseScrollHooks, getScrollDataForNode } from '../parsing/scroll-parser';
import { trace } from '@/shared/debug-trace';
import { findTagClose, findJSXDataIdIndex, insertBeforeRenderReturn, findMatchingCloseTagIndex, findStyleObjectEnd } from './generator-utils';
import { ensureMediaQueryHook, ensureMediaGate, type SerScope } from './scoped-expr';
import { MOTION_NEUTRALS, getJSXStyleValue, buildSpringParams } from './generator-motion-transition';
import { updateMotionPropInCode } from './generator-motion-props';
import { removeScrollAnimFromCode } from './generator-motion-scroll-fx';

// ─── Scroll-Linked Animation (useScroll + useTransform) ─────────────────────
// Clean generator matching AI patterns: short variable names, no markers.
// Parser in scroll-parser.ts reads the hooks back.

export type ScrollTrigger =
  | 'onScroll'          // page-level, no target ref
  | 'layerInView'       // this element passes through the viewport
  | 'sectionInView';    // another element (by anchor id) passes through the viewport

export const SCROLL_TRIGGER_OFFSETS: Record<ScrollTrigger, string> = {
  onScroll: '',
  // Layer-in-View matches the reference's snappy "completes as the element
  // becomes fully visible" feel. Range:
  //   progress 0 = element top hits viewport bottom (just entering)
  //   progress 1 = element bottom hits viewport bottom (fully entered)
  // Previously was `["start end", "end start"]` (full pass-through,
  // entire element width of scroll), which felt sluggish because the
  // animation stretched over `viewport + element` of scroll distance.
  layerInView: `["start end", "end end"]`,
  // Section-mode still uses the full pass-through by default (a section
  // is typically tall enough that you want progress to span its
  // traversal). Per-viewport overrides happen in the call site.
  sectionInView: `["start end", "end start"]`,
};

export const SCROLL_TRIGGER_LABELS: Record<ScrollTrigger, string> = {
  onScroll: 'On Scroll',
  layerInView: 'Layer in View',
  sectionInView: 'Section in View',
};

/** The `useScroll` offset for a Layer-in-View trigger at a chosen position of
 *  the layer against the viewport bottom (design-tool parity). The scrub runs from
 *  the layer's top entering the viewport (`"start end"`) to the chosen anchor:
 *   - top    → `"start start"`  (finishes when the layer TOP hits the viewport top — full pass-through, slowest)
 *   - center → `"start center"` (finishes when the layer top hits the viewport middle)
 *   - bottom → `"end end"`      (finishes when the layer BOTTOM hits the viewport bottom = fully entered — the default)
 *  These are the SAME three offsets `detectSectionViewportFromOffset` decodes,
 *  so the position round-trips for free. Shared by the page Scroll Transform
 *  (updateScrollAnimInCode) and the component-instance transform (instance-fx-gen).
 *  NOTE: ScrollVariant's layerInView is a discrete getBoundingClientRect threshold
 *  (LINE_FRACTION), NOT a scrubbed useScroll offset — it can't share this helper. */
export function layerInViewOffset(pos: 'top' | 'center' | 'middle' | 'bottom'): string {
  if (pos === 'top') return `["start end", "start start"]`;
  if (pos === 'center' || pos === 'middle') return `["start end", "start center"]`;
  return `["start end", "end end"]`; // bottom (default)
}

/** The `useScroll` offset for a Layer-in-View trigger scrubbed on the layer's
 *  EXIT (as it leaves the viewport off the TOP) rather than its entrance. Both
 *  anchors END at the viewport top (`"end start"` = layer bottom passed the top =
 *  fully gone); the position picks WHERE the scrub BEGINS:
 *   - top    → `["start start", "end start"]`  (starts when the layer TOP hits the viewport top — shortest exit)
 *   - center → `["start center", "end start"]` (starts when the layer top hits the viewport middle)
 *   - bottom → `["start end", "end start"]`     (starts the moment the layer enters the bottom = full pass-through)
 *  Progress stays pinned at 0 through the entrance AND any `position: sticky`
 *  hold, then runs 0→1 only as the layer slides up off the top — the mirror of
 *  layerInViewOffset. Decoded by detectLayerExitFromOffset (timing) +
 *  detectSectionViewportFromOffset (position). NOTE: `["start end", "end start"]`
 *  (bottom-exit) is the SAME string as sectionInView's default offset — the two
 *  are told apart by the section binding (hasSection), never by offset shape. */
export function layerInViewExitOffset(pos: 'top' | 'center' | 'middle' | 'bottom'): string {
  if (pos === 'top') return `["start start", "end start"]`;
  if (pos === 'center' || pos === 'middle') return `["start center", "end start"]`;
  return `["start end", "end start"]`; // bottom = full pass-through exit
}

/** True when a Layer-in-View offset scrubs the EXIT (leaves off the top) rather
 *  than the entrance. The tell is the SECOND anchor: exit offsets all end at the
 *  viewport top (`… "end start"]`), entrance offsets end at `start start` /
 *  `start center` / `end end`. Used by ScrollEditor to pre-fill the Enter/Exit
 *  timing control on re-open. */
export function detectLayerExitFromOffset(offset: string | null): boolean {
  if (!offset) return false;
  return /,\s*"end start"\s*\]/.test(offset.replace(/\s+/g, ' ').trim());
}

/** Detect the section viewport variant ('top' / 'middle' / 'bottom') from
 *  a raw offset string. Inverse of the generator's per-viewport offset
 *  selection above. Used by ScrollEditor to pre-fill the Viewport
 *  segmented control on re-open. Returns 'middle' when the offset doesn't
 *  match one of the known shapes (sensible default). */
export function detectSectionViewportFromOffset(offset: string | null): 'top' | 'middle' | 'bottom' {
  if (!offset) return 'middle';
  const clean = offset.replace(/\s+/g, ' ').trim();
  if (clean === `["start end", "start start"]`) return 'top';
  if (clean === `["start end", "end end"]`) return 'bottom';
  if (clean === `["start end", "start center"]`) return 'middle';
  // Layer-in-View EXIT shapes (see layerInViewExitOffset) — position lives in the
  // FIRST anchor (where the exit scrub begins), both end at "end start".
  if (clean === `["start start", "end start"]`) return 'top';
  if (clean === `["start center", "end start"]`) return 'middle';
  if (clean === `["start end", "end start"]`) return 'bottom';
  return 'middle';
}

/** Detect trigger type from a raw offset string.
 *  `hasSection` disambiguates `sectionInView` vs `layerInView` — both now
 *  use the same offset `["start end", "end start"]`. The difference is
 *  the `target` (own ref vs section element via getElementById), which
 *  the parser surfaces via `source.sectionId`. */
/** Decode the layerInView range slider value (0–1) back from a useScroll
 *  offset string. Recognizes the generator's emit shape
 *  `["start end", "start <P>%"]` and inverts the percentage to a range
 *  fraction. Returns null when the offset isn't a recognizable range
 *  shape (e.g. legacy `["start end", "end start"]` full pass-through).
 *  Falls back at the call site so the editor opens with a sensible
 *  default rather than empty state. */
export function detectLayerRangeFromOffset(offset: string | null): string | null {
  if (!offset) return null;
  const m = offset.match(/"start end"\s*,\s*"start\s+(\d+(?:\.\d+)?)%?"/);
  if (!m) return null;
  const pct = parseFloat(m[1]);
  if (!Number.isFinite(pct)) return null;
  // Inverse of the emit: range = 1 - pct/100
  const range = 1 - pct / 100;
  if (range <= 0 || range > 1) return null;
  return String(range);
}

export function detectTriggerFromOffset(offset: string | null, hasRef: boolean, hasSection = false): ScrollTrigger {
  if (!hasRef) return 'onScroll';
  if (!offset) return hasSection ? 'sectionInView' : 'layerInView';
  const clean = offset.replace(/\s+/g, ' ').trim();
  // Section binding is the strongest signal — when present, it's
  // sectionInView regardless of offset shape.
  if (hasSection) return 'sectionInView';
  for (const [trigger, expected] of Object.entries(SCROLL_TRIGGER_OFFSETS)) {
    if (trigger === 'onScroll' || !expected) continue;
    if (trigger === 'sectionInView') continue; // ambiguous with layerInView w/o a section
    if (clean === expected.replace(/\s+/g, ' ').trim()) return trigger as ScrollTrigger;
  }
  // Legacy: pre-fix files with the old `["start start", "end end"]` offset
  // get mapped back to sectionInView so the UI shows the right entry on
  // re-open. Re-saving will rewrite to the new offset shape.
  if (clean.includes('start start') && clean.includes('end end')) return 'sectionInView';
  if (clean.includes('start end') && clean.includes('end start')) return 'layerInView';
  // Layer-in-View with a custom range emits `["start end", "start <P>%"]`.
  if (/"start end"\s*,\s*"start\s+\d+(?:\.\d+)?%?"/.test(clean)) return 'layerInView';
  return 'layerInView';
}

// ─── Complex CSS value decomposition for useMotionTemplate ───────────────────

/**
 * Convert hex colors to rgba() so numeric extraction doesn't break them.
 * #fff → rgba(255, 255, 255, 1)
 * #ff00aa → rgba(255, 0, 170, 1)
 * #ff00aa80 → rgba(255, 0, 170, 0.5)
 */
function hexToRgba(css: string): string {
  return css.replace(/#([0-9a-fA-F]{3,8})\b/g, (match, hex) => {
    let r: number, g: number, b: number, a = 1;
    if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
    } else if (hex.length === 6) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    } else if (hex.length === 8) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
      a = Math.round((parseInt(hex.slice(6, 8), 16) / 255) * 100) / 100;
    } else {
      return match; // unknown format, keep as-is
    }
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  });
}

/**
 * Extract all numeric values from a CSS function string, returning the template and values.
 * Hex colors are first converted to rgba() to avoid extracting digits from color codes.
 * e.g., "polygon(20% 0%, 80% 100%)" → { template: "polygon(#% #%, #% #%)", values: [20, 0, 80, 100] }
 * e.g., "0 4px 8px #ff0000" → converted to "0 4px 8px rgba(255, 0, 0, 1)" first
 */
function extractCSSNumerics(css: string): { template: string; values: number[] } | null {
  // Convert hex colors to rgba() first so their digits aren't extracted as numbers
  const safe = hexToRgba(css);
  const values: number[] = [];
  // Replace all numeric values (including negative, decimal) with a placeholder
  const template = safe.replace(/-?[\d.]+/g, (match) => {
    values.push(parseFloat(match));
    return '\x00'; // placeholder
  });
  if (values.length === 0) return null;
  return { template, values };
}

/**
 * Decompose complex CSS values (polygon, filter, etc.) into individual useTransform calls
 * and a useMotionTemplate that reconstructs the CSS string.
 *
 * Returns generated code lines and the template variable name for style binding.
 */
function decomposeComplexCSSValue(
  outputs: string[],             // one value per stop, e.g., ["polygon(20% 0%, ...)", "polygon(25% 0%, ...)"]
  baseName: string,              // e.g., "heroStickyClipPath"
  sourceVar: string,             // e.g., "heroStickyProgress"
  inputRange: number[],          // e.g., [0, 1]
): { lines: string[]; templateVar: string } | null {
  // Extract numerics from each stop value
  const parsed = outputs.map(extractCSSNumerics);
  if (parsed.some(p => !p)) return null;

  const allParsed = parsed as { template: string; values: number[] }[];

  // Find max point count across all stops
  const maxCount = Math.max(...allParsed.map(p => p.values.length));
  if (maxCount === 0) return null;

  // Pad shorter stops by duplicating the last point to match the longest.
  // For polygon clip-paths: a repeated point at the same position is visually identical
  // but allows smooth interpolation between polygons with different point counts.
  // Also rebuild the template to match the padded structure.
  const isPolygon = outputs[0].startsWith('polygon');
  for (const p of allParsed) {
    if (p.values.length < maxCount) {
      const lastVal = p.values[p.values.length - 1];
      const secondLastVal = p.values.length >= 2 ? p.values[p.values.length - 2] : lastVal;
      while (p.values.length < maxCount) {
        // For polygons, duplicate the last point (x%, y% pair)
        if (isPolygon && maxCount - p.values.length >= 2) {
          p.values.push(secondLastVal, lastVal);
        } else {
          p.values.push(lastVal);
        }
      }
    }
  }

  // Use the template from the stop with the most points (it has all the slots)
  const templateSource = allParsed.reduce((a, b) => {
    // Find the original (pre-pad) parsed entry whose template has the most placeholders
    const aCount = (a.template.match(/\x00/g) || []).length;
    const bCount = (b.template.match(/\x00/g) || []).length;
    return bCount > aCount ? b : a;
  });

  // If the template source doesn't have enough placeholders, rebuild it for polygons
  const templatePlaceholders = (templateSource.template.match(/\x00/g) || []).length;
  let finalTemplate = templateSource.template;
  if (templatePlaceholders < maxCount && isPolygon) {
    // Rebuild polygon template: polygon(\x00% \x00%, \x00% \x00%, ...)
    const pointCount = Math.floor(maxCount / 2);
    const pointSlots = Array.from({ length: pointCount }, () => '\x00% \x00%').join(', ');
    finalTemplate = `polygon(${pointSlots})`;
  }

  const lines: string[] = [];

  // Generate a useTransform per numeric slot
  const slotVarNames: string[] = [];
  for (let i = 0; i < maxCount; i++) {
    const slotVar = `${baseName}_${i}`;
    slotVarNames.push(slotVar);
    const slotValues = allParsed.map(p => p.values[i]);
    lines.push(`  const ${slotVar} = useTransform(${sourceVar}, [${inputRange.join(', ')}], [${slotValues.join(', ')}]);`);
  }

  // Build the useMotionTemplate string — replace each placeholder with ${varName}
  let slotIdx = 0;
  const templateStr = finalTemplate.replace(/\x00/g, () => `\${${slotVarNames[slotIdx++]}}`);
  const templateVar = baseName;
  lines.push(`  const ${templateVar} = useMotionTemplate\`${templateStr}\`;`);

  return { lines, templateVar };
}

export interface ScrollAnimConfig {
  nodeId: string;
  trigger: ScrollTrigger;
  /** Single-section mode: the data-id of the section to track. Kept for
   *  backward-compat with existing files and as a shorthand when there's
   *  only one section. When `sections` is set, that takes precedence. */
  sectionId?: string;
  /** For sectionInView: where in the viewport the section is when the
   *  animation reaches its To state.
   *  - 'top'    → section's top at viewport's top   (full pass-through, slowest)
   *  - 'middle' → section's top at viewport's center (default)
   *  - 'bottom' → section's bottom at viewport's bottom (fully entered, fastest)
   *  All three start at "section's top entering viewport bottom" (progress 0).
   *  The offset differs only on the endpoint. */
  sectionViewport?: 'top' | 'middle' | 'bottom';
  /** Layer-in-View only: fraction (0–1) of the viewport height that the
   *  animation occupies, measured from the moment the element enters the
   *  viewport. e.g. 0.3 = TO state reached after the user has scrolled
   *  30% of a viewport-height past entry. Maps to the useScroll offset
   *  endpoint as `"start <100*(1-range)>%"`. */
  layerRange?: string;
  /** Layer-in-View timing: when true, scrub the layer's EXIT (as it leaves off
   *  the top) instead of its entrance. Uses layerInViewExitOffset(sectionViewport)
   *  for the offset. The classic "shrink a `position: sticky` element only as it
   *  releases and slides away" needs this — the entrance scrub finishes the moment
   *  the element sticks. Round-trips via detectLayerExitFromOffset. */
  layerExit?: boolean;
  /** Multi-section mode (sectionInView only): ordered list of milestones.
   *  Each entry is a section anchor + the property values at that
   *  milestone. The page-level scroll progress drives interpolation
   *  through `fromProps → sections[0].props → sections[1].props → …`.
   *  Single-section shape (one milestone) is also supported here. */
  sections?: { sectionId: string; props: Record<string, string> }[];
  /** Multi-section mode: the property values BEFORE any section is in
   *  view. Pre-first-section state. */
  fromProps?: Record<string, string>;
  /** Array of scroll stops — each stop has a progress value (0-1) and property values */
  stops: { progress: number; props: Record<string, string> }[];
  /** Smooth spring config (optional — backward compat: true = default spring) */
  smooth?: boolean;
  /** Full transition config (overrides smooth when provided) */
  transition?: Record<string, string>;
  /** On-Scroll (the reference) direction: 'down' (default) animates resting→To as you
   *  scroll DOWN; 'up' reverses (output range flipped). */
  direction?: 'down' | 'up';
  /** On-Scroll (the reference) replay: true (default) = scrubbed, reverses on scroll
   *  back; false = plays once and LATCHES (a peak-progress motion value, so it
   *  doesn't reverse). */
  replay?: boolean;
}

/**
 * Generate or update scroll-linked animation hooks matching AI patterns.
 * Generates clean code like:
 *   const heroRef = useRef(null);
 *   const { scrollYProgress: heroProgress } = useScroll({ target: heroRef, offset: [...] });
 *   const heroOpacity = useTransform(heroProgress, [0, 1], [0, 1]);
 */
export function updateScrollAnimInCode(code: string, config: ScrollAnimConfig): string {
  trace.fn('generator.updateScrollAnimInCode', { nodeId: config.nodeId, trigger: config.trigger, sectionId: config.sectionId, sectionCount: config.sections?.length, stopCount: config.stops.length });

  // Multi-section dispatch: when the caller provides `sections[]` with
  // 2+ entries, route to the page-scroll + computed-positions generator.
  // 1-section flows still use the existing single-section path below so
  // we don't churn already-working files.
  if (config.trigger === 'sectionInView' && config.sections && config.sections.length >= 2) {
    return updateMultiSectionScrollAnimInCode(code, config);
  }

  const { nodeId, trigger, sectionId, stops, smooth, transition } = config;
  // Clean variable name from node ID (e.g., "hero-section" → "heroSection")
  const cleanName = nodeIdToVarName(nodeId);
  const refName = `${cleanName}Ref`;
  const progressName = `${cleanName}Progress`;

  // Section mode: trigger=sectionInView with a sectionId picked → useScroll
  // targets the section element (resolved at mount via getElementById), NOT
  // this element. Drives one element's animation from another element's
  // scroll position. Mirrors the reference's pattern.
  const useSectionRef = trigger === 'sectionInView' && !!sectionId;

  // Resolve whether to use spring wrapping and with what params.
  // Two spring shapes from the Transition panel:
  //   - physics: { stiffness, damping, mass }   → useSpring(v, { stiffness, damping, mass, restDelta })
  //   - time:    { duration, bounce }           → useSpring(v, { duration, bounce })
  // The earlier version only handled physics and fell back to a HARDCODED
  // soft spring (stiffness:100, damping:30) for the time-based path —
  // which is why a 0.3s/0.25-bounce config felt slow & laggy on scroll
  // (the soft spring lags far behind scrollYProgress).
  const isInstant = transition?.type === 'instant';
  const useSpringWrap = transition
    ? transition.type === 'spring'
    : !!smooth; // backward compat
  const springParams = buildSpringParams(transition);

  // Build hook lines
  const lines: string[] = [];

  // useRef — not needed for onScroll (whole-page useScroll has no target).
  if (trigger !== 'onScroll') lines.push(`  const ${refName} = useRef(null);`);

  // Section mode: resolve the ref at mount via document.getElementById.
  // This is how the reference drives one element's animation from another element's
  // scroll position — useScroll polls ref.current.getBoundingClientRect()
  // each frame, so the ref doesn't need to be attached via JSX `ref={}`.
  //
  // The `|| document.body` fallback prevents a crash when the picked
  // section element has been deleted or renamed since the scroll transform
  // was authored. Without it, getElementById returns null, ref.current
  // stays null, and useScroll throws "Target ref is defined but not
  // hydrated" — which tears down the entire page render. Falling through
  // to body means the animation effectively no-ops (body scroll doesn't
  // change), but the page still loads and the rest of the canvas works.
  if (useSectionRef) {
    lines.push(`  useEffect(() => { ${refName}.current = document.getElementById('${sectionId}') || document.body; }, []);`);
  }

  // useScroll
  // Section-in-View viewport variants. The endpoint (offset[1]) controls
  // where in the viewport the section finishes the animation. Default is
  // 'middle' — the most natural feel (animation completes as the section
  // crosses the viewport center).
  let offsetStr = SCROLL_TRIGGER_OFFSETS[trigger];
  if (useSectionRef) {
    const vp = config.sectionViewport || 'middle';
    if (vp === 'top') offsetStr = `["start end", "start start"]`;
    else if (vp === 'bottom') offsetStr = `["start end", "end end"]`;
    else offsetStr = `["start end", "start center"]`; // middle (default)
  } else if (trigger === 'layerInView') {
    // Layer-in-View EXIT (scrub as the layer leaves off the top) — mirror of the
    // entrance scrub. Needed for the "shrink a sticky element only as it releases"
    // effect: the entrance offset finishes the instant the element sticks.
    if (config.layerExit) {
      offsetStr = layerInViewExitOffset(config.sectionViewport || 'top');
    }
    // Layer-in-View POSITION (top/center/bottom) — the trigger's control —
    // takes precedence and round-trips via detectSectionViewportFromOffset.
    else if (config.sectionViewport) {
      offsetStr = layerInViewOffset(config.sectionViewport);
    } else if (config.layerRange) {
      // Legacy range slider: <range> = fraction of viewport scrolled between
      // element-entry (progress 0) and TO state (progress 1). Endpoint is
      // `"start <100-(range*100)>%"`. range=1 → "start start", 0.3 → "start 70%".
      const r = parseFloat(config.layerRange);
      if (Number.isFinite(r) && r > 0 && r <= 1) {
        const pct = Math.round((1 - r) * 100);
        offsetStr = `["start end", "start ${pct}%"]`;
      }
    }
    // else: keep SCROLL_TRIGGER_OFFSETS.layerInView (bottom = "end end") default.
  }
  const scrollParts = [];
  if (trigger !== 'onScroll') scrollParts.push(`target: ${refName}`);
  if (offsetStr) scrollParts.push(`offset: ${offsetStr}`);
  const scrollArgs = scrollParts.length > 0 ? `{ ${scrollParts.join(', ')} }` : '';
  lines.push(`  const { scrollYProgress: ${progressName} } = useScroll(${scrollArgs});`);

  // Optional useSpring wrapping (not for instant or plain ease)
  const valueVar = useSpringWrap ? `${cleanName}Smooth` : progressName;
  if (useSpringWrap) {
    lines.push(`  const ${valueVar} = useSpring(${progressName}, ${springParams});`);
  }

  // Replay = false → LATCH the peak progress so the effect plays ONCE and stays
  // (doesn't reverse on scroll-back). A useRef tracks the max; the transform reads
  // the latched value instead of the live scroll progress.
  let transformSource = valueVar;
  if (config.replay === false) {
    const peakRef = `${cleanName}Peak`;
    transformSource = `${cleanName}Latched`;
    lines.push(`  const ${peakRef} = useRef(0);`);
    lines.push(`  const ${transformSource} = useTransform(${valueVar}, (v) => { if (v > ${peakRef}.current) ${peakRef}.current = v; return ${peakRef}.current; });`);
  }
  // Direction = 'up' → reverse the output range (resting↔To swap), so the effect
  // resolves as you scroll UP instead of down.
  const reverseOutput = config.direction === 'up';

  // useTransform for each animated property
  const inputRange = stops.map(s => s.progress);
  const allProps = new Set<string>();
  for (const stop of stops) {
    for (const key of Object.keys(stop.props)) allProps.add(key);
  }

  const styleBindings: Record<string, string> = {};
  let needsMotionTemplate = false;

  for (const prop of allProps) {
    const varName = `${cleanName}${prop.charAt(0).toUpperCase() + prop.slice(1)}`;
    const rawOutputs = stops.map(s => s.props[prop] ?? (prop === 'opacity' || prop === 'scale' ? '1' : '0'));
    // Direction 'up' flips the output range (resting↔To).
    const outputs = reverseOutput ? [...rawOutputs].reverse() : rawOutputs;
    // Skip properties where any stop has an empty value (empty = "not set")
    if (outputs.some(v => v === '')) continue;
    // Skip webkit-prefixed duplicates (e.g., WebkitMaskImage mirrors maskImage)
    if (prop.startsWith('Webkit') || prop.startsWith('webkit')) continue;
    const allNumeric = outputs.every(v => !isNaN(Number(v)));

    // Check if this property needs useMotionTemplate decomposition
    // Complex CSS functions (polygon, circle, blur, etc.) can't be interpolated by useTransform
    const needsDecomposition = !allNumeric && outputs.some(v => /\(/.test(v));

    if (needsDecomposition) {
      // Decompose complex CSS value into individual numeric useTransform calls + useMotionTemplate
      const decomposed = decomposeComplexCSSValue(outputs, varName, transformSource, inputRange);
      if (decomposed) {
        lines.push(...decomposed.lines);
        styleBindings[prop] = decomposed.templateVar;
        needsMotionTemplate = true;
      }
      // Whether decomposition succeeded or failed, don't fall through to regular useTransform
      // A raw useTransform with complex CSS strings won't interpolate — it'll just snap
      continue;
    }

    // Simple value — direct useTransform
    const outputStr = allNumeric ? `[${outputs.join(', ')}]` : `[${outputs.map(v => `"${v}"`).join(', ')}]`;
    lines.push(`  const ${varName} = useTransform(${transformSource}, [${inputRange.join(', ')}], ${outputStr});`);
    styleBindings[prop] = varName;
  }

  let result = code;

  // Builder-named scroll hooks for THIS node — remove up front by cleanName. The
  // parser-based source-tracing cleanup below can't follow the Replay latch (the
  // prop transforms read the LATCHED var, not the scroll source), so without this
  // the old useScroll/useSpring/latch survive and the new ones duplicate them
  // (`Identifier '…Progress' has already been declared`).
  // Purge legacy `// @scroll dir:… replay:…` markers (a prior approach — now
  // inferred from code; clean up any that accumulated).
  result = result.replace(/\s*\/\/\s*@scroll\s+dir:\w+\s+replay:\w+/g, '');
  const cnEsc = escapeRegExp(cleanName);
  result = result.replace(new RegExp(`\\s*const \\{\\s*scrollYProgress:\\s*${cnEsc}Progress\\s*\\} = useScroll\\([\\s\\S]*?\\);`, 'g'), '');
  result = result.replace(new RegExp(`\\s*const ${cnEsc}Smooth = useSpring\\([\\s\\S]*?\\);`, 'g'), '');
  result = result.replace(new RegExp(`\\s*const ${cnEsc}Peak = useRef\\(0\\);`, 'g'), '');
  result = result.replace(new RegExp(`\\s*const ${cnEsc}Latched = useTransform\\([\\s\\S]*?\\}\\);`, 'g'), '');

  // Section-mode upfront cleanup: strip any existing ref attribute on JSX
  // AND any prior `const ${refName} = useRef(null);` declaration. Running
  // this BEFORE the parser-based cleanup means we don't depend on the
  // parser finding bindings or the source's refVar to land cleanly —
  // section mode needs both gone, full stop. The previous useEffect (if
  // any) is overwritten anyway when the new hookLines re-emit one.
  if (useSectionRef) {
    result = result.replace(new RegExp(`\\s*ref=\\{${refName}\\}`, 'g'), '');
    result = result.replace(new RegExp(`\\s*const ${refName} = useRef\\(null\\);`, 'g'), '');
    // Permissive useEffect match — body can be anything as long as it
     // references `${refName}.current` and ends with the standard `}, []);`
     // closer. The earlier strict shape failed once we added the
     // `|| document.body` fallback to the body, so every save was
     // appending a fresh useEffect on top of the stale ones (21 dupes
     // in 21 slider drags before this fix).
    result = result.replace(new RegExp(`\\s*useEffect\\(\\s*\\(\\)\\s*=>\\s*\\{[^}]*${refName}\\.current[^}]*\\},\\s*\\[\\]\\);`, 'g'), '');
  }

  // ── Remove old hooks using the scroll parser (handles AI-generated names) ──
  // The parser finds the ACTUAL variable names bound to this node's style,
  // regardless of naming convention (AI uses heroScale, builder uses heroStickyScale, etc.)
  const parsed = parseScrollHooks(code);
  const nodeScroll = getScrollDataForNode(parsed, nodeId);

  // Track where the old ref was placed — it may be on a DIFFERENT element than nodeId
  // (e.g., ref on hero-wrapper but transforms applied to hero-sticky child)
  let oldRefTargetNodeId: string | null = null;

  if (nodeScroll.bindings.length > 0) {
    // Collect actual transform var names bound to this node
    const oldTransformVars = new Set(nodeScroll.bindings.map(b => b.transformVar));
    // Find the source(s) driving those transforms
    const oldSourceVars = new Set(nodeScroll.transforms.map(t => t.sourceVar));
    // Check if other nodes share any of these sources (don't remove shared sources)
    const otherBindings = parsed.bindings.filter(b => b.nodeId !== nodeId);
    const otherTransformVars = new Set(otherBindings.map(b => b.transformVar));
    const otherSourceVars = new Set<string>();
    for (const t of parsed.transforms) {
      if (otherTransformVars.has(t.varName)) otherSourceVars.add(t.sourceVar);
    }

    // Remove old useTransform declarations by exact var name
    for (const varName of oldTransformVars) {
      const regex = new RegExp(`\\s*const ${varName} = (?:useSpring\\(\\s*)?useTransform\\([^;]*;`, 'g');
      result = result.replace(regex, '');
      // Also remove decomposed slot variables (varName_0, varName_1, ...) and useMotionTemplate
      result = result.replace(new RegExp(`\\s*const ${varName}_\\d+ = useTransform\\([^;]*;`, 'g'), '');
      // useMotionTemplate uses tagged template: const x = useMotionTemplate`...`;
      result = result.replace(new RegExp(`\\s*const ${varName} = useMotionTemplate\`[^\`]*\`;`, 'g'), '');
    }

    // Remove spring wrappers that feed into this node's transforms
    for (const t of nodeScroll.transforms) {
      if (t.isSpring && !otherTransformVars.has(t.varName)) {
        // Check if this is a standalone spring wrapping a progress var
        const springRegex = new RegExp(`\\s*const ${t.varName} = useSpring\\([^;]*;`);
        result = result.replace(springRegex, '');
      }
    }

    // Remove source + ref only if no other node uses them
    for (const srcVar of oldSourceVars) {
      if (!otherSourceVars.has(srcVar)) {
        // Also remove spring-smoothed variants of this source
        for (const t of parsed.transforms) {
          if (t.sourceVar === srcVar && t.isSpring && !otherTransformVars.has(t.varName)) {
            const smoothSpringRegex = new RegExp(`\\s*const ${t.varName} = useSpring\\([^;]*;`);
            result = result.replace(smoothSpringRegex, '');
          }
        }

        // If srcVar is itself a spring (e.g., heroStickySmooth), trace back to the scroll source
        const springTransform = parsed.transforms.find(t => t.varName === srcVar && t.isSpring);
        const actualScrollVar = springTransform ? springTransform.sourceVar : srcVar;

        // Remove the spring declaration if srcVar is a spring
        if (springTransform) {
          const springDeclRegex = new RegExp(`\\s*const ${srcVar} = useSpring\\([^;]*;`);
          result = result.replace(springDeclRegex, '');
        }

        // Remove useScroll declaration (using the actual scroll progress var)
        const scrollRegex = new RegExp(`\\s*const \\{[^}]*:\\s*${actualScrollVar}\\s*\\} = useScroll\\([\\s\\S]*?\\);`);
        result = result.replace(scrollRegex, '');
        // Find and remove the ref used by this source — but remember WHERE it was
        const src = parsed.sources.find(s => s.progressVar === actualScrollVar);
        if (src?.refVar) {
          // Remember which element the old ref was on (may differ from nodeId)
          const oldRefEntry = parsed.refs.find(r => r.varName === src.refVar);
          if (oldRefEntry && oldRefEntry.nodeId) {
            oldRefTargetNodeId = oldRefEntry.nodeId;
          }
          const refUsedElsewhere = parsed.sources.some(s => s.progressVar !== actualScrollVar && s.refVar === src.refVar);
          if (!refUsedElsewhere) {
            const oldRefRegex = new RegExp(`\\s*const ${src.refVar} = useRef\\(null\\);`);
            result = result.replace(oldRefRegex, '');
            // Remove old ref= from JSX element
            result = result.replace(new RegExp(`ref=\\{${src.refVar}\\}\\s*`, 'g'), '');
          }
        }
      }
    }

    // Remove old style bindings (the actual var names, not derived cleanName)
    const idPattern = `data-id="${nodeId}"`;
    const idIdx = findJSXDataIdIndex(result, nodeId);
    if (idIdx !== -1) {
      const tagStart = result.lastIndexOf('<', idIdx);
      const tagEnd = findTagClose(result, idIdx);
      if (tagStart !== -1 && tagEnd !== -1) {
        const styleStartIdx = result.indexOf('style={{', tagStart);
        if (styleStartIdx !== -1 && styleStartIdx < tagEnd) {
          const sStart = styleStartIdx + 'style={{'.length;
          const sClose = findStyleObjectEnd(result, sStart);
          if (sClose !== -1) {
            let styleContent = result.slice(sStart, sClose);
            for (const b of nodeScroll.bindings) {
              const bindRegex = new RegExp(`,?\\s*${b.property}:\\s*${b.transformVar}\\b`);
              styleContent = styleContent.replace(bindRegex, '');
            }
            // Clean leading comma after removals
            styleContent = styleContent.replace(/^\s*,/, '');
            result = result.slice(0, sStart) + styleContent + result.slice(sClose);
          }
        }
      }
    }

    trace.action('generator.updateScrollAnim:removedOldHooks', {
      nodeId, removedTransforms: [...oldTransformVars], removedSources: [...oldSourceVars],
    });
  } else {
    // Fallback: also try cleanName-based removal for hooks we previously generated
    const smoothVar = `${cleanName}Smooth`;
    const existingTransformRegex = new RegExp(`\\s*const \\w+ = (?:useSpring\\(\\s*)?useTransform\\((?:${progressName}|${smoothVar})[^;]*;`, 'g');
    const existingSpringRegex = new RegExp(`\\s*const ${smoothVar} = useSpring\\([^;]*;`);
    const existingScrollRegex = new RegExp(`\\s*const \\{ scrollYProgress: ${progressName} \\} = useScroll\\([\\s\\S]*?\\);`);
    const existingRefRegex = new RegExp(`\\s*const ${refName} = useRef\\(null\\);`);
    result = result.replace(existingTransformRegex, '');
    result = result.replace(existingSpringRegex, '');
    result = result.replace(existingScrollRegex, '');
    result = result.replace(existingRefRegex, '');
    // Also remove decomposed slots and useMotionTemplate for cleanName-based vars
    result = result.replace(new RegExp(`\\s*const ${cleanName}\\w+_\\d+ = useTransform\\([^;]*;`, 'g'), '');
    result = result.replace(new RegExp(`\\s*const ${cleanName}\\w+ = useMotionTemplate\`[^\`]*\`;`, 'g'), '');
  }
  // Orphan-proof the insert: sweep any pre-existing declaration of the EXACT
  // transform vars we're about to add. The binding-based removal above only
  // catches vars still BOUND in the JSX — an ORPHANED hook (declared but its
  // JSX binding was later overwritten with a static value, e.g. a scroll
  // `rotate` that became `rotate: "16"`) survives it, so re-adding the same var
  // collides → "Identifier 'X' has already been declared". `lines` holds the
  // fresh hook declarations; match the useTransform ones and strip any prior
  // declaration of that name (plain / spring-wrapped / decomposed slot / template).
  for (const ln of lines) {
    if (ln.includes('=>')) continue;  // skip latched/custom transforms — their arrow body has internal `;` that `[^;]*` would truncate
    const dm = ln.match(/^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:useSpring\(\s*)?useTransform\(/);
    if (!dm) continue;
    const vEsc = escapeRegExp(dm[1]);
    result = result.replace(new RegExp(`\\s*const ${vEsc} = (?:useSpring\\(\\s*)?useTransform\\([^;]*;`, 'g'), '');
    result = result.replace(new RegExp(`\\s*const ${vEsc}_\\d+ = useTransform\\([^;]*;`, 'g'), '');
    result = result.replace(new RegExp(`\\s*const ${vEsc} = useMotionTemplate\`[^\`]*\`;`, 'g'), '');
  }

  // Collapse runs of blank lines to max 1
  result = result.replace(/\n{3,}/g, '\n\n');

  // Check if ref already exists (from another scroll source on same element).
  // In section mode we ALWAYS emit the full block — the upfront cleanup
  // above already wiped any prior `const ${refName}` declaration, so we
  // must own the canonical placement (useRef BEFORE useEffect, otherwise
  // the useEffect closes over a TDZ binding visible to linters and reads
  // wrong on subsequent re-renders).
  const hookLines = (!useSectionRef && trigger !== 'onScroll' && result.includes(`const ${refName}`)) ? lines.slice(1) : lines;
  const hookBlock = hookLines.join('\n');

  // Insert new hooks before "return ("
  const withHooks = insertBeforeRenderReturn(result, hookBlock);
  if (withHooks === null) return result;
  result = withHooks;

  // Add ref to the correct element — preserve old ref placement when it was on a parent
  // e.g., AI put ref on hero-wrapper (150vh scroll container) but transforms on hero-sticky (child)
  //
  // Section mode is the exception: the ref is bound to ANOTHER element
  // (resolved at mount via document.getElementById), so we must NOT attach
  // `ref={refName}` to this element — that would compete with the
  // useEffect assignment and useScroll would track whichever was set last.
  // onScroll (whole-page) uses `useScroll()` with no target, so the element
  // needs no ref either — and attaching one would make it parse back as
  // layerInView (hasRef) instead of onScroll.
  if (!useSectionRef && trigger !== 'onScroll') {
    const refTargetNodeId = (oldRefTargetNodeId && oldRefTargetNodeId !== nodeId) ? oldRefTargetNodeId : nodeId;
    const refTargetPattern = `data-id="${refTargetNodeId}"`;
    const refTargetIdx = result.indexOf(refTargetPattern);
    if (refTargetIdx !== -1) {
      const tagStart = result.lastIndexOf('<', refTargetIdx);
      const tagEnd = findTagClose(result, refTargetIdx);
      if (tagStart !== -1 && tagEnd !== -1) {
        const tag = result.slice(tagStart, tagEnd + 1);
        if (!tag.includes(`ref={${refName}}`)) {
          result = result.slice(0, refTargetIdx) + `ref={${refName}} ` + result.slice(refTargetIdx);
        }
      }
    }
  }

  // Convert to motion.* if needed
  const idPattern = `data-id="${nodeId}"`;
  const motionIdIdx = findJSXDataIdIndex(result, nodeId);
  if (motionIdIdx !== -1) {
    const tagStart = result.lastIndexOf('<', motionIdIdx);
    const tagMatch = result.slice(tagStart + 1).match(/^([\w.]+)/);
    if (tagMatch && !tagMatch[1].startsWith('motion.')) {
      result = updateMotionPropInCode(result, nodeId, '_scrollDummy', {});
      // Remove the dummy prop we just added
      result = result.replace(/\s*_scrollDummy=\{\{\s*\}\}\s*/g, '');
    }
  }

  // Add new style bindings for this node
  // (Old bindings were already removed above by the parser-based or cleanName-based path)
  const cleanIdIdx = findJSXDataIdIndex(result, nodeId);
  if (cleanIdIdx !== -1) {
    const cleanTagStart = result.lastIndexOf('<', cleanIdIdx);
    const cleanTagEnd = findTagClose(result, cleanIdIdx);
    if (cleanTagStart !== -1 && cleanTagEnd !== -1) {
      const styleStartIdx = result.indexOf('style={{', cleanTagStart);
      if (styleStartIdx !== -1 && styleStartIdx < cleanTagEnd) {
        const sStart = styleStartIdx + 'style={{'.length;
        const sClose = findStyleObjectEnd(result, sStart);
        if (sClose !== -1) {
          let styleContent = result.slice(sStart, sClose);
          // Remove any new binding vars that might already exist (from cleanName fallback)
          for (const varName of Object.values(styleBindings)) {
            const bindRegex = new RegExp(`,?\\s*\\w+:\\s*${varName}\\b`);
            styleContent = styleContent.replace(bindRegex, '');
          }
          styleContent = styleContent.replace(/,\s*$/, '');
          styleContent = styleContent.replace(/^\s*,/, '');

          // Add new bindings
          const newBindings = Object.entries(styleBindings).map(([prop, varName]) => `${prop}: ${varName}`).join(', ');
          if (newBindings) {
            const trimmed = styleContent.trimEnd();
            styleContent = trimmed + (trimmed.length > 0 ? ', ' : '') + newBindings;
          }

          result = result.slice(0, sStart) + styleContent + result.slice(sClose);
        }
      }
    }
  }

  // Add framer-motion imports if needed
  if (!result.includes("from 'framer-motion'") && !result.includes('from "framer-motion"')) {
    result = `import { motion, useScroll, useTransform, useSpring${needsMotionTemplate ? ', useMotionTemplate' : ''} } from 'framer-motion';\n` + result;
  } else {
    // Add missing hooks to existing import
    const needed = ['useScroll', 'useTransform'];
    if (smooth) needed.push('useSpring');
    if (needsMotionTemplate) needed.push('useMotionTemplate');
    result = result.replace(
      /import\s*\{([^}]*)\}\s*from\s*['"]framer-motion['"]/,
      (match, imports) => {
        const existing = imports.split(',').map((s: string) => s.trim()).filter(Boolean);
        for (const n of needed) {
          if (!existing.includes(n)) existing.push(n);
        }
        return `import { ${existing.join(', ')} } from 'framer-motion'`;
      }
    );
  }

  // Final whitespace cleanup — collapse any 3+ consecutive newlines to 2
  result = result.replace(/\n{3,}/g, '\n\n');

  return result;
}

/**
 * Multi-section scroll-anim generator. Used when `sections[]` has 2+
 * entries. Emits:
 *   const xRef0 = useRef(null);
 *   const xRef1 = useRef(null);
 *   const [xPos, setXPos] = useState([0, 0]);
 *   useEffect(() => { xRef0.current = document.getElementById(...);
 *                     xRef1.current = document.getElementById(...);
 *                     const compute = () => { ... setXPos([p0, p1]); };
 *                     compute(); window.addEventListener('resize', compute);
 *                     return () => window.removeEventListener('resize', compute); }, []);
 *   const { scrollYProgress: xProgress } = useScroll();
 *   const xOpacity = useTransform(xProgress, [0, xPos[0], xPos[1], 1], [from, t0, t1, t1]);
 *   ...
 */
function updateMultiSectionScrollAnimInCode(code: string, config: ScrollAnimConfig): string {
  const { nodeId, sections, fromProps, sectionViewport, smooth, transition } = config;
  if (!sections || sections.length === 0) return code;

  const cleanName = nodeIdToVarName(nodeId);
  const progressName = `${cleanName}Progress`;
  const positionsVar = `${cleanName}SecPositions`;
  const setPositionsVar = `set${cleanName[0].toUpperCase() + cleanName.slice(1)}SecPositions`;
  const refNames = sections.map((_, i) => `${cleanName}Sec${i}Ref`);

  // Viewport-aware offset for the position computation. Anchors where in
  // the viewport the section "reaches the milestone":
  //   top    → section top hits viewport top   (need scrollY = offsetTop)
  //   middle → section top hits viewport center (offsetTop − vpH/2)
  //   bottom → section top hits viewport bottom (offsetTop − vpH)
  const vp = sectionViewport || 'middle';
  const viewportOffsetExpr =
    vp === 'top' ? '0'
    : vp === 'bottom' ? 'window.innerHeight'
    : 'window.innerHeight / 2';

  const lines: string[] = [];

  // 1. Refs (one per section)
  for (const refName of refNames) {
    lines.push(`  const ${refName} = useRef(null);`);
  }

  // 2. Position state (one entry per section, normalized 0..1 of page scroll)
  lines.push(`  const [${positionsVar}, ${setPositionsVar}] = useState(() => Array(${sections.length}).fill(0));`);

  // 3. Mount effect: resolve refs + compute positions, recompute on resize
  lines.push(`  useEffect(() => {`);
  sections.forEach((s, i) => {
    lines.push(`    ${refNames[i]}.current = document.getElementById('${s.sectionId}');`);
  });
  lines.push(`    const compute = () => {`);
  lines.push(`      const pageH = document.documentElement.scrollHeight - window.innerHeight;`);
  lines.push(`      if (pageH <= 0) return;`);
  lines.push(`      const offsetPx = ${viewportOffsetExpr};`);
  const posExpr = refNames.map(r => `${r}.current ? Math.max(0, Math.min(1, (${r}.current.offsetTop - offsetPx) / pageH)) : 0`).join(', ');
  lines.push(`      ${setPositionsVar}([${posExpr}]);`);
  lines.push(`    };`);
  lines.push(`    compute();`);
  lines.push(`    window.addEventListener('resize', compute);`);
  lines.push(`    return () => window.removeEventListener('resize', compute);`);
  lines.push(`  }, []);`);

  // 4. Page-level useScroll (no target — measures window scroll)
  lines.push(`  const { scrollYProgress: ${progressName} } = useScroll();`);

  // 5. Optional spring smoothing — uses buildSpringParams so both
  // physics-mode (stiffness/damping) and time-mode (duration/bounce)
  // transitions from the editor reach the generated useSpring call.
  const useSpringWrap = transition ? transition.type === 'spring' : !!smooth;
  const springParams = buildSpringParams(transition);
  const valueVar = useSpringWrap ? `${cleanName}Smooth` : progressName;
  if (useSpringWrap) {
    lines.push(`  const ${valueVar} = useSpring(${progressName}, ${springParams});`);
  }

  // 6. useTransform per property — input range [0, ...positions, 1],
  //    output range [from, ...sectionVals, lastVal-held].
  const allProps = new Set<string>();
  for (const k of Object.keys(fromProps || {})) allProps.add(k);
  for (const sec of sections) for (const k of Object.keys(sec.props)) allProps.add(k);

  // For each prop, walk stops in order (From + sections) and forward-fill
  // missing/empty values from the most recently seen value. Then backfill
  // the leading run (any stops BEFORE the first known value) with the
  // element's REST VALUE — its authored static style for that prop (e.g.
  // `backgroundColor: '#97cffc'` from JSX) for CSS props, or a motion
  // neutral (opacity:1, scale:1, rotate:0…) for motion-transform props.
  //
  // The previous backfill used the first known *section* value, which
  // produced silent "no-op animations" for any prop set on only a later
  // milestone — e.g. a `backgroundColor` set only on Section 2 would
  // emit ["#c52d2d", "#c52d2d", "#c52d2d", "#c52d2d"] (red from the
  // start) instead of transitioning from the element's own #97cffc.
  const stopProps: Array<Record<string, string>> = [
    fromProps || {},
    ...sections.map(s => s.props),
  ];

  const styleBindings: Record<string, string> = {};
  for (const prop of allProps) {
    if (prop.startsWith('Webkit') || prop.startsWith('webkit')) continue;
    // Forward-fill: walk stops in order, carrying forward last known value.
    const filled: Array<string | undefined> = stopProps.map(() => undefined);
    let last: string | undefined;
    for (let i = 0; i < stopProps.length; i++) {
      const v = stopProps[i][prop];
      if (v !== undefined && v !== '') last = v;
      filled[i] = last;
    }
    const firstKnownIdx = filled.findIndex(v => v !== undefined);
    if (firstKnownIdx === -1) continue; // never seen — nothing to emit
    // Backfill leading slots with the element's rest value, falling back
    // to the first known value if no rest value is available. This is the
    // bit that makes "set on Section 2 only" animate FROM the element's
    // authored color TO the user's section-2 color, instead of jumping
    // straight to the section-2 value at page load.
    const restVal = getJSXStyleValue(code, nodeId, prop) ?? MOTION_NEUTRALS[prop];
    for (let i = 0; i < firstKnownIdx; i++) {
      filled[i] = restVal ?? filled[firstKnownIdx]!;
    }

    const fromVal = filled[0]!;
    const sectionVals = filled.slice(1) as string[];
    const lastVal = sectionVals[sectionVals.length - 1];
    const outputVals = [fromVal, ...sectionVals, lastVal];
    const allNumeric = outputVals.every(v => !isNaN(Number(v)));
    const outputStr = allNumeric
      ? `[${outputVals.join(', ')}]`
      : `[${outputVals.map(v => `"${v}"`).join(', ')}]`;
    const inputParts = ['0', ...sections.map((_, i) => `${positionsVar}[${i}]`), '1'];
    const varName = `${cleanName}${prop.charAt(0).toUpperCase() + prop.slice(1)}`;
    lines.push(`  const ${varName} = useTransform(${valueVar}, [${inputParts.join(', ')}], ${outputStr});`);
    styleBindings[prop] = varName;
  }

  let result = code;

  // ── Strip ALL existing scroll hooks for this nodeId before inserting fresh.
  //    Covers both the old single-section pattern and any prior multi-section pattern.
  result = removeScrollAnimFromCode(result, nodeId);
  // Strip our specific multi-section artifacts. Crucially, this uses a
  // wildcard `\d+` on the section index — NOT the new refNames list —
  // so refs left over from a PREVIOUS run with a different section
  // count get removed too. Without this, deleting a section from a
  // 3-section block leaves an orphan `<cleanName>Sec2Ref` declaration
  // that the parser counts toward `sectionRefs.length`, breaking the
  // `values.length !== sectionRefs.length + 2` guard and dropping the
  // whole multi-section detection.
  result = result.replace(new RegExp(`\\s*ref=\\{${cleanName}Sec\\d+Ref\\}`, 'g'), '');
  result = result.replace(new RegExp(`\\s*const ${cleanName}Sec\\d+Ref\\s*=\\s*useRef\\(null\\);`, 'g'), '');
  result = result.replace(new RegExp(`\\s*const \\[${positionsVar},\\s*${setPositionsVar}\\][^;]*;`, 'g'), '');
  // Tear down the prior mount-effect (the brace-aware regex matches a useEffect
  // body that touches any of OUR refs and uses our setPositions setter).
  result = result.replace(new RegExp(`\\s*useEffect\\(\\s*\\(\\)\\s*=>\\s*\\{[\\s\\S]*?${setPositionsVar}[\\s\\S]*?\\},\\s*\\[\\]\\);`, 'g'), '');

  // ── Insert the new hooks before `return (`.
  const withHooks = insertBeforeRenderReturn(result, lines.join('\n'));
  if (withHooks === null) return result;
  result = withHooks;

  // ── Convert tag to motion.* if needed (same dummy-prop trick the
  //    single-section path uses to force motion conversion).
  const idIdx = findJSXDataIdIndex(result, nodeId);
  if (idIdx !== -1) {
    const tagStart = result.lastIndexOf('<', idIdx);
    const tagMatch = result.slice(tagStart + 1).match(/^([\w.]+)/);
    if (tagMatch && !tagMatch[1].startsWith('motion.')) {
      result = updateMotionPropInCode(result, nodeId, '_scrollDummy', {});
      result = result.replace(/\s*_scrollDummy=\{\{\s*\}\}\s*/g, '');
    }
  }

  // ── Add motion-value style bindings to the animated element.
  const cleanIdIdx = findJSXDataIdIndex(result, nodeId);
  if (cleanIdIdx !== -1) {
    const cleanTagStart = result.lastIndexOf('<', cleanIdIdx);
    const cleanTagEnd = findTagClose(result, cleanIdIdx);
    if (cleanTagStart !== -1 && cleanTagEnd !== -1) {
      const styleStartIdx = result.indexOf('style={{', cleanTagStart);
      if (styleStartIdx !== -1 && styleStartIdx < cleanTagEnd) {
        const sStart = styleStartIdx + 'style={{'.length;
        const sClose = findStyleObjectEnd(result, sStart);
        if (sClose !== -1) {
          let styleContent = result.slice(sStart, sClose);
          for (const varName of Object.values(styleBindings)) {
            const bindRegex = new RegExp(`,?\\s*\\w+:\\s*${varName}\\b`);
            styleContent = styleContent.replace(bindRegex, '');
          }
          styleContent = styleContent.replace(/,\s*$/, '').replace(/^\s*,/, '');
          const newBindings = Object.entries(styleBindings).map(([prop, varName]) => `${prop}: ${varName}`).join(', ');
          if (newBindings) {
            const trimmed = styleContent.trimEnd();
            styleContent = trimmed + (trimmed.length > 0 ? ', ' : '') + newBindings;
          }
          result = result.slice(0, sStart) + styleContent + result.slice(sClose);
        }
      }
    }
  }

  // ── Imports
  const needs = ['useScroll', 'useTransform', 'motion'];
  if (useSpringWrap) needs.push('useSpring');
  if (!result.includes("from 'framer-motion'") && !result.includes('from "framer-motion"')) {
    result = `import { ${needs.join(', ')} } from 'framer-motion';\n` + result;
  } else {
    result = result.replace(
      /import\s*\{([^}]*)\}\s*from\s*['"]framer-motion['"]/,
      (_match, imports) => {
        const existing = imports.split(',').map((s: string) => s.trim()).filter(Boolean);
        for (const n of needs) if (!existing.includes(n)) existing.push(n);
        return `import { ${existing.join(', ')} } from 'framer-motion'`;
      },
    );
  }

  // useState + useRef + useEffect imports from React — picked up by
  // syncImports on the next flush, but we add them here for safety.

  result = result.replace(/\n{3,}/g, '\n\n');
  trace.action('generator.updateMultiSectionScrollAnim', { nodeId, sectionCount: sections.length, viewport: vp });
  return result;
}

/**
 * Remove scroll animation hooks for a node.
 * Uses the scroll parser to find actual variable names bound to this node,
 * handles any naming convention (AI-generated or builder-generated).
 */
// ─── Direction-TRIGGERED scroll (the reference "On Scroll") ─────────────────────────
//
// NOT a scrubbed useScroll/useTransform. The element animates TO the `toProps`
// state when the user scrolls in `direction`; with `replay`, it reverts to its
// resting state when scrolling the opposite way (the reference's navbar-hide pattern).
// Mechanism: useState + useScroll().scrollY + useMotionValueEvent (direction) +
// an `animate` prop ternary.

export interface ScrollDirectionConfig {
  nodeId: string;
  toProps: Record<string, string>;
  direction: 'down' | 'up';
  replay: boolean;
  transition?: Record<string, string>;
  /** Per-viewport PRESENCE: the effect animates ONLY on these viewports; off-scope the
   *  `animate` ternary stays at rest (no direction animation). Absent = everywhere. */
  scope?: SerScope[];
  /** Per-viewport VALUE overrides (direction / replay / toProps) — base is the fields
   *  above. Lets Tablet scroll UP while Desktop scrolls DOWN, etc. */
  responsive?: Array<{ scope: SerScope; direction?: 'down' | 'up'; replay?: boolean; toProps?: Record<string, string> }>;
}

/** Remove a direction-triggered scroll's hooks + animate/transition for a node. */
export function removeScrollDirectionFromCode(code: string, nodeId: string): string {
  const cleanName = nodeIdToVarName(nodeId);
  const cn = escapeRegExp(cleanName);
  // Capitalised setter form (`set<Cap>Scrolled`) — the responsive reset-on-resize
  // useEffect references ONLY this, never the lowercase-initial node name, so neither
  // the rules below nor the const-sweep safety net in clearNodeScrollFx would catch it.
  const cap = escapeRegExp(cleanName.charAt(0).toUpperCase() + cleanName.slice(1));
  let r = code;
  r = r.replace(new RegExp(`\\s*const \\[${cn}Scrolled, set\\w+\\] = useState\\([^;]*\\);`, 'g'), '');
  r = r.replace(new RegExp(`\\s*const \\{\\s*scrollY:\\s*${cn}ScrollY\\s*\\} = useScroll\\([^;]*\\);`, 'g'), '');
  r = r.replace(new RegExp(`\\s*useMotionValueEvent\\(${cn}ScrollY,[\\s\\S]*?\\}\\);`, 'g'), '');
  // Reset-on-resize effect injected for responsive Direction (updateScrollDirectionAnimInCode):
  //   useEffect(() => { set<Cap>Scrolled(false); }, [__mqN, …]);
  r = r.replace(new RegExp(`\\s*useEffect\\(\\(\\)\\s*=>\\s*\\{\\s*set${cap}Scrolled\\(false\\);\\s*\\},\\s*\\[[^\\]]*\\]\\);`, 'g'), '');
  // Strip the animate/transition props we injected (the ternary referencing Scrolled).
  r = r.replace(new RegExp(`\\s*animate=\\{${cn}Scrolled \\?[^}]*\\}[^}]*\\}\\}`, 'g'), '');
  r = r.replace(new RegExp(`\\s*animate=\\{${cn}Scrolled \\?[\\s\\S]*?\\}\\}`, 'g'), '');
  return r;
}

export function updateScrollDirectionAnimInCode(code: string, config: ScrollDirectionConfig): string {
  trace.fn('generator.updateScrollDirectionAnim', { nodeId: config.nodeId, direction: config.direction, replay: config.replay });
  const { nodeId, toProps, direction, replay, transition, scope, responsive } = config;
  const cleanName = nodeIdToVarName(nodeId);
  const cap = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);
  const stateVar = `${cleanName}Scrolled`;
  const setter = `set${cap}Scrolled`;
  const syVar = `${cleanName}ScrollY`;

  // Clear only PRIOR direction-triggered setup for this node. We must NOT
  // touch the scrubbed Scroll Transform (`useTransform` style bindings) or
  // Scroll Speed (`*SpeedY`) — Scroll Animation / Transform / Speed are
  // separate stackable effects that coexist on one node (last-writer-wins).
  let result = removeScrollDirectionFromCode(code, nodeId);

  // PRESENCE gate: off-scope the trigger never fires (stays at rest = no direction
  // animation). `(stateVar && (__mqN || …))` — ensures each gate const; empty = unscoped.
  let presenceCond: string | null = null;
  if (scope?.length) {
    result = ensureMediaQueryHook(result);
    const vars: string[] = [];
    for (const s of scope) {
      if ('query' in s && s.query !== undefined && !('locale' in s)) {
        const g = ensureMediaGate(result, s.query); result = g.code; vars.push(g.gateVar);
      } else if ('variant' in s) {
        vars.push(`variant === '${s.variant}'`);
      }
      // locale scopes don't gate scroll effects — skipped.
    }
    presenceCond = vars.join(' || ');
  }
  const cond = presenceCond ? `(${stateVar} && (${presenceCond}))` : stateVar;

  const fmt = (o: Record<string, string>) => Object.entries(o)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}: ${isNaN(Number(v)) ? `'${v}'` : v}`).join(', ');

  // Per-viewport VALUE overrides. Build a gate var per responsive scope (reusing the
  // shared useMediaQuery gates), then emit a BRANCHED handler (each scope's direction/
  // replay decides which scroll way flips the universal `scrolled` state) and a GATED
  // animate To (per-scope `{…}` with the base as the tail). resting covers the UNION of
  // every variant's To keys so it resets fully.
  const resp = (responsive ?? []).map((r) => {
    let gate: string;
    if ('query' in r.scope && r.scope.query !== undefined && !('locale' in r.scope)) {
      result = ensureMediaQueryHook(result); const g = ensureMediaGate(result, r.scope.query); result = g.code; gate = g.gateVar;
    } else if ('variant' in r.scope) {
      gate = `variant === '${r.scope.variant}'`;
    } else {
      gate = 'false'; // locale scopes don't gate scroll effects
    }
    return { gate, direction: r.direction ?? direction, replay: r.replay ?? replay, toProps: r.toProps ?? toProps };
  });

  const allKeys = new Set<string>(Object.keys(toProps));
  for (const r of resp) for (const k of Object.keys(r.toProps)) allKeys.add(k);
  const resting: Record<string, string> = {};
  for (const k of allKeys) resting[k] = (k === 'opacity' || k.startsWith('scale')) ? '1' : '0';

  // animate To: gated per-scope, base as the tail.
  let toExpr = `{ ${fmt(toProps)} }`;
  for (let i = resp.length - 1; i >= 0; i--) toExpr = `${resp[i].gate} ? { ${fmt(resp[i].toProps)} } : ${toExpr}`;
  const animExpr = `${cond} ? ${resp.length ? `(${toExpr})` : toExpr} : { ${fmt(resting)} }`;
  const transObj = transition && Object.keys(transition).length
    ? `{ ${Object.entries(transition).filter(([, v]) => v !== '').map(([k, v]) => `${k}: ${isNaN(Number(v)) ? `'${v}'` : v}`).join(', ')} }`
    : `{ type: 'spring', duration: 0.5, bounce: 0.25 }`;

  // Handler: per-scope branch (early-return) then the base. Each branch's direction
  // decides which scroll way sets the state true; replay adds the opposite revert.
  const branch = (d: 'down' | 'up', rp: boolean): string => {
    const trig = d === 'down' ? 'y > prev' : 'y < prev';
    const opp = d === 'down' ? 'y < prev' : 'y > prev';
    return `if (${trig}) ${setter}(true);` + (rp ? ` else if (${opp}) ${setter}(false);` : '');
  };
  const handler: string[] = [];
  for (const r of resp) handler.push(`    if (${r.gate}) { ${branch(r.direction, r.replay)} return; }`);
  handler.push(`    ${branch(direction, replay)}`);
  const lines = [
    `  const [${stateVar}, ${setter}] = useState(false);`,
    `  const { scrollY: ${syVar} } = useScroll();`,
    `  useMotionValueEvent(${syVar}, "change", (y) => {`,
    `    const prev = ${syVar}.getPrevious() ?? 0;`,
    ...handler,
    `  });`,
  ];
  // The handler only fires on SCROLL, so crossing a breakpoint (resize, no scroll) would
  // leave `scrolled` stale (showing the previous viewport's To/rest). Reset it to rest
  // whenever a gate flips, so it re-evaluates per the new viewport's direction on the next
  // scroll — same adaptive behaviour the loop has. (Gathers presence + responsive gates.)
  const dirGateVars = [...new Set([...(presenceCond?.match(/__mq\d+/g) ?? []), ...resp.flatMap((r) => r.gate.match(/__mq\d+/g) ?? [])])];
  if (dirGateVars.length) lines.push(`  useEffect(() => { ${setter}(false); }, [${dirGateVars.join(', ')}]);`);

  const withHooks = insertBeforeRenderReturn(result, lines.join('\n'));
  if (withHooks === null) return code;
  result = withHooks;

  // Inject animate + transition on the element (ensure motion.<tag>).
  result = injectScrollAnimateProps(result, nodeId, animExpr, transObj);
  return result;
}

/** Convert a node's element to `motion.<tag>` — rewrites BOTH the opening tag
 *  AND its matching closing tag (`</div>` → `</motion.div>`). Returns the code
 *  unchanged if the tag is already motion.* / uppercase (component) / self-closing
 *  needs no closer. Brace-balanced close matching so nested children don't fool it. */
export function ensureMotionTag(code: string, nodeId: string): string {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return code;
  const tagStart = code.lastIndexOf('<', idIdx);
  if (tagStart === -1) return code;
  const nameM = code.slice(tagStart).match(/^<([a-zA-Z][\w.]*)/);
  if (!nameM) return code;
  const tagName = nameM[1];
  if (!/^[a-z]/.test(tagName) || tagName.startsWith('motion.')) return code;
  const baseTag = tagName.toLowerCase();
  const motionTag = `motion.${baseTag}`;
  let result = code.slice(0, tagStart + 1) + motionTag + code.slice(tagStart + 1 + tagName.length);

  // Find the opening tag's `>` to know if it self-closes.
  let gt = -1, depth = 0, inStr = '';
  for (let i = tagStart; i < result.length; i++) {
    const ch = result[i];
    if (inStr) { if (ch === inStr) inStr = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) { gt = i; break; }
  }
  if (gt === -1 || result[gt - 1] === '/') return result; // self-closing → no closer

  // Find the MATCHING `</tag>` by balancing same-name opens/closes (self-close aware,
  // so self-closing descendants like `<div … />` don't desync the count).
  const closePattern = `</${tagName}>`;
  const closeIdx = findMatchingCloseTagIndex(result, tagName, gt + 1);
  if (closeIdx !== -1) {
    result = result.slice(0, closeIdx) + `</motion.${baseTag}>` + result.slice(closeIdx + closePattern.length);
  }
  return result;
}

/** Add `animate={…} transition={…}` to a node's tag, converting to motion.<tag>
 *  if needed and replacing any existing animate/transition. */
function injectScrollAnimateProps(code: string, nodeId: string, animExpr: string, transObj: string): string {
  code = ensureMotionTag(code, nodeId);
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return code;
  const tagStart = code.lastIndexOf('<', idIdx);
  if (tagStart === -1) return code;
  // Find the opening tag's `>` — brace/string aware (skip `style={{…}}` etc.).
  let gt = -1, depth = 0, inStr = '';
  for (let i = idIdx; i < code.length; i++) {
    const ch = code[i];
    if (inStr) { if (ch === inStr) inStr = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) { gt = i; break; }
  }
  if (gt === -1) return code;

  let tag = code.slice(tagStart, gt);   // opening tag, WITHOUT the `>`
  // Remove any existing animate/transition we may have written before.
  tag = tag.replace(/\s*animate=\{[\s\S]*?\}\}/g, '').replace(/\s*transition=\{[\s\S]*?\}\}/g, '');

  const selfClose = /\/\s*$/.test(tag);
  const body = selfClose ? tag.replace(/\/\s*$/, '') : tag;
  const props = `\n          animate={${animExpr}}\n          transition={${transObj}}\n          `;
  const newTag = body + props + (selfClose ? '/' : '');
  return code.slice(0, tagStart) + newTag + code.slice(gt);
}

// ─── Scroll SPEED (the reference parallax) ──────────────────────────────────────────
//
// The element scrolls at `speed`% of normal — a parallax depth cue. 100% = normal;
// <100% lags (further away), >100% leads (closer). framer-motion: page scrollY →
// a `y` motion value = scrollY × (1 − speed/100), bound into the element's style.

export interface ScrollSpeedConfig {
  nodeId: string; speed: number;
  /** Scoped EDIT: write `speed` into THIS viewport/variant's branch, keeping the base
   *  + other branches (responsive). Omit → write the base. */
  scope?: SerScope | null;
  /** Spec REGENERATE: authoritative full per-scope override list (base = `speed`). */
  responsive?: Array<{ scope: SerScope; speed: number }>;
}


export { hexToRgba, extractCSSNumerics, decomposeComplexCSSValue, injectScrollAnimateProps };
