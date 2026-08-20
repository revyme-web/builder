// ScrollEditor.tsx — Scroll-linked animation editor.
// Supports: Scroll Transform (from→to with full transition control), multi-section morphing.
// Uses refs for state so pushPanel content stays reactive.

import { useState, useRef, useCallback, useMemo, Fragment } from 'react';
import { useAtomValue } from 'jotai';
import { ToolSelect, ControlLabel, ControlActionRow, ToolSegmentedControl, ToolDivider } from '../../../controls';
import { useToolPopup } from '../../../ui/ToolPopup';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { type ScrollAnimConfig, type ScrollTrigger, detectTriggerFromOffset, detectSectionViewportFromOffset, detectLayerRangeFromOffset, detectLayerExitFromOffset } from '@/code/generation/generator-motion';
import { parseRange } from '@/code/parsing/scroll-parser';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { getAnchorsForPage } from '../../LinkTool/LinkUrlControl';
import { findEnclosingAnchorId } from '../enclosing-section';
import { trace } from '@/shared/debug-trace';
import TransitionPanel from '../TransitionPanel';
import { TransitionCurveIcon, summarizeTransition } from '../CurvePreview';

import MotionPropsEditor from './MotionPropsEditor';

/** Parse a raw `useSpring` config object string from the source into the
 *  flat-string-map transition shape the Transition panel uses. Supports
 *  both physics (`{ stiffness, damping, mass }`) and time
 *  (`{ duration, bounce }`) forms — picks whichever fields are present.
 *  Returns null if the string can't be parsed or contains no spring info. */
function parseSpringConfig(springConfig: string | undefined): Record<string, string> | null {
  if (!springConfig) return null;
  const out: Record<string, string> = { type: 'spring' };
  // Lightweight key:value extractor — handles "{ stiffness: 100, damping: 30, restDelta: 0.001 }"
  // and "{ duration: 0.5, bounce: 0.25 }" without needing a real parser. We
  // skip `restDelta` (a settling tolerance the user doesn't author) and
  // anything we don't recognize.
  const known = ['stiffness', 'damping', 'mass', 'duration', 'bounce', 'delay'];
  for (const key of known) {
    const m = springConfig.match(new RegExp(`\\b${key}\\s*:\\s*(-?[\\d.]+)`));
    if (m) out[key] = m[1];
  }
  // Reject if we found nothing useful (kept the bare `type:spring`).
  return Object.keys(out).length > 1 ? out : null;
}

/** Tiny rectangle-with-bar icon used by the Viewport segmented control.
 *  Outline = viewport, filled bar = where the section sits inside it at
 *  the end of the animation. */
export function ViewportIcon({ position }: { position: 'top' | 'middle' | 'bottom' }) {
  const barY = position === 'top' ? 3 : position === 'bottom' ? 12 : 8;
  return (
    <svg width="14" height="14" viewBox="0 0 16 18" fill="none" stroke="currentColor" strokeWidth="1.25">
      <rect x="2" y="2" width="12" height="14" rx="1.5" />
      <rect x="3.5" y={barY} width="9" height="2.5" rx="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Extract from/to stops from parsed scroll data for a node */
function extractStopsFromScrollData(scrollData: any): ScrollStop[] | null {
  // ── Combined node (the reference model)? The separate-form bindings are gone — the
  //    From/To live in the data-scroll-fx spec the panel handed us. Map them
  //    straight onto the two-stop layout (progress 0 = From, 1 = To).
  if (scrollData?.transformSpec) {
    const { from = {}, to = {} } = scrollData.transformSpec;
    const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])];
    const p0: Record<string, string> = {}, p1: Record<string, string> = {};
    for (const k of keys) {
      if (from[k] !== undefined) p0[k] = from[k];
      if (to[k] !== undefined) p1[k] = to[k];
    }
    return [{ progress: 0, props: p0 }, { progress: 1, props: p1 }];
  }

  // ── Multi-section block? Parser surfaces fromProps + sections[] for the
  //    multi-section generator pattern; map them onto our flat ScrollStop
  //    shape so the editor renders the same row layout for both modes.
  if (scrollData?.multiSectionForNode) {
    const block = scrollData.multiSectionForNode;
    const stops: ScrollStop[] = [
      { progress: 0, props: { ...block.fromProps } },
      ...block.sections.map((s: any) => ({
        progress: 1,
        props: { ...s.props },
        sectionId: s.sectionId,
      })),
    ];
    // Evenly space progress for display (the generator computes positions
    // from offsetTop dynamically — progress is cosmetic in this mode).
    stops.forEach((s, i) => { s.progress = i / (stops.length - 1); });
    return stops;
  }

  if (!scrollData?.transforms || scrollData.transforms.length === 0) return null;

  // Build stops from the transform input/output ranges
  const transforms = scrollData.transforms;
  // Use the first transform's input range as the stop count
  const inputRange = parseRange(transforms[0].inputRange);
  const stopCount = inputRange.length;

  const stops: ScrollStop[] = [];
  for (let i = 0; i < stopCount; i++) {
    const props: Record<string, string> = {};
    for (const t of transforms) {
      // Find which property this transform controls
      const binding = scrollData.bindings?.find((b: any) => b.transformVar === t.varName);
      if (!binding) continue;
      const outputs = parseRange(t.outputRange);
      if (outputs[i] !== undefined) {
        props[binding.property] = outputs[i];
      }
    }
    stops.push({ progress: parseFloat(inputRange[i]) || 0, props });
  }

  return stops.length > 0 ? stops : null;
}

/** Build the ScrollAnimConfig for the current stop layout. In section-view
 *  mode with 2+ section milestones, emit `sections[]` + `fromProps` so the
 *  generator dispatches to the multi-section path. Otherwise emit the legacy
 *  single-`sectionId` / progress-stops shape. */
function buildScrollConfig(
  nodeId: string,
  trigger: ScrollAnimConfig['trigger'],
  stops: ScrollStop[],
  transition: Record<string, string>,
  sectionId: string,
  sectionViewport: 'top' | 'middle' | 'bottom',
  layerRange: string,
  layerExit: boolean,
): ScrollAnimConfig {
  // Multi-section: From (stops[0]) + N section milestones (stops[1..N])
  if (trigger === 'sectionInView' && stops.length >= 3) {
    const sections = stops.slice(1).map(s => ({
      sectionId: s.sectionId || '',
      props: s.props,
    }));
    return {
      nodeId, trigger,
      sectionId: '',
      sectionViewport,
      sections,
      fromProps: stops[0].props,
      stops: stops.map(s => ({ progress: s.progress, props: s.props })),
      transition,
    };
  }
  // Single-section (sectionInView + 2 stops): the lone "To" stop owns the section.
  const effectiveSectionId =
    trigger === 'sectionInView' && stops.length === 2
      ? (stops[1].sectionId || sectionId)
      : sectionId;
  return {
    nodeId, trigger,
    sectionId: effectiveSectionId,
    sectionViewport,
    // Range only applies to layerInView; pass it unconditionally — the
    // generator ignores it for other triggers.
    layerRange: trigger === 'layerInView' ? layerRange : undefined,
    // Enter/Exit timing is layerInView-only. Exit wins over layerRange in the
    // generator (it picks a different offset shape entirely).
    layerExit: trigger === 'layerInView' ? layerExit : undefined,
    stops: stops.map(s => ({ progress: s.progress, props: s.props })),
    transition,
  };
}

// ─── Stop Editor (delegates to MotionPropsEditor, adds scroll-specific filter sync) ──

interface StopEditorProps {
  stopsRef: React.MutableRefObject<ScrollStop[]>;
  stopIndex: number;
  nodeId: string;
  triggerRef: React.MutableRefObject<string>;
  transitionRef: React.MutableRefObject<Record<string, string>>;
  /** Section ref so per-stop writes from inside the StopEditor preserve
   *  the currently-picked section. Missing this caused every slider drag
   *  to fire `updateScrollAnim` with `sectionId === undefined`, which
   *  made the generator re-attach `ref={refName}` to the animated element
   *  and clobber the section setup on every property tweak. */
  sectionIdRef: React.MutableRefObject<string>;
  /** Same idea for sectionViewport — without it, every per-stop write
   *  would reset the viewport to the generator default. */
  sectionViewportRef: React.MutableRefObject<'top' | 'middle' | 'bottom'>;
  /** Layer-in-View range (0–1). Threaded the same reason as the above —
   *  per-stop writes need to preserve the current range or they'd reset
   *  to the generator default on every slider tweak. */
  layerRangeRef: React.MutableRefObject<string>;
  /** Layer-in-View Enter/Exit timing — threaded for the same reason as the
   *  above: a per-stop write must preserve Exit or it'd revert to Enter. */
  layerExitRef: React.MutableRefObject<boolean>;
  /** Direction/Replay for the direction-triggered On Scroll write path. */
  directionRef: React.MutableRefObject<'down' | 'up'>;
  replayRef: React.MutableRefObject<boolean>;
  /** 'animation' = discrete (On Scroll → direction-triggered); 'transform' =
   *  scrubbed (On Scroll → From→To via updateScrollAnim). */
  mode: 'animation' | 'transform';
  /** Per-viewport write hook: on a REPLICA, route the From/To edit to a
   *  transform.responsive override (via the spec) instead of the base. Returns
   *  true when it handled the write (active scope present) → skip the base write. */
  scopedWrite?: (which: 'from' | 'to', props: Record<string, string>) => boolean;
  /** Per-viewport presence of a direction-triggered Scroll Animation — preserved on a
   *  To edit so it doesn't become a base (every-viewport) effect. */
  directionScope?: ({ query: string } | { variant: string })[];
  /** On a REPLICA, route a direction-To edit to a per-viewport animation.responsive
   *  override (returns true when handled). */
  scopedDirectionWrite?: (patch: { direction?: 'down' | 'up'; replay?: boolean; toProps?: Record<string, string> }) => boolean;
}

function StopEditor({ stopsRef, stopIndex, nodeId, triggerRef, transitionRef, sectionIdRef, sectionViewportRef, layerRangeRef, layerExitRef, directionRef, replayRef, mode, scopedWrite, directionScope, scopedDirectionWrite }: StopEditorProps) {
  const handleChange = useCallback((newProps: Record<string, string>) => {
    const newStops = [...stopsRef.current];
    newStops[stopIndex] = { ...newStops[stopIndex], props: newProps };
    // Per-viewport: on a REPLICA, a scrubbed From/To edit writes a transform.responsive
    // override (keeping base + siblings) instead of the base. Only the simple 2-stop
    // transform case (not multi-section). scopedWrite returns false on primary → base path.
    if (scopedWrite && mode === 'transform' && triggerRef.current !== 'sectionInView' && newStops.length === 2
        && scopedWrite(stopIndex === 0 ? 'from' : 'to', newProps)) {
      stopsRef.current = newStops;
      return;
    }
    // Scroll ANIMATION On Scroll: edit the To → updateScrollDirection (discrete).
    // Scroll TRANSFORM On Scroll is scrubbed → falls through to updateScrollAnim.
    if (triggerRef.current === 'layerInView' && mode === 'animation') {
      stopsRef.current = newStops;
      const toProps = newStops[newStops.length - 1].props;
      // On a REPLICA: route the To edit to a per-viewport animation.responsive override.
      if (scopedDirectionWrite?.({ direction: directionRef.current, replay: replayRef.current, toProps })) return;
      queueMutation({ type: 'updateScrollDirection', config: {
        nodeId, toProps,
        direction: directionRef.current, replay: replayRef.current, transition: transitionRef.current,
        ...(directionScope?.length ? { scope: directionScope } : {}),   // preserve per-viewport presence
      } });
      return;
    }

    // Scroll-specific: sync filter functions across all stops for useMotionTemplate
    if (newProps.filter) {
      const fns = newProps.filter.match(/(\w+)\([^)]*\)/g) || [];
      const fnNames = fns.map(f => f.match(/^(\w+)/)?.[1] || '');
      const defaults: Record<string, string> = {
        blur: '0px', brightness: '100%', contrast: '100%',
        saturate: '100%', grayscale: '0%', 'hue-rotate': '0deg',
      };
      for (let i = 0; i < newStops.length; i++) {
        if (i === stopIndex) continue;
        const otherFilter = newStops[i].props.filter || '';
        const otherFns = otherFilter.match(/(\w+)\([^)]*\)/g) || [];
        const otherFnNames = otherFns.map(f => f.match(/^(\w+)/)?.[1] || '');
        let updated = otherFilter;
        for (const name of fnNames) {
          if (!otherFnNames.includes(name)) {
            const def = defaults[name] || '0';
            updated = updated ? `${updated} ${name}(${def})` : `${name}(${def})`;
          }
        }
        if (updated !== otherFilter) {
          newStops[i] = { ...newStops[i], props: { ...newStops[i].props, filter: updated } };
        }
      }
    }

    stopsRef.current = newStops;
    // On Scroll (Layer-in-View): the From is always resting — normalize so editing
    // the To never leaves a stale From. (No-op for section/other triggers.)
    const config = buildScrollConfig(
      nodeId,
      triggerRef.current as ScrollAnimConfig['trigger'],
      mode === 'animation' ? normalizeScrollStops(newStops, triggerRef.current) : newStops,
      transitionRef.current,
      sectionIdRef.current,
      sectionViewportRef.current,
      layerRangeRef.current,
      layerExitRef.current,
    );
    queueMutation({ type: 'updateScrollAnim', config });
  }, [stopsRef, stopIndex, nodeId, triggerRef, transitionRef, sectionIdRef, sectionViewportRef, layerRangeRef, layerExitRef, directionRef, replayRef, mode, scopedWrite, directionScope, scopedDirectionWrite]);

  // Collect keys from ALL stops so all stops show the same controls
  const allStopKeys = new Set<string>();
  for (const stop of stopsRef.current) {
    for (const key of Object.keys(stop.props)) allStopKeys.add(key);
  }

  return (
    <MotionPropsEditor
      nodeId={nodeId}
      props={stopsRef.current[stopIndex]?.props || {}}
      onChange={handleChange}
      preview
      mode="scrollStop"
      extraKeys={allStopKeys}
    />
  );
}

// ─── Scroll Transform ───────────────────────────────────────────────────────

interface ScrollStop {
  progress: number;
  props: Record<string, string>;
  sectionId?: string;
}

// On-Scroll presets (the reference's full list): the "To" the element scrolls TO from
// its resting state. Effect-OUT style (resting full/visible → To faded/scaled/
// flipped/slid). The From is auto = resting (normalizeScrollStops).
const SCROLL_PRESETS: Record<string, Record<string, string>> = {
  fadeOut:        { opacity: '0' },
  scaleOut:       { opacity: '0', scale: '0.5' },
  scaleOutBottom: { opacity: '0', scale: '0.5', y: '40' },
  flipHorizontal: { opacity: '0', rotateY: '90' },
  flipVertical:   { opacity: '0', rotateX: '90' },
  slideOutTop:    { opacity: '0', y: '-100' },
  slideOutLeft:   { opacity: '0', x: '-100' },
  slideOutRight:  { opacity: '0', x: '100' },
  slideOutBottom: { opacity: '0', y: '100' },
};
const SCROLL_PRESET_LABELS: Record<string, string> = {
  fadeOut: 'Fade Out', scaleOut: 'Scale Out', scaleOutBottom: 'Scale Out Bottom',
  flipHorizontal: 'Flip Horizontal', flipVertical: 'Flip Vertical',
  slideOutTop: 'Slide Out Top', slideOutLeft: 'Slide Out Left',
  slideOutRight: 'Slide Out Right', slideOutBottom: 'Slide Out Bottom', custom: 'Custom',
};
/** Resting (From) values for a To's keys — opacity/scale → 1, transforms → 0.
 *  On Scroll (Layer-in-View) authors only the To; the From is always resting. */
const restingStopProps = (toProps: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.keys(toProps).map(k => [k, (k === 'opacity' || k.startsWith('scale')) ? '1' : '0']));
/** the reference On Scroll layout applies to the scrubbed scroll triggers (page-level
 *  `onScroll` AND element `layerInView`) — NOT sectionInView (which keeps From/To
 *  + anchors). */
const isMotionScrollMode = (trigger: string) => trigger === 'onScroll' || trigger === 'layerInView';
/** Normalize stops for On Scroll: [resting, To]. No-op for sectionInView. */
const normalizeScrollStops = (stops: { progress: number; props: Record<string, string> }[], trigger: string) => {
  if (!isMotionScrollMode(trigger) || stops.length < 2) return stops;
  const to = stops[stops.length - 1];
  return [{ progress: 0, props: restingStopProps(to.props) }, { ...to, progress: 1 }];
};
const detectScrollPreset = (toProps: Record<string, string>): string => {
  const norm = (o: Record<string, string>) => JSON.stringify(Object.entries(o).filter(([, v]) => v !== '').sort());
  const cur = norm(toProps);
  for (const [key, props] of Object.entries(SCROLL_PRESETS)) if (norm(props) === cur) return key;
  return 'custom';
};

export function ScrollTransformEditor({ nodeId, scrollData, onSwitchToAppear, mode = 'transform', scopedTransformWrite, scopedDirectionWrite, onSwitchToSectionInView }: { nodeId: string; scrollData?: any; onSwitchToAppear?: (currentTrigger: ScrollTrigger) => void; mode?: 'animation' | 'transform'; scopedTransformWrite?: (which: 'from' | 'to', props: Record<string, string>) => boolean; scopedDirectionWrite?: (patch: { direction?: 'down' | 'up'; replay?: boolean; toProps?: Record<string, string> }) => boolean; /** Animation-mode only: a scrubbed Section-in-View write re-classifies the effect as the Scroll Transform ENTRY — the host moves the open popup there (after this editor's write flushed). */ onSwitchToSectionInView?: () => void }) {
  // 'animation' = the discrete Scroll Animation editor: Section in View is a
  // SINGLE section (no Add Section / multi-section). 'transform' = the scrubbed
  // Scroll Transform editor: Section in View supports Add Section multi-step.
  const allowMultiSection = mode === 'transform';
  const { pushPanel } = useToolPopup();

  // Initialize from parsed data if available, otherwise use defaults.
  // For spring smoothing: the parser captures the raw `useSpring(value, {...})`
  // config string per transform. We decode the first one we see (all transforms
  // share the same smoothed source in our generator output) so the Transition
  // panel re-opens with the EXACT params we last wrote — physics or time.
  // Direction-triggered On Scroll: stops come from the `toProps` (To) + resting.
  const initStops = scrollData?.directionTriggered
    ? [{ progress: 0, props: restingStopProps(scrollData.toProps || {}) }, { progress: 1, props: { ...(scrollData.toProps || {}) } }]
    : scrollData ? extractStopsFromScrollData(scrollData) : null;
  const springTransform: any = scrollData?.transforms?.find((t: any) => t.isSpring);
  const parsedSpring = parseSpringConfig(springTransform?.springConfig);
  // Scroll-linked is spring-only (matches the reference's behavior — there's no
  // meaningful Instant or Ease for scroll-driven progress). Default
  // sensible Time-mode spring when no transition is in the source yet.
  const initTransition: Record<string, string> = parsedSpring
    // Combined node: the spec carries the last-written transition (no parsed
    // spring var to decode), so honour it before the generic default.
    ?? (scrollData?.transformSpec && scrollData?.transition)
    ?? { type: 'spring', duration: '0.5', bounce: '0.25' };
  // Multi-section block: trigger is implicitly 'sectionInView' (the
  // generator pattern only emits for that mode), so short-circuit
  // offset detection.
  const detectedTrigger: ScrollTrigger = scrollData?.directionTriggered
    ? 'layerInView'   // "On Scroll" (direction-triggered)
    : scrollData?.multiSectionForNode
    ? 'sectionInView'
    : detectTriggerFromOffset(
        scrollData?.source?.offset ?? null,
        !!scrollData?.source?.refVar,
        !!scrollData?.source?.sectionId,
      );
  // Scroll ANIMATION folds page-level `onScroll` into the element-scrubbed
  // "On Scroll" (layerInView, direction-triggered). Scroll TRANSFORM keeps
  // `onScroll` as-is — its "On Scroll" IS whole-page scrubbed (From at page
  // top → To as you scroll), which is what makes the From state visible at
  // load even for an element that's already on screen.
  const initTrigger: ScrollTrigger = (detectedTrigger === 'onScroll' && mode === 'animation')
    ? 'layerInView' : detectedTrigger;

  const [trigger, setTrigger] = useState<ScrollTrigger>(initTrigger);
  // Default From/To match the reference's "fade + scale" preview when a fresh
  // Scroll Transform is added: opacity goes 0.5 → 1, scale 0.5 → 1. The
  // user immediately sees something happen on scroll AND a visible
  // delta in the canvas at rest (the From state shows the element at
  // half opacity + half size), so it's discoverable without typing.
  const [stops, setStops] = useState<ScrollStop[]>(initStops || [
    { progress: 0, props: { opacity: '0.5', scale: '0.5' } },
    { progress: 1, props: { opacity: '1', scale: '1' } },
  ]);
  const [transition, setTransition] = useState<Record<string, string>>(initTransition);
  // Section reference for Section-in-View trigger: data-id of another element
  // on the page (typically one with an `id` anchor set via the Link tool's
  // Section field). When set + trigger='sectionInView', the generated
  // useScroll targets that section instead of this element.
  const [sectionId, setSectionId] = useState<string>(scrollData?.source?.sectionId || '');
  const sectionIdRef = useRef(sectionId);
  sectionIdRef.current = sectionId;
  // Where in the viewport the section reaches its "To" state. Re-read on
  // mount from the parsed offset shape so a saved file pre-fills the
  // segmented control correctly.
  const [sectionViewport, setSectionViewport] = useState<'top' | 'middle' | 'bottom'>(
    scrollData?.multiSectionForNode?.sectionViewport
      ?? detectSectionViewportFromOffset(scrollData?.source?.offset ?? null),
  );
  const sectionViewportRef = useRef(sectionViewport);
  sectionViewportRef.current = sectionViewport;

  // Layer-in-View range (0–1 fraction of viewport scrolled until TO).
  // Default 0.3 = snappy (30% of viewport). The detect helper returns
  // null for legacy/full-pass-through offsets; fall back to default in
  // that case so the slider always has a value.
  const [layerRange, setLayerRange] = useState<string>(
    detectLayerRangeFromOffset(scrollData?.source?.offset ?? null) ?? '0.3',
  );
  const layerRangeRef = useRef(layerRange);
  layerRangeRef.current = layerRange;

  // Layer-in-View timing: Enter (scrub the entrance, default) vs Exit (scrub as
  // the layer leaves off the top). Exit is the mirror offset — essential for a
  // `position: sticky` layer, whose entrance scrub finishes the instant it sticks.
  // Re-read on mount from the offset's second anchor.
  const [layerExit, setLayerExit] = useState<boolean>(
    detectLayerExitFromOffset(scrollData?.source?.offset ?? null),
  );
  const layerExitRef = useRef(layerExit);
  layerExitRef.current = layerExit;

  // Refs so pushPanel content can read latest state.
  // IMPORTANT: only sync ref FROM state when state changes via setStops (not on every render),
  // because StopEditor also writes to stopsRef directly.
  const stopsRef = useRef(stops);
  const triggerRef = useRef(trigger);
  triggerRef.current = trigger;
  const transitionRef = useRef(transition);
  transitionRef.current = transition;

  // On-Scroll (the reference) Direction + Replay — read back from the `// @scroll`
  // marker (defaults down / replay). Down = animate resting→To scrolling down;
  // Replay = scrubbed (reverses on scroll-back), No = play once and latch.
  const [direction, setDirection] = useState<'down' | 'up'>(scrollData?.direction === 'up' ? 'up' : 'down');
  const [replay, setReplay] = useState<boolean>(scrollData?.replay !== false);
  const directionRef = useRef(direction); directionRef.current = direction;
  const replayRef = useRef(replay); replayRef.current = replay;

  // Anchor list for the Section dropdown — uses the same helper the Link
  // tool uses, so anchors stay consistent across the editor (any element
  // with an `id` attribute on the active page).
  const activeFilePath = useAtomValue(activeFilePathAtom);
  const anchors = useMemo(
    () => activeFilePath ? getAnchorsForPage(activeFilePath) : [],
    [activeFilePath],
  );

  const writeToCode = useCallback((newStops: ScrollStop[], newTrigger: string, trans: Record<string, string>, secId?: string, vp?: 'top' | 'middle' | 'bottom', range?: string) => {
    // Scroll ANIMATION "On Scroll" (layerInView) is direction-TRIGGERED (the reference):
    // the To animates in when scrolling in `direction`, reverts on opposite
    // (replay). Scroll TRANSFORM "On Scroll" is SCRUBBED (From→To tied to scroll
    // progress) — it falls through to the updateScrollAnim path below.
    if (newTrigger === 'layerInView' && mode === 'animation') {
      const dirPatch = { direction: directionRef.current, replay: replayRef.current, toProps: newStops[newStops.length - 1].props };
      // On a REPLICA: route to a per-viewport animation.responsive override (keeping base).
      if (scopedDirectionWrite?.(dirPatch)) return;
      queueMutation({ type: 'updateScrollDirection', config: {
        nodeId, toProps: dirPatch.toProps, direction: dirPatch.direction, replay: dirPatch.replay, transition: trans,
        ...(scrollData?.scope?.length ? { scope: scrollData.scope } : {}),   // preserve per-viewport presence
      } });
      return;
    }
    // Scroll Animation On Scroll authors only the "To" (From = resting, auto-
    // filled). Scroll Transform authors an explicit From + To — so only
    // normalize-to-resting in animation mode.
    const finalStops = mode === 'animation' ? normalizeScrollStops(newStops, newTrigger) : newStops;
    const config = buildScrollConfig(
      nodeId,
      newTrigger as ScrollAnimConfig['trigger'],
      finalStops,
      trans,
      secId ?? sectionIdRef.current,
      vp ?? sectionViewportRef.current,
      range ?? layerRangeRef.current,
      layerExitRef.current,
    );
    // Direction/Replay are Scroll ANIMATION (direction-triggered) concepts. For
    // Scroll TRANSFORM (scrubbed) they must NOT be applied: config.direction='up'
    // reverses the output range and inverts From↔To. (The parser infers 'up' for
    // a 0.5→1 reveal because its output ends at the resting value, so without
    // this guard a transition edit would silently flip the stops.)
    if (mode === 'animation') {
      config.direction = directionRef.current;
      config.replay = replayRef.current;
    }
    trace.action('scroll-editor:write', {
      nodeId, trigger: newTrigger, sectionId: config.sectionId,
      sectionViewport: config.sectionViewport, stopCount: newStops.length,
      sectionMilestones: config.sections?.length || 0,
      transitionType: trans.type, direction: config.direction, replay: config.replay,
    });
    queueMutation({ type: 'updateScrollAnim', config });
  }, [nodeId, mode, scopedDirectionWrite, scrollData]);

  const addStop = () => {
    const current = stopsRef.current;
    // New section milestone inherits the LAST stop's props by default —
    // so adding a section creates a "no-op hold" until the user edits
    // it. Avoids surprise transforms that would animate just because a
    // new milestone got added with hardcoded values.
    const lastProps = current.length > 0 ? { ...current[current.length - 1].props } : {};
    const newStops = [...current, { progress: 1, props: lastProps }];
    newStops.forEach((s, i) => { s.progress = i / (newStops.length - 1); });
    stopsRef.current = newStops;
    setStops(newStops);
    writeToCode(newStops, trigger, transition);
  };

  const removeStop = (index: number) => {
    const current = stopsRef.current;
    if (current.length <= 2) return;
    const newStops = current.filter((_, i) => i !== index);
    newStops.forEach((s, i) => { s.progress = i / (newStops.length - 1); });
    stopsRef.current = newStops;
    setStops(newStops);
    writeToCode(newStops, trigger, transition);
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Trigger */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Trigger" property="" plain />
        <div className="w-full">
          <ToolSelect value={trigger} onChange={(v) => {
            // "On Appear" lives in the SAME Trigger dropdown — selecting it
            // switches the whole effect to the Appear mechanism (the parent wipes
            // useScroll and seeds whileInView). One dropdown, three triggers.
            if (v === '__appear') { onSwitchToAppear?.(trigger); return; }
            const newTrigger = v as ScrollTrigger;
            setTrigger(newTrigger);
            // Layer-in-view / on-scroll only support From + To. Collapse
            // any extra section milestones so the editor doesn't fall
            // out of sync with the generator (which would silently lose
            // those stops on next write anyway).
            let stopsToUse = stops;
            if (newTrigger !== 'sectionInView' && stops.length > 2) {
              const collapsed = [stops[0], stops[stops.length - 1]];
              collapsed.forEach((s, idx) => { s.progress = idx; });
              stopsRef.current = collapsed;
              setStops(collapsed);
              stopsToUse = collapsed;
              trace.action('scroll-editor:collapse-to-from-to', { nodeId, from: stops.length, to: collapsed.length });
            }
            // Within the Scroll ANIMATION effect the triggers use different
            // mechanisms (layerInView → direction-triggered `animate`; sectionInView →
            // scrubbed `useTransform`), so an in-editor switch must clear the outgoing
            // mechanism's leftovers. Scroll TRANSFORM is ALWAYS scrubbed for every
            // trigger (updateScrollAnim handles the switch itself), so this cleanup
            // would wrongly remove a SEPARATE effect — e.g. removeScrollDirection here
            // nukes the node's stacked Animation (Scrolled/AnimOpacity). Gate on mode.
            if (mode === 'animation') {
              if (newTrigger === 'layerInView') queueMutation({ type: 'removeScrollAnim', nodeId });
              else if (newTrigger === 'sectionInView') queueMutation({ type: 'removeScrollDirection', nodeId });
            }
            // Fresh switch to Section in View: default the target to the
            // node's ENCLOSING anchored section — that's what the trigger
            // means. An empty sectionId degrades to a self-targeted scrub
            // (valid code), so this only upgrades the default.
            let seedSecId: string | undefined;
            if (newTrigger === 'sectionInView' && !sectionIdRef.current) {
              const enclosing = findEnclosingAnchorId(nodeId);
              if (enclosing) {
                seedSecId = enclosing;
                setSectionId(enclosing);
                sectionIdRef.current = enclosing;
                trace.action('scroll-editor:seed-enclosing-section', { nodeId, sectionId: enclosing });
              }
            }
            writeToCode(stopsToUse, v, transition, seedSecId);
            // Animation-mode Section in View is SCRUBBED — after this write
            // the effect parses back as the separate Scroll Transform entry,
            // so the open popup must follow it there (the host flushes then
            // re-targets; without it this popup re-renders as empty Appear).
            if (newTrigger === 'sectionInView' && mode === 'animation') onSwitchToSectionInView?.();
          }} options={[
            ...(onSwitchToAppear ? [{ value: '__appear', label: 'On Appear' }] : []),
            // Scroll Animation "On Scroll" = element-scrubbed direction-trigger
            // (layerInView). Scroll Transform "On Scroll" = whole-page scrubbed
            // (onScroll) so the From shows at the top of the page.
            { value: mode === 'animation' ? 'layerInView' : 'onScroll', label: 'On Scroll' },
            // Scroll TRANSFORM also gets a distinct "Layer in View" — a scrubbed
            // transform timed to the LAYER's own position (top/center/bottom).
            // In Animation mode "On Scroll" already IS layerInView, so it's only
            // added for transform to avoid a duplicate.
            ...(mode === 'transform' ? [{ value: 'layerInView', label: 'Layer in View' }] : []),
            { value: 'sectionInView', label: 'Section in View' },
          ]} />
        </div>
      </div>

      {/* Direction + Replay (the reference On Scroll) — both scrubbed scroll triggers.
          Direction: 'down' animates resting→To as you scroll down; 'up' reverses.
          Replay: Yes = scrubbed (reverses on scroll-back); No = play once + latch. */}
      {mode === 'animation' && isMotionScrollMode(trigger) && (<>
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Direction" property="" plain />
          <ToolSegmentedControl value={direction}
            onChange={(v) => { const d = v as 'down' | 'up'; setDirection(d); directionRef.current = d; writeToCode(stops, trigger, transition); }}
            options={[{ value: 'down', label: 'Down' }, { value: 'up', label: 'Up' }]} size="sm" />
        </div>
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Replay" property="" plain />
          <ToolSegmentedControl value={replay ? 'yes' : 'no'}
            onChange={(v) => { const r = v === 'yes'; setReplay(r); replayRef.current = r; writeToCode(stops, trigger, transition); }}
            options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} size="sm" />
        </div>
      </>)}

      {/* Range removed from the On Scroll panel (design-tool parity — no Range
          control). The generator uses the default layerRange (0.3, snappy). */}

      {/* Enter / Exit timing (Layer in View only). Enter = scrub the entrance
          (default). Exit = scrub as the layer LEAVES off the top — the MIRROR
          offset (layerInViewExitOffset). Essential for a `position: sticky`
          layer, whose entrance scrub finishes the instant it sticks: with Exit,
          progress stays 0 through the entrance + sticky hold and only runs as it
          slides away. Toggling seeds the canonical anchor for each mode — Exit →
          top ("leave off the top"), Enter → middle. */}
      {trigger === 'layerInView' && (
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Timing" property="" plain />
          <ToolSegmentedControl
            value={layerExit ? 'exit' : 'enter'}
            onChange={(v) => {
              const ex = v === 'exit';
              const vp = ex ? 'top' : 'middle';
              setLayerExit(ex);
              layerExitRef.current = ex;
              setSectionViewport(vp);
              sectionViewportRef.current = vp;
              writeToCode(stops, trigger, transition, undefined, vp);
              trace.action('scroll-editor:layer-timing', { nodeId, exit: ex, viewport: vp });
            }}
            options={[{ value: 'enter', label: 'Enter' }, { value: 'exit', label: 'Exit' }]}
            size="sm"
          />
        </div>
      )}

      {/* Viewport segmented — where in the viewport the section reaches
          its "To" state. Top = full pass-through (slowest), Middle = at
          viewport center (default), Bottom = fully entered (fastest).
          Shown BEFORE Section so the user picks the timing model before
          the anchor — matches the reference's layout where the global "how"
          comes before the "what". */}
      {/* Also drives the Layer-in-View "Start" position (top/center/bottom of the
          LAYER against the viewport) — shares the sectionViewport state; the
          generator maps it via layerInViewOffset and it round-trips through
          detectSectionViewportFromOffset. */}
      {(trigger === 'sectionInView' || trigger === 'layerInView') && (
        <div className="flex items-center justify-between w-full">
          <ControlLabel label={trigger === 'layerInView' ? 'Start' : 'Viewport'} property="" plain />
          <ToolSegmentedControl
            value={sectionViewport}
            onChange={(v) => {
              const vp = v as 'top' | 'middle' | 'bottom';
              setSectionViewport(vp);
              sectionViewportRef.current = vp;
              writeToCode(stops, trigger, transition, undefined, vp);
              trace.action('scroll-editor:viewport-pick', { nodeId, viewport: vp });
            }}
            options={[
              { value: 'top',    icon: <ViewportIcon position="top" /> },
              { value: 'middle', icon: <ViewportIcon position="middle" /> },
              { value: 'bottom', icon: <ViewportIcon position="bottom" /> },
            ]}
            size="sm"
          />
        </div>
      )}

      {/* ── standard layout (sectionInView):
            Section anchor (for stops[1])
            From  Effect
            To    Effect
            Transition
            ─────── (separator)
            Section anchor (stops[2])
            To    Effect
            ─────── (separator)
            …
          For layerInView / onScroll: just From → To → Transition. */}
      {(() => {
        const isSectionMode = trigger === 'sectionInView';
        const REMOVE_SENTINEL = '__remove_section__';

        /** A section-anchor picker row (with `Remove` sentinel option). */
        const renderAnchorRow = (stopIdx: number, allowRemove: boolean) => {
          const stop = stops[stopIdx];
          return (
            <div className="flex items-center justify-between w-full">
              <ControlLabel label="Section" property="" plain />
              <div className="w-full">
                <ToolSelect
                  value={stop.sectionId || ''}
                  onChange={(v) => {
                    if (v === REMOVE_SENTINEL) {
                      if (allowRemove) removeStop(stopIdx);
                      return;
                    }
                    const updated = stopsRef.current.map((s, idx) =>
                      idx === stopIdx ? { ...s, sectionId: v } : s,
                    );
                    stopsRef.current = updated;
                    setStops(updated);
                    // Mirror to top-level sectionId for the single-section
                    // legacy generator path (kept for round-trip safety).
                    if (stopIdx === 1) { setSectionId(v); sectionIdRef.current = v; }
                    writeToCode(updated, trigger, transition, stopIdx === 1 ? v : undefined);
                    trace.action('scroll-editor:stop-section-pick', { nodeId, stopIndex: stopIdx, sectionId: v });
                  }}
                  options={[
                    { value: '', label: anchors.length === 0 ? 'No anchors on page' : 'Select…' },
                    ...anchors.map(id => ({ value: id, label: `#${id}` })),
                    ...(allowRemove ? [{ value: REMOVE_SENTINEL, label: 'Remove' }] : []),
                  ]}
                />
              </div>
            </div>
          );
        };

        /** A stop "Effect" button row. */
        const renderEffectRow = (stopIdx: number, label: string, panelTitle?: string) => (
          <div className="flex items-center justify-between w-full">
            <ControlLabel label={label} property="" plain />
            <div className="w-full">
              <ControlActionRow onClick={() => pushPanel(panelTitle ?? label, (
                <StopEditor stopsRef={stopsRef} stopIndex={stopIdx} nodeId={nodeId} triggerRef={triggerRef} transitionRef={transitionRef} sectionIdRef={sectionIdRef} sectionViewportRef={sectionViewportRef} layerRangeRef={layerRangeRef} layerExitRef={layerExitRef} directionRef={directionRef} replayRef={replayRef} mode={mode} scopedWrite={scopedTransformWrite} directionScope={scrollData?.scope} scopedDirectionWrite={scopedDirectionWrite} />
              ))}>
                <svg width="14" height="14" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="6" className="text-[var(--text-secondary)] shrink-0">
                  <path fill="currentColor" d="m24.95 42.36l5.466-11.99l12.689-3.72l-9.767-8.88l.368-13.163l-11.502 6.503l-12.46-4.416l2.657 12.9l-8.069 10.433l13.145 1.47z" />
                  <path d="m36.178 36.054l8 7.964" />
                </svg>
                <span className="text-[var(--text-secondary)]">Effect</span>
              </ControlActionRow>
            </div>
          </div>
        );

        /** The shared Transition row — same widget the StylesTool uses. */
        const renderTransitionRow = () => (
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Transition" property="" plain />
            <div className="w-full">
              <ControlActionRow onClick={() => pushPanel('Transition', (
                <TransitionPanel
                  initialTransition={transition}
                  restrictTo={['spring']}
                  onWrite={(t) => {
                    setTransition(t);
                    writeToCode(stops, trigger, t);
                  }}
                />
              ))}>
                <TransitionCurveIcon isSpring={transition.type === 'spring'} />
                <span className="text-[var(--text-secondary)] truncate">
                  {summarizeTransition(transition)}
                </span>
              </ControlActionRow>
            </div>
          </div>
        );

        const isLayerMode = isMotionScrollMode(trigger);
        // Preset dropdown (On Scroll) — quick-fills the To; From stays resting.
        const renderPresetRow = () => (
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Preset" property="" plain />
            <div className="w-full">
              <ToolSelect
                value={detectScrollPreset(stops[stops.length - 1]?.props || {})}
                onChange={(v) => {
                  if (v === 'custom') return;
                  const newStops: ScrollStop[] = [
                    { progress: 0, props: {} },
                    { progress: 1, props: { ...SCROLL_PRESETS[v] } },
                  ];
                  stopsRef.current = newStops;
                  setStops(newStops);
                  writeToCode(newStops, trigger, transition);
                  trace.action('scroll-editor:preset', { nodeId, preset: v });
                }}
                options={Object.entries(SCROLL_PRESET_LABELS).map(([value, label]) => ({ value, label }))}
              />
            </div>
          </div>
        );
        return (
          <>
            {/* First section anchor (sectionInView only). Belongs visually
                with the From/To/Transition block below. */}
            {isSectionMode && stops.length >= 2 && renderAnchorRow(1, false)}
            {/* Scroll Animation On Scroll: Preset + To only (From = resting).
                Scroll Transform (scrubbed) and Section in View: explicit From + To. */}
            {isLayerMode && mode === 'animation' ? renderPresetRow() : renderEffectRow(0, 'From')}
            {/* First To */}
            {stops.length >= 2 && renderEffectRow(1, 'To',
              isSectionMode && stops.length >= 3 ? 'Section 1 — To' : 'To')}
            {/* Transition — attached to the first section block. */}
            {renderTransitionRow()}
            {/* Additional sections (stops[2..N]) — each is its own block
                separated by a ToolDivider, with its own Section anchor
                and To Effect. Only in Scroll Transform (multi-section);
                Scroll Animation is single-section. */}
            {allowMultiSection && stops.slice(2).map((_, idx) => {
              const i = idx + 2;
              return (
                <Fragment key={i}>
                  <ToolDivider />
                  {renderAnchorRow(i, stops.length > 2)}
                  {renderEffectRow(i, 'To', `Section ${i} — To`)}
                </Fragment>
              );
            })}
          </>
        );
      })()}

      {/* Add Section — only when sectionInView is the trigger (Layer in
          View / On Scroll are strictly From → To). Sticky to the bottom
          of the scrollable panel so it stays visible as the user adds
          more milestones and the list scrolls. Negative horizontal
          margins + matching padding extend the solid bg to the popup
          edges, hiding the section rows that scroll past underneath.
          `bg-[var(--bg-surface)]` matches ToolPopup's container bg. */}
      {trigger === 'sectionInView' && allowMultiSection && (
        <div className="sticky bottom-0 -mx-3 px-3 pt-2 pb-1 bg-[var(--bg-surface)] z-10">
          <button onClick={addStop}
            className="w-full h-[var(--control-height)] flex items-center justify-center text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] cursor-pointer transition-colors">
            Add Section
          </button>
        </div>
      )}
    </div>
  );
}
