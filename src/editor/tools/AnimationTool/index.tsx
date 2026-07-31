// AnimationTool/index.tsx — Main animation panel orchestrator.
// Detects all animations on the selected node, renders entries, handles add/remove.
// Sub-editors live in motion/ and css/ subfolders.

import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { ToolSection, ToolRow, ToolDivider, ControlLabel, ControlActionRow, RemoveButton } from '../../controls';
import ToolPopup from '../../ui/ToolPopup';
import { useControl } from '../../controls/ControlProvider';
import { keyframesBumpAtom, scrollAnimDataAtom, activeKeyframeSheetAtom, selectedKeyframeStopAtom, textAnimCallsAtom, cssHoverStylesAtom } from '@/code/stores/animation-store';
import { codeAtom, getNodeFromCache } from '@/code/stores/store';
import { overlayCallsAtom } from '@/code/stores/overlay-store';
import { getScrollDataForNode, getMultiSectionForNode, parseScrollDirection } from '@/code/parsing/scroll-parser';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { refreshCanvasTokens } from '@/canvas/node-ops';
import {
  parseTransitionShorthand, formatTransitionShorthand,
  parseAnimationShorthand, formatAnimationShorthand,
  transitionSummary, animationSummary,
  createDefaultTransition, createDefaultAnimation,
  createDefaultKeyframeAnimation, formatKeyframes,
} from '@/shared/animation-utils';
import { trace } from '@/shared/debug-trace';

// Sub-components
import { type AnimEntryType, type DetectedEntry, ENTRY_META, OpenEditorBadge } from './shared';
import type { MenuItem } from '../../controls/control-menu-items';
import { copiedAnimationAtom, buildCopiedAnimation, canPasteAnimation, applyCopiedAnimation, type CopiedAnimation } from './animation-clipboard';
import { appearReveal } from './appear-utils';
import { summarizeTransition } from './CurvePreview';
import AddEffectDropdown, { type AddActionType } from './AddEffectDropdown';
import NameInputModal from '../../ui/NameInputModal';
import { ScrollTransformEditor } from './motion/ScrollEditor';
import { activeFilePathAtom, listPageFiles, getFileDisplayName } from '@/code/project/active-file-store';
import { projectVersionAtom } from '@/code/project/project-fs';
import { getEffectsForPage, setPageEffectForPage, removePageEffectForPage, routeForPage } from '@/code/project/page-effects-ops';
import { applyPreset } from '@/code/generation/view-transition-css';
import { isHomeRoute, type PageEffect } from '@/code/project/page-effects-config';
import PageEffectPopup from '../PageEffectTool/PageEffectPopup';
import { ScrollVariantEditor } from './motion/ScrollVariantEditor';
import { getScrollVariant, scrollVariantPresentOn, scrollVariantIsOverride, hasScrollVariantTargetScope, hideScrollVariantOn, resetScrollVariantScope, type ScrollVariantSpec, ensureComponentAcceptsRef } from '@/code/generation/scroll-variant-gen';
import { getInstanceFx, resetTransformScope, hasTransformScope, resetFxValueScope, hasFxValueScope, resetSpeedScope, hasSpeedScope, instanceFxNeedsRef, instanceFxPresentOn, instanceFxIsOverride, addInstanceFxScope, hideInstanceFxOn, resetInstanceFxScope, type InstanceFxSpec, type FxKey } from '@/code/generation/instance-fx-gen';
import type { SerScope } from '@/code/generation/generator-motion';
import { upsertResponsive, dropResponsive, findResponsive, presentOn, isPresenceOverride, hidePresenceOn, scopeEq } from '@/code/animations/presence';
import { parseVariantConfig } from '@/code/variants/variant-config';
import { projectFS } from '@/code/project/project-fs';
import { modifyProjectFile } from '@/code/project/modify-file';
import { type ScrollFxSpec, getScrollFx, getSpeedResponsive } from '@/code/generation/generator-motion';
import { getActiveAnimationScope, resolveResponsiveMotionProp } from './animation-scope-source';
import { getSortedBreakpointWidths, activeComponentVariantAtom } from '@/code/stores/viewport-store';
import TextEffectPopup from './motion/TextEffectPopup';
import { getTextAnimForNode } from '@/code/parsing/text-anim-parser';
import { DEFAULT_TEXT_ANIM, hasTextAnimScope, resetTextAnimScope, type TextAnimConfig, type TextAnimScope } from './motion/text-anim-presets';
import { consumeAnchorOverride } from '../../controls/unified/UsedByRow';
import { isTextTag } from '@/shared/constants';
import { LocalizeGate } from '@/editor/controls/localize-gate';
import {
  summarizeSketchAnim,
  type SketchAnimConfig,
} from '@/code/sketch/sketch-anim-config';
import { createDefaultSketchAnim, readSketchAnimFromCode } from '@/code/sketch/sketch-anim-gen';

// Popup editors — lifted to popups/ + css/ (Phase 7 god-file split, item 7.6).
import { InstanceFxPopup } from './popups/InstanceFxPopup';
import { InstanceAppearPopup } from './popups/InstanceAppearPopup';
import { InstanceScrollSpeedPopup } from './popups/InstanceScrollSpeedPopup';
import { InstanceScrollTransformPopup } from './popups/InstanceScrollTransformPopup';
import { HoverPopup } from './popups/HoverPopup';
import { GlidePopup } from './popups/GlidePopup';
import { TapPopup } from './popups/TapPopup';
import { OverlayAppearPopup } from './popups/OverlayAppearPopup';
import { AppearScrollPopup } from './popups/AppearScrollPopup';
import { ScrollSpeedPopup } from './popups/ScrollSpeedPopup';
import { LoopPopup } from './popups/LoopPopup';
import { SketchDrawPopup } from './popups/SketchDrawPopup';
import { CssTransitionEditor } from './css/CssTransitionEditor';
import { seedScroll } from './popups/seeds';

/** Equality for two resolved scopes ({query}|{variant}|null) — matches a stored
 *  scroll-value override against the active tile's scope. */
function sameScope(a: any, b: any): boolean {
  if (!a || !b) return false;
  if ('query' in a && 'query' in b) return a.query === b.query;
  if ('variant' in a && 'variant' in b) return a.variant === b.variant;
  return false;
}

// ─── Entry Card ─────────────────────────────────────────────────────────────

/** Animation entry — uses w-3/4 label + w-full button format like Border/Shadow/Transform */
function AnimEntryCard({ type, summary, onEdit, onRemove, dataAttr, labelOverride, isOverride, onReset, chipLabel, hideLabel, nodeId, node, copyable }: {
  type: AnimEntryType; summary: string; onEdit: (e?: React.MouseEvent) => void; onRemove?: () => void; dataAttr?: string; labelOverride?: string;
  /** This animation is a per-breakpoint / per-variant OVERRIDE on the current
   *  tile (differs from base). The label goes accent + click resets (removes it). */
  isOverride?: boolean; onReset?: () => void;
  /** Override the chip's text (e.g. grouped Scroll effects show "Animation" /
   *  "Speed" / "Transform" instead of the per-entry summary). */
  chipLabel?: string;
  /** Render an empty left column (used to stack grouped rows under one label). */
  hideLabel?: boolean;
  /** Selected node — Paste Style applies the copied animation here. */
  nodeId?: string;
  /** The full target CanvasNode — lets Paste derive the Appear reveal over the
   *  node's existing enter keys + authored styles (so layout keys don't collapse). */
  node?: any;
  /** This entry's clipboard snapshot (null for kinds that don't support copy/paste). */
  copyable?: CopiedAnimation | null;
}) {
  const meta = ENTRY_META[type];
  const opensSheet = type === 'keyframe';

  // Animation Copy / Paste Style. The default CSS-style copy/paste (gated on a
  // real `property`) is meaningless here, so we hide it (`hideCopyPasteStyle`)
  // and inject our own that snapshots / re-applies THIS animation entry.
  const copiedAnim = useAtomValue(copiedAnimationAtom);
  const setCopiedAnim = useSetAtom(copiedAnimationAtom);
  const animMenuItems: MenuItem[] = copyable
    ? [
        { label: 'Copy Style', show: true, separator: true, onClick: () => { setCopiedAnim(copyable); trace.action('anim-clipboard:copy', { kind: copyable.kind }); } },
        { label: 'Paste Style', show: canPasteAnimation(copiedAnim, type), onClick: () => { if (copiedAnim && nodeId) applyCopiedAnimation(copiedAnim, nodeId, node); } },
      ]
    : [];

  return (
    <div className="flex items-center justify-between w-full">
      {/* Real ControlLabel (chevron + dropdown menu) so animation rows match
          every other control. `property=""` (not a CSS prop) → we suppress the
          variable / CMS / Reset-Style menu entries; `overridden` forces the
          accent when this animation is a per-breakpoint/per-variant override on
          the current tile, and `onResetOverride` makes "Reset Override" remove
          the scoped animation. Copy/Paste Style is injected via extraMenuItems
          (the default style copy/paste is hidden — animations aren't CSS). */}
      <div className="w-3/4">
        {hideLabel ? <span /> : (
          <ControlLabel
            label={labelOverride || meta.label}
            property=""
            overridden={isOverride}
            onResetOverride={onReset}
            hideResetStyle
            hideCreateVariable
            hideCmsBinding
            hideCopyPasteStyle
            extraMenuItems={animMenuItems}
          />
        )}
      </div>
      <ControlActionRow onClick={onEdit} className={`${opensSheet ? 'justify-center' : 'justify-between pr-2'}`}
        {...(dataAttr ? { [dataAttr]: '' } : {})}>
        {opensSheet ? (
          <OpenEditorBadge />
        ) : (
          <span className="flex items-center gap-1.5">
            <meta.Icon width={20} height={20} className="shrink-0" />
            <span className="text-[var(--text-secondary)]">{chipLabel ?? (summary || 'Edit')}</span>
          </span>
        )}
        {onRemove && (
          <RemoveButton onClick={() => onRemove()} />
        )}
      </ControlActionRow>
    </div>
  );
}

// ─── Main AnimationTool ─────────────────────────────────────────────────────

interface Props { styles: Record<string, string>; onUpdate: (key: string, value: string) => void; glideOnly?: boolean; }

export default function AnimationTool({ styles: s, onUpdate, glideOnly }: Props) {
  const { node, vpWidth } = useControl();
  // Overlay nodes only support Appear (the panel mounts/unmounts with its
  // trigger) — the Add dropdown greys everything else out.
  const isOverlayNode = useAtomValue(overlayCallsAtom).some((c) => c.overlayId === node?.id);
  // Scope context — which tile/variant is being viewed, so per-breakpoint /
  // per-variant animations only show on the tile they belong to (+ a Reset).
  const activeVariant = useAtomValue(activeComponentVariantAtom);
  const scopeCtx = useMemo(
    () => ({ vpWidth, allWidths: getSortedBreakpointWidths(), variant: activeVariant }),
    [vpWidth, activeVariant],
  );
  const setKeyframeSheet = useSetAtom(activeKeyframeSheetAtom);
  const setSelectedKeyframeStop = useSetAtom(selectedKeyframeStopAtom);
  const bumpKeyframes = useSetAtom(keyframesBumpAtom);
  const [activePopup, setActivePopup] = useState<string | null>(null);
  const [showKfNameModal, setShowKfNameModal] = useState(false);
  const popupAnchorRef = useRef<HTMLDivElement>(null);
  const clickedEntryRef = useRef<HTMLElement | null>(null);
  // ─── Page Transitions (View Transitions) — page-level effect on the viewport.
  // Lives in the Animation tool's "+" (glideOnly), not a separate Effects tool.
  const activePageFile = useAtomValue(activeFilePathAtom);
  useAtomValue(projectVersionAtom); // recompute page effects when project files change
  const setProjVersion = useSetAtom(projectVersionAtom);
  const pageEffects = (glideOnly && activePageFile) ? getEffectsForPage(activePageFile) : [];
  // "All Pages" (the site-wide default) is ONLY offered on the HOME page. On any
  // other page you override a specific destination (this page → target page), so
  // the Target list is just the page list — no "All Pages".
  const isHomePage = activePageFile ? isHomeRoute(routeForPage(activePageFile)) : false;
  const pageList = (glideOnly && activePageFile)
    ? listPageFiles().filter((f) => f !== activePageFile)
        .map((f) => ({ value: routeForPage(f), label: isHomeRoute(routeForPage(f)) ? 'Home' : getFileDisplayName(f) }))
    : [];
  const pageTargetOptions = (glideOnly && activePageFile)
    ? [...(isHomePage ? [{ value: 'all', label: 'All Pages' }] : []), ...pageList]
    : [];
  const commitPageEffect = (prevTarget: string, e: PageEffect) => {
    if (!activePageFile) return;
    if (e.target !== prevTarget) removePageEffectForPage(activePageFile, prevTarget);
    setPageEffectForPage(activePageFile, e);
    setProjVersion((v) => v + 1);
    setActivePopup('pageTransition:' + e.target);
  };
  const removePageEffect = (target: string) => {
    if (!activePageFile) return;
    removePageEffectForPage(activePageFile, target);
    setProjVersion((v) => v + 1);
    if (activePopup === 'pageTransition:' + target) setActivePopup(null);
  };
  const allTextAnims = useAtomValue(textAnimCallsAtom);
  const cssHoverStyles = useAtomValue(cssHoverStylesAtom);
  const scrollData = useAtomValue(scrollAnimDataAtom);
  const code = useAtomValue(codeAtom);
  const nodeId = node?.id || '';

  // ─── Detect all animations ─────────────────────────────
  const detected = useMemo(() => {
    const entries: DetectedEntry[] = [];
    if (!node) return entries;
    const mp = node.motionProps;
    // The tile/variant being worked on, for marking per-viewport overrides. Reactive
    // via the scopeCtx dep (recomputes when the active viewport/variant changes).
    const activeScope = getActiveAnimationScope() as SerScope | null;

    // Scroll Variant (component instances) — page-level, independent of the
    // data-scroll-fx motion-value compose, so it's detected straight from the code.
    const svSpec = getScrollVariant(code, nodeId);
    // Per-viewport presence: only show the row on tiles where the effect actually runs
    // (a replica-only effect is hidden on Desktop; a hidden-here effect is hidden on
    // that replica). Flag a presence customization so the Scroll group shows a Reset.
    if (svSpec && scrollVariantPresentOn(svSpec, activeScope)) {
      // PURPLE label = an explicit per-tile customization of the EFFECT itself: its PRESENCE
      // (added / removed / hidden on this viewport via scope/hiddenOn). The effect's per-viewport
      // VARIANT TARGET config (`responsive[scope].to`/`from`/`direction`) is the effect's natural
      // per-viewport behavior on a multi-variant component — NOT a "this tile overrides the effect"
      // signal — so it stays un-accented ("tied"), matching the Variant-row rule. (Per-tile targets
      // remain editable + resettable inside the Scroll effect editor.)
      entries.push({ type: 'scrollVariant', summary: 'Edit', key: 'scrollVariant',
        data: { spec: svSpec, componentFile: node.componentFile, isOverride: scrollVariantIsOverride(svSpec, activeScope) } });
    }

    // Component-instance effects (Hover/Press/Appear/Loop) — page-level instance-fx,
    // read straight from the `data-instance-fx` spec. Instances can't carry the
    // whileHover/animate that the fxSpec/motionProps detection below looks for, so
    // this is their ONLY detection path (no double-counting with regular nodes).
    if (node.componentFile) {
      const ifx = getInstanceFx(code, nodeId);
      // Per-viewport PRESENCE: only show an effect's row on tiles where it actually runs
      // (added-on-a-replica is absent on primary; hidden-here is absent on that replica).
      // `over(key)` flags a presence customization so the Scroll group / row shows Reset.
      const present = (key: FxKey) => !!ifx && instanceFxPresentOn(ifx, key, activeScope);
      // Override dot = a PRESENCE customization (added/hidden here) OR a per-tile VALUE
      // override (hover/tap/appear `to`/`from`, or speed) on the active replica.
      const over = (key: FxKey) => !!ifx && (instanceFxIsOverride(ifx, key, activeScope)
        || ((key === 'hover' || key === 'tap' || key === 'appear') && hasFxValueScope(ifx, key, activeScope))
        || (key === 'speed' && hasSpeedScope(ifx, activeScope)));
      if (ifx?.hover && present('hover')) entries.push({ type: 'hover', summary: 'Motion', key: 'hover', data: { instanceFx: ifx, fxKind: 'hover', isOverride: over('hover') } });
      if (ifx?.tap && present('tap')) entries.push({ type: 'tap', summary: 'Motion', key: 'tap', data: { instanceFx: ifx, fxKind: 'tap', isOverride: over('tap') } });
      if (ifx?.appear && present('appear')) {
        // A scroll-driven trigger (onScroll/layerInView) moves the row into the Scroll
        // group with a 'scroll' chip — same as a regular node's On-Scroll appear; only
        // onAppear (mount) stays a standalone Appear row.
        const scrollTriggered = (ifx.appear.trigger ?? 'onAppear') !== 'onAppear';
        entries.push({ type: 'appear', summary: scrollTriggered ? 'Scroll' : 'Appear', key: 'appear',
          data: { instanceFx: ifx, fxKind: 'appear', trigger: scrollTriggered ? 'scroll' : 'appear', isOverride: over('appear') } });
      }
      if (ifx?.loop && present('loop')) entries.push({ type: 'loop', summary: 'Edit', key: 'loop', data: { instanceFx: ifx, fxKind: 'loop', isOverride: over('loop') } });
      if (ifx?.transform && present('transform')) entries.push({ type: 'scrollTransform', summary: 'Edit', key: 'scrollTransform', data: { instanceFx: ifx, fxKind: 'transform', isOverride: hasTransformScope(ifx, activeScope) || over('transform') } });
      if (ifx?.speed != null && ifx.speed !== 100 && present('speed')) entries.push({ type: 'scrollSpeed', summary: `${ifx.speed}%`, key: 'scrollSpeed', data: { instanceFx: ifx, fxKind: 'speed', isOverride: over('speed') } });
    }

    // Tap and Hover are both unified across engines below — see those
    // blocks. Detected as a single row each, with engine + payload
    // packed into `entry.data` so the popup can route to the right
    // editor and the × button can dispatch the right removal mutation.

    // Appear (Enter-only). The ENTER state is `initial` — scoped/responsive like
    // hover/tap. Resolve it for this tile so the row shows where the enter applies
    // with the override indicator; the seed is the active tile's enter value.
    // Unified Appear / Scroll (the reference model): one trigger-switched entry. On
    // Appear = `whileInView` (animate once); On Scroll = `useScroll` (scrubbed).
    // The ENTER state (`initial`) is responsive like hover/tap.
    // ── Combined node (the reference model): when multiple scroll effects share a
    //    property they're composed into ONE native element, and the original
    //    separate-form params survive in `data-scroll-fx` on the div. Every
    //    parser (incl. parseProjectFile) keeps the attr in node.attrs. When it's
    //    present we drive the rows straight off the spec — the combined source no
    //    longer carries the separate whileInView/animate/bindings to detect from.
    let fxSpec: ScrollFxSpec | null = null;
    const fxRaw = node.attrs?.['data-scroll-fx'];
    if (fxRaw) { try { fxSpec = JSON.parse(fxRaw); } catch { fxSpec = null; } }
    // Glide ("Flow") — a per-node container effect stored as data-glide, independent
    // of the scroll-fx spec. Stacks alongside the others; shows one Transition row.
    const glideRaw = node.attrs?.['data-glide'];
    if (glideRaw) {
      let glideSpec: { transition?: Record<string, string> } | null = null;
      try { glideSpec = JSON.parse(glideRaw); } catch { glideSpec = null; }
      if (glideSpec) {
        entries.push({ type: 'glide', summary: summarizeTransition(glideSpec.transition || {}), key: 'glide', data: { spec: glideSpec } });
      }
    }
    // Direction-triggered On Scroll uses an `animate=` ternary with no style
    // bindings; parse it up front since both the loop guard (below) and the
    // separate-form detection need it. (null for a combined node.)
    const scrollDir = parseScrollDirection(code, nodeId);
    if (fxSpec) {
      // A responsive motion-prop effect (hover/tap/appear) shows on the active tile only
      // when it has a base (runs everywhere) OR a responsive override for THIS viewport —
      // mirrors the motionProps-path resolveResponsiveMotionProp. Without this, persisting
      // the attr for a responsive TRANSFORM would route the whole node onto this path and
      // make a tablet-only hover appear on every viewport. `props` = the active-tile value.
      const fxApplies = (base: Record<string, string> | undefined, responsive: unknown, hiddenOn?: SerScope[]) => {
        // PRESENCE first: hidden on this tile (the reference "removed here") → no row at all.
        if (activeScope && (hiddenOn ?? []).some((s) => scopeEq(s, activeScope))) {
          return { applies: false, isOverride: false, props: {} };
        }
        const ov = activeScope ? (findResponsive(responsive as any, activeScope) as any) : undefined;
        if (ov) return { applies: true, isOverride: true, props: { ...(base ?? {}), ...(ov.props ?? {}) } };
        const hasBase = !!base && Object.keys(base).length > 0;
        return { applies: hasBase, isOverride: false, props: { ...(base ?? {}) } };
      };
      if (fxSpec.appear) {
        const a = fxApplies(fxSpec.appear.initial, fxSpec.appear.responsive, fxSpec.appear.hiddenOn);
        if (a.applies) entries.push({ type: 'appear', summary: 'Appear', key: 'appear',
          data: { trigger: 'appear', initialProps: a.props,
            transition: fxSpec.appear.transition || {}, isVariantMode: false, isOverride: a.isOverride, fxSpec, fxKind: 'appear' } });
      }
      if (fxSpec.animation && presentOn({ scope: (fxSpec.animation as any).scope }, activeScope)) {
        entries.push({ type: 'appear', summary: 'Scroll', key: 'appear',
          data: { trigger: 'scroll', scrollPayload: { directionTriggered: true, toProps: fxSpec.animation.toProps,
            direction: fxSpec.animation.direction, replay: fxSpec.animation.replay, transition: fxSpec.animation.transition,
            scope: (fxSpec.animation as any).scope },
            isOverride: isPresenceOverride({ scope: (fxSpec.animation as any).scope }, activeScope), isVariantMode: false, fxSpec, fxKind: 'animation' } });
      }
      // Presence gate: a transform ADDED on a replica carries `scope` and must NOT
      // appear on primary/other tiles (same 3-state model as loop/animation). A
      // per-viewport VALUE override (`responsive`) flags the row for Reset.
      if (fxSpec.transform && presentOn({ scope: (fxSpec.transform as any).scope }, activeScope)) {
        // Shape the spec into what ScrollTransformEditor reads: `transformSpec`
        // (From/To → stops, see extractStopsFromScrollData), `transition`, and a
        // synthetic `source.refVar` so detectTriggerFromOffset resolves the
        // trigger (refVar set → layerInView, unset → onScroll).
        entries.push({ type: 'scrollTransform', summary: 'Edit', key: 'scrollTransform',
          data: { fxSpec, fxKind: 'transform', transformSpec: fxSpec.transform,
            transition: fxSpec.transform.transition,
            isOverride: isPresenceOverride({ scope: (fxSpec.transform as any).scope }, activeScope)
              || !!(activeScope && findResponsive((fxSpec.transform as any).responsive, activeScope)),
            source: { offset: null, refVar: fxSpec.transform.trigger === 'layerInView' ? 'fx' : undefined } } });
      }
      if (typeof fxSpec.speed === 'number') {
        // PRESENCE (same as the separate-form path): 100% = identity. A replica-added
        // Speed keeps base 100 + the real value in speedResponsive — resolve the active
        // tile's value and only surface a row where it's a real (non-100) speed or has
        // an explicit override here.
        const sov = activeScope ? findResponsive<{ scope: SerScope; speed: number }>((fxSpec as any).speedResponsive, activeScope) : undefined;
        const sShown = sov ? sov.speed : fxSpec.speed;
        if (sShown !== 100 || !!sov) {
          entries.push({ type: 'scrollSpeed', summary: `${sShown}%`, key: 'scrollSpeed',
            data: { speed: sShown, isOverride: !!sov, fxSpec, fxKind: 'speed' } });
        }
      }
      // Hover / Tap folded into the scroll motion values — the spec holds the full
      // gesture props (the live whileHover may be gone or partial after compose).
      if (fxSpec.hover) {
        const a = fxApplies(fxSpec.hover.props, fxSpec.hover.responsive, fxSpec.hover.hiddenOn);
        if (a.applies) entries.push({ type: 'hover', summary: 'Motion', key: 'hover',
          data: { engine: 'motion', payload: { props: a.props }, isOverride: a.isOverride, fxSpec, fxKind: 'hover' } });
      }
      if (fxSpec.tap) {
        const a = fxApplies(fxSpec.tap.props, fxSpec.tap.responsive, fxSpec.tap.hiddenOn);
        if (a.applies) entries.push({ type: 'tap', summary: 'Motion', key: 'tap',
          data: { engine: 'motion', payload: { props: a.props }, isOverride: a.isOverride, fxSpec, fxKind: 'tap' } });
      }
      if (fxSpec.loop && presentOn({ scope: (fxSpec.loop as any).scope }, activeScope)) {
        entries.push({ type: 'loop', summary: 'Edit', key: 'loop',
          data: { props: fxSpec.loop.props, transition: fxSpec.loop.transition, offscreen: fxSpec.loop.offscreen,
            scope: (fxSpec.loop as any).scope, isOverride: isPresenceOverride({ scope: (fxSpec.loop as any).scope }, activeScope), fxSpec, fxKind: 'loop' } });
      }
      // NOTE: do NOT return here — Hover / Tap / Loop / text effects can ALSO
      // stack on a combined node (the reference blends them with the scroll effects). They
      // detect from node.motionProps / parsed calls below, independent of the spec.
      // We only skip the SCROLL re-detection (the spec already provided those rows).
    } else if (!node.componentFile) {
    // Component instances drive Scroll Transform/Speed/Appear through instance-fx +
    // Scroll Variant (detected above), and their page-level useScroll/useTransform
    // hooks would otherwise be re-detected here as a DUPLICATE scroll-transform row.
    const nodeScroll = getScrollDataForNode(scrollData, nodeId);
    const multiSectionForNode = getMultiSectionForNode(scrollData, nodeId);
    const hasMotionScroll = nodeScroll.bindings.length > 0 || !!multiSectionForNode;
    const hasMotionAppear = !!(mp?.whileInView && !mp.whileInView._variantName);
    // ── Scroll Animation (DISCRETE): On Appear / in-view / direction-triggered
    //    On Scroll. State-based — plays a transition when triggered. The scrubbed
    //    Scroll Transform is a SEPARATE entry (below), so these no longer share.
    if (isOverlayNode && mp?.animate && !mp.animate._variantName) {
      // Overlay appear uses initial→animate + exit inside <AnimatePresence> (NOT
      // whileInView) — it gets both an ENTER and an EXIT animation. Editor: a
      // dedicated OverlayAppearPopup with Enter + Exit rows.
      entries.push({ type: 'appear', summary: 'Appear', key: 'appear',
        data: { trigger: 'appear', isOverlay: true, isVariantMode: false,
          initialProps: (mp.initial && !mp.initial._variantName) ? mp.initial : {},
          exitProps: (mp.exit && !mp.exit._variantName) ? mp.exit : {},
          transition: mp.transition || {} } });
    } else if (scrollDir && !hasMotionAppear) {
      entries.push({ type: 'appear', summary: 'Scroll', key: 'appear',
        data: { trigger: 'scroll', scrollPayload: { directionTriggered: true, toProps: scrollDir.toProps,
          direction: scrollDir.direction, replay: scrollDir.replay, transition: scrollDir.transition }, isVariantMode: false } });
    } else if (hasMotionAppear) {
      const motionInitial = mp?.initial && !mp.initial._variantName ? mp.initial : null;
      const r = motionInitial
        ? resolveResponsiveMotionProp(motionInitial, code, scopeCtx)
        : { applies: true, isOverride: false, props: {} };
      if (r.applies) {
        entries.push({ type: 'appear', summary: 'Appear', key: 'appear',
          data: { trigger: 'appear', initialProps: r.props, transition: mp.transition || {}, isVariantMode: false, isOverride: r.isOverride } });
      }
    } else if (mp?.whileInView?._variantName && node.motionVariants) {
      const initName = mp.initial?._variantName || '';
      entries.push({ type: 'appear', summary: 'Appear', key: 'appear',
        data: { trigger: 'appear', initialProps: node.motionVariants[initName] || {},
                transition: mp.transition || {}, isVariantMode: true, initialName: initName } });
    }

    // ── Scroll Transform (SCRUBBED): From→To tied to scroll progress, with
    //    multi-section morphing. A SEPARATE, stackable entry — coexists with
    //    Scroll Animation (discrete) and Scroll Speed (parallax) on one node.
    if (hasMotionScroll) {
      const secCount = multiSectionForNode?.sections?.length ?? 0;
      entries.push({ type: 'scrollTransform', summary: secCount > 1 ? `${secCount} sections` : 'Edit', key: 'scrollTransform',
        data: { ...nodeScroll, multiSectionForNode, direction: nodeScroll.direction, replay: nodeScroll.replay } });
    }

    // Scroll Speed (parallax) — a SEPARATE, stackable effect (its own row).
    // RESPONSIVE: resolve the value for the ACTIVE viewport/variant (its override if
    // one exists, else the base) and flag it as an override so the row gets a Reset.
    const speedR = getSpeedResponsive(code, nodeId);
    if (speedR !== null) {
      const active = getActiveAnimationScope();
      const ov = active ? speedR.responsive.find(r => sameScope(r.scope, active)) : null;
      const shown = ov ? ov.speed : speedR.base;
      // PRESENCE: 100% = identity (no parallax). When Speed is added on a replica the
      // base stays 100 and the real value lives in the override — so on primary/other
      // tiles it resolves to 100 (no effect) and must NOT surface a row. Show only where
      // it resolves to a real value, OR there's an explicit override here (so it's resettable).
      if (shown !== 100 || !!ov) {
        entries.push({ type: 'scrollSpeed', summary: `${shown}%`, key: 'scrollSpeed', data: { speed: shown, isOverride: !!ov } });
      }
    }
    } // end separate-form scroll detection — Hover/Tap/Loop run for BOTH below

    // Loop (Motion).
    // NOT when the `animate` is the direction-triggered On Scroll ternary
    // (`animate={xScrolled ? … : …}`, marked `gate:…Scrolled`) — that's a Scroll,
    // not a Loop.
    const animIsScrollTrigger = !!scrollDir || /Scrolled$/.test((mp?.animate as any)?._scope?.replace(/^gate:/, '') || '');
    // Combined nodes drive the Loop row from the spec (the live animate={{…}} is
    // folded into a useEffect); skip live detection when the spec carries it.
    // Overlays carry `animate` as their Appear RESTING state (inside
    // <AnimatePresence>), NOT a loop — exclude them or a phantom Loop row shows.
    if (mp?.animate && !mp.animate._variantName && !animIsScrollTrigger && !fxSpec?.loop && !isOverlayNode) {
      entries.push({ type: 'loop', summary: 'Edit', key: 'loop',
        data: { props: mp.animate, transition: mp?.transition || {} } });
    }

    // Hover & Tap detection — Motion only. (CSS hover removed: CSS transform
    // can't beat motion's inline projection. Coordinated multi-element hover =
    // a component + a mouseEnter variant connection.)
    // `resolveResponsiveMotionProp` reads back the full
    // responsive chain (`__mqN ? … : base`) so the row shows on the right tile,
    // seeds the active tile's value, and flags the override (→ Reset).
    // Combined nodes drive Hover/Tap rows from the spec above when it carries the
    // gesture (it's been folded into handlers). Guard on the spec ENTRY, not just
    // fxSpec — a transitional combined node may still have a live whileHover whose
    // gesture isn't in the spec yet; that should still show via live detection.
    const motionHover = !fxSpec?.hover && mp?.whileHover && !mp.whileHover._variantName ? mp.whileHover : null;
    if (motionHover) {
      const { applies, isOverride, props } = resolveResponsiveMotionProp(motionHover, code, scopeCtx);
      if (applies) {
        entries.push({ type: 'hover', summary: 'Motion', key: 'hover',
          // `transition` = the tag-level prop the HoverPopup's Transition row
          // edits — carried so Copy Style captures the timing with the gesture
          // (pasting a hover without its spring pasted only half the effect).
          data: { engine: 'motion', payload: { props }, isOverride, transition: mp?.transition || {} } });
      }
    }

    const motionTap = !fxSpec?.tap && mp?.whileTap && !mp.whileTap._variantName ? mp.whileTap : null;
    if (motionTap) {
      const { applies, isOverride, props } = resolveResponsiveMotionProp(motionTap, code, scopeCtx);
      if (applies) {
        entries.push({ type: 'tap', summary: 'Motion', key: 'tap',
          data: { engine: 'motion', payload: { props }, isOverride, transition: mp?.transition || {} } });
      }
    }

    // Text animation (Motion) — blue override on a replica/variant when this tile has a value override.
    const textAnim = getTextAnimForNode(allTextAnims, nodeId);
    if (textAnim) {
      const taScope = getActiveAnimationScope() as TextAnimScope | null;
      entries.push({ type: 'textEffect', summary: textAnim.config.animationType, key: 'textEffect',
        data: { ...textAnim, isOverride: hasTextAnimScope(textAnim.config, taScope) } });
    }

    // CSS
    const trans = parseTransitionShorthand(s.transition);
    if (trans.length > 0) entries.push({ type: 'transition', summary: transitionSummary(trans), key: 'transition', data: trans });
    const anims = parseAnimationShorthand(s.animation);
    if (anims.length > 0) entries.push({ type: 'keyframe', summary: animationSummary(anims), key: 'keyframe', data: anims });

    // CSS :hover is folded into the unified Hover entry detected above.

    // Scroll Path is folded into the unified `scroll` entry detected above.

    // Sketch draw — config lives as a useEffect block injected into
    // the page component, marked with `// __SKETCH_ANIM_BLOCK_*__`
    // comments. We read the inline options literal back out of source
    // so the editor can show / edit it.
    if (node.type === 'svg' && node.attrs?.['data-sketch'] === 'true') {
      const cfg = readSketchAnimFromCode(code, nodeId);
      if (cfg) {
        entries.push({ type: 'sketchDraw', summary: summarizeSketchAnim(cfg), key: 'sketchDraw', data: cfg });
      }
    }

    return entries;
  }, [node, nodeId, allTextAnims, scrollData, code, s.transition, s.animation, cssHoverStyles, scopeCtx]);

  const existingTypes = useMemo(() => new Set(detected.map(d => d.type)), [detected]);

  // ─── Close a stale effect popup when selection moves to a node without it ───
  // Open the Appear popup on element A (which HAS Appear), then click element B
  // that does NOT → the popup must CLOSE; a popup for an effect the element
  // doesn't have shouldn't linger. Keyed on nodeId so it fires ONLY on a real
  // selection change — never on same-node edits, where the add-flow legitimately
  // opens a popup a frame before the new effect shows up in `detected`. If B has
  // the SAME effect the key matches, so the popup stays open and retargets (the
  // ToolPopup resetKey already re-keys its content to the new node).
  const prevNodeIdRef = useRef(nodeId);
  useEffect(() => {
    if (prevNodeIdRef.current === nodeId) return;
    prevNodeIdRef.current = nodeId;
    if (activePopup && !detected.some((d) => d.key === activePopup)) {
      setActivePopup(null);
      clickedEntryRef.current = null;
    }
  }, [nodeId, detected, activePopup]);

  // Component instances can't carry whileHover/animate (the component only forwards
  // style+ref), so Hover/Press/Appear/Loop route to the PAGE-LEVEL instance-fx system
  // instead of updateMotionProp. One `data-instance-fx` spec per instance; every write
  // merges into it.
  const isInstance = !!node?.componentFile;
  const writeInstanceFx = useCallback((mutate: (spec: InstanceFxSpec) => InstanceFxSpec) => {
    const cur = getInstanceFx(code, nodeId) || {};
    const next = mutate({ ...cur });
    const empty = !next.hover && !next.tap && !next.appear && !next.loop
      && (next.speed == null || next.speed === 100) && !next.transform;
    queueMutation(empty
      ? { type: 'removeInstanceFx', nodeId }
      : { type: 'updateInstanceFx', nodeId, spec: next });
    // Any ref-needing effect (hover/press, layerInView Appear, AND a non-section
    // Scroll Transform — its `useScroll` targets the instance box) requires the
    // component to FORWARD the ref, or `ref.current` is null and motion throws
    // "Target ref is defined but not hydrated". `instanceFxNeedsRef` is the same
    // condition setInstanceFxInCode uses to attach the ref, so they can't drift.
    if (instanceFxNeedsRef(next) && node?.componentFile) {
      modifyProjectFile(node.componentFile, ensureComponentAcceptsRef);
    }
  }, [code, nodeId, node]);

  // Add an instance effect SCOPED to the active tile: on a replica it's present there
  // ONLY (absent on primary, standard); on Desktop/primary it's a base effect.
  const addInstanceFx = useCallback((key: FxKey, seed: Partial<InstanceFxSpec>) => {
    const scope = getActiveAnimationScope() as SerScope | null;
    writeInstanceFx((sp) => addInstanceFxScope({ ...sp, ...seed }, key, scope));
  }, [writeInstanceFx]);

  // Normal-node (motion.*) effects — spec-driven, mirrors writeInstanceFx. Reads the
  // node's full ScrollFxSpec (from the data-scroll-fx attr or reconstructed from the
  // separate form), mutates ONE key, and regenerates the whole block via updateScrollFx.
  // This replaces the fragile per-prop decompose/remove path: clearing is format-
  // tolerant and regeneration is reformat-proof, so the X-to-remove can't orphan vars
  // or leave duplicate hooks behind.
  const writeScrollFx = useCallback((mutate: (spec: ScrollFxSpec) => ScrollFxSpec) => {
    const cur = getScrollFx(code, nodeId) || {};
    const next = mutate({ ...cur });
    const empty = !next.hover && !next.tap && !next.appear && !next.loop
      && !next.animation && !next.transform && (next.speed == null || next.speed === 100);
    queueMutation(empty
      ? { type: 'removeScrollFx', nodeId }
      : { type: 'updateScrollFx', nodeId, spec: next });
  }, [code, nodeId]);

  // Normal-node Scroll Transform: a From/To edit made on a REPLICA writes a per-viewport
  // override (transform.responsive, keeping base + siblings) via the spec path instead of
  // the base updateScrollAnim. Returns true when it handled the write (active scope present)
  // so the editor skips its base write. Shares upsertResponsive with the instance path.
  const commitScopedTransform = useCallback((which: 'from' | 'to', props: Record<string, string>): boolean => {
    const scope = getActiveAnimationScope() as SerScope | null;
    if (!scope) return false;
    writeScrollFx((sp) => {
      const tf = sp.transform ?? { trigger: 'onScroll', from: {}, to: {} };
      return { ...sp, transform: { ...tf, responsive: upsertResponsive(tf.responsive ?? [], scope, { [which]: props }) } };
    });
    return true;
  }, [writeScrollFx]);

  // Direction (On-Scroll) edit on a REPLICA → per-viewport override of direction/replay/
  // toProps in animation.responsive (keeping base + siblings); false on primary so the
  // editor does its normal base write. Same model as commitScopedTransform.
  const commitScopedDirection = useCallback((patch: { direction?: 'down' | 'up'; replay?: boolean; toProps?: Record<string, string> }): boolean => {
    const scope = getActiveAnimationScope() as SerScope | null;
    if (!scope) return false;
    writeScrollFx((sp) => {
      const anim = sp.animation ?? { direction: 'down' as const, replay: true, toProps: { opacity: '0' } };
      return { ...sp, animation: { ...anim, responsive: upsertResponsive(anim.responsive ?? [], scope, patch) } };
    });
    return true;
  }, [writeScrollFx]);

  // ─── Handlers ──────────────────────────────────────────
  const handleAdd = useCallback((type: AddActionType) => {
    trace.action('animation:add', { nodeId, type });
    // Scope the new effect to the tile/variant being worked on (null = base/all).
    // VALUE props (whileHover/whileTap/initial/whileInView/animate) get scoped;
    // structural props (viewport/transition) don't.
    const scope = getActiveAnimationScope();
    switch (type) {
      case 'hover':
        if (isInstance) { addInstanceFx('hover', { hover: { to: { scale: 1.05 } } }); setActivePopup('hover'); break; }
        queueMutation({ type: 'updateMotionProp', nodeId, propName: 'whileHover', props: { scale: '1.05' }, scope });
        setActivePopup('hover'); break;
      case 'tap':
        if (isInstance) { addInstanceFx('tap', { tap: { to: { scale: 0.95 } } }); setActivePopup('tap'); break; }
        queueMutation({ type: 'updateMotionProp', nodeId, propName: 'whileTap', props: { scale: '0.95' }, scope });
        setActivePopup('tap'); break;
      case 'appear':
        if (isInstance) { addInstanceFx('appear', { appear: { from: { opacity: 0, y: 30 } } }); setActivePopup('appear'); break; }
        // the reference model: only an ENTER (From) state — the element animates TO its
        // resting state automatically. `initial` is the (scoped) enter; `whileInView`
        // is the DERIVED reveal (non-scoped — resting is the same on every viewport).
        // Derived via appearReveal, NOT hardcoded `{ opacity: '1', y: '0' }`: the
        // rest is the node's AUTHORED style (an aura authored at opacity 0.2 must
        // reveal to 0.2 — the hardcoded 1 rendered it saturated on the live page
        // while the canvas showed it faint, user report 2026-07-27). Styles read
        // from the cache at click time (the `node` closure can be stale).
        queueMutation({ type: 'updateMotionProp', nodeId, propName: 'initial', props: { opacity: '0', y: '30' }, scope });
        queueMutation({
          type: 'updateMotionProp', nodeId, propName: 'whileInView',
          props: appearReveal(['opacity', 'y'], getNodeFromCache(nodeId)?.styles),
        });
        queueMutation({ type: 'updateMotionProp', nodeId, propName: 'viewport', props: { once: 'true' } });
        setActivePopup('appear'); break;
      case 'glide':
        // Glide ("Flow"): wrap this container's children in a shared LayoutGroup
        // so siblings glide smoothly when one resizes (e.g. an accordion opening).
        queueMutation({ type: 'updateGlide', nodeId, spec: { transition: { type: 'spring', duration: '0.5', bounce: '0.25', delay: '0' } } });
        setActivePopup('glide'); break;
      case 'pageTransition': {
        // Page Transition (View Transitions) — page-level enter/exit. Seeds a
        // crossfade effect + opens its editor. Default target = 'all' on the
        // HOME page (site-wide), else the first destination page (per-target
        // override). Writes the runtime into the LayoutClient on first use.
        if (activePageFile) {
          const defaultTarget = isHomePage ? 'all' : (pageList[0]?.value ?? 'all');
          const e: PageEffect = { preset: 'crossfade', target: defaultTarget, ...applyPreset('crossfade') };
          setPageEffectForPage(activePageFile, e);
          setProjVersion((v) => v + 1);
          setActivePopup('pageTransition:' + defaultTarget);
        }
        break;
      }
      case 'scrollAnimation':
        // Component instances: there's no direction-triggered scroll-direction form
        // (the OLD seedScroll path generates `…OpacityDC` etc. that's undefined on an
        // instance). Route to the instance-fx mount Appear instead — it composes.
        if (isInstance) { addInstanceFx('appear', { appear: { from: { opacity: 0, y: 30 }, trigger: 'onScroll', direction: 'down', replay: true } }); setActivePopup('appear'); break; }
        // Scroll Animation = the SAME discrete `appear` effect, but with an
        // On Scroll trigger (direction-triggered). Mutually exclusive with
        // Appear (both are the `appear` entry — the dropdown hides the other).
        seedScroll(nodeId, 'layerInView');
        setActivePopup('appear'); break;
      case 'loop': {
        if (isInstance) { addInstanceFx('loop', { loop: { keyframes: { rotate: [0, 360] } } }); setActivePopup('loop'); break; }
        // Adding on a replica scopes the loop to THAT tile (runs there only); on
        // Desktop/primary it's a base loop (everywhere).
        const lscope = getActiveAnimationScope() as SerScope | null;
        queueMutation({ type: 'updateLoop', nodeId, spec: { props: { rotate: '360' }, transition: { duration: '2', repeat: 'Infinity', ease: 'linear' }, ...(lscope ? { scope: [lscope] } : {}) } });
        setActivePopup('loop'); break;
      }
      case 'textEffect':
        queueMutation({ type: 'addTextAnim', nodeId, config: { ...DEFAULT_TEXT_ANIM } });
        setActivePopup('textEffect'); break;
      case 'scrollTransform':
        if (isInstance) { addInstanceFx('transform', { transform: { from: { opacity: 0.5, scale: 0.5 }, to: { opacity: 1, scale: 1 } } }); setActivePopup('scrollTransform'); break; }
        // Scroll Transform = SCRUBBED From→To tied to scroll progress. Its own
        // editor (Add Section / multi-section). Seed the reference's fade+scale: the
        // From shows a visible delta at rest so the effect is discoverable.
        {
          const tScope = getActiveAnimationScope() as SerScope | null;
          const from = { opacity: '0.5', scale: '0.5' }, to = { opacity: '1', scale: '1' };
          const transition = { type: 'spring', duration: '0.5', bounce: '0.25' };
          // Adding on a replica scopes the transform to THAT tile (no scrub off-scope) via
          // the spec; on Desktop/primary it's a base transform (the original direct path).
          if (tScope) writeScrollFx((sp) => ({ ...sp, transform: { trigger: 'onScroll', from, to, transition, scope: [tScope] } }));
          else queueMutation({ type: 'updateScrollAnim', config: { nodeId, trigger: 'onScroll', stops: [{ progress: 0, props: from }, { progress: 1, props: to }], transition } });
        }
        setActivePopup('scrollTransform'); break;
      case 'scrollSpeed':
        if (isInstance) { addInstanceFx('speed', { speed: 110 }); setActivePopup('scrollSpeed'); break; }
        // Adding on a replica scopes the parallax to that tile (base 100 = none elsewhere);
        // on Desktop/primary it's a base speed. Same responsive model the popup edit uses.
        queueMutation({ type: 'updateScrollSpeed', config: { nodeId, speed: 110, scope: getActiveAnimationScope() as any } });
        setActivePopup('scrollSpeed'); break;
      case 'scrollVariant': {
        // Component instance only. Seed an On-Scroll variant switch (from base → the
        // 2nd variant if one exists, else base). The popup refines it.
        const vs = node?.componentFile ? parseVariantConfig(projectFS.readFile(node.componentFile) || '') : [];
        const base = vs[0]?.name || 'default';
        // PRESERVE the variant the user is currently displaying as the RESTING state. `from` is
        // both the static-canvas display AND the live initial (`useState(from)`), so seeding it
        // with the user's current pick means the published page LOADS at that variant (not the
        // base) and the canvas keeps showing it. `canvasVariant` mirrors `from` for the canvas
        // (which can't read `from` directly — that would override per-tile data-responsive picks).
        // When the pick equals the morph target, from===to ⇒ no morph (nothing scrolls), exactly
        // as the user expects ("Var2 selected + scroll To Var2 = nothing changes").
        const picked = (typeof node?.attrs?.initialVariant === 'string' && node.attrs.initialVariant) || base;
        // Adding on a replica scopes the effect to THAT tile only (absent on primary,
        // standard); on Desktop/primary it's a base effect (runs everywhere).
        const svScope = getActiveAnimationScope() as SerScope | null;
        queueMutation({ type: 'updateScrollVariant', nodeId, spec: {
          trigger: 'onScroll', from: picked, to: vs[1]?.name || picked, direction: 'down', replay: true,
          canvasVariant: picked,
          ...(svScope ? { scope: [svScope] } : {}),
        } });
        setActivePopup('scrollVariant'); break;
      }
      case 'transition':
        onUpdate('transition', formatTransitionShorthand([createDefaultTransition()]));
        setActivePopup('transition'); break;
      case 'sketchDraw':
        // Skipping the dropdown for sketches: clicking + on a sketch
        // wrapper lands here directly. Write the default config + open
        // the editor popup so the user can dial it in.
        queueMutation({ type: 'setSketchAnim', nodeId, config: createDefaultSketchAnim() });
        setActivePopup('sketchDraw'); break;
      case 'keyframe': {
        // Open name modal — actual creation happens in handleCreateKeyframe
        setShowKfNameModal(true);
        break;
      }
    }
  }, [nodeId, onUpdate, setKeyframeSheet, bumpKeyframes, s.transition, isInstance, writeInstanceFx, addInstanceFx]);

  const handleRemove = useCallback((type: AnimEntryType, entry?: DetectedEntry) => {
    trace.action('animation:remove', { nodeId, type });
    // Component-instance effects live in the data-instance-fx spec — drop the one key.
    if (isInstance && (entry?.data as any)?.instanceFx) {
      const key = (type === 'scrollSpeed' ? 'speed' : type === 'scrollTransform' ? 'transform'
        : (type === 'hover' || type === 'tap' || type === 'appear' || type === 'loop') ? type : null) as FxKey | null;
      if (key) {
        // the reference "remove here": on a replica delete just that tile (base effect → hidden
        // there, scoped-only → removed when last); on primary remove the whole effect.
        const scope = getActiveAnimationScope() as SerScope | null;
        writeInstanceFx((sp) => {
          if (scope) return hideInstanceFxOn(sp, key, scope);
          const n = { ...sp }; delete n[key]; return n;
        });
        return;
      }
    }
    // Normal-node (motion.*) effects are spec-driven: drop the one key from the
    // ScrollFxSpec and regenerate the whole block (robust to reformatting — no
    // orphaned vars, no duplicate hooks). Each `delete` mirrors what the old
    // per-prop removeMotionProp/removeScroll* path did, but via clean regeneration.
    //
    // the reference "remove here" (live find 2026-06-10: X-ing an Appear on a variant
    // replica stripped it EVERYWHERE): on a replica the remove only HIDES the
    // effect on that tile (presence hiddenOn — gated to false/undefined there);
    // the base keeps running on the primary and every other tile. On the
    // primary the whole effect is removed, as before.
    const hideHere = <K extends 'hover' | 'tap' | 'appear'>(sp: ScrollFxSpec, key: K): boolean => {
      const scope = getActiveAnimationScope() as SerScope | null;
      const eff = sp[key];
      if (!scope || !eff) return false;
      const r = hidePresenceOn({ hiddenOn: (eff as { hiddenOn?: SerScope[] }).hiddenOn }, scope);
      if (r.remove) return false;
      sp[key] = { ...eff, hiddenOn: r.state?.hiddenOn } as ScrollFxSpec[K];
      return true;
    };
    switch (type) {
      case 'hover':
        writeScrollFx((sp) => { if (!hideHere(sp, 'hover')) delete sp.hover; return sp; }); break;
      case 'tap':
        writeScrollFx((sp) => { if (!hideHere(sp, 'tap')) delete sp.tap; return sp; }); break;
      case 'appear':
        // Scroll Animation = DISCRETE (On Appear / in-view / direction-triggered).
        // Drop its appear (in-view) AND animation (direction) keys. Does NOT touch
        // the scrubbed Scroll Transform — that's a separate, independent entry.
        writeScrollFx((sp) => { if (!hideHere(sp, 'appear')) { delete sp.appear; delete sp.animation; } return sp; }); break;
      case 'loop':
        writeScrollFx((sp) => { delete sp.loop; return sp; }); break;
      case 'scrollVariant': {
        // the reference "remove here": on a replica, hide just that tile (a base effect stays
        // on the others; a scoped-only effect drops the tile, removed when it was the
        // last). On primary, remove the whole effect.
        const svScope = getActiveAnimationScope() as SerScope | null;
        const sv = getScrollVariant(code, nodeId);
        if (svScope && sv) {
          const next = hideScrollVariantOn(sv, svScope);
          queueMutation(next ? { type: 'updateScrollVariant', nodeId, spec: next } : { type: 'removeScrollVariant', nodeId });
        } else {
          queueMutation({ type: 'removeScrollVariant', nodeId });
        }
        break;
      }
      case 'textEffect':
        queueMutation({ type: 'removeTextAnim', nodeId }); break;
      case 'glide':
        queueMutation({ type: 'removeGlide', nodeId }); break;
      case 'scrollTransform':
        writeScrollFx((sp) => { delete sp.transform; return sp; }); break;
      case 'scrollSpeed':
        writeScrollFx((sp) => { delete sp.speed; return sp; });
        break;
      case 'transition': onUpdate('transition', ''); break;
      case 'sketchDraw':
        queueMutation({ type: 'removeSketchAnim', nodeId });
        break;
      case 'keyframe': {
        const anims = parseAnimationShorthand(s.animation || '');
        for (const anim of anims) {
          if (anim.keyframeName) queueMutation({ type: 'removeKeyframes', name: anim.keyframeName });
        }
        flushNow();
        refreshCanvasTokens();
        bumpKeyframes(v => v + 1);
        onUpdate('animation', '');
        setKeyframeSheet(null);
        setSelectedKeyframeStop(null);
        break;
      }
    }
    setActivePopup(null);
  }, [nodeId, onUpdate, s.animation, setKeyframeSheet, setSelectedKeyframeStop, bumpKeyframes, writeScrollFx, isInstance, writeInstanceFx, code]);

  // Reset Override: the animation is a RESPONSIVE override on the current tile
  // (a `__mqN ? {override} : {base}` branch). Drop just this scope's branch and
  // collapse back to the base — NOT a full removal. Only the framer-motion props
  // carry the responsive-value form; CSS uses the on/off model, so for those
  // (or when no scope is active) fall back to the regular remove.
  const handleResetOverride = useCallback((type: AnimEntryType, entry?: DetectedEntry) => {
    const scope = getActiveAnimationScope();
    // Component-instance effects store per-viewport presence + values in the
    // data-instance-fx SPEC, not in gated code we'd parse — reset via the spec.
    if (scope && isInstance) {
      const key = (type === 'scrollTransform' ? 'transform' : type === 'scrollSpeed' ? 'speed'
        : (type === 'hover' || type === 'tap' || type === 'appear' || type === 'loop') ? type : null) as FxKey | null;
      if (key) {
        trace.action('animation:reset-override', { nodeId, type: `instance-${key}`, scope });
        writeInstanceFx((s) => {
          let n = resetInstanceFxScope(s, key, scope as SerScope);   // presence
          // + per-tile VALUE override (so Reset clears both the presence customization
          // AND the responsive value on this tile, back to the base).
          if (key === 'transform') n = resetTransformScope(n, scope as SerScope);
          else if (key === 'hover' || key === 'tap' || key === 'appear') n = resetFxValueScope(n, key, scope as SerScope);
          else if (key === 'speed') n = resetSpeedScope(n, scope as SerScope);
          return n;
        });
        setActivePopup(null);
        return;
      }
    }
    // Normal-node Scroll Transform: drop this viewport's transform.responsive override
    // (back to base) via the spec path — NOT a full remove.
    if (scope && !isInstance && type === 'scrollTransform') {
      trace.action('animation:reset-override', { nodeId, type: 'scrollTransform', scope });
      writeScrollFx((sp) => sp.transform
        ? { ...sp, transform: { ...sp.transform, responsive: dropResponsive(sp.transform.responsive, scope as SerScope) } }
        : sp);
      setActivePopup(null);
      return;
    }
    // Scroll Speed carries its responsive override INSIDE the useTransform expression
    // (a gated scalar), not as a motion-prop ternary → its own reset mutation.
    if (scope && type === 'scrollSpeed') {
      trace.action('animation:reset-override', { nodeId, type, scope });
      queueMutation({ type: 'removeScrollSpeedScopeBranch', nodeId, scope: scope as any });
      setActivePopup(null);
      return;
    }
    // Text Effect stores its responsive overrides INSIDE the data-text-anim JSON spec → reset by
    // dropping this scope's entry and regenerating (spec-driven). Mirrors the Scroll Transform spec reset.
    if (scope && type === 'textEffect') {
      const ta = getTextAnimForNode(allTextAnims, nodeId);
      if (ta) {
        trace.action('animation:reset-override', { nodeId, type: 'textEffect', scope });
        queueMutation({ type: 'updateTextAnim', nodeId, config: resetTextAnimScope(ta.config, scope as TextAnimScope) });
        setActivePopup(null);
        return;
      }
    }
    // hover/tap → whileHover/whileTap; appear → its ENTER state `initial`.
    const propName = type === 'hover' ? 'whileHover' : type === 'tap' ? 'whileTap' : type === 'appear' ? 'initial' : null;
    if (scope && propName) {
      trace.action('animation:reset-override', { nodeId, type, propName, scope });
      queueMutation({ type: 'removeMotionScopeBranch', nodeId, propName, scope });
      setActivePopup(null);
      return;
    }
    handleRemove(type, entry);
  }, [nodeId, handleRemove, isInstance, writeInstanceFx, writeScrollFx, allTextAnims]);

  // ─── Popup content ─────────────────────────────────────
  const popup = useMemo(() => {
    if (!activePopup || !node) return null;
    // Page Transition (View Transitions) — the editor popup for one effect.
    if (activePopup.startsWith('pageTransition:')) {
      const target = activePopup.slice('pageTransition:'.length);
      const eff = pageEffects.find((e) => e.target === target);
      if (!eff) return null;
      return {
        title: 'Page Effect',
        content: <PageEffectPopup effect={eff} targetOptions={pageTargetOptions} onChange={(e) => commitPageEffect(eff.target, e)} />,
      };
    }
    const entry = detected.find(d => d.key === activePopup);
    const mp = node.motionProps;

    // Component-instance effects route to the instance-fx popup (page-level spec).
    // For ANY component instance, route the Hover/Press/Appear/Loop/Scroll popups to
    // the instance-fx editors with the FRESH spec — never the regular-node editors
    // (which write whileHover/updateScrollSpeed that are no-ops / wrong on an instance).
    // Reading getInstanceFx directly (not entry.data) survives detection lag right
    // after an add.
    const ifx: InstanceFxSpec | undefined = node?.componentFile
      ? (getInstanceFx(code, nodeId) ?? {})
      : undefined;

    switch (activePopup) {
      case 'hover': {
        if (ifx) return { title: 'Hover Effect', content: <InstanceFxPopup key={nodeId} nodeId={nodeId} fxKind="hover" spec={ifx} write={writeInstanceFx} /> };
        // Hover is Motion-only. Payload carries the resolved-for-tile props.
        return { title: 'Hover Effect',
          content: <HoverPopup key={nodeId} nodeId={nodeId} node={node} payload={entry?.data?.payload} /> };
      }
      case 'tap': {
        if (ifx) return { title: 'Tap Effect', content: <InstanceFxPopup key={nodeId} nodeId={nodeId} fxKind="tap" spec={ifx} write={writeInstanceFx} /> };
        return { title: 'Tap Effect',
          content: <TapPopup key={nodeId} nodeId={nodeId} node={node} payload={entry?.data?.payload} /> };
      }
      case 'glide':
        return { title: 'Glide', content: <GlidePopup key={nodeId} nodeId={nodeId} spec={entry?.data?.spec || {}} /> };
      case 'appear': {
        if (ifx) return { title: 'Appear Effect', content: <InstanceAppearPopup key={nodeId} nodeId={nodeId} spec={ifx} write={writeInstanceFx} /> };
        const d = entry?.data || {};
        if (d.isOverlay) {
          return { title: 'Appear Effect', content: (
            <OverlayAppearPopup key={nodeId} nodeId={nodeId} node={node}
              enterProps={d.initialProps || mp?.initial || {}}
              exitProps={d.exitProps || mp?.exit || {}}
              transition={d.transition || mp?.transition || {}} />
          ) };
        }
        const trigger = (d.trigger || 'appear') as 'appear' | 'scroll';
        // Seed the Direction editor with the active tile's resolved direction/replay/To
        // (base ⊕ this viewport's animation.responsive override) so a replica shows ITS
        // values; edits route through commitScopedDirection.
        let scrollPayload = d.scrollPayload;
        const dirScope = getActiveAnimationScope() as SerScope | null;
        if (dirScope && scrollPayload?.directionTriggered) {
          const anim = getScrollFx(code, nodeId)?.animation as any;
          const ov = anim?.responsive ? (findResponsive(anim.responsive, dirScope) as any) : null;
          if (ov) scrollPayload = { ...scrollPayload, direction: ov.direction ?? scrollPayload.direction, replay: ov.replay ?? scrollPayload.replay, toProps: ov.toProps ?? scrollPayload.toProps };
        }
        return { title: trigger === 'scroll' ? 'Scroll Animation' : 'Appear Effect',
          content: <AppearScrollPopup key={nodeId} nodeId={nodeId} node={node} trigger={trigger}
            enterProps={d.initialProps || mp?.initial || {}}
            transition={d.transition || mp?.transition || {}}
            scrollPayload={scrollPayload} scopedDirectionWrite={commitScopedDirection}
            isVariantMode={!!d.isVariantMode} initialName={d.initialName} /> };
      }
      case 'loop': {
        if (ifx) return { title: 'Loop Effect', content: <InstanceFxPopup key={nodeId} nodeId={nodeId} fxKind="loop" spec={ifx} write={writeInstanceFx} /> };
        const d = entry?.data || {};
        return { title: 'Loop Effect',
          content: <LoopPopup key={nodeId} nodeId={nodeId}
            props={d.props || {}}
            transition={d.transition || {}}
            offscreen={d.offscreen} scope={d.scope} /> };
      }
      case 'scrollTransform': {
        if (ifx) return { title: 'Scroll Transform', content: <InstanceScrollTransformPopup key={nodeId} nodeId={nodeId} spec={ifx} write={writeInstanceFx} /> };
        // Seed the editor with the active tile's resolved From/To (base ⊕ this scope's
        // override) so a replica shows ITS values; edits route through commitScopedTransform
        // (→ transform.responsive) instead of clobbering the base.
        const sd = entry?.data as any;
        const tScope = getActiveAnimationScope() as SerScope | null;
        const tf = sd?.transformSpec;
        let scrollData = sd;
        if (tScope && tf?.responsive) {
          const ov = findResponsive<{ scope: SerScope; from?: Record<string, string>; to?: Record<string, string> }>(tf.responsive, tScope);
          if (ov) scrollData = { ...sd, transformSpec: { ...tf, from: { ...tf.from, ...(ov.from ?? {}) }, to: { ...tf.to, ...(ov.to ?? {}) } } };
        }
        return { title: 'Scroll Transform', content: <ScrollTransformEditor key={nodeId} nodeId={nodeId} scrollData={scrollData} scopedTransformWrite={commitScopedTransform} /> };
      }
      case 'scrollVariant':
        return { title: 'Scroll Variant', content: <ScrollVariantEditor key={nodeId} nodeId={nodeId}
          componentFile={entry?.data?.componentFile ?? node?.componentFile}
          spec={(entry?.data?.spec as ScrollVariantSpec) ?? { trigger: 'onScroll', from: 'default', to: 'default', direction: 'down', replay: true }} /> };
      case 'textEffect': {
        const textAnim = getTextAnimForNode(allTextAnims, nodeId);
        const currentConfig: TextAnimConfig = textAnim?.config || { ...DEFAULT_TEXT_ANIM };
        // `config` is the FULL base (incl. responsive). The popup resolves/writes per active scope and
        // hands back the merged full config; we just persist it (spec-driven regenerate).
        return { title: 'Text',
          content: <TextEffectPopup key={nodeId} nodeId={nodeId} config={currentConfig}
            scope={getActiveAnimationScope() as TextAnimScope | null}
            onChange={(cfg) => queueMutation({ type: 'updateTextAnim', nodeId, config: cfg })} /> };
      }
      case 'transition': {
        const trans = parseTransitionShorthand(s.transition || '');
        return { title: 'CSS Transition',
          content: <CssTransitionEditor
            transition={trans[0] || createDefaultTransition()}
            onChange={(t) => onUpdate('transition', formatTransitionShorthand([t]))}
          /> };
      }
      case 'scrollSpeed':
        if (ifx) return { title: 'Scroll Speed', content: <InstanceScrollSpeedPopup key={nodeId} spec={ifx} write={writeInstanceFx} /> };
        return { title: 'Scroll Speed',
          content: <ScrollSpeedPopup key={nodeId} nodeId={nodeId} speed={(entry?.data as any)?.speed ?? 110} /> };
      case 'sketchDraw': {
        const cfg = (entry?.data as SketchAnimConfig | undefined) ?? null;
        if (!cfg) return null;
        return { title: 'Sketch Draw',
          content: <SketchDrawPopup key={nodeId} nodeId={nodeId} config={cfg} /> };
      }
      default:
        return null;
    }
  }, [activePopup, node, nodeId, detected, allTextAnims, cssHoverStyles, writeInstanceFx, pageEffects, pageTargetOptions]);

  const handleCreateKeyframe = useCallback((kfName: string) => {
    queueMutation({ type: 'updateKeyframes', name: kfName, css: formatKeyframes(createDefaultKeyframeAnimation(kfName)) });
    onUpdate('animation', formatAnimationShorthand([{ ...createDefaultAnimation(), keyframeName: kfName }]));
    flushNow();
    refreshCanvasTokens();
    bumpKeyframes(v => v + 1);
    setKeyframeSheet({ name: kfName, nodeId });
    trace.action('animation:add-keyframe', { nodeId, kfName });
  }, [nodeId, onUpdate, setKeyframeSheet, bumpKeyframes]);

  if (!node) return null;

  return (
    <LocalizeGate hidden>
      <ToolSection title="Animation" collapsible hasContent={detected.length > 0 || pageEffects.length > 0}
        action={<AddEffectDropdown onAdd={handleAdd} existing={existingTypes} isTextNode={!!node && isTextTag(node.type)}
          isComponentInstance={!!node?.componentFile}
          appearOnly={isOverlayNode}
          glideOnly={glideOnly}
          isSketchNode={!!node && node.type === 'svg' && node.attrs?.['data-sketch'] === 'true'}
          onApplyKeyframe={(kfName) => {
            trace.action('animation:apply-existing-keyframe', { nodeId, kfName });
            onUpdate('animation', formatAnimationShorthand([{ ...createDefaultAnimation(), keyframeName: kfName }]));
            setKeyframeSheet({ name: kfName, nodeId });
          }} />}>
        <div ref={popupAnchorRef} className="flex flex-col gap-2">
          {(() => {
            // standard grouping: Scroll Animation / Speed / Transform render
            // under ONE "Scroll" label (left), each chip showing just the short
            // name. Returns the chip name for a scroll entry, else null.
            const scrollChip = (entry: DetectedEntry): string | null => {
              if (entry.type === 'scrollSpeed') return 'Speed';
              if (entry.type === 'scrollTransform') return 'Transform';
              if (entry.type === 'scrollVariant') return 'Variant';
              if (entry.type === 'appear' && (entry.data as any)?.trigger === 'scroll') return 'Animation';
              return null;
            };

            const onEditEntry = (entry: DetectedEntry, e?: React.MouseEvent) => {
              // Keyframe entries open the CSS keyframe sheet
              if (entry.type === 'keyframe') {
                const anims = parseAnimationShorthand(s.animation || '');
                const kfName = anims[0]?.keyframeName;
                if (kfName) {
                  trace.action('animation-tool:open-keyframe-sheet', { kfName, nodeId });
                  setKeyframeSheet({ name: kfName, nodeId });
                }
                return;
              }
              const override = consumeAnchorOverride();
              clickedEntryRef.current = override || (e?.currentTarget as HTMLElement) || null;
              setActivePopup(entry.key);
            };

            const renderCard = (entry: DetectedEntry, group?: { chipLabel: string; first: boolean; groupIsOverride?: boolean; groupReset?: () => void }) => (
              <AnimEntryCard type={entry.type} summary={entry.summary}
                nodeId={nodeId}
                node={node}
                copyable={buildCopiedAnimation(entry.type, entry.data)}
                onEdit={(e) => onEditEntry(entry, e)}
                labelOverride={group ? (group.first ? 'Scroll' : '') : undefined}
                chipLabel={group?.chipLabel}
                hideLabel={group ? !group.first : false}
                // Grouped scroll effects: the override dot + Reset live on the ONE
                // "Scroll" label (the first card) and act on the WHOLE group,
                // standard. Non-grouped entries keep their own per-row override/reset.
                isOverride={group ? (group.first && group.groupIsOverride) : (entry.data as any)?.isOverride}
                onReset={group ? group.groupReset : () => handleResetOverride(entry.type, entry)}
                onRemove={() => handleRemove(entry.type, entry)}
                dataAttr={entry.type === 'scrollTransform' ? 'data-scroll-transform-entry' : undefined} />
            );

            // Render the Scroll group contiguously at the first scroll entry's
            // position; non-scroll entries keep their order around it.
            const scrollEntries = detected.filter(e => scrollChip(e) !== null);
            // The group shows an override when ANYTHING under Scroll differs from the
            // primary on the active tile; the group Reset clears every such override.
            const groupIsOverride = scrollEntries.some(e => !!(e.data as any)?.isOverride);
            const groupReset = () => {
              const scope = getActiveAnimationScope() as SerScope | null;
              if (!scope) return;
              trace.action('animation:reset-scroll-group', { nodeId, scope, isInstance });
              // Scroll Variant carries its own per-viewport presence (separate spec) —
              // reset it back to base, or remove it if it was scoped-only to this tile.
              const sv = getScrollVariant(code, nodeId);
              if (sv && (scrollVariantIsOverride(sv, scope) || hasScrollVariantTargetScope(sv, scope))) {
                // resetScrollVariantScope clears BOTH presence and the per-tile target override.
                const next = resetScrollVariantScope(sv, scope);
                queueMutation(next ? { type: 'updateScrollVariant', nodeId, spec: next } : { type: 'removeScrollVariant', nodeId });
              }
              if (isInstance) {
                // One spec write clears every per-viewport customization under Scroll:
                // transform value-overrides + presence for transform/speed/appear.
                writeInstanceFx((s) => {
                  let n = resetTransformScope(s, scope);
                  for (const k of ['transform', 'speed', 'appear'] as FxKey[]) n = resetInstanceFxScope(n, k, scope);
                  return n;
                });
                setActivePopup(null);
                return;
              }
              scrollEntries.forEach(e => { if ((e.data as any)?.isOverride) handleResetOverride(e.type, e); });
            };
            // Gradient text (background-clip: text) + a Text animation with
            // transforms: the per-character transforms don't render because the
            // glyphs are painted by the parent's clipped gradient, not the spans.
            // Warn under the Text row so the user knows why rotate/offset/etc.
            // won't animate (only opacity works). See text-anim gradient caveat.
            const isGradientText = !!(node && (node.styles?.WebkitBackgroundClip === 'text' || node.styles?.backgroundClip === 'text'));
            const out: React.ReactNode[] = [];
            let groupDone = false;
            detected.forEach((entry) => {
              if (scrollChip(entry) !== null) {
                if (groupDone) return;
                groupDone = true;
                out.push(
                  <div key="scroll-group" className="flex flex-col gap-2">
                    {scrollEntries.map((se, i) => (
                      <div key={se.key}>{renderCard(se, { chipLabel: scrollChip(se)!, first: i === 0, groupIsOverride, groupReset })}</div>
                    ))}
                  </div>,
                );
                return;
              }
              out.push(
                <div key={entry.key}>
                  {renderCard(entry)}
                  {entry.type === 'textEffect' && isGradientText && (
                    <div className="flex justify-end mt-1">
                      <span className="w-full max-w-[64%] text-right text-[10px] leading-tight text-[var(--text-disabled)]">
                        Transforms on scroll don't work with gradient text.
                      </span>
                    </div>
                  )}
                </div>,
              );
            });
            // Page Transition rows (viewport only) — same section, plain rows.
            pageEffects.forEach((pe) => {
              const label = pageTargetOptions.find((o) => o.value === pe.target)?.label ?? (pe.target === 'all' ? 'All Pages' : pe.target);
              // "Page" label (left, w-3/4) + the effect button (right, w-full) —
              // same row geometry as every other control.
              out.push(
                <ToolRow key={'pe-' + pe.target} label="Page">
                  <ControlActionRow className="!pr-2" onClick={() => setActivePopup('pageTransition:' + pe.target)}>
                    <span className="flex items-center justify-center w-5 h-5 rounded shrink-0" style={{ backgroundColor: 'var(--accent)' }}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="white"><path d="M12 2 L22 12 L12 22 L2 12 Z" /></svg>
                    </span>
                    <span className="truncate flex-1">{label}</span>
                    <RemoveButton onClick={() => removePageEffect(pe.target)} />
                  </ControlActionRow>
                </ToolRow>,
              );
            });
            return out;
          })()}
        </div>
      </ToolSection>

      {popup && (
        // Width: match the standard 260px popup (same as Text Decoration). Only
        // the popups whose rows carry a LEFT CHEVRON on a (non-plain) ControlLabel
        // — the Scroll Transform / Scroll Variant editors with per-viewport
        // override reset — need the extra ~40px gutter so the chevron has room.
        // Plain-label popups (Appear / Hover / Tap / Loop / …) must NOT be widened.
        <ToolPopup key={activePopup} width={popup.title === 'Scroll Transform' || popup.title === 'Scroll Variant' ? 300 : 260} isOpen={!!activePopup} onClose={() => { setActivePopup(null); clickedEntryRef.current = null; }} title={popup.title} anchorRef={clickedEntryRef.current ? { current: clickedEntryRef.current } as React.RefObject<HTMLElement> : popupAnchorRef} resetKey={`${nodeId}:${scopeCtx.vpWidth}:${scopeCtx.variant ?? ''}`}>
          {popup.content}
        </ToolPopup>
      )}

      <ToolDivider />

      {/* Keyframe name modal */}
      <NameInputModal
        isOpen={showKfNameModal}
        onClose={() => setShowKfNameModal(false)}
        onSubmit={handleCreateKeyframe}
        title="New Keyframe Animation"
        placeholder="e.g. fade-in, pulse, slide-up"
        defaultValue={node ? `anim-${node.name || node.id}` : ''}
      />
    </LocalizeGate>
  );
}
