// ControlProvider.tsx — Mode-aware control provider with value routing and binding detection.
// Rewritten from scratch for Revyme's code-source-of-truth architecture.
// Inspired by old builder's UnifiedControlSystem pattern but uses parser/generator pipeline.

import { useMemo, useCallback, useRef } from 'react';
import { useAtomValue } from 'jotai';
// Live nodes — same as legacy ControlProvider; panel must reflect current
// parent on reparent.
import { selectedNodeAtom, selectedIdsAtom } from '@/code/stores/store';
import { useLiveNode } from '@/code/stores/node-family';
import { scrollAnimDataAtom } from '@/code/stores/animation-store';
import { isDefaultLocaleAtom, localeOverridesAtom } from '@/code/stores/locale-store';
import { updateNodeStyles, getContentRoot, flushAndForceStructuralRender } from '@/canvas/node-ops';
import { detectValueSource } from '@/code/features/variable-ops';
import { containerOverridesAtom, hasOverride as _hasOverride, hasOverrideAtWidth, getOverrideBreakpoints, clearShorthandSupersededLonghands } from '@/code/stores/container-query-store';
import { isReplicaViewportAtom, interactingViewportWidthAtom, isComponentVariantViewportAtom, activeComponentVariantAtom } from '@/code/stores/viewport-store';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { removeComponentPropProjectWide } from '@/code/features/remove-component-prop';
import { getScrollBoundProps } from '@/editor/hooks/useScrollBoundProps';
import { UnifiedControlContext } from './useControlContext';
import { useControlOptional } from '../ControlProvider';
import type { ControlMode, ControlBinding, UnifiedControlProviderProps, UnifiedControlContextValue } from './types';
import type { ScrollAnimData } from '@/code/parsing/scroll-parser';
import { trace } from '@/shared/debug-trace';
import { parseVarRef } from '@/shared/css-utils';

// ─── Pure functions (exported for testing) ───────────────────────────────────

/** Resolve the current value based on mode */
export function resolveValue(
  mode: ControlMode,
  property: string,
  nodeStyles: Record<string, string>,
  stopProps?: Record<string, string>,
  externalValue?: string,
  defaultValue?: string,
): string {
  switch (mode) {
    case 'direct': {
      const raw = nodeStyles[property] ?? '';
      // If value is a var: reference (motion value / component prop), return default
      if (raw.startsWith('var:')) return defaultValue ?? '';
      return raw || (defaultValue ?? '');
    }
    case 'htmlAttr': {
      // HTML attrs are read from nodeStyles too — the caller merges node.attrs into nodeStyles
      const raw = nodeStyles[property] ?? '';
      if (raw.startsWith('var:')) return defaultValue ?? '';
      return raw || (defaultValue ?? '');
    }
    case 'scrollStop':
    case 'motionVariant':
    case 'cssKeyframe':
    case 'motionPathWaypoint':
      return stopProps?.[property] ?? defaultValue ?? '';
    case 'variableDefault':
    case 'preset':
    case 'override':
    case 'locale':
    case 'fetch':
      return externalValue ?? defaultValue ?? '';
    default:
      return defaultValue ?? '';
  }
}

/**
 * Surface `hiddenOnVariants` (the AnimatePresence visibility source of truth) as a
 * `display: 'none'` in the resolved styles, so the Hide toggle reads "Yes" when the
 * ACTIVE component variant is hidden. Returns `styles` untouched otherwise (a
 * stale/baked `display:none` from an older component still reads as hidden; a clean
 * shown component reads as shown).
 *
 * Gated on `activeVariant` ALONE — deliberately NOT on a "non-primary viewport"
 * check. `activeVariant` is 'default' on the master's primary viewport and null on
 * page files, so this correctly lights the toggle for BOTH the default and the
 * non-default variant viewports. The earlier `isComponentVariantViewport` gate was
 * FALSE on the primary (`vpId === 'desktop'`), so hiding on the master's default
 * view — which sets `hiddenOnVariants` for EVERY variant, incl. 'default' — left the
 * Hide toggle stuck on "No" until a page switch. Pure + exported for unit tests.
 */
export function surfaceHiddenVariantDisplay(
  styles: Record<string, string>,
  property: string,
  activeVariant: string | null,
  hiddenOnVariants: Set<string> | undefined,
): Record<string, string> {
  if (property === 'display' && activeVariant && hiddenOnVariants?.has(activeVariant)) {
    return { ...styles, display: 'none' };
  }
  return styles;
}

/** Detect if a property is bound by an animation or variable in direct mode */
export function resolveBinding(
  property: string,
  nodeId: string | null,
  scrollData: ScrollAnimData,
  rawStyleValue?: string,
): ControlBinding {
  const noBinding: ControlBinding = { bound: false, boundBy: null, onNavigate: null };
  if (!nodeId) return noBinding;

  // Check if value is a preset reference: var(--brand-color)
  // Presets are NOT "bound" (user can still edit) — instead we set presetRef
  // so controls can show a preset pill UI
  if (rawStyleValue?.startsWith('var(--')) {
    const varName = parseVarRef(rawStyleValue) || '';
    return {
      bound: false,
      boundBy: null,
      onNavigate: null,
      presetRef: varName,
    };
  }

  // Check scroll bindings
  const scrollBound = getScrollBoundProps(scrollData, nodeId);
  if (scrollBound[property]) {
    return {
      bound: true,
      boundBy: 'Scroll Transform',
      onNavigate: () => {
        const el = document.querySelector('[data-scroll-transform-entry]');
        if (el instanceof HTMLElement) el.click();
      },
    };
  }

  // NOTE: var: prefix (component prop / variable) is NOT a `binding.bound`
  // case. Treating it as bound routes the row to UsedByRow (gray "navigate"
  // pill) and short-circuits atoms before they can render the purple
  // VariableBoundPill, which is the right UI: a variable is editable through
  // the same atom, not a read-only navigate target. The `hasVariable` flag
  // in the unified context (computed from detectValueSource) drives the pill
  // separately. Keep this branch for animation/scroll bindings only.

  // Future: check CSS keyframe bindings, motion variants, etc.

  return noBinding;
}

// ─── Provider Component ──────────────────────────────────────────────────────

export function UnifiedControlProvider({
  property,
  defaultValue = '',
  mode = 'direct',
  stopProps,
  onStopChange,
  externalValue,
  externalOnChange,
  externalOnChangeLive,
  hideLabel,
  children,
}: UnifiedControlProviderProps) {
  // Read outer ControlProvider for map-aware routing.
  // Use a ref so callbacks always get the LATEST context (avoids stale closure).
  const outerControl = useControlOptional();
  const outerControlRef = useRef(outerControl);
  outerControlRef.current = outerControl;

  // Read stores (used primarily in direct mode, but atoms are always read for binding detection)
  const selectedId = useAtomValue(selectedNodeAtom);
  const selectedIds = useAtomValue(selectedIdsAtom);
  const scrollData = useAtomValue(scrollAnimDataAtom);
  const overrides = useAtomValue(containerOverridesAtom);
  const isReplica = useAtomValue(isReplicaViewportAtom);
  const vpWidth = useAtomValue(interactingViewportWidthAtom);
  const isComponentVariantViewport = useAtomValue(isComponentVariantViewportAtom);
  const activeComponentVariant = useAtomValue(activeComponentVariantAtom);

  const isDefaultLocale = useAtomValue(isDefaultLocaleAtom);
  const localeOverrides = useAtomValue(localeOverridesAtom);

  const isDirect = mode === 'direct' || mode === 'htmlAttr';
  // Per-node subscription (fine-grained): only re-renders when THIS node's
  // identity changes, not on every whole-map commit.
  const selectedNode = useLiveNode(isDirect ? selectedId : null);
  const node = isDirect && selectedId ? selectedNode ?? null : null;
  const nodeId = isDirect ? selectedId : null;
  // For htmlAttr mode, merge node.attrs into styles so resolveValue can read them
  const baseNodeStyles = mode === 'htmlAttr'
    ? { ...(node?.styles ?? {}), ...(node?.attrs ?? {}) }
    : (node?.styles ?? {});

  // Merge overrides on top of base styles so controls show correct values:
  // 1. Locale overrides (when in non-default locale)
  // 2. Responsive overrides (when in replica viewport — tablet/mobile)
  // 3. Map data overrides (when editing a ghost item — read from outer ControlProvider)
  const nodeStyles = useMemo(() => {
    let result: Record<string, string>;
    // When outer ControlProvider exists in direct mode, use its effectiveStyles
    // (includes map data overrides for ghost items, locale, and responsive overrides)
    if (isDirect && outerControl?.styles && Object.keys(outerControl.styles).length > 0) {
      result = outerControl.styles;
    } else {
      result = baseNodeStyles;
      // Locale overrides
      if (!isDefaultLocale && selectedId) {
        const override = localeOverrides.get(selectedId);
        if (override?.styles && Object.keys(override.styles).length > 0) {
          result = { ...result, ...override.styles };
        }
      }
      // Per-viewport style-VARIABLE values: the inline `__mq` ternary can't evaluate per replica
      // tile, so surface the resolved value for THIS tile (cascade: smallest breakpoint whose
      // max-width covers vpWidth) — keeps the Fill swatch in sync with the per-viewport pill.
      if (isReplica && vpWidth && node?.responsiveStyleValues) {
        for (const [p, byW] of Object.entries(node.responsiveStyleValues)) {
          const widths = Object.keys(byW).map(Number).sort((a, b) => a - b);
          for (const b of widths) {
            const min = node.responsiveStyleBands?.[p]?.[b] ?? 0;
            if (vpWidth <= b && vpWidth >= min) { result = { ...result, [p]: byW[b] }; break; }
          }
        }
      }
      // Responsive overrides: merge @media values for the current viewport width (these win — an
      // explicit literal override beats a cascaded variable value).
      if (isReplica && selectedId && vpWidth) {
        const nodeOverrides = overrides.get(selectedId);
        if (nodeOverrides?.has(vpWidth)) {
          const bpProps = nodeOverrides.get(vpWidth)!;
          result = { ...result, ...Object.fromEntries(bpProps) };
          // A SHORTHAND override (e.g. @media `border-radius: 26px`) supersedes
          // the base LONGHANDS at paint, so drop them here — else RadiusControl
          // reads the stale base `borderTopLeftRadius` and shows the wrong value
          // even though the override pill is lit.
          clearShorthandSupersededLonghands(result, bpProps.keys());
        }
      }
      // Component-variant overrides: per-variant motion values (rotate, x/y
      // deltas, paint props) live in motionVariants[activeVariant], not the
      // inline style — same merge the CLASSIC ControlProvider already does.
      // Without it the Rotate control showed 0 (and no override dot) for a
      // variant-rotated svg group child (live find 2026-06-12).
      if (isComponentVariantViewport && activeComponentVariant && node?.motionVariants) {
        const variantStyles = (node.motionVariants as Record<string, Record<string, string>>)[activeComponentVariant];
        if (variantStyles) result = { ...result, ...variantStyles };
        // svg GROUP CHILD per-variant SIZE rides scaleX/scaleY (CSS width/height
        // are not painted on a nested svg — Chromium probe 2026-06-12). The
        // panel speaks px: synthesize width/height from base attrs × scale so
        // the Dimensions controls show the painted size (and the override dot).
        if (variantStyles && node?.type === 'svg' && node.attrs) {
          const sxV = parseFloat(String(variantStyles.scaleX ?? ''));
          const syV = parseFloat(String(variantStyles.scaleY ?? ''));
          const baseW = parseFloat(node.attrs.width ?? '');
          const baseH = parseFloat(node.attrs.height ?? '');
          if (Number.isFinite(sxV) && Number.isFinite(baseW)) {
            result = { ...result, width: `${Math.round(baseW * sxV * 100) / 100}px` };
          }
          if (Number.isFinite(syV) && Number.isFinite(baseH)) {
            result = { ...result, height: `${Math.round(baseH * syV * 100) / 100}px` };
          }
        }
      }
    }

    // Hide control: when the active variant is hidden via `hiddenOnVariants`
    // (AnimatePresence — the visibility source of truth), surface it as
    // `display: 'none'` so the Hide toggle reads "Yes".
    result = surfaceHiddenVariantDisplay(result, property, activeComponentVariant, node?.hiddenOnVariants);

    return result;
  }, [mode, outerControl?.styles, baseNodeStyles, isDefaultLocale, selectedId, localeOverrides, isReplica, vpWidth, overrides, property, isComponentVariantViewport, activeComponentVariant, node]);

  // Resolve value
  const value = resolveValue(mode, property, nodeStyles, stopProps, externalValue, defaultValue);

  // Resolve binding (only in direct mode)
  const binding = useMemo(() => {
    if (!isDirect) return { bound: false, boundBy: null, onNavigate: null } as ControlBinding;
    return resolveBinding(property, nodeId, scrollData, nodeStyles[property]);
  }, [mode, property, nodeId, scrollData, nodeStyles[property]]);

  // onChange routing
  const onChange = useCallback((newValue: string) => {
    trace.action('unified-control:change', { property, mode, value: newValue });
    switch (mode) {
      case 'direct': {
        // Route through outer ControlProvider (handles map-aware routing)
        trace.action('unified-control:direct-route', { property, hasOuter: !!outerControl, value: newValue?.slice?.(0, 20) });
        if (outerControlRef.current) {
          outerControlRef.current.updateStyle(property, newValue);
        } else {
          const contentEl = getContentRoot();
          if (!contentEl) return;
          for (const id of selectedIds) {
            updateNodeStyles({ id, styles: { [property]: newValue }, contentEl });
          }
        }
        // Hide control on a component master: `updateNodeStyles` routed this
        // `display:none`/'' write to a STRUCTURAL `setVariantVisibility`
        // (`<AnimatePresence>` rewrap) that only lands on a full Renderer cycle —
        // which a control write doesn't trigger, so the DOM stayed stale until a
        // page switch. Force it here, exactly as the Layers eye does (the writes
        // above have all queued, so this commits atomically = one undo step).
        // `activeComponentVariant` is non-null ONLY on component files, so page
        // display writes (which patch the DOM live) are untouched.
        if (property === 'display' && activeComponentVariant && (newValue === 'none' || newValue === '')) {
          trace.action('unified-control:hide-force-render', { selectedIds, newValue, variant: activeComponentVariant });
          flushAndForceStructuralRender();
        }
        break;
      }
      case 'htmlAttr': {
        // Write HTML attribute via updateHtmlAttrs mutation + imperative DOM update
        trace.action('unified-control:htmlAttr-route', { property, value: newValue?.slice?.(0, 20) });
        for (const id of selectedIds) {
          queueMutation({ type: 'updateHtmlAttrs', nodeId: id, attrs: { [property]: newValue } });
          // Imperative DOM update for instant feedback
          const contentEl = getContentRoot();
          if (contentEl) {
            const el = contentEl.querySelector(`[data-id="${id}"]`) as HTMLElement | null;
            if (el) {
              if (newValue) el.setAttribute(property, newValue);
              else el.removeAttribute(property);
            }
          }
        }
        break;
      }
      case 'scrollStop':
      case 'motionVariant':
      case 'cssKeyframe':
      case 'motionPathWaypoint':
        onStopChange?.({ ...stopProps, [property]: newValue });
        break;
      case 'variableDefault':
      case 'preset':
      case 'override':
      case 'locale':
      case 'fetch':
        externalOnChange?.(newValue);
        break;
    }
  }, [mode, property, selectedIds, stopProps, onStopChange, externalOnChange, activeComponentVariant]);

  // onChangeMultiple (for shorthand properties like border, padding)
  const onChangeMultiple = useCallback((styles: Record<string, string>) => {
    trace.action('unified-control:change-multiple', { property, mode, keys: Object.keys(styles) });
    switch (mode) {
      case 'direct': {
        // Route through outer ControlProvider (handles map-aware routing)
        if (outerControlRef.current) {
          outerControlRef.current.updateMultipleStyles(styles);
          break;
        }
        const contentEl = getContentRoot();
        if (!contentEl) return;
        for (const id of selectedIds) {
          updateNodeStyles({ id, styles, contentEl });
        }
        break;
      }
      case 'scrollStop':
      case 'motionVariant':
      case 'cssKeyframe':
      case 'motionPathWaypoint':
        onStopChange?.({ ...stopProps, ...styles });
        break;
      case 'variableDefault':
      case 'preset':
      case 'override':
      case 'locale':
      case 'fetch': {
        const firstValue = Object.values(styles)[0];
        if (firstValue !== undefined) externalOnChange?.(firstValue);
        break;
      }
    }
  }, [mode, property, selectedIds, stopProps, onStopChange, externalOnChange]);

  // DOM-only live patch — for slider drag previews. Direct mode goes
  // through the outer ControlProvider's updateStyleLive so map-aware
  // routing applies. Non-direct modes don't have a DOM-only path
  // (animation timeline, scroll, htmlAttr all need the code write to
  // get the right semantics), so we fall back to the regular onChange
  // for them. Consumers that want smooth dragging in those modes
  // should still call onChangeLive — it'll route to onChange in
  // those cases.
  const onChangeLive = useCallback((newValue: string) => {
    if (mode === 'direct' && outerControlRef.current?.updateStyleLive) {
      outerControlRef.current.updateStyleLive(property, newValue);
    } else if (externalOnChangeLive) {
      // Non-direct (e.g. a component-tool variable): route live drag to the caller's preview
      // (previewProp) so the canvas updates per frame instead of committing+re-parsing each move.
      externalOnChangeLive(newValue);
    } else {
      onChange(newValue);
    }
  }, [mode, property, onChange, externalOnChangeLive]);

  // Multi-property DOM-only live patch (e.g. shadow = boxShadow + filter).
  // Reuses the per-key `updateStyleLive` so map/variant/replica routing is
  // identical to the single-prop path. Non-direct modes commit (no DOM-only
  // path), matching `onChangeLive`'s fallback.
  const onChangeMultipleLive = useCallback((styles: Record<string, string>) => {
    if (mode === 'direct' && outerControlRef.current?.updateStyleLive) {
      const live = outerControlRef.current.updateStyleLive;
      for (const [k, v] of Object.entries(styles)) live(k, v);
    } else if (externalOnChangeLive) {
      // Non-direct (variableDefault, preset, override, …): a SHORTHAND atom (border/padding/shadow) drives
      // its live drag through onChangeMultipleLive. Without this branch it fell through to onChangeMultiple =
      // a CODE WRITE + full re-parse EVERY frame → the slow-fps border color/width drag in the Template tool
      // AND the variable modal. Collapse to the single representative value (same pick onChangeMultiple's
      // variableDefault branch uses) and route to the caller's IMPERATIVE preview (previewVar →
      // patchNodeStyles), exactly like onChangeLive does for single-value atoms — no code write per frame.
      const vals = Object.values(styles);
      const firstValue = vals.find((v) => v !== '' && v !== undefined) ?? vals[0];
      if (firstValue !== undefined) externalOnChangeLive(firstValue);
    } else {
      onChangeMultiple(styles);
    }
  }, [mode, onChangeMultiple, externalOnChangeLive]);

  // Overrides (direct mode only)
  const hasOverride = isDirect && selectedId ? _hasOverride(overrides, selectedId, property) : false;
  const getOverrides = useCallback(() => {
    if (!isDirect || !selectedId) return [];
    return getOverrideBreakpoints(overrides, selectedId, property);
  }, [mode, selectedId, overrides, property]);

  // Variable detection — prefer node.styleVariables (post-resolve marker)
  // over a `var:` prefix in the raw style. The parser now resolves master
  // file styles to their actual literal values and tracks the binding
  // separately, so the prefix path is only a fallback for instances where
  // `var:` may still appear in propStyleOverrides.
  // Per-variant detach: on a non-primary variant that overrides this property,
  // the base variable is shadowed → treat it as a literal here (no pill), so a
  // variable removed from this variant shows the normal control. Same rule as
  // the legacy ControlProvider.getValueSource.
  // Also detect an OVERLAY-border detach: the property (`border`) is shadowed on this variant by
  // overriding the bound variable's CUSTOM PROPERTY (`--X`) in the variant object — not `border`
  // itself. Without this the pill stays purple on the detached variant and the × no-ops.
  const overlayVarName = node?.styleVariables?.[property];
  const overlayCustomKey = overlayVarName ? `--${overlayVarName}` : null;
  const variantObj = (node?.motionVariants as Record<string, Record<string, string>> | undefined)?.[activeComponentVariant || ''];
  const overriddenInVariant = isComponentVariantViewport
    && !!activeComponentVariant
    && !!variantObj
    && (property in variantObj || (!!overlayCustomKey && overlayCustomKey in variantObj));
  // Per-variant VARIABLE binding (`'--X': initialVariant === 'v' ? X : 'none'`): bound (purple) on
  // the variant it applies to even with no base binding. Takes precedence over the detach logic.
  const condVarRef = (isComponentVariantViewport && !!activeComponentVariant)
    ? (node?.conditionalStyleVariables?.[property]?.[activeComponentVariant]
      // IDIOMATIC variant-object binding (`logoNameVariants['v'] = { color: prop }`) — same pill.
      // motionVariantVariables is keyed [variant][cssProp] (transposed from conditionalStyleVariables).
      ?? node?.motionVariantVariables?.[activeComponentVariant]?.[property])
    : undefined;
  // Per-VIEWPORT detach on a replica: a `@media` override at THIS tile's width (written when the
  // variable was removed here) shadows the cascaded variable binding → treat it as a literal (no
  // pill), so the row shows the override VALUE + Reset. Width-specific so ONLY the overridden tile
  // loses the pill (a sibling replica with no override of its own keeps it). Mirrors the per-variant
  // `overriddenInVariant` rule above.
  const overriddenInViewport = isReplica && !!selectedId && !!vpWidth
    && hasOverrideAtWidth(overrides, selectedId, property, vpWidth);
  // Per-VIEWPORT variable bound on THIS replica tile → THAT variable is the pill (purple),
  // shadowing the cascaded base. Cascade: smallest breakpoint whose max-width covers vpWidth
  // (matches the inline `__mq` chain + the Renderer). Takes precedence over the base + the
  // literal-override null below.
  const responsiveVarRef = (() => {
    if (!isReplica || !vpWidth || !node?.responsiveStyleVariables?.[property]) return undefined;
    const byW = node.responsiveStyleVariables[property];
    const widths = Object.keys(byW).map(Number).sort((a, b) => a - b);
    for (const b of widths) {
      // BAND, not cascade: a Tablet override's pill shows on Tablet only, not Mobile.
      const min = node.responsiveStyleBands?.[property]?.[b] ?? 0;
      if (vpWidth <= b && vpWidth >= min) return byW[b];
    }
    return undefined;
  })();
  const variableRefFromMarker = responsiveVarRef ?? condVarRef
    ?? ((overriddenInVariant || overriddenInViewport) ? undefined : node?.styleVariables?.[property]);
  const valueSource = detectValueSource(nodeStyles[property] ?? '', variableRefFromMarker);
  const hasVariable = isDirect && valueSource.source === 'prop';
  const variableRef = hasVariable ? valueSource.ref : null;

  // Variable create/remove must go through the OUTER (legacy) ControlProvider
  // when one is mounted, because that's where the file-type routing lives:
  // component master files → component prop mutation, regular page files →
  // addPageVariable + bindStylePageVariable. Calling queueMutation directly
  // here bypassed that routing and silently wrote a function-signature prop
  // even on regular pages — the binding pill rendered (parser saw the prop)
  // but the variables modal was empty (no @pageVariables block written).
  //
  // Falls back to a direct queueMutation (component-style) only when there's
  // no outer provider — e.g. standalone variable-default editors in the
  // VariableModal itself, where the page-vs-component distinction doesn't
  // apply since we're editing a value buffer, not a node.
  const createVariable = useCallback((propName: string) => {
    if (!selectedId) return;
    const outer = outerControlRef.current;
    if (outer) {
      outer.createVariable(property, propName, value);
      return;
    }
    queueMutation({ type: 'createVariable', nodeId: selectedId, styleProperty: property, propName, defaultValue: value });
  }, [selectedId, property, value]);

  const removeVariable = useCallback((propName: string, defValue: string) => {
    if (!selectedId) return;
    const outer = outerControlRef.current;
    if (outer) {
      outer.removeVariable(property, propName, defValue);
      return;
    }
    // Removing a component PROP at its SOURCE (inside the master) when it was the LAST binding → detach
    // the prop from every instance project-wide (the page var stays in the modal). Returns false (→ normal
    // single-node unbind, prop kept) when not a component master or other nodes still use the prop.
    if (removeComponentPropProjectWide(selectedId, property, propName, defValue)) return;
    queueMutation({ type: 'removeVariable', nodeId: selectedId, styleProperty: property, propName, defaultValue: defValue });
  }, [selectedId, property]);

  // All properties for the current context (use outer styles for map-aware values)
  const allProps = isDirect ? nodeStyles : (stopProps ?? {});

  const ctx: UnifiedControlContextValue = useMemo(() => ({
    value, onChange, onChangeMultiple, onChangeLive, onChangeMultipleLive,
    property, mode, binding, hideLabel,
    nodeId, node, allProps,
    hasOverride, getOverrides,
    hasVariable, variableRef, createVariable, removeVariable,
  }), [value, onChange, onChangeMultiple, onChangeLive, onChangeMultipleLive, property, mode, binding, hideLabel, nodeId, node, allProps,
       hasOverride, getOverrides, hasVariable, variableRef, createVariable, removeVariable]);

  return (
    <UnifiedControlContext.Provider value={ctx}>
      {children}
    </UnifiedControlContext.Provider>
  );
}
