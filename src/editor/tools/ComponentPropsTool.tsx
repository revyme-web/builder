// ComponentPropsTool.tsx — Shows component props as editable controls
// when a component instance is selected on the page.
//
// Reads props from the component registry (extracted from function signature).
// Reads current override values from the JSX instance attributes.
// On edit, updates the JSX: <FeatureCard /> → <FeatureCard cardGap="24px" />
//
// Only shown when selectedNode.componentFile is set (i.e., it's a component instance).

import { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { codeAtom, stableCodeAtom, nodesAtom, selectedNodeAtom, selectedIdsAtom, updatingFromCanvasAtom, variableModalRequestAtom, componentToolRevealAtom } from '@/code/stores/store';
import { enterComponentFile } from '@/canvas/component-navigation';
import { projectFS, projectVersionAtom, stableProjectVersionAtom } from '@/code/project/project-fs';
import { activeFilePathAtom, componentBreadcrumbAtom } from '@/code/project/active-file-store';
import { isComponentFilePath } from '@/code/project/file-path-kind';
import { isReplicaViewportAtom, interactingViewportWidthAtom, isComponentVariantViewportAtom, activeComponentVariantAtom } from '@/code/stores/viewport-store';
import { buildComponentRegistry, parseComponentInfoFromSource } from '@/code/components/component-registry';
import { resolveVariableCssProp, isVariableAppliedInCode, type ResolveChildCode } from '@/code/components/prop-css-mapping';
import { useCdnSource } from '@/cloud/components/cdn-source-hook';
import { linkedComponentModalUrlAtom } from '@/cloud/components/linked-component-modal-store';
import { parseComponentName } from '@/code/components/component-ops';
import type { ComponentControlDef } from '@/code/components/controls-parser';
import { ToolRow, ToolInput, ToolSlider, ToolSelect, ToolDivider, ControlLabel, resolveControl, ToolSegmentedControl } from '../controls';
import { resolveVariableEditor } from '../controls/variable-editor-registry';
import { UnifiedControlProvider } from '../controls/unified';
import { YES_NO_OPTIONS } from '../controls/css-property-options';
import ColorInput from '../controls/ColorInput';
import UploadControl from '../controls/UploadControl';
import { FontFamilyControl } from './TextStyleTool/atoms/FontFamilyControl';
import SlotControl from './SlotControl';
import GroupControl from './GroupControl';
import ImageListControl from './ImageListControl';
import TransitionControl from './TransitionControl';
import { modifyProjectFile } from '@/code/project/modify-file';
import { renderCodeComponentDirect } from '@/canvas/CodeComponentHost';
import { componentEditorFileAtom } from '@/code/stores/component-editor-store';
import { suppressSelectionOverlayAtom } from '@/code/stores/editor-store';
import Button from '@/design-system/Button';
import { parseVariantConfig, selectableVariants } from '@/code/variants/variant-config';
import {
  parseConditionalPropExpression,
  resolveConditionalPropValue,
} from '@/code/components/instance-conditional-prop';
import {
  setResponsiveOverride,
  setResponsiveBindingOverride,
  getResponsiveOverridesAtViewport,
  getConditionalInstancePropBranch,
  removeConditionalInstancePropBranchInCode,
  setConditionalInstancePropVarInCode,
} from '@/code/components/instance-prop-overrides';
import {
  getResponsiveInstancePropVarAtViewport,
  resetResponsiveInstancePropVarInCode,
  setResponsiveInstancePropVarInCode,
  getInstancePropBaseValue,
  setInstancePropBaseInCode,
} from '@/code/generation/responsive-instance-prop-vars-gen';
import { formatTransitionObj } from '@/code/generation/generator-motion';
import { getComponentDisplayName } from '@/code/components/component-ops';
import { propertyHasPresets, buildPresetSubmenuItems } from '../controls/control-menu-items';
import { presetTokensAtom } from '@/code/stores/preset-store';
import { flushNow, queueMutation } from '@/code/mutation/mutation-queue';
import { useControl } from '../controls/ControlProvider';
import { CmsBoundPill, CmsMissingPill, CmsFieldPill, cmsFieldLabel } from '../controls/CmsBoundPill';
import { getScrollVariant, setScrollVariantInCode, rehydrateScrollVariant } from '@/code/generation/scroll-variant-gen';
import { getActiveAnimationScope } from '@/editor/tools/AnimationTool/animation-scope-source';
import { isComponentLikeFilePath, isTemplateFilePath } from '@/code/project/active-file-store';
import VariableModal from '../ui/VariableModal';
import type { PageVariableType } from '@/code/features/page-variables';
import { HoistMenuItemProvider } from '../controls/hoist-context';
import LinkRelControl from './LinkTool/LinkRelControl';
import { LabelOverrideProvider } from '../controls/label-override-context';
import { LocalePropPillOr, localizeInstanceProp, getLocalePropState, localePropBandedHere, resetLocalePropBand, resolveScopedPropDisplayValue } from '../controls/LocalePropPill';
import { i18nConfigAtom, activeLocaleAtom } from '@/code/stores/locale-store';
import { viewportWidthsAtom as vpWidthsAtomForLocale } from '@/code/stores/viewport-store';
import { LegacyVariableBoundPill } from '../controls/VariableBoundPill';
import { resolveVariableIconKey, acceptedVariableFamilies, type VariableIconKey } from '../controls/VariableTypeIcon';
import { getVariableType } from '../controls/variable-types';
import { codeControlVariableType } from '../controls/control-variable-type';
import { getPropOptions, getPropNumberMeta, parsePropMeta } from '@/code/components/prop-meta';
import { getJustifyOptions, getAlignOptions } from '../controls/css-property-options';
import NumberVariableEditor from '../controls/NumberVariableEditor';
import type { MenuItem } from '../controls/control-menu-items';
import { getContentRoot, patchNodeStyles } from '@/canvas/node-ops';
import { viewportsConfigAtom } from '@/code/stores/viewport-store';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { trace } from '@/shared/debug-trace';
import { expediteStableAtomSync } from '@/canvas/hooks/useStableAtomSync';

// Lifted-out row components + helpers (Phase 7 god-file split, item 7.5) — see
// ./ComponentPropsTool/. The public API below is re-exported so existing
// importers of this module keep working.
import {
  transitionLiteralToJSON,
  detectPropCSSMapping,
  detectPropAsComponentCursor,
  resolveChildComponentFile,
  detectPropAsVariantBinding,
  detectPresetRefValue,
  codeComponentControlVariableType,
  detectPropAsCodeComponentControl,
  detectPropAsLinkAttr,
  humanizeStylePropName,
  cmsFieldTypesForVarType,
} from './ComponentPropsTool/helpers';
import {
  parseInstanceProps,
  setInstanceProp,
  removeInstanceProp,
  setConditionalInstanceProp,
} from './ComponentPropsTool/instance-props';
import { VariablePresetPillRow } from './ComponentPropsTool/VariablePresetPillRow';
import { CodeComponentControlField } from './ComponentPropsTool/CodeComponentControlField';
import { LinkVariableInstanceRow } from './ComponentPropsTool/LinkVariableInstanceRow';
import { CursorVariableInstanceRow } from './ComponentPropsTool/CursorVariableInstanceRow';

export {
  detectPropCSSMapping,
  detectPropAsComponentCursor,
  detectPropAsVariantBinding,
  detectPropAsCodeComponentControl,
} from './ComponentPropsTool/helpers';
export { setInstanceProp, removeInstanceProp } from './ComponentPropsTool/instance-props';

/**
 * Component props tool — renders when a component instance is selected.
 * Shows each prop with its current value (or default), editable.
 */
export default function ComponentPropsTool() {
  const nodes = useAtomValue(nodesAtom);
  const jotaiStore = useStore();
  const selectedId = useAtomValue(selectedNodeAtom);
  // ─── Double-click reveal: scroll to this tool + flash it ────────────────
  // Canvas double-click on a code-component instance bumps
  // `componentToolRevealAtom` (see component-navigation's revealComponentTool)
  // instead of opening the code overlay — the panel guides the user here.
  const revealNonce = useAtomValue(componentToolRevealAtom);
  const revealRef = useRef<HTMLDivElement>(null);
  const [revealFlash, setRevealFlash] = useState(false);
  const revealSeenRef = useRef(revealNonce);
  useEffect(() => {
    // Skip mount / re-mounts — only a bump AFTER this tool is up counts
    // (the nonce is global and persists across selections).
    if (revealSeenRef.current === revealNonce) return;
    revealSeenRef.current = revealNonce;
    revealRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setRevealFlash(true);
    const t = setTimeout(() => setRevealFlash(false), 1400);
    return () => clearTimeout(t);
  }, [revealNonce]);
  // Read STABLE code: this only drives display values (parsed instance props,
  // responsive overrides). Live code is set via `setCode(...)` below. The
  // stable mirror means a fast drag's per-reparent file writes don't trigger
  // panel re-renders. See Canvas.tsx sync effect.
  const code = useAtomValue(stableCodeAtom);
  const activeFile = useAtomValue(activeFilePathAtom);
  const setCode = useSetAtom(codeAtom);
  const setVersion = useSetAtom(projectVersionAtom);
  // Subscribe to STABLE project version so the panel doesn't re-render on
  // every per-reparent file write during drag (the cascade was eating ~80ms
  // per reparent). The stable atom catches up on drag end via the sync effect
  // in Canvas.tsx, so by the time the user releases, componentInfo /
  // propCSSMap / currentValues will refresh. Reads of `code` (also derived
  // from stable) follow the same pattern.
  const projectVersion = useAtomValue(stableProjectVersionAtom);
  // Design-token presets — used to build the per-row "Apply Preset" submenu
  // for variable rows whose CSS property supports presets (radius / spacing /
  // margin / shadow / border).
  const presetTokens = useAtomValue(presetTokensAtom);
  const isReplica = useAtomValue(isReplicaViewportAtom);
  const vpWidth = useAtomValue(interactingViewportWidthAtom);
  // Component-file routing: when the user is on a non-default variant in a
  // component master, prop changes (especially `initialVariant`) must land in
  // a per-parent-variant override (a JSX ternary), not on the base prop value
  // — otherwise the change applies to ALL parent variants.
  const isComponentVariant = useAtomValue(isComponentVariantViewportAtom);
  const activeComponentVariant = useAtomValue(activeComponentVariantAtom);
  const setActiveFile = useSetAtom(activeFilePathAtom);
  const setBreadcrumb = useSetAtom(componentBreadcrumbAtom);
  const setSelectedIds = useSetAtom(selectedIdsAtom);
  const setInteractingVp = useSetAtom(interactingViewportIdAtom);
  const setUpdatingFromCanvas = useSetAtom(updatingFromCanvasAtom);
  const setComponentEditorFile = useSetAtom(componentEditorFileAtom);
  const interactingVpId = useAtomValue(interactingViewportIdAtom);
  const viewportsConfig = useAtomValue(viewportsConfigAtom);
  const node = selectedId ? nodes.get(selectedId) ?? null : null;
  const componentFile = node?.componentFile ?? null;
  // Master file source — used to read a variable's @propMeta Option choices when rendering an Option
  // editor for the instance. Re-reads on every mutation flush so freshly-edited choices show up.
  const masterCode = useMemo(() => (componentFile ? projectFS.readFile(componentFile) ?? '' : ''), [componentFile, projectVersion]);

  // CDN-linked component: fetch the original TSX source from the auth-
  // gated `/api/components/source` endpoint so we can parse variants /
  // props / display name the same way local components do. Returns
  // `{ source: null, loading: true }` while in flight; `{ source, false }`
  // once the cache is populated. The hook keys by full URL so cached
  // sources persist across component selection changes — clicking back
  // and forth between two CDN instances doesn't refetch.
  const isCdnLinked = !!componentFile && componentFile.startsWith('http');
  // CDN VECTOR instances render the IconSetTool
  // below, not the ComponentPropsTool — they're container-set
  // components whose only user-facing prop is `name` (which variant to
  // show), and the kind-specific picker UI gives a richer experience
  // than this tool's generic prop grid would. Bail before any of the
  // source-fetching / registry lookup runs so we don't waste a
  // `useCdnSource` round-trip.
  const isCdnVector = isCdnLinked && componentFile.includes('/vectors/');
  const isCdnContainerSet = isCdnVector;
  const { source: cdnSource } = useCdnSource(isCdnLinked && !isCdnContainerSet ? componentFile : null);

  // Build registry and find this component's info.
  // Adding `projectVersion` as a dep ensures we re-read the registry when
  // the master file changes (e.g. user creates a new variable on the master,
  // adding a destructured prop to the function signature).
  // For CDN-linked components, parse the fetched source directly — they
  // aren't in projectFS so the registry doesn't know about them.
  const componentInfo = useMemo(() => {
    if (!componentFile) return null;
    if (isCdnLinked) {
      if (!cdnSource) return null; // still loading
      // Use the URL as the cache hash key — content-addressed already.
      const hashMatch = componentFile.match(/@([a-f0-9]+)\./);
      const hash = hashMatch?.[1] ?? componentFile;
      return parseComponentInfoFromSource(componentFile, cdnSource, hash);
    }
    const registry = buildComponentRegistry(projectFS);
    for (const info of registry.values()) {
      if (info.filePath === componentFile) return info;
    }
    return null;
  }, [componentFile, projectVersion, isCdnLinked, cdnSource]);

  // Get display name from @name annotation. For CDN-linked components
  // parse the cached source directly.
  const displayName = useMemo(() => {
    if (!componentFile) return null;
    if (isCdnLinked) {
      return cdnSource ? parseComponentName(cdnSource) : null;
    }
    return getComponentDisplayName(componentFile);
  }, [componentFile, projectVersion, isCdnLinked, cdnSource]);

  // Parse variant config from the component file (or fetched CDN source)
  const variantConfig = useMemo(() => {
    if (!componentFile) return [];
    let compCode: string | null = null;
    if (isCdnLinked) {
      compCode = cdnSource;
    } else {
      compCode = projectFS.readFile(componentFile);
    }
    if (!compCode) return [];
    return parseVariantConfig(compCode);
  }, [componentFile, projectVersion, isCdnLinked, cdnSource]);

  // handleEditComponent is defined below after currentVariant

  // ─── Hoist-variable modal state ──────────────────────────────────────────
  // The modal is opened from a per-prop "Hoist" button rendered next to
  // each editable instance-prop control (only when the active file is a
  // component master, i.e. there's a parent to hoist INTO). Confirming
  // dispatches the `hoistInstanceProp` mutation; the registry refresh
  // afterward makes the new prop appear on the parent's instance editor
  // wherever that parent is used.
  type HoistTarget = {
    propName: string;
    currentLiteral: string;
    inferredType: PageVariableType;
    /** CSS property the prop binds to (e.g. `backgroundColor`). Passed to
     *  VariableModal so it renders the right default-value control (color
     *  picker / slider / etc.). Undefined for props with no CSS mapping —
     *  the modal falls back to a plain text input. */
    cssProp: string | undefined;
    /** Code component `@control` definition when the variable is created from a code-
     *  component control (color / slider / etc.). The modal renders THIS
     *  control for the default value — `cssProp` is null for code components, so
     *  without it the modal would fall back to a bare text input. */
    codeComponentControl?: ComponentControlDef;
  } | null;
  const [hoistTarget, setHoistTarget] = useState<HoistTarget>(null);
  // A TEMPLATE (LayoutClient.tsx) is a component-like master too — a selected
  // component instance inside it can hoist its variables UP into the template
  // (which the Template tool then surfaces per-page), exactly like hoisting into
  // a design-component master. So treat templates as "in a component master".
  const isInComponentMaster = isComponentLikeFilePath(activeFile);
  const inferTypeForProp = (cssProp: string | undefined, literal: string): PageVariableType => {
    // CSS-property hints come first — `backgroundColor` → color, etc.
    if (cssProp) {
      // box/text-SHADOW is NOT a color (the value is `Npx Npx … #hex`, a shorthand the Shadow editor owns).
      // Matching it here as `color` mis-typed hoisted shadow vars → the modal showed a colour picker, not the
      // Shadow control. Let it fall through to `text` (like `border`); the editor resolves from the binding.
      if (/shadow/i.test(cssProp)) return 'text';
      // borderRadius / border*Radius is its OWN multi-value type (the Radius editor with px + per-corner
      // expand), NOT a Number — but its value (`0px`) matches the numeric literal regex below, so it was
      // mis-typed `number` → the modal showed a Number editor (min/max/step). Fall through to `text` like
      // shadow/border; the modal derives the real Radius control from the bound property.
      if (/radius/i.test(cssProp)) return 'text';
      if (/color|background|fill|stroke/i.test(cssProp)) return 'color';
      if (/Image|backgroundImage|src/i.test(cssProp)) return 'image';
    }
    // Literal-shape fallback when there's no CSS hint.
    if (/^#[0-9a-fA-F]{3,8}$/.test(literal)) return 'color';
    if (/^(rgb|hsl)a?\(/.test(literal)) return 'color';
    if (/^(true|false)$/.test(literal)) return 'boolean';
    if (/^-?\d+(\.\d+)?(px|%|em|rem|vh|vw)?$/.test(literal)) return 'number';
    return 'text';
  };

  // Parse current prop values from the JSX instance: <Component propName="value" />
  const componentName = componentInfo?.name ?? null;
  // ── Prop LOCALIZATION: Localize menu item per prop row +
  // blue pill + popup — rides the updateLocaleInstanceProp mutation. The
  // menu item converts-on-click (seeds the first non-default locale with the
  // current value, artboard-scoped on a replica); the pill's popup edits all
  // locales.
  const i18nCfgForProps = useAtomValue(i18nConfigAtom);
  const localeTargets = (i18nCfgForProps?.locales ?? []).filter(l => l.code !== i18nCfgForProps?.defaultLocale);
  const interactingVpForLocale = useAtomValue(interactingViewportIdAtom);
  const activeCanvasLocale = useAtomValue(activeLocaleAtom);
  const vpWidthsForLocale = useAtomValue(vpWidthsAtomForLocale);
  /** A row's SAFE fallback for locale flows: the current value unless it's a
   *  raw scoped-expression string (a localized prop's attr parses verbatim),
   *  then the @propMeta default. Baking the raw expression as a VALUE
   *  corrupted the attr (the "× removed it everywhere + garbage band" find). */
  const cleanPropFallback = (propValue: string, defaultValue?: string | null): string | undefined => {
    const looksExpr = (v: string) => v.includes('__activeLocale') || v.includes('__mq') || /^\(.*\)$/.test(v.trim());
    // Stringified `undefined`/`null` = the expression's bare base branch
    // ("defer to master default") leaking through canvas resolution — never a
    // usable fallback (the "Fallback: undefined" popup find).
    const usable = (v?: string | null): v is string => !!v && v !== 'undefined' && v !== 'null' && !looksExpr(v);
    if (usable(propValue)) return propValue;
    if (usable(defaultValue)) return defaultValue;
    return undefined;
  };
  /** FIXED axis-neutral labels for layout-driving option variables (Start/
   *  Center/End/Space …) — the stored values stay raw CSS (deploy truth);
   *  no direction detection (removed 2026-07-22, it confused more than it
   *  helped). Also dedupes creation-time snapshot artifacts (start vs
   *  flex-start). */
  const layoutAwareOptions = (propName: string, cssPropName: string | null | undefined, raw: { value: string; label: string }[]): { value: string; label: string }[] => {
    const isLayoutProp = cssPropName === 'justifyContent' || cssPropName === 'alignItems';
    const norm = (v: string) => v === 'start' ? 'flex-start' : v === 'end' ? 'flex-end' : v;
    if (!isLayoutProp) return raw;
    const labeled = cssPropName === 'justifyContent' ? getJustifyOptions() : getAlignOptions();
    const seen = new Set<string>();
    const out: { value: string; label: string }[] = [];
    for (const o of raw) {
      const n = norm(o.value);
      if (seen.has(n)) continue;
      seen.add(n);
      out.push({ value: o.value, label: labeled.find((l) => norm(l.value) === n)?.label ?? o.label });
    }
    return out;
  };
  // ── OPTIMISTIC prop values ──────────────────────────────────────────────
  // A prop write settles through several async stages (queue flush → parse →
  // responsive fold), and the row's derived value passes through STALE
  // intermediate parses — the select visibly ping-ponged old↔new before
  // settling (live report 2026-07-22). The clicked value is held here and
  // wins the display until the parsed pipeline settles (cleared on a timer;
  // the parsed value has always converged well within it).
  const [pendingProps, setPendingProps] = useState<Record<string, string>>({});
  const pendingPropTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const setPropOptimistic = useCallback((propName: string, value: string) => {
    setPendingProps((p) => ({ ...p, [propName]: value }));
    clearTimeout(pendingPropTimersRef.current[propName]);
    pendingPropTimersRef.current[propName] = setTimeout(() => {
      setPendingProps((p) => { const n = { ...p }; delete n[propName]; return n; });
    }, 1200);
  }, []);

  const localePropState = (propName: string) =>
    getLocalePropState(code, selectedId, propName, interactingVpForLocale, vpWidthsForLocale);
  const resolveScopedPropDisplay = (propName: string, raw: string, defaultValue?: string | null): string =>
    resolveScopedPropDisplayValue(code, selectedId, propName, interactingVpForLocale, vpWidthsForLocale,
      activeCanvasLocale, i18nCfgForProps?.defaultLocale ?? 'en', raw, defaultValue);
  const localizeMenuItem = (propName: string, currentValue: string) => {
    if (localeTargets.length === 0 || !selectedId || !componentName) return [];
    const lp = localePropState(propName);
    // Already localized on this artboard → the pill owns the flow; no
    // second Localize entry (mirror of the style rows).
    if (lp.locales.length > 0) return [];
    const vpWidth = vpWidthsForLocale[interactingVpForLocale];
    const primaryW = Math.max(...Object.values(vpWidthsForLocale).map(Number).filter(n => Number.isFinite(n)), 0);
    const isReplica = Number.isFinite(vpWidth) && vpWidth > 0 && vpWidth !== primaryW;
    return [{
      label: 'Localize',
      show: true,
      onClick: () => localizeInstanceProp({
        nodeId: selectedId, componentName, prop: propName, currentValue,
        firstLocale: localeTargets[0].code, isReplica, vpWidth: isReplica ? vpWidth : undefined,
      }),
    }];
  };
  /** Blue label + Reset Override when THIS replica holds banded locale
   *  values for the prop (the per-replica locale override state). */
  const localePropOverride = (propName: string): { overridden: boolean; reset: (() => void) | null } => {
    if (!selectedId || !componentName) return { overridden: false, reset: null };
    const lp = localePropState(propName);
    if (!localePropBandedHere(lp)) return { overridden: false, reset: null };
    return { overridden: true, reset: () => resetLocalePropBand(selectedId, componentName, propName, lp) };
  };
  const currentValues = useMemo(() => {
    if (!selectedId || !code || !componentName) return new Map<string, string>();
    return parseInstanceProps(code, selectedId, componentName);
  }, [selectedId, code, componentName]);

  // Detect which CSS property each prop maps to (for rendering the right control atom).
  // The componentFile path is passed so the detector can follow forwarded
  // props through child components — the hoisted-variable case where the
  // parent file has no direct CSS use of the variable, only a
  // `<Child cprop={parentVar} />` forward. Without this, the page-level
  // instance editor falls back to a plain text input for hoisted color
  // / padding / shadow variables.
  const propCSSMap = useMemo(() => {
    if (!componentFile || !componentInfo) return new Map<string, string>();
    const compCode = projectFS.readFile(componentFile);
    if (!compCode) return new Map<string, string>();
    return detectPropCSSMapping(componentInfo.props, compCode, componentFile);
  }, [componentFile, componentInfo, projectVersion]);

  // propName → variant options map. After hoisting a nested instance's
  // `initialVariant`, the parent ends up with a prop wired through as
  // `<NestedChild initialVariant={parentProp}/>`. On the page-level
  // instance editor of the parent, that prop should render a variant
  // SELECT (matching the nested child's variants), not a plain text
  // input. Detect the forward via `detectPropAsVariantBinding`, then
  // read the child's `variantConfig` to build the options list.
  const propVariantOptionsMap = useMemo(() => {
    const out = new Map<string, { value: string; label: string }[]>();
    if (!componentFile || !componentInfo) return out;
    const compCode = projectFS.readFile(componentFile);
    if (!compCode) return out;
    for (const prop of componentInfo.props) {
      if (prop.name === 'style' || prop.name === 'initialVariant') continue;
      const childFile = detectPropAsVariantBinding(prop.name, compCode, componentFile);
      if (!childFile) continue;
      const childCode = projectFS.readFile(childFile);
      if (!childCode) continue;
      const childVariants = selectableVariants(parseVariantConfig(childCode));
      if (childVariants.length === 0) continue;
      out.set(prop.name, childVariants.map(v => ({ value: v.name, label: v.label })));
    }
    return out;
  }, [componentFile, componentInfo, projectVersion]);

  // propName → true when the prop drives a component-cursor variable
  // (either directly via `withCursor(propName, …)` or forwarded into a
  // child instance whose corresponding prop is itself a cursor variable).
  // The page-level instance editor uses this to render a component picker
  // (`CursorComponentPickerRow`) instead of a plain text input. Recursive
  // hoist works out of the box — see `detectPropAsComponentCursor`'s
  // multi-level branch.
  const propCursorVarSet = useMemo(() => {
    const out = new Set<string>();
    if (!componentFile || !componentInfo) return out;
    const compCode = projectFS.readFile(componentFile);
    if (!compCode) return out;
    for (const prop of componentInfo.props) {
      if (prop.name === 'style' || prop.name === 'initialVariant') continue;
      if (detectPropAsComponentCursor(prop.name, compCode, componentFile)) {
        out.add(prop.name);
      }
    }
    return out;
  }, [componentFile, componentInfo, projectVersion]);

  // propName → Code component control def, when the prop forwards into a code
  // component's `@control` (e.g. `<FilmGrain intensity={prop} />` or
  // `<LiquidMetal accentColor={prop} />`). The page-instance editor renders
  // the code component's REAL control (color picker / slider) for these instead of a
  // plain text input — the variable was created from that control, so its
  // editor should match. Without this, a hoisted code component color/number variable
  // shows a bare hex/number input on the parent instance.
  const propCodeComponentControlMap = useMemo(() => {
    const out = new Map<string, ComponentControlDef>();
    if (!componentFile || !componentInfo) return out;
    const compCode = projectFS.readFile(componentFile);
    if (!compCode) return out;
    for (const prop of componentInfo.props) {
      if (prop.name === 'style' || prop.name === 'initialVariant') continue;
      const def = detectPropAsCodeComponentControl(prop.name, compCode, componentFile);
      if (def) out.set(prop.name, def);
    }
    return out;
  }, [componentFile, componentInfo, projectVersion]);

  // propName → link-attr kind, when the prop drives href / target /
  // data-smooth-scroll on an <a>/<Link> in the master (created via the Link
  // tool's "Create Variable"). Lets the instance row render a link input or
  // a Yes/No toggle instead of a raw text field.
  const propLinkAttrMap = useMemo(() => {
    const out = new Map<string, 'href' | 'newTab' | 'smooth' | 'tracking' | 'rel' | 'params'>();
    if (!componentFile || !componentInfo) return out;
    const compCode = projectFS.readFile(componentFile);
    if (!compCode) return out;
    for (const prop of componentInfo.props) {
      if (prop.name === 'style' || prop.name === 'initialVariant') continue;
      const kind = detectPropAsLinkAttr(prop.name, compCode);
      if (kind) out.set(prop.name, kind);
    }
    return out;
  }, [componentFile, componentInfo, projectVersion]);

  // Parent-file variables — i.e. the variables/props of the COMPONENT MASTER
  // we're currently inside. After a hoist, the nested-instance prop's JSX
  // value becomes a bare identifier referencing one of these. We use this
  // map for two things:
  //   1. detect whether an instance prop is bound to a parent variable
  //      (its value matches a known name), so we can show the purple
  //      "T <varName> ×" pill instead of the atom's normal editor.
  //   2. fall back to the parent variable's default when the user clicks
  //      × to unbind — that way the prop reverts to a meaningful literal
  //      instead of an empty string.
  // On regular page files there's no "parent component master" — the map
  // is empty and the binding path is skipped. The standard style-variable
  // pill flow there is unaffected.
  // The ACTIVE master file's own ComponentInfo (its props = the variables a
  // hoist targets / "Set Variable" can bind to). Templates aren't scanned into
  // the `components/` registry, so parse the LayoutClient source directly —
  // mirrors VariableModal's existingVars fallback.
  const activeFileInfo = useMemo(() => {
    if (!isInComponentMaster) return null;
    const registry = buildComponentRegistry(projectFS);
    for (const info of registry.values()) {
      if (info.filePath === activeFile) return info;
    }
    if (isTemplateFilePath(activeFile)) {
      const tplCode = projectFS.readFile(activeFile) ?? '';
      return tplCode ? parseComponentInfoFromSource(activeFile, tplCode, String(tplCode.length)) : null;
    }
    return null;
  }, [isInComponentMaster, activeFile, projectVersion]);

  const parentVarsByName = useMemo(() => {
    const out = new Map<string, string>();
    if (!activeFileInfo) return out;
    for (const p of activeFileInfo.props) out.set(p.name, p.defaultValue ?? '');
    return out;
  }, [activeFileInfo]);

  // Typed list of the master's variables (name + default + icon family) for the code-component
  // "Set Variable" submenu. A code @control offers existing variables of its OWN data type — a Number
  // (slider/number) control lists number variables, a Color control color variables, etc. The family
  // comes from the variable's declared type, falling back to its value shape for untyped ones.
  const parentVars = useMemo(() => {
    if (!activeFileInfo) return [] as { name: string; label: string; default: string; family: VariableIconKey }[];
    // Resolve each var's BINDING cssProp (the same resolver the modal/Template tool use) so the icon reflects
    // what the var DRIVES — `overflow`/`direction` → the 'option' icon, a 'text'-typed border var → 'border' —
    // not the bare "T" its primitive type would give. Value-inference alone can't tell `"hidden"`/`"column"`
    // apart from text, so the binding is required for those.
    const activeCode = projectFS.readFile(activeFile) ?? '';
    // @propMeta of the active component — a `variantOf` entry marks a VARIANT variable (it drives a child
    // component's variants), which must show the 'option'/select icon, NOT the "T" its generic 'text' type
    // would give. Mirrors the variable modal's variantVarNameSet. Parsed once, reused for every prop below.
    const propMetaForIcon = parsePropMeta(activeCode);
    const resolveChild: ResolveChildCode = (childTag, parentCode, parentFilePath) => {
      const childFile = resolveChildComponentFile(childTag, parentCode, parentFilePath);
      const childCode = childFile ? projectFS.readFile(childFile) : null;
      return (childFile && childCode) ? { code: childCode, filePath: childFile } : null;
    };
    return activeFileInfo.props
      .filter(p => p.name !== 'style' && p.name !== 'initialVariant')
      // Hide a cursor variable's paired `<prop>Opts` param — it's the
      // machinery for per-instance behaviour overrides (managed by the
      // Component Cursor popup), not a user-facing variable.
      .filter(p => !(p.name.endsWith('Opts')
        && activeFileInfo.props.some(q => `${q.name}Opts` === p.name && q.varType === 'componentCursor')))
      .map(p => ({
        name: p.name,
        label: p.label || p.name,
        default: p.defaultValue ?? '',
        // A SPECIFIC declared type wins; a GENERIC 'text' type (a var with no @propMeta type) defers to the
        // BINDING/value icon (border / option / …), keeping "T" only for a true plain-text var. Same rule the
        // variable modal's list uses.
        family: (() => {
          // Variant variable (drives a component's variants) → the 'option'/select icon, even with a generic
          // 'text' type and no CSS binding the value-resolver could read. Same rule the variable modal uses.
          if (propMetaForIcon[p.name]?.variantOf) return 'option';
          const ti = getVariableType(p.varType)?.iconKey;
          if (ti && ti !== 'text') return ti;
          const boundProp = resolveVariableCssProp(p.name, activeCode, activeFile, resolveChild);
          const bi = resolveVariableIconKey({ property: boundProp || undefined, value: p.defaultValue ?? '' });
          return bi !== 'generic' ? bi : (ti ?? 'generic');
        })(),
      }));
  }, [activeFileInfo, activeFile, projectVersion]);

  const setVariableModalRequest = useSetAtom(variableModalRequestAtom);

  // INSTANT hoist: create the variable IMMEDIATELY with a unique auto-name + bind it, then open the
  // manage modal on it for RENAME — NO "Create Variable" form / Cancel. Matches every other create
  // flow (ControlLabel, InteractionsTool, ScrollVariantEditor) so creation is always one-and-done.
  const instantHoist = useCallback((target: NonNullable<HoistTarget>) => {
    if (!componentName || !selectedId) return;
    // Variant hoist uses the reserved `initialVariant` prop → seed a component-derived name
    // (`startTrialButtonVariant`); a plain prop → the prop name. Uniquify against existing vars.
    const base = target.propName === 'initialVariant'
      ? `${componentName.charAt(0).toLowerCase()}${componentName.slice(1)}Variant`
      : target.propName;
    const taken = new Set(parentVars.map(v => v.name));
    let name = base;
    for (let i = 1; taken.has(name); i++) name = `${base}${i}`;
    queueMutation({
      type: 'hoistInstanceProp',
      instanceNodeId: selectedId,
      componentName,
      propName: target.propName,
      variable: { name, type: target.inferredType, default: target.currentLiteral },
      scope: getActiveAnimationScope(),
    });
    // VARIANT variable → persist the "tied to this component" identity in @propMeta so that, after the
    // instance is unbound (X), the modal keeps the variant SELECT and "Set Variable" can re-offer it on
    // this component (componentName is the JSX tag, e.g. "StartTrialButton"). See prop-meta `variantOf`.
    if (target.propName === 'initialVariant') {
      queueMutation({ type: 'setComponentPropVariantOf', propName: name, componentTag: componentName });
    }
    // A `transition` is NOT a valid @pageVariables type (the page-variables parser rejects it → null), so it's
    // hoisted with a 'text' @pageVariables type; record the real type in @propMeta instead so the variable modal
    // shows the transition icon and the component/template tool renders the curve picker (not a raw 'T' input).
    if (target.cssProp === 'transition') {
      queueMutation({ type: 'setComponentPropType', propName: name, varType: 'transition' });
    }
    if (target.codeComponentControl && (target.codeComponentControl.type === 'number' || target.codeComponentControl.type === 'slider')) {
      queueMutation({ type: 'setComponentPropNumberMeta', propName: name, meta: {
        min: target.codeComponentControl.min, max: target.codeComponentControl.max, step: target.codeComponentControl.step,
        unit: target.codeComponentControl.unit, control: target.codeComponentControl.displayStepper ? 'stepper' : 'slider',
      } });
    }
    flushNow(); // the variable must exist before the rename modal reads it
    setVariableModalRequest({
      property: target.cssProp ?? target.propName,
      propertyLabel: target.propName,
      currentValue: target.currentLiteral,
      variableRef: name,
      nameEditable: true,
    });
    trace.action('component-props:instant-hoist', { propName: target.propName, name });
  }, [componentName, selectedId, parentVars, setVariableModalRequest]);

  // Bind a code-component control to an EXISTING master variable: write the instance prop as a bare
  // identifier (`speed={someVar}`) — always an expression, regardless of control type, so the parser
  // reads it back as a binding (not a string literal). Mirrors the hoist bind without minting a new var.
  const bindCodeControlVariable = useCallback((propName: string, varName: string) => {
    if (!selectedId || !componentInfo) return;
    previewProp(propName, varName);
    // On a REPLICA, bind the variable for THIS viewport ONLY (inline `prop={__mq ? var : base}`) — exactly
    // like a design-component per-viewport variable — so the base binding on other viewports is untouched.
    // On the primary, bind the base. Parity with the design-component prop rows.
    const scope = isReplica ? getActiveAnimationScope() : null;
    modifyProjectFile(activeFile, (currentCode) =>
      (scope && 'query' in scope)
        ? setResponsiveInstancePropVarInCode(currentCode, selectedId, componentInfo.name, scope.query, propName, varName)
        : setInstanceProp(currentCode, selectedId, componentInfo.name, propName, varName, true));
    const newCode = projectFS.readFile(activeFile);
    if (newCode) { setCode(newCode); setVersion(v => v + 1); }
    trace.action('component-props:bind-code-control-variable', { propName, varName, isReplica });
  }, [selectedId, componentInfo, activeFile, isReplica]);

  const controlsMeta = componentInfo?.controlsMeta ?? null;

  // Parse data-responsive overrides for current viewport
  const responsiveOverrides = useMemo(() => {
    if (!isReplica || !selectedId || !code || !componentName) return new Map<string, string>();
    // Reads BOTH the static string form and the computed `={JSON.stringify({…})}`
    // form, so a per-viewport CMS field-ref surfaces as `item.field` (lights up the
    // bound-pill detection below) and a literal as its value.
    return getResponsiveOverridesAtViewport(code, selectedId, componentName, vpWidth);
  }, [isReplica, selectedId, code, componentName, vpWidth]);

  // Per-viewport VARIABLE bindings on this instance's props (the inline `prop={__mqN ? var : base}`
  // rail) at the current replica width → Map<prop, varName>. Powers the per-viewport variable pill.
  const responsiveAttrVars = useMemo(() => {
    if (!isReplica || !selectedId || !code || !componentName || !vpWidth) return new Map<string, string>();
    return getResponsiveInstancePropVarAtViewport(code, selectedId, componentName, vpWidth);
  }, [isReplica, selectedId, code, componentName, vpWidth]);

  // Current variant for this instance — checks responsive override first, then direct prop
  const currentVariant = useMemo(() => {
    if (!selectedId || !code || !componentInfo) return 'default';
    if (isReplica) {
      const override = responsiveOverrides.get('initialVariant');
      if (override) return override;
      // Inline-ternary per-viewport variant (`initialVariant={__mq2 ? 'variant-3' : 'default'}`) — its
      // resolved per-tile value lives in `responsiveAttrPropValues` (raw parse) or `responsiveVariantMap`
      // (folded), depending on the node. Read either so the control shows the right variant on the replica.
      // Appears after a per-viewport variant VARIABLE is deleted → inlined to a literal. data-responsive
      // (above) still wins — same precedence as the canvas.
      const vpNode = vpWidth ? nodes.get(selectedId) : undefined;
      const vpVariant = vpNode?.responsiveAttrPropValues?.initialVariant?.[vpWidth!]
        ?? vpNode?.responsiveVariantMap?.[vpWidth!];
      if (vpVariant) return vpVariant;
    }
    // Scroll-variant instances bind `initialVariant={…Sv}` to runtime state — the displayed
    // variant CHOICE lives in the spec's `canvasVariant`. Read it so the dropdown highlights
    // the right entry (the binding itself isn't a parseable variant name).
    if (!isReplica && !(isComponentVariant && activeComponentVariant)) {
      const sv = getScrollVariant(code, selectedId);
      if (sv && typeof sv.canvasVariant === 'string') return sv.canvasVariant;
    }
    const props = parseInstanceProps(code, selectedId, componentInfo.name);
    const raw = props.get('initialVariant') ?? 'default';
    // When in a component file on a non-default variant, the JSX may carry a
    // ternary like `initialVariant === 'variant-1' ? 'variant-2' : 'default'`.
    // Resolve to the value for the parent variant currently being viewed so
    // the variant-tool select highlights the right entry.
    if (isComponentVariant && activeComponentVariant) {
      // A per-variant VARIABLE binding (`variant === 'v6' ? var : base`, the hoist twin) → resolve the bound
      // variable's value so the dropdown highlights the right variant; the literal-only parser returns null
      // on a var branch, so we'd otherwise fall through and show the raw ternary.
      const branch = getConditionalInstancePropBranch(code, selectedId, componentInfo.name, 'initialVariant', activeComponentVariant);
      if (branch?.isVar) {
        const rawVal = parentVarsByName.get(branch.value);
        if (rawVal != null) return rawVal.replace(/^["'](.*)["']$/s, '$1');
      }
      const map = parseConditionalPropExpression(raw);
      if (map) return resolveConditionalPropValue(map, activeComponentVariant);
      if (branch && !branch.isVar) return branch.value;
    }
    return raw;
  }, [selectedId, code, componentInfo, isReplica, responsiveOverrides, isComponentVariant, activeComponentVariant, nodes, vpWidth, parentVarsByName]);

  // Navigate to component master page — or open code editor for code components.
  // Centralized via enterComponentFile so this matches the double-click on
  // an instance + the Make Component flow (same timing, zoom strength,
  // breadcrumb behavior).
  //
  // For CDN-linked components, the "master" is a remote URL we can't
  // navigate into. Open the LinkedComponentModal (Unlink Instance / Unlink
  // and Replace All) instead — same target the dblclick on a CDN instance
  // hits.
  const handleEditComponent = useCallback(() => {
    if (!componentFile) return;
    if (isCdnLinked) {
      // Pass the selected instance's node id so "Unlink Instance" can
      // retarget JUST this one JSX tag — without it the modal would
      // have to fall back to project-wide URL rewrite ("Replace All").
      // For multi-select we open the modal against the first id (the
      // panel only shows the per-instance editor for one node anyway).
      if (!selectedId) return;
      jotaiStore.set(linkedComponentModalUrlAtom, { url: componentFile, nodeId: selectedId });
      return;
    }
    enterComponentFile(
      {
        fromFilePath: activeFile,
        componentFilePath: componentFile,
        initialVariant: currentVariant,
        // Component variants are framer-motion VIEWPORTS sharing one
        // root data-id; pass the variant name so the pre-zoom + post-
        // render zoom land on the variant viewport the instance is
        // currently pointing at, not on the union of all variants.
        focusVariantName: currentVariant,
      },
      {
        setActiveFile,
        setBreadcrumb,
        setSelectedIds,
        setUpdatingFromCanvas,
        setInteractingViewport: setInteractingVp,
        getNodes: () => jotaiStore.get(nodesAtom),
        openCodeEditor: setComponentEditorFile,
        // Same overlay-flash suppression as the canvas dbl-click
        // path — without it the SelectionBorder polls stale rect-
        // cache entries from the previous file for one frame and
        // visibly flashes huge before the new master's rects land.
        setSuppressSelectionOverlay: (v) => jotaiStore.set(suppressSelectionOverlayAtom, v),
      },
    );
  }, [componentFile, isCdnLinked, activeFile, currentVariant, setActiveFile, setBreadcrumb, setSelectedIds, setUpdatingFromCanvas, setInteractingVp, setComponentEditorFile, jotaiStore]);

  // ─── In-flight slider drag values ────────────────────────────────────────
  // While a slider is dragging we don't write to the source file (Babel parse
  // 60×/sec is the bottleneck). The committed `currentValue` therefore stays
  // stale until pointer-up. Mirror the in-flight value here so the slider
  // thumb, the inline input number, and the canvas preview all show the same
  // live number during the drag. Cleared on commit (handlePropChange).
  const [previewValues, setPreviewValues] = useState<Record<string, string>>({});

  // ─── Live preview path (slider drag, color drag, etc.) ────────────────────
  // Patches the live canvas DOM + re-renders code components in place. Does
  // NOT touch the source file. Cheap enough to run 60×/sec without lag.
  // Babel-parsing the source on every slider tick was the bottleneck — for
  // code components this is purely cosmetic during the drag because the live React
  // instance is already updated via `renderCodeComponentDirect` below.
  const previewProp = useCallback((propName: string, value: string) => {
    if (!selectedId || !componentInfo) return;
    setPreviewValues((p) => (p[propName] === value ? p : { ...p, [propName]: value }));

    const controlDef = controlsMeta?.controls?.[propName];
    // Booleans MUST be JSX expressions (`prop={false}`), never strings
    // (`prop="false"`) — the string "false" is truthy in JS, so a boolean link
    // variable (New Tab / Smooth Scroll) set to false would still read as true
    // at runtime (the smooth-scroll handler kept firing). Code component slider/number/
    // toggle controls already use expressions; the boolean link-attr variables
    // (`newTab`/`smooth`) need the same.
    const linkKindForExpr = propLinkAttrMap.get(propName);
    // Typed component variables whose runtime value is a JS literal, not a string: a Toggle prop must be
    // `prop={true}` (the string "false" is truthy), a Number prop `prop={16}`. Write them as expressions.
    const propVarType = componentInfo?.props?.find(p => p.name === propName)?.varType;
    const useExpression = (!!controlDef && (
      controlDef.type === 'slider' || controlDef.type === 'number' || controlDef.type === 'toggle'
    )) || propVarType === 'toggle' || propVarType === 'number'
      || linkKindForExpr === 'newTab' || linkKindForExpr === 'smooth' || linkKindForExpr === 'params';
    const coercedValue = useExpression
      ? (value === 'true' ? true : value === 'false' ? false : /^-?\d+(\.\d+)?$/.test(value) ? parseFloat(value) : value)
      : value;

    // Live DOM patch for design components — find every expanded child whose
    // styleVariables[cssProp] matches the current binding-name in the
    // FORWARDING CHAIN that starts at the selected instance's `propName`.
    //
    // For a hoisted variable, the descendant deep inside a nested
    // expansion is bound by the INNER component's prop name (e.g. `poon`),
    // not the page-level prop name (`poon2`). The forwarding sits on
    // nested-instance wrappers via `attrPropRefs` (e.g.
    // `<RoHuVu poon={poon2}/>` → `attrPropRefs.poon = 'poon2'`). To find
    // the right descendants at preview time we walk the subtree DFS,
    // RENAMING the active name each time we cross a wrapper that
    // re-aliases it. When we land on a node whose `styleVariables[cssProp]
    // === activeName` we patch — that's the same DOM the file write would
    // have updated on commit, so the preview is pixel-accurate.
    //
    // Without this chain walk the live drag does nothing for hoisted
    // variables (the descendant's marker is `poon`, the change event is
    // for `poon2`) and the canvas only catches up after the debounced
    // file write lands ~200ms later — visible as a lag at the end of the
    // drag instead of smooth real-time feedback.
    const cssProp = propCSSMap.get(propName);
    const contentEl = getContentRoot();
    if (contentEl) {
      const targetVpPrefixes: string[] = [];
      if (isReplica) {
        targetVpPrefixes.push(`${interactingVpId}-`);
      } else {
        for (const vp of viewportsConfig) {
          targetVpPrefixes.push(vp.isPrimary ? '' : `${vp.id}-`);
        }
      }

      // DFS from the selected instance, carrying the active forwarding
      // name. The stack entry is `{ id, activeName }`.
      const stack: Array<{ id: string; activeName: string }> = [
        { id: selectedId, activeName: propName },
      ];
      const visited = new Set<string>();
      while (stack.length > 0) {
        const { id, activeName } = stack.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);

        const node = nodes.get(id);
        if (!node) continue;

        if (node.styleVariables) {
          // A binding can surface under TWO markers for the same activeName: the
          // resolved cssProp (e.g. `border`) AND a CSS custom property (`--X`)
          // when it's an OVERLAY binding (`'--X': prop` inline + `::after {
          // border: var(--X) }`). Prefer the custom property — patching `--X`
          // updates the `::after` overlay (stays OVER children), whereas patching
          // the inline `border` paints a box border UNDER children during the
          // drag (only the commit's re-parse + afterCSS would correct it, which
          // is the "under while dragging, over on release" glitch).
          const boundKeys = Object.keys(node.styleVariables).filter(
            (k) => node.styleVariables![k] === activeName,
          );
          const customKey = boundKeys.find((k) => k.startsWith('--'));
          const patchKey = customKey ?? (cssProp && boundKeys.includes(cssProp) ? cssProp : null);
          if (patchKey) {
            for (const vpPrefix of targetVpPrefixes) {
              patchNodeStyles(contentEl, node.id, vpPrefix, { [patchKey]: value });
            }
          }
        }
        // PER-VARIANT conditional binding (`<cssProp>: variant === 'v' ? prop : '…'`): the binding
        // lives in `conditionalStyleVariables`, not `styleVariables`. The element on canvas shows the
        // variant the var applies to (a page instance is pinned to its `initialVariant`; on a master
        // the user is viewing that variant), so patch the resolved cssProp live. Prefer the `--X`
        // custom prop for overlay bindings (it drives the `::after`); skip the `border` mirror.
        if (node.conditionalStyleVariables) {
          const matchCps = Object.entries(node.conditionalStyleVariables)
            .filter(([, vm]) => Object.values(vm).includes(activeName))
            .map(([cp]) => cp);
          if (matchCps.length > 0) {
            const condPatchKey = matchCps.find((cp) => cp.startsWith('--'))
              ?? matchCps.find((cp) => cp === cssProp) ?? matchCps[0];
            for (const vpPrefix of targetVpPrefixes) {
              patchNodeStyles(contentEl, node.id, vpPrefix, { [condPatchKey]: value });
            }
          }
        }
        if (node.textVariable === activeName) {
          for (const vpPrefix of targetVpPrefixes) {
            const el = contentEl.querySelector(`[data-node-id="${vpPrefix}${node.id}"]`) as HTMLElement | null;
            if (el) el.textContent = value;
          }
        }

        // Nested CODE COMPONENT live update. By the time we POP this
        // node the chain walk has already re-aliased `activeName` to the
        // node's OWN prop name (e.g. the page var `accentColorVar` became the
        // code component control `accentColor` when we crossed `<FilmGrain
        // accentColor={accentColorVar}/>`). So for any component-instance node
        // (`componentFile` set) we re-render it in place with
        // `{ [activeName]: value }` — exactly what makes a DIRECTLY-selected
        // code component slider/color update smoothly. `renderCodeComponentDirect`
        // no-ops on non-code nodes (e.g. design-component instances aren't in
        // the code-component map), so this is safe.
        if (node.componentFile) {
          const codeComponentDef = propCodeComponentControlMap.get(propName);
          const codeComponentCoerced = codeComponentDef && (codeComponentDef.type === 'slider' || codeComponentDef.type === 'number')
            ? (/^-?\d+(\.\d+)?$/.test(value) ? parseFloat(value) : value)
            : codeComponentDef?.type === 'toggle'
              ? (value === 'true')
              : value;
          renderCodeComponentDirect(node.id, { [activeName]: codeComponentCoerced }, isReplica ? vpWidth : undefined,
            isComponentVariant && activeComponentVariant ? activeComponentVariant : undefined);
        }

        for (const childId of node.children) {
          const child = nodes.get(childId);
          if (!child) continue;
          // If the child is a nested-instance wrapper that re-aliases
          // the active name (e.g. forwards `poon2 → poon`), update the
          // chain entry for that subtree only.
          let childActive = activeName;
          if (child.attrPropRefs) {
            for (const [innerName, refName] of Object.entries(child.attrPropRefs)) {
              if (refName === activeName) {
                childActive = innerName;
                break;
              }
            }
          }
          stack.push({ id: childId, activeName: childActive });
        }
      }
    }

    // Direct render — instant visual feedback for code components / code components
    // (no-op for design components, which are covered above). For replica
    // edits, only update that viewport's instance.
    renderCodeComponentDirect(selectedId, { [propName]: coercedValue }, isReplica ? vpWidth : undefined,
      isComponentVariant && activeComponentVariant ? activeComponentVariant : undefined);
    trace.fn('component-props:preview', { nodeId: selectedId, propName, value });
  }, [selectedId, componentInfo, controlsMeta, isReplica, vpWidth, propCSSMap, propCodeComponentControlMap, propLinkAttrMap, nodes, viewportsConfig, interactingVpId, isComponentVariant, activeComponentVariant]);

  // ─── Persistence path (debounced) ─────────────────────────────────────────
  // Writing a prop into the source JSX is expensive: Babel parse + AST
  // mutation + generate + whole-project re-parse + autosave. A 60fps color /
  // slider drag fires the change every frame — committing per frame was THE
  // bottleneck. So `handlePropChange` previews instantly (cheap — see
  // `previewProp`) and DEFERS the file write; the debounce collapses a whole
  // drag into one commit when it settles. Pending commits are keyed by prop
  // so editing two props in quick succession can't drop one.
  const pendingCommitsRef = useRef(new Map<string, () => void>());
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushCommits = useCallback(() => {
    if (commitTimerRef.current) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    const pending = pendingCommitsRef.current;
    if (pending.size === 0) return;
    const thunks = [...pending.values()];
    pending.clear();
    for (const run of thunks) run();
  }, []);

  // Flush any pending commit before the selection changes (a deferred write
  // must land on the node it was made for) and on unmount.
  useEffect(() => () => flushCommits(), [selectedId, flushCommits]);

  const handlePropChange = useCallback((propName: string, value: string, defaultValue: string | null) => {
    if (!selectedId || !componentInfo) return;
    // Hold the chosen value on screen through the async commit/parse churn.
    setPropOptimistic(propName, value);

    const controlDef = controlsMeta?.controls?.[propName];
    // Booleans MUST be JSX expressions (`prop={false}`), never strings
    // (`prop="false"`) — the string "false" is truthy in JS, so a boolean link
    // variable (New Tab / Smooth Scroll) set to false would still read as true
    // at runtime (the smooth-scroll handler kept firing). Code component slider/number/
    // toggle controls already use expressions; the boolean link-attr variables
    // (`newTab`/`smooth`) need the same.
    const linkKindForExpr = propLinkAttrMap.get(propName);
    // Typed component variables whose runtime value is a JS literal, not a string: a Toggle prop must be
    // `prop={true}` (the string "false" is truthy), a Number prop `prop={16}`. Write them as expressions.
    const propVarType = componentInfo?.props?.find(p => p.name === propName)?.varType;
    const useExpression = (!!controlDef && (
      controlDef.type === 'slider' || controlDef.type === 'number' || controlDef.type === 'toggle'
    )) || propVarType === 'toggle' || propVarType === 'number'
      || linkKindForExpr === 'newTab' || linkKindForExpr === 'smooth' || linkKindForExpr === 'params';

    // A TRANSITION variable's value is a framer-motion OBJECT, not a string. The editor hands a JSON string
    // (`{"type":"spring",...}`), but the prop must be `transition={{ type: 'spring', duration: 0.5, … }}` — an
    // object EXPRESSION — or `<MotionConfig transition={transition}>` gets a STRING and framer-motion ignores it
    // (the reported "transition not applied between variants in preview"). Parse + format with the canonical
    // transition formatter and force expression mode.
    let writeValue = value;
    let writeUseExpr = useExpression;
    if (propVarType === 'transition') {
      writeUseExpr = true;
      let obj: Record<string, string> = {};
      const trimmed = (value ?? '').trim();
      if (trimmed && trimmed !== '{}') {
        try { obj = JSON.parse(trimmed); } catch { obj = {}; }
      }
      // "Instant" = duration 0. motion has NO `type: 'instant'` — it'd be ignored → a default ease/spring
      // (the reported "instant does a default ease"). Write `{ duration: 0 }`, mirroring the master control's
      // handleWrite isInstant. (The READ converts duration:0 back to type:'instant' so the editor still shows it.)
      if (obj.type === 'instant') obj = { duration: '0' };
      writeValue = formatTransitionObj(obj);
    }

    // Instant live preview — the canvas reflects the value at once.
    previewProp(propName, value);

    // Defer the expensive source write; coalesce a drag into one commit.
    pendingCommitsRef.current.set(propName, () => {
      // On a REPLICA viewport, a prop change is a PER-VIEWPORT override → write it
      // into `data-responsive` (withResponsiveProps merges the matching breakpoint
      // at runtime). This must fire for DESIGN-component @propMeta variables too —
      // not only Code component @controls. The old `&& controlsMeta` gate (controlsMeta is
      // null for design components) routed design props to the BASE attribute, so
      // setting e.g. `direction` on mobile overwrote EVERY viewport. setResponsiveOverride
      // self-coerces the value (number/bool/string), so no controlsMeta is needed.
      if (isReplica) {
        modifyProjectFile(activeFile, (currentCode) => {
          // Clear the override only when it equals the value THIS viewport would
          // inherit without one — i.e. the BASE (primary) attribute value, NOT the
          // component default. Otherwise setting a prop to its component default on
          // a replica (e.g. direction→'row') deletes the override and the viewport
          // snaps back to the base (e.g. 'column') — the "reverses my entry" bug.
          const baseVal = parseInstanceProps(currentCode, selectedId, componentInfo.name).get(propName) ?? defaultValue;
          return setResponsiveOverride(currentCode, selectedId, componentInfo.name, vpWidth, propName, value, baseVal);
        });
      } else if (isComponentVariant && activeComponentVariant) {
        // COMPONENT FILE, NON-DEFAULT PARENT VARIANT: the write must apply to
        // THIS parent variant only — as a `initialVariant === 'X' ? … : base`
        // ternary — exactly like the variant-select routing above. The old
        // path wrote the shared base prop, so editing a code-component prop
        // (e.g. Fill Color) on the Hover tile overrode the primary and every
        // other variant (user report 2026-07-31). Seed the default branch
        // from the current base (or the control default) so the base look is
        // preserved on first override.
        modifyProjectFile(activeFile, (currentCode) => {
          const baseSeed = parseInstanceProps(currentCode, selectedId, componentInfo.name).get(propName)
            ?? (defaultValue ?? '');
          return setConditionalInstanceProp(
            currentCode, selectedId, componentInfo.name,
            propName, activeComponentVariant, writeValue, baseSeed,
          );
        });
      } else if (isComponentFilePath(activeFile)) {
        // COMPONENT FILE, DEFAULT variant: write the DEFAULT branch through
        // the conditional writer so existing per-variant branches SURVIVE —
        // plain setInstanceProp would replace the whole ternary and wipe them.
        modifyProjectFile(activeFile, (currentCode) => {
          return setConditionalInstanceProp(
            currentCode, selectedId, componentInfo.name,
            propName, 'default', writeValue,
          );
        });
      } else {
        modifyProjectFile(activeFile, (currentCode) => {
          // PER-VIEWPORT VARIABLE branches live in an inline `prop={(__mq ? var : base)}` ternary (NOT in
          // data-responsive, which holds per-viewport LITERALS and already survives removeInstanceProp). So
          // changing/removing the PRIMARY must write ONLY the base (else-branch) — wiping the whole prop would
          // delete the replicas' individual variable bindings. Same rule as the link tool: remove from primary
          // updates only the SYNCED viewports; individual per-tile branches stay INTACT.
          if (getInstancePropBaseValue(currentCode, selectedId, componentInfo.name, propName)) {
            const newBaseExpr = writeUseExpr && writeValue !== '' ? String(writeValue) : JSON.stringify(writeValue);
            return setInstancePropBaseInCode(currentCode, selectedId, componentInfo.name, propName, newBaseExpr);
          }
          if (value === (defaultValue ?? '') || value === '') {
            return removeInstanceProp(currentCode, selectedId, componentInfo.name, propName);
          } else {
            return setInstanceProp(currentCode, selectedId, componentInfo.name, propName, writeValue, writeUseExpr);
          }
        });
      }
      // Re-sync UI atoms.
      const newCode = projectFS.readFile(activeFile);
      if (newCode) {
        setCode(newCode);
        setVersion(v => v + 1);
      }
      // Clear the in-flight preview so currentValue (now reflecting the
      // freshly written source) drives the controls again.
      setPreviewValues((p) => {
        if (!(propName in p)) return p;
        const { [propName]: _, ...rest } = p;
        return rest;
      });
      trace.action('component-props:update', { nodeId: selectedId, propName, value, useExpression, isReplica, vpWidth: isReplica ? vpWidth : undefined });
    });
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(flushCommits, 140);
  }, [selectedId, activeFile, componentInfo, controlsMeta, isReplica, vpWidth, propLinkAttrMap, setCode, setVersion, previewProp, flushCommits]);

  // Write a prop value as a RAW JSX EXPRESSION (`prop={expr}`), not a string
  // literal. Used by the link control's Slug binding to set the per-row CMS
  // detail link (`linkHref={`/coll/${item._slug}`}`) — a template that must
  // stay an expression. One-shot (no preview/commit deferral); viewport-agnostic
  // so it writes the base attr, not a data-responsive override.
  const handleSetLinkExpr = useCallback((propName: string, expr: string) => {
    if (!selectedId || !componentInfo) return;
    trace.action('component-props:set-link-expr', { nodeId: selectedId, propName, expr });
    modifyProjectFile(activeFile, (code) => setInstanceProp(code, selectedId, componentInfo.name, propName, expr, true));
    const newCode = projectFS.readFile(activeFile);
    if (newCode) { setCode(newCode); setVersion(v => v + 1); }
  }, [selectedId, activeFile, componentInfo, setCode, setVersion]);

  // A SCROLL VARIANT caches the per-viewport resting variant in its OWN spec
  // (`responsive[scope].from`), which migratePerViewportResting derives FROM
  // `data-responsive`. The generated page code — useState(...), the scroll revert
  // default, the useEffect resync — reads the SPEC, not data-responsive. So every
  // write that changes an instance's per-viewport `initialVariant` must reseed it,
  // or the canvas tile shows the new variant while the PUBLISHED page still rests
  // at the old one (live case: a nav whose tablet resting stayed on the scrolled
  // black variant, so the header was black from load instead of only after its
  // trigger section — 2026-08-01).
  //
  // Call this LAST in the modifyProjectFile callback: it re-reads the UPDATED
  // data-responsive. Reseeding before the write reseeds from stale data.
  const resyncScrollResting = useCallback((code: string): string => (
    selectedId && getScrollVariant(code, selectedId) ? rehydrateScrollVariant(code, selectedId) : code
  ), [selectedId]);

  // Reset a single responsive override for a prop (removes from data-responsive)
  const handleResetOverride = useCallback((propName: string) => {
    if (!selectedId || !componentInfo) return;
    trace.action('component-props:reset-override', { nodeId: selectedId, propName, vpWidth });
    modifyProjectFile(activeFile, (currentCode) => {
      return resyncScrollResting(
        setResponsiveOverride(currentCode, selectedId, componentInfo.name, vpWidth, propName, '', null));
    });
    const newCode = projectFS.readFile(activeFile);
    if (newCode) { setCode(newCode); setVersion(v => v + 1); }
  }, [selectedId, activeFile, componentInfo, vpWidth, resyncScrollResting, setCode, setVersion]);

  // X on a per-viewport VARIABLE pill (replica): drop the `__mqN` branch for this band → revert the
  // tile to the base binding. `getActiveAnimationScope()` gives the current replica's banded query.
  const handleResetAttrVar = useCallback((propName: string) => {
    if (!selectedId || !componentInfo) return;
    const scope = getActiveAnimationScope();
    if (!scope || !('query' in scope)) return;
    trace.action('component-props:reset-attr-var', { nodeId: selectedId, propName, query: scope.query });
    modifyProjectFile(activeFile, (currentCode) =>
      resetResponsiveInstancePropVarInCode(currentCode, selectedId, componentInfo.name, scope.query, propName));
    const newCode = projectFS.readFile(activeFile);
    if (newCode) { setCode(newCode); setVersion(v => v + 1); }
  }, [selectedId, activeFile, componentInfo, setCode, setVersion]);

  // ─── CMS COMPONENT (Mechanism A) ───────────────────────────────────────────
  // When this component INSTANCE sits inside a collection list, each prop can be
  // connected to a CMS field of the MATCHING TYPE (text prop → text/richtext fields,
  // image → image, link → link, …). `useControl().cmsBinding` resolves the collection
  // (slug / itemVar / fields) by walking ancestors for a `collectionList`; it's null
  // when the instance isn't inside a list, so the affordance simply doesn't appear.
  const { cmsBinding } = useControl();
  // Bind a component prop to a CMS field → `propName={item.field}` (per item) via the
  // existing map codegen. `varName` is the collection's array var (== the slug, the
  // imported `@/cms/<slug>.json` name); `itemVar` is the `.map()` iterator.
  // `urlWrap` = whole-value IMAGE prop (default starts with `url(` — the master binds
  // it bare, e.g. `backgroundImage: coverImage`): the CMS field holds a PLAIN url, so
  // the binding wraps at the instance → `propName={`url(${item.field})`}`.
  const bindPropToCmsField = useCallback((propName: string, fieldId: string, currentValue: string, urlWrap = false) => {
    if (!selectedId || !cmsBinding || !componentInfo) return;
    trace.action('ComponentPropsTool:cms-bind-prop', { nodeId: selectedId, propName, fieldId, urlWrap, isReplica, vpWidth: isReplica ? vpWidth : undefined });
    // Panel-originated: the pill has to appear the moment it's clicked, not
    // after the mirror's canvas-paint budget (trace 2026-08-08 — the bind
    // parsed in 5ms, the panel showed it 466ms later).
    expediteStableAtomSync();
    if (isReplica) {
      // Per-viewport REBIND → a computed `data-responsive` override carrying the
      // live `item.field` ref; withResponsiveProps merges it for this breakpoint.
      // The base binding (other viewports) is untouched. The override model stores
      // non-literal exprs as raw source, so the wrapped template round-trips.
      const expr = urlWrap ? `\`url(\${${cmsBinding.itemVar}.${fieldId}})\`` : `${cmsBinding.itemVar}.${fieldId}`;
      modifyProjectFile(activeFile, (currentCode) =>
        setResponsiveBindingOverride(currentCode, selectedId, componentInfo.name, vpWidth, propName, { kind: 'field', expr }));
      const newCode = projectFS.readFile(activeFile);
      if (newCode) { setCode(newCode); setVersion(v => v + 1); }
      return;
    }
    queueMutation({ type: 'bindPropToMap', nodeId: selectedId, varName: cmsBinding.slug, propName, fieldName: fieldId, currentValue, urlWrap });
    flushNow();
  }, [selectedId, cmsBinding, componentInfo, isReplica, vpWidth, activeFile, setCode, setVersion]);

  // Per-viewport UNBIND → inject the component default on THIS viewport only
  // (a literal override), leaving the base binding intact elsewhere.
  const unbindPropForViewport = useCallback((propName: string, defaultValue: string) => {
    if (!selectedId || !componentInfo) return;
    trace.action('ComponentPropsTool:cms-unbind-prop-viewport', { nodeId: selectedId, propName, vpWidth });
    expediteStableAtomSync();
    modifyProjectFile(activeFile, (currentCode) =>
      setResponsiveBindingOverride(currentCode, selectedId, componentInfo.name, vpWidth, propName, { kind: 'literal', value: defaultValue }));
    const newCode = projectFS.readFile(activeFile);
    if (newCode) { setCode(newCode); setVersion(v => v + 1); }
  }, [selectedId, componentInfo, vpWidth, activeFile, setCode, setVersion]);

  const componentControls = controlsMeta?.controls ?? null;
  const hasComponentControls = componentControls && Object.keys(componentControls).length > 0;

  trace.fn('ComponentPropsTool:render', {
    selectedId,
    componentFile,
    componentName: componentInfo?.name ?? null,
    propCount: componentInfo?.props.length ?? 0,
    props: componentInfo?.props.map(p => p.name) ?? [],
    hasCodeComponent: !!hasComponentControls,
    componentControlCount: hasComponentControls ? Object.keys(componentControls).length : 0,
  });

  if (!componentFile || !componentInfo) return null;
  // Vectors render under IconSetTool —
  // see the `isCdnContainerSet` comment up top. Returning null here
  // keeps the right panel from double-displaying a generic Component
  // card next to the proper kind-specific picker.
  if (isCdnContainerSet) return null;

  const componentLabel = displayName || componentInfo.name;
  const hasVariants = variantConfig.length > 1;
  // REAL variants only — interaction states (hover/pressed) are applied on interaction, never chosen
  // as a base variant (design-tool parity). The variant-EDITING UI keeps using the full `variantConfig`.
  const variantOptions = selectableVariants(variantConfig).map(v => ({ value: v.name, label: v.label }));

  // Handle variant change — writes initialVariant on the instance.
  // On primary viewport: writes as direct prop (applies to all viewports without overrides).
  // On replica viewport: writes to data-responsive for just that viewport's breakpoint.
  // On component-file non-default variant: writes a JSX ternary so the choice
  // applies only to that parent variant (per-parent-variant child variant).
  const handleVariantSelect = (variantName: string) => {
    if (!selectedId || !componentInfo) return;
    trace.action('component-tool:variant-change', {
      nodeId: selectedId, variant: variantName,
      isReplica, vpWidth, isComponentVariant, activeComponentVariant,
    });

    // Scroll-variant instance (primary/page): `initialVariant` is bound to runtime state
    // (`{…Sv}`), so writing it as a literal would CLOBBER the scroll binding. The chosen variant
    // is the RESTING state — update BOTH the spec's `from` (the live initial via `useState(from)`
    // + the scroll revert target) AND `canvasVariant` (the static-canvas display). Keeping them
    // in sync means the published page LOADS at the picked variant and the canvas matches. (Replica
    // per-tile picks still flow through data-responsive below; this is the base/primary display.)
    if (!isReplica && !(isComponentVariant && activeComponentVariant)) {
      const sv = getScrollVariant(code, selectedId);
      if (sv) {
        queueMutation({ type: 'updateScrollVariant', nodeId: selectedId, spec: { ...sv, from: variantName, canvasVariant: variantName } });
        return;
      }
    }

    if (isReplica) {
      // Replica viewport: write to data-responsive for this breakpoint only.
      // Clear the override ONLY when the pick equals what this tile would
      // inherit WITHOUT one — the instance's BASE initialVariant prop, NOT
      // the machine's primary. With initialVariant="open" inline, picking
      // 'default' (Closed) must WRITE {"<w>":{"initialVariant":"default"}};
      // the old hardcoded 'default' base treated that pick as "no override
      // needed", cleared it, and the tile snapped back to Open (the
      // "can't close FAQ item 1 on mobile" bug). Same rule as the generic
      // prop path above.
      modifyProjectFile(activeFile, (currentCode) => {
        const rawBase = parseInstanceProps(currentCode, selectedId, componentInfo.name).get('initialVariant');
        const baseVal = rawBase && variantConfig.some((vc) => vc.name === rawBase) ? rawBase : 'default';
        const next = setResponsiveOverride(currentCode, selectedId, componentInfo.name, vpWidth, 'initialVariant', variantName, baseVal);
        // A SCROLL VARIANT keeps its OWN copy of the per-viewport resting variant
        // (spec.responsive[scope].from), which migratePerViewportResting seeds FROM
        // data-responsive. We just changed data-responsive, so that copy is now stale
        // — and the generated `useState`/revert expressions read the SPEC, not
        // data-responsive. Rehydrate to reseed it (the migration drops from-only
        // entries and re-derives them), otherwise the canvas tile shows the new
        // variant while the published page still RESTS at the old one — e.g. a nav
        // whose tablet resting stayed on the scrolled black variant, so the header
        // was black from load instead of only after the trigger section. The primary
        // path above already syncs via updateScrollVariant; this is the replica half.
        return resyncScrollResting(next);
      });
    } else if (isComponentVariant && activeComponentVariant) {
      // Component file, non-default parent variant: write per-parent-variant
      // override as a JSX ternary so each parent variant picks its own child
      // variant independently.
      modifyProjectFile(activeFile, (currentCode) => {
        return setConditionalInstanceProp(
          currentCode, selectedId, componentInfo.name,
          'initialVariant', activeComponentVariant, variantName,
        );
      });
    } else if (variantName === 'default') {
      // Primary viewport (page) OR default variant in component file:
      // overwrite the default branch. If there are existing per-variant
      // overrides, KEEP them — only the default branch changes.
      modifyProjectFile(activeFile, (currentCode) => {
        return setConditionalInstanceProp(
          currentCode, selectedId, componentInfo.name,
          'initialVariant', 'default', variantName,
        );
      });
    } else {
      // Primary viewport (page): write as direct prop. Page files never use
      // component-variant ternary form because the parent isn't a variant
      // host; for page contexts the per-viewport mechanism is data-responsive.
      modifyProjectFile(activeFile, (currentCode) => {
        return setInstanceProp(currentCode, selectedId, componentInfo.name, 'initialVariant', variantName, false);
      });
    }

    // Ensure the component file has animate/initial props on the root element with variants.
    // Skip if connections exist (animate={variant} from useState) — don't overwrite.
    // Skip for CDN-linked components — the bundled source already has the
    // right variant wiring and we can't write to a remote file anyway.
    if (componentFile && !isCdnLinked) {
      const compCode = projectFS.readFile(componentFile);
      if (compCode && compCode.includes('variants={') && !compCode.includes('animate={variant}') && !compCode.includes("animate={['default', variant]}") && !compCode.includes('initial={initialVariant}') && !compCode.includes("initial={['default', initialVariant]}")) {
        modifyProjectFile(componentFile, (code) => {
          // Only add to the FIRST element with variants (root) — children inherit via propagation
          let added = false;
          return code.replace(/(variants=\{\w+\})/, (match) => {
            if (added) return match;
            added = true;
            return `${match} initial={['default', initialVariant]} animate={['default', initialVariant]}`;
          });
        });
      }
    }

    const newCode = projectFS.readFile(activeFile);
    if (newCode) { setCode(newCode); setVersion(v => v + 1); }
  };

  // ─── Component header (always rendered) ──────────────────────────────────

  const componentHeader = (
    // px-2 + pl-3 on the body matches ToolSection's natural padding so the
    // labels in the code component / regular prop lists below sit flush with Styles /
    // Layout / Position labels (ControlLabel's `pl-[18px] -ml-[18px]` trick
    // anchors text at the section's content edge — only ToolSection-aligned
    // siblings will line up with it).
    <div className="px-2">
      {/* Component name + icon */}
      <div className="flex items-center justify-between py-2 mb-1">
        <span className="text-xs font-bold" style={{ color: 'var(--accent-secondary, #a855f7)' }}>
          {componentLabel}
        </span>
        <span style={{ color: 'var(--accent-secondary, #a855f7)' }}>
          {hasComponentControls ? (
            <svg width="14" height="14" viewBox="0 0 24 24"><g fill="none"><path d="M0 0h24v24H0z" /><path fill="currentColor" d="M14.62 2.662a1.5 1.5 0 0 1 1.04 1.85l-4.431 15.787a1.5 1.5 0 0 1-2.889-.81L12.771 3.7a1.5 1.5 0 0 1 1.85-1.039ZM7.56 6.697a1.5 1.5 0 0 1 0 2.12L4.38 12l3.182 3.182a1.5 1.5 0 1 1-2.122 2.121L1.197 13.06a1.5 1.5 0 0 1 0-2.12l4.242-4.243a1.5 1.5 0 0 1 2.122 0Zm8.88 2.12a1.5 1.5 0 1 1 2.12-2.12l4.243 4.242a1.5 1.5 0 0 1 0 2.121l-4.242 4.243a1.5 1.5 0 1 1-2.122-2.121L19.621 12z" /></g></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M12.53 2.47a.75.75 0 0 0-1.06 0L8.32 5.62a.75.75 0 0 0 0 1.06l3.15 3.15a.75.75 0 0 0 1.06 0l3.15-3.15a.75.75 0 0 0 0-1.06zm5.85 6.3a.75.75 0 0 0-1.06 0l-3.15 3.15a.75.75 0 0 0 0 1.06l3.15 3.15a.75.75 0 0 0 1.06 0l3.15-3.15a.75.75 0 0 0 0-1.06zm-5.85 5.4a.75.75 0 0 0-1.06 0l-3.15 3.15a.75.75 0 0 0 0 1.06l3.15 3.15a.75.75 0 0 0 1.06 0l3.15-3.15a.75.75 0 0 0 0-1.06zM6.68 8.32a.75.75 0 0 0-1.06 0l-3.15 3.15a.75.75 0 0 0 0 1.06l3.15 3.15a.75.75 0 0 0 1.06 0l3.15-3.15a.75.75 0 0 0 0-1.06z" /></svg>
          )}
        </span>
      </div>

      {/* Edit button — full width, secondary style */}
      <div className="mb-2.5">
        <Button variant="secondary" size="sm" className="w-full" onClick={handleEditComponent}>
          {hasComponentControls ? 'Edit Code' : 'Edit Component'}
        </Button>
      </div>

      <div className="flex flex-col gap-2 pl-3">

        {/* Variant selector (only when component has multiple variants).
            Uses the same `ControlLabel + direct flex child` pattern as the
            prop rows below (FillControl, BorderControl, etc.) so the label
            gutter and value column line up pixel-for-pixel. ToolRow's
            extra `<div w-full>` value wrapper made the variant select
            visibly narrower than the sibling Background / Border value
            buttons — visible as a ragged right edge in the panel. */}
        {hasVariants && (() => {
          // Variant row is a normal instance prop — it just happens to drive
          // initialVariant (the parser-special prop that selects which
          // motion-variant is active). We give it the same chevron menu
          // affordances as every other prop row:
          //   - Inside a component master with a nested instance selected
          //     → wrap with `HoistMenuItemProvider` so the chevron menu
          //     shows "Hoist Variable" (the rich-atom rows do the same).
          //   - Detect bound state by checking whether `currentVariant`
          //     (parsed JSX value) matches a parent-master variable name
          //     in `parentVarsByName`. After a hoist the JSX is
          //     `<Child initialVariant={varName}/>` and `currentVariant`
          //     resolves to the identifier string `'varName'`.
          //   - On bound: render the same purple `T varName ×` pill the
          //     other instance-prop rows use. Click × restores the parent
          //     variable's default value via `handleVariantSelect`.
          const hoistMenuItem = isInComponentMaster && componentName && selectedId ? {
            label: 'Hoist Variable',
            onClick: () => instantHoist({
              propName: 'initialVariant',
              // Seed the new variable's default with the variant VISIBLE here — resolving a base that's
              // itself a variable (`initialVariant={seJoReVariant}`) to that variable's VALUE, never its NAME
              // (else the new var defaults to a non-existent "seJoReVariant" variant).
              currentLiteral: parentVarsByName.has(currentVariant)
                ? (parentVarsByName.get(currentVariant) ?? 'default').replace(/^["'](.*)["']$/s, '$1')
                : currentVariant,
              inferredType: 'text' as PageVariableType,
              cssProp: undefined,
            }),
            show: true,
            hoverColor: 'accent-secondary' as const,
          } : null;
          // Scroll-variant RESTING binding. When this instance has a scroll variant whose
          // resting/start is bound to a parent variable (`spec.fromVar`), THAT is the
          // variant-variable binding — the instance keeps `initialVariant={…Sv}` for the
          // scroll machine (so `currentVariant` resolves to the canvas variant, not the
          // variable). Show the same purple pill as a direct binding; remove by clearing
          // `fromVar` (the scroll effect + its binding stay).
          // Read the spec on EVERY viewport (not just primary) so the binding CASCADES:
          // the active viewport's resting variable is `responsive[scope].fromVar` (a replica's
          // own override) ?? the base `spec.fromVar` (Desktop, which cascades to all tiles).
          // `activeScope` = the current viewport's banded `{query}` (null on the primary) —
          // the SAME scope every per-viewport prop override uses.
          const svRowSpec = selectedId && code && !(isComponentVariant && activeComponentVariant)
            ? getScrollVariant(code, selectedId) : null;
          const activeScope = getActiveAnimationScope();
          const activeQuery = activeScope && 'query' in activeScope ? activeScope.query : null;
          // This viewport's responsive entry. A `fromVar` KEY present (even '') is an EXPLICIT
          // per-viewport binding: a name → that variable (pill); '' → explicitly NO variable on
          // this tile (cascade BROKEN → dropdown). No `fromVar` key → the base `fromVar` cascades.
          const scopedEntry = activeQuery && svRowSpec
            ? (svRowSpec.responsive ?? []).find((r) => 'query' in r.scope && r.scope.query === activeQuery)
            : null;
          const scopedFromVar = (scopedEntry && 'fromVar' in scopedEntry)
            ? (scopedEntry.fromVar || null)     // '' → null (cascade broken, no variable)
            : (svRowSpec?.fromVar ?? null);      // not set → cascade the base variable
          const fromVarBoundRef = scopedFromVar && parentVarsByName.has(scopedFromVar) ? scopedFromVar : null;
          // A NON-scroll instance hoisted on a replica binds the variant per-viewport via an inline
          // `initialVariant={__mqN ? var : base}` ternary (the same rail as other props). On the replica
          // that variable WINS the row (override pill); the base (Desktop) keeps its own binding.
          const vpVariantVar = isReplica ? responsiveAttrVars.get('initialVariant') : undefined;
          const vpVariantBoundRef = (vpVariantVar && parentVarsByName.has(vpVariantVar)) ? vpVariantVar : null;
          // A nested instance whose variant was hoisted on a NON-DEFAULT parent VARIANT binds it per-parent-
          // variant via `initialVariant={variant === 'v6' ? var : base}`. On THAT variant the variable WINS
          // the row (purple override pill); every OTHER parent variant keeps its literal. The per-variant twin
          // of vpVariantBoundRef (per-viewport). Without this, the bound row read null → no pill.
          const cvVariantBranch = (isComponentVariant && activeComponentVariant && selectedId && code && componentName)
            ? getConditionalInstancePropBranch(code, selectedId, componentName, 'initialVariant', activeComponentVariant)
            : null;
          const cvVariantBoundRef = (cvVariantBranch?.isVar && parentVarsByName.has(cvVariantBranch.value)) ? cvVariantBranch.value : null;
          const variantBoundRef = vpVariantBoundRef ?? cvVariantBoundRef ?? fromVarBoundRef ?? (parentVarsByName.has(currentVariant) ? currentVariant : null);
          const removeVariantVar = () => {
            if (!selectedId || !componentInfo) return;
            // X on a per-PARENT-VARIANT variable → drop the variable branch, leaving this variant a plain
            // LITERAL (the variable's resolved variant). Every OTHER parent variant + the base are untouched.
            if (cvVariantBoundRef && isComponentVariant && activeComponentVariant) {
              modifyProjectFile(activeFile, (c) => {
                const raw = (parentVarsByName.get(cvVariantBoundRef) ?? '').replace(/^["'](.*)["']$/s, '$1');
                const literal = variantConfig.some((v) => v.name === raw)
                  ? raw : (variantConfig.find((v) => v.isPrimary)?.name ?? variantConfig[0]?.name ?? 'default');
                return setConditionalInstanceProp(c, selectedId, componentInfo.name, 'initialVariant', activeComponentVariant, literal);
              });
              const nc = projectFS.readFile(activeFile);
              if (nc) { setCode(nc); setVersion((v) => v + 1); }
              return;
            }
            // X on a per-viewport variant VARIABLE → unbind it on THIS tile and leave a per-viewport
            // LITERAL (the variable's last value, sanitised to a real variant) so the tablet shows a plain
            // SELECT, NOT the base's variable inherited (the reference: unbind = revert to the resolved literal,
            // not re-couple to the base binding). `defaultVal` null → always writes a literal. The base
            // (Desktop) binding is never touched; Reset Override (on the label) is the separate "revert
            // this tile to the base cascade" path.
            if (vpVariantBoundRef && isReplica && activeQuery) {
              modifyProjectFile(activeFile, (currentCode) => {
                let c = resetResponsiveInstancePropVarInCode(currentCode, selectedId, componentInfo.name, activeQuery, 'initialVariant');
                const raw = parentVarsByName.get(vpVariantBoundRef) ?? '';
                const literal = variantConfig.some((v) => v.name === raw)
                  ? raw : (variantConfig.find((v) => v.isPrimary)?.name ?? variantConfig[0]?.name ?? 'default');
                c = setResponsiveOverride(c, selectedId, componentInfo.name, vpWidth, 'initialVariant', literal, null);
                return resyncScrollResting(c);
              });
              const nc = projectFS.readFile(activeFile);
              if (nc) { setCode(nc); setVersion((v) => v + 1); }
              return;
            }
            if (vpVariantBoundRef && isReplica) { handleResetAttrVar('initialVariant'); return; }
            // ON A REPLICA: break the cascade for THIS tile ONLY — the base (Desktop) binding is
            // NEVER touched. Mark the tile "no variable" via `responsive[scope].fromVar = ''` (so
            // both the runtime resting and the read drop the cascaded variable), and reflect a
            // REAL resting variant into data-responsive for the canvas — NEVER the scroll
            // state-machine identifier. The tile then shows the dropdown (no pill) + Reset Override.
            if (isReplica && activeQuery) {
              modifyProjectFile(activeFile, (currentCode) => {
                let c = currentCode;
                const spec = getScrollVariant(c, selectedId);
                let restingLiteral = variantConfig.find((v) => v.isPrimary)?.name ?? variantConfig[0]?.name ?? 'default';
                if (spec) {
                  const responsive = [...(spec.responsive ?? [])];
                  const idx = responsive.findIndex((r) => 'query' in r.scope && r.scope.query === activeQuery);
                  if (idx >= 0) responsive[idx] = { ...responsive[idx], fromVar: '' };
                  else responsive.push({ scope: { query: activeQuery }, fromVar: '' });
                  c = setScrollVariantInCode(c, selectedId, { ...spec, responsive });
                  // The resting this tile falls to (per-scope `from` ?? base `from`), sanitised to
                  // a REAL variant so the scroll state-machine id never leaks into data-responsive.
                  const cand = (idx >= 0 ? (responsive[idx] as { from?: string }).from : undefined) ?? spec.from;
                  if (cand && variantConfig.some((v) => v.name === cand)) restingLiteral = cand;
                }
                // Reflect the resting into data-responsive (canvas); defaultValue null so it always
                // writes a literal and never clears back to the cascaded base.
                c = setResponsiveOverride(c, selectedId, componentInfo.name, vpWidth, 'initialVariant', restingLiteral, null);
                return resyncScrollResting(c);
              });
              const newCode = projectFS.readFile(activeFile);
              if (newCode) { setCode(newCode); setVersion((v) => v + 1); }
              return;
            }
            // ON THE PRIMARY: remove the base binding entirely.
            if (fromVarBoundRef && svRowSpec) {
              const { fromVar: _drop, ...rest } = svRowSpec;
              queueMutation({ type: 'updateScrollVariant', nodeId: selectedId, spec: rest });
              return;
            }
            const fallback = parentVarsByName.get(currentVariant) ?? variantOptions[0]?.value ?? 'default';
            handleVariantSelect(fallback);
          };
          // "Set Variable" — bind an EXISTING variant variable to the Variant (vs "Hoist
          // Variable" which creates a new one). Candidates = the variant variables this
          // instance already uses (base `fromVar` + any per-viewport `responsive[scope].fromVar`).
          // Picking one binds it for the ACTIVE viewport (replica → responsive[scope].fromVar,
          // primary → base) — the same wiring the hoist uses, just with an existing variable.
          const bindVariantVariable = (varName: string) => {
            if (!selectedId || !componentInfo) return;
            const spec = getScrollVariant(code, selectedId);
            if (spec) {
              // SCROLL-variant instance → the resting variable is `fromVar` (base or per-viewport).
              if (isReplica && activeQuery) {
                const responsive = [...(spec.responsive ?? [])];
                const idx = responsive.findIndex((r) => 'query' in r.scope && r.scope.query === activeQuery);
                if (idx >= 0) responsive[idx] = { ...responsive[idx], fromVar: varName };
                else responsive.push({ scope: { query: activeQuery }, fromVar: varName });
                queueMutation({ type: 'updateScrollVariant', nodeId: selectedId, spec: { ...spec, responsive } });
              } else {
                queueMutation({ type: 'updateScrollVariant', nodeId: selectedId, spec: { ...spec, fromVar: varName } });
              }
              return;
            }
            // PLAIN variant instance → bind `initialVariant={varName}` as an EXPRESSION (a variable
            // binding), NOT a literal variant value — the SAME wiring the hoist uses, just re-using an
            // EXISTING variable. SCOPE it like the hoist: a page REPLICA → per-viewport inline-ternary rail;
            // a non-default COMPONENT-MASTER VARIANT → per-parent-variant ternary (`variant === 'v' ? var :
            // base`), so the binding lands ONLY on this variant, not every counterpart; else the base prop.
            modifyProjectFile(activeFile, (c) =>
              (isReplica && activeQuery)
                ? setResponsiveInstancePropVarInCode(c, selectedId, componentInfo.name, activeQuery, 'initialVariant', varName)
                : (isComponentVariant && activeComponentVariant)
                  ? setConditionalInstancePropVarInCode(c, selectedId, componentInfo.name, 'initialVariant', activeComponentVariant, varName, currentVariant)
                  : setInstanceProp(c, selectedId, componentInfo.name, 'initialVariant', varName, true));
            const nc = projectFS.readFile(activeFile);
            if (nc) { setCode(nc); setVersion((v) => v + 1); }
          };
          // Candidates = variant variables this instance can bind: the scroll-variant `fromVar`s PLUS
          // variables PERSISTED as this component's variant (@propMeta.variantOf === componentName) — the
          // latter is what lets an UNBOUND variant var (X'd off) still be re-offered here (design-tool parity:
          // the variable stays tied to its component). Exclude whatever's already bound on this row.
          const variantPropMeta = componentName ? parsePropMeta(code) : {};
          const variantOfCandidates = componentName
            ? parentVars.filter((v) => variantPropMeta[v.name]?.variantOf === componentName).map((v) => v.name)
            : [];
          const variantVarCandidates = Array.from(new Set([
            ...(svRowSpec?.fromVar ? [svRowSpec.fromVar] : []),
            ...((svRowSpec?.responsive ?? []).map((r) => r.fromVar).filter((v): v is string => !!v)),
            ...variantOfCandidates,
          ])).filter((v) => parentVarsByName.has(v) && v !== variantBoundRef);
          const setVariantItem: MenuItem | null = (variantVarCandidates.length > 0) ? {
            label: 'Set Variable',
            show: true,
            hoverColor: 'accent-secondary' as const,
            onClick: () => { /* parent is a no-op; the submenu opens on hover */ },
            submenuItems: variantVarCandidates.map((v) => ({
              label: variantPropMeta[v]?.label || v,
              show: true,
              hoverColor: 'accent-secondary' as const,
              onClick: () => bindVariantVariable(v),
            })),
          } : null;
          const variantMenuItems = [setVariantItem, hoistMenuItem].filter(Boolean) as MenuItem[];
          // Per-viewport variant override → PURPLE label. For a scroll-variant the binding is
          // "overridden" on a replica ONLY when THIS tile's binding actually differs from the
          // cascaded base — the active scope has its OWN `fromVar` (a different variable, or the
          // '' removed-sentinel). The scroll effect's own per-viewport `from`/`to` config + the
          // auto `data-responsive` reflection are NOT variant overrides, so a tile that merely
          // INHERITS the base variable stays un-accented ("tied"). Non-scroll instances keep the
          // plain data-responsive-literal check.
          // THIS TILE'S RESTING VARIANT vs the base's — the plain "tablet shows Mobile,
          // desktop shows Nav" case. For a scroll instance `data-responsive` cannot answer
          // it: the spec auto-reflects into it (migratePerViewportResting), so an entry
          // there proves nothing about who chose it — which is why the literal check below
          // is skipped for these. The SPEC can answer, and it is the source the generated
          // page actually reads.
          //
          // NOTE the two different keys for one tile: the resting is stored under the
          // CAPPED `(max-width: Wpx)` query (migratePerViewportResting's key), while
          // `activeQuery` / a per-tile to+direction use the BANDED
          // `(max-width: Wpx) and (min-width: …)` form. Looking the resting up with
          // activeQuery finds the wrong entry (or none) — that mismatch is why this tile
          // read as un-overridden while visibly showing a different variant.
          const svRestingEntry = (svRowSpec && vpWidth != null)
            ? (svRowSpec.responsive ?? []).find((r) => 'query' in r.scope && r.scope.query === `(max-width: ${vpWidth}px)`)
            : undefined;
          const svRestingFrom = (svRestingEntry as { from?: string } | undefined)?.from;
          const svRestingDiffers = typeof svRestingFrom === 'string'
            && svRestingFrom !== (svRowSpec?.from ?? 'default');
          const variantOverridden = cvVariantBranch != null || (isReplica && (
            // A per-viewport variant VARIABLE on this tile (inline `initialVariant={__mqN ? var : base}`)
            // IS an override — it differs from the base binding — so the label goes PURPLE + Reset Override,
            // same as a per-viewport literal. (Without this it stayed un-accented because the rail isn't
            // data-responsive.)
            vpVariantBoundRef != null
            || (svRowSpec
              ? ((scopedEntry != null && 'fromVar' in scopedEntry && scopedEntry.fromVar !== (svRowSpec.fromVar ?? ''))
                || svRestingDiffers)
              // data-responsive literal OR an inline-ternary per-viewport LITERAL (`__mq2 ? 'variant-3' :
              // 'default'`) — both are per-viewport overrides → PURPLE label + Reset Override. The inline form
              // (its value in responsiveAttrPropValues) appears after a per-viewport variant VARIABLE is
              // deleted → inlined to a literal; without this the label stayed un-accented on the replica.
              : (responsiveOverrides.has('initialVariant')
                || (vpWidth != null && selectedId != null && nodes.get(selectedId)?.responsiveAttrPropValues?.initialVariant?.[vpWidth] != null)))
          ));
          // Inline-ternary per-viewport LITERAL (`__mq2 ? 'variant-3' : 'default'`) on this tile — distinct
          // from a per-viewport VARIABLE (vpVariantBoundRef) and from a data-responsive literal.
          const hasInlineVpVariant = isReplica && vpWidth != null && selectedId != null
            && nodes.get(selectedId)?.responsiveAttrPropValues?.initialVariant?.[vpWidth] != null;
          const variantResetOverride = !variantOverridden ? undefined : () => {
            // Per-PARENT-VARIANT override (variable OR literal) → Reset Override drops THIS variant's branch
            // so it re-inherits the base/default; every other parent variant + the base are untouched.
            if (cvVariantBranch && isComponentVariant && activeComponentVariant && selectedId && componentInfo) {
              modifyProjectFile(activeFile, (c) =>
                removeConditionalInstancePropBranchInCode(c, selectedId, componentInfo.name, 'initialVariant', activeComponentVariant));
              const nc = projectFS.readFile(activeFile);
              if (nc) { setCode(nc); setVersion((v) => v + 1); }
              return;
            }
            // Per-viewport variant VARIABLE *or* inline-ternary LITERAL → Reset Override reverts THIS tile to
            // the base by dropping the inline `__mq` branch (handleResetAttrVar = resetResponsiveInstancePropVarInCode,
            // which reverts `{__mq2 ? 'variant-3' : 'default'}` → `{"default"}`). handleResetOverride below only
            // clears a data-responsive literal, so it did NOTHING for the inline form (the user's broken case).
            if ((vpVariantBoundRef || hasInlineVpVariant) && isReplica) { handleResetAttrVar('initialVariant'); return; }
            // Reset Override = revert THIS tile to the cascaded base. Scroll-variant: drop this
            // scope's own `fromVar` (so it inherits the base again) + clear the data-responsive
            // reflection. Non-scroll: clear the data-responsive literal.
            if (svRowSpec && activeQuery && selectedId && componentInfo) {
              modifyProjectFile(activeFile, (currentCode) => {
                let c = currentCode;
                const spec = getScrollVariant(c, selectedId);
                if (spec) {
                  const responsive = (spec.responsive ?? []).map((r) =>
                    ('query' in r.scope && r.scope.query === activeQuery && 'fromVar' in r)
                      ? (() => { const { fromVar: _d, ...rest } = r; return rest; })()
                      : r);
                  c = setScrollVariantInCode(c, selectedId, { ...spec, responsive });
                }
                c = setResponsiveOverride(c, selectedId, componentInfo.name, vpWidth, 'initialVariant', '', null);
                return resyncScrollResting(c);
              });
              const nc = projectFS.readFile(activeFile);
              if (nc) { setCode(nc); setVersion((v) => v + 1); }
              return;
            }
            handleResetOverride('initialVariant');
          };
          return (
            <HoistMenuItemProvider item={variantMenuItems.length ? variantMenuItems : null}>
              <div className="flex items-center justify-between w-full">
                {/* hideCopyPasteStyle: a variant is not a style — Copy/Paste Style is meaningless here. */}
                <ControlLabel label="Variant" property="initialVariant" hideCopyPasteStyle overridden={variantOverridden} onResetOverride={variantResetOverride} />
                {variantBoundRef ? (
                  <LegacyVariableBoundPill
                    property="initialVariant"
                    propertyLabel="Variant"
                    variableRef={variantBoundRef}
                    currentValue={parentVarsByName.get(variantBoundRef) ?? ''}
                    removeVariable={removeVariantVar}
                  />
                ) : (
                  <ToolSelect
                    value={currentVariant}
                    onChange={handleVariantSelect}
                    options={variantOptions}
                  />
                )}
              </div>
            </HoistMenuItemProvider>
          );
        })()}
      </div>
    </div>
  );

  // Render one code component @control row. Recursive — a `group` control renders its
  // own nested controls through this same function (inside the group popup).
  // Per-parent-variant DISPLAY resolution: in a component file a prop may be
  // a `initialVariant === 'X' ? … : …` ternary (the per-variant write above).
  // Resolve the ACTIVE tile's branch so the Hover tile shows ITS value and
  // the default tile shows the base — instead of the raw ternary source.
  const resolveVariantBranchDisplay = (raw: string | undefined): string | undefined => {
    if (raw == null || !isComponentFilePath(activeFile)) return raw;
    const map = parseConditionalPropExpression(raw);
    if (!map) return raw;
    return resolveConditionalPropValue(map, (isComponentVariant && activeComponentVariant) || 'default');
  };

  // Per-VARIANT override state for a prop (component masters): the ACTIVE
  // tile has its own ternary branch → purple (accent-secondary) label +
  // "Reset Override", mirroring the per-viewport data-responsive convention.
  // Reset writes the DEFAULT branch's value to this variant, which
  // setConditionalPropEntry collapses into deleting the branch.
  const variantOverrideFor = (propName: string): { overridden: boolean; reset?: () => void } => {
    if (!(isComponentVariant && activeComponentVariant) || !selectedId || !componentInfo) return { overridden: false };
    const raw = currentValues.get(propName);
    if (!raw) return { overridden: false };
    const map = parseConditionalPropExpression(raw);
    if (!map || map[activeComponentVariant] == null) return { overridden: false };
    return {
      overridden: true,
      reset: () => {
        const defVal = map['default'] ?? '';
        setPropOptimistic(propName, defVal);
        modifyProjectFile(activeFile, (c) =>
          setConditionalInstanceProp(c, selectedId, componentInfo.name, propName, activeComponentVariant, defVal));
        trace.action('component-props:reset-variant-override', { propName, variant: activeComponentVariant });
      },
    };
  };

  const renderControl = (propName: string, controlDef: ComponentControlDef): React.ReactNode => {
    const hasResponsiveOverride = isReplica && responsiveOverrides.has(propName);
    // A `transition` control's default is an OBJECT (a framer-motion
    // transition); every other control's default is a primitive.
    const rawDefault = controlDef.default;
    const defaultStr = rawDefault != null && typeof rawDefault === 'object'
      ? JSON.stringify(rawDefault)
      : String(rawDefault ?? '');
    // Locale-scoped attrs parse back as raw expressions — resolve to the
    // effective display value (same rail as design-prop rows), and let the
    // optimistic hold win until the parse settles (no select ping-pong).
    const baseValue = resolveScopedPropDisplay(propName, resolveVariantBranchDisplay(currentValues.get(propName)) ?? defaultStr, defaultStr);
    const committedValue = hasResponsiveOverride ? responsiveOverrides.get(propName)! : baseValue;
    // While a slider is dragging, previewValues holds the in-flight value.
    const currentValue = previewValues[propName] ?? pendingProps[propName] ?? committedValue;
    const variantOv = variantOverrideFor(propName);
    const labelStyle = hasResponsiveOverride
      ? { color: 'var(--accent-text)', fontWeight: 600 } as React.CSSProperties
      : variantOv.overridden
        ? { color: 'var(--accent-secondary)', fontWeight: 600 } as React.CSSProperties
        : undefined;
    // FULL locale parity with design-prop rows (Localize arrow → blue pill →
    // popup → per-replica bands → blue label + Reset Override): code-component
    // instances are ordinary instance tags, so the exact same scoped-expr
    // machinery applies — only the row chrome differed (ToolRow vs
    // ControlLabel), hence ToolRow's extraMenuItems/overridden passthrough.
    const lpOv = localePropOverride(propName);
    const lpMenu = localizeMenuItem(propName, currentValue);
    const resetOverride = lpOv.reset
      ?? (hasResponsiveOverride ? () => handleResetOverride(propName) : undefined)
      ?? variantOv.reset;
    const rowLocale = {
      extraMenuItems: lpMenu,
      overridden: hasResponsiveOverride || lpOv.overridden || variantOv.overridden,
      onResetOverride: resetOverride,
    };
    const pillOpts = controlDef.type === 'select'
      ? (controlDef.options || []).map(o => ({ label: o.label, value: o.value }))
      : controlDef.type === 'toggle'
        ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]
        : undefined;
    const isNumberCtl = controlDef.type === 'number' || controlDef.type === 'slider';
    const numberCtlMeta = isNumberCtl ? {
      control: (controlDef.type === 'slider'
        || (controlDef.min !== undefined && controlDef.max !== undefined && !controlDef.displayStepper)
        ? 'slider' : 'stepper') as 'slider' | 'stepper',
      min: controlDef.min, max: controlDef.max, step: controlDef.step ?? 1,
    } : undefined;
    const wrapPill = (node: React.ReactNode): React.ReactNode => (
      selectedId && componentName
        ? <LocalePropPillOr nodeId={selectedId} componentName={componentName} prop={propName}
            propLabel={controlDef.label} options={pillOpts}
            editorKind={controlDef.type === 'color' ? 'color' : isNumberCtl ? 'number' : undefined}
            numberMeta={numberCtlMeta}
            fallback={cleanPropFallback(currentValue, defaultStr)}>{node}</LocalePropPillOr>
        : node
    );

    trace.fn('ComponentPropsTool:code-component-control', {
      propName, type: controlDef.type, currentValue,
      defaultValue: controlDef.default, hasResponsiveOverride,
    });

    switch (controlDef.type) {
      case 'color':
        return (
          <ToolRow key={propName} label={controlDef.label} labelStyle={labelStyle} {...rowLocale}>
            {wrapPill(<ColorInput
              value={currentValue || (controlDef.default as string)}
              onChangeLive={(v) => previewProp(propName, v)}
              onChange={(v) => handlePropChange(propName, v, String(controlDef.default))}
            />)}
          </ToolRow>
        );
      case 'text':
        return (
          <ToolRow key={propName} label={controlDef.label} labelStyle={labelStyle} {...rowLocale}>
            {wrapPill(<ToolInput
              value={currentValue}
              onChange={(v) => handlePropChange(propName, v, String(controlDef.default))}
              text
            />)}
          </ToolRow>
        );
      case 'font':
        // The font picker is a SELF-CONTAINED row (its own label + the family
        // button + the FontFamilyPopup) — the exact control the Text Style tool
        // uses — so it is NOT wrapped in a ToolRow. It carries the @control's own
        // label and writes the CSS font-family stack string to the prop.
        return (
          <FontFamilyControl
            key={propName}
            value={currentValue}
            onChange={(v) => handlePropChange(propName, v, String(controlDef.default))}
            label={controlDef.label}
          />
        );
      case 'slider':   // legacy alias — always a slider
      case 'number': {
        // EXACT same number editor as a Number VARIABLE (NumberVariableEditor): a bounded number
        // (min+max, not displayStepper) or the legacy `slider` type → slider + input; every other number
        // (e.g. Target / Decimals — no range) → input + a −/+ stepper. Previously the no-range case fell
        // to a bare input with no stepper, which is what the user was seeing.
        const control: 'slider' | 'stepper' = controlDef.type === 'slider'
          || (controlDef.min !== undefined && controlDef.max !== undefined && !controlDef.displayStepper)
          ? 'slider' : 'stepper';
        return (
          <ToolRow key={propName} label={controlDef.label} labelStyle={labelStyle} {...rowLocale}>
            {wrapPill(<NumberVariableEditor
              value={currentValue}
              onChange={(v) => handlePropChange(propName, v, String(controlDef.default))}
              onChangeLive={(v) => previewProp(propName, v)}
              meta={{ control, min: controlDef.min, max: controlDef.max, step: controlDef.step ?? 1 }}
            />)}
          </ToolRow>
        );
      }
      case 'toggle':
        return (
          <ToolRow key={propName} label={controlDef.label} labelStyle={labelStyle} {...rowLocale}>
            {wrapPill(<ToolSegmentedControl
              value={currentValue === 'true' ? 'yes' : 'no'}
              onChange={(v) => handlePropChange(propName, v === 'yes' ? 'true' : 'false', String(controlDef.default))}
              options={YES_NO_OPTIONS}
              size="sm"
            />)}
          </ToolRow>
        );
      case 'select':
        return (
          <ToolRow key={propName} label={controlDef.label} labelStyle={labelStyle} {...rowLocale}>
            {wrapPill(<ToolSelect
              value={currentValue}
              onChange={(v) => handlePropChange(propName, v, String(controlDef.default))}
              options={(controlDef.options || []).map(o => ({ label: o.label, value: o.value }))}
            />)}
          </ToolRow>
        );
      case 'imageList':
        // Ordered image list — popup with per-image sub-rows + append upload.
        return (
          <ImageListControl
            key={propName}
            label={controlDef.label}
            value={currentValue}
            onChange={(v) => handlePropChange(propName, v, String(controlDef.default ?? ''))}
            uploadSource={controlDef.uploadSource || 'uploaded'}
          />
        );
      case 'upload':
        return (
          <ToolRow key={propName} label={controlDef.label} labelStyle={labelStyle} {...rowLocale}>
            {wrapPill(<UploadControl
              value={currentValue}
              onChange={(v) => handlePropChange(propName, v, String(controlDef.default))}
              accept={controlDef.accept || 'image/*'}
              multiple={controlDef.multiple || false}
              uploadSource={controlDef.uploadSource || 'uploaded'}
              onBatchComplete={controlDef.multiple ? (count) => {
                if (controlsMeta?.controls?.totalFrames) {
                  handlePropChange('totalFrames', String(count), String(controlsMeta.controls.totalFrames.default));
                }
              } : undefined}
            />)}
          </ToolRow>
        );
      case 'slot':
        // Slot — connected canvas nodes render as the component's children.
        return (
          <SlotControl
            key={propName}
            componentId={selectedId ?? ''}
            label={controlDef.label}
            slotMax={controlDef.slotMax}
          />
        );
      case 'group':
        // A button → popup of NESTED controls (each a normal flat prop).
        return (
          <GroupControl
            key={propName}
            label={controlDef.label}
            controls={controlDef.controls ?? {}}
            renderControl={renderControl}
          />
        );
      case 'transition':
        // A button → the Motion transition editor; value is a JSON string.
        return (
          <TransitionControl
            key={propName}
            label={controlDef.label}
            value={currentValue}
            onChange={(v) => handlePropChange(propName, v, defaultStr)}
          />
        );
      default:
        return null;
    }
  };

  // NOTE: SUPERSEDED by `instantHoist` (above) — all Create/Hoist entry points now create the variable
  // INSTANTLY and open the global RENAME modal (variableModalRequestAtom), so `hoistTarget` is never set
  // and this inline create-FORM modal is unreachable. Kept (renders null) only to avoid churn in a large
  // file; safe to delete with its `hoistTarget` state once the helper refs are pruned.
  const variableModal = (hoistTarget && componentName && selectedId) ? (
    <VariableModal
      isOpen={true}
      onClose={() => setHoistTarget(null)}
      property={hoistTarget.cssProp ?? hoistTarget.propName}
      propertyLabel={hoistTarget.propName}
      currentValue={hoistTarget.currentLiteral}
      // The new VARIABLE name defaults to the prop name — EXCEPT for a variant
      // hoist, where the prop is the reserved `initialVariant`. A variable named
      // `initialVariant` collides with the structural prop the instance editor
      // skips everywhere, so its bound pill never renders and it never reaches
      // the Template tool. Seed a safe, component-derived name (e.g. headerVariant)
      // instead; the CHILD prop stays `initialVariant` (carried by hoistTarget.propName).
      initialName={hoistTarget.propName === 'initialVariant'
        ? `${componentName.charAt(0).toLowerCase()}${componentName.slice(1)}Variant`
        : hoistTarget.propName}
      // Code-component-control variables: render the code component's real control (color
      // picker / slider) for the default value instead of a text input.
      // Variant hoist: render a SELECT of THIS instance's component variants
      // (Desktop / Desktop White / …) so the Default is a real variant pick,
      // not a free-text box where you'd have to know the internal name.
      renderDefaultValue={hoistTarget.codeComponentControl
        ? (value, onChange) => (
            <CodeComponentControlField
              controlDef={hoistTarget.codeComponentControl!}
              value={value}
              onChange={onChange}
            />
          )
        : hoistTarget.propName === 'initialVariant'
        ? (value, onChange) => (
            <ToolSelect value={value || 'default'} onChange={onChange} options={variantOptions} />
          )
        : undefined}
      // Number control → show the full Number editor (min/max/step/…) in the create form, seeded from the
      // control, so the new variable is the SAME unified Number type as opacity/gap (interchangeable).
      createNumberMeta={hoistTarget.codeComponentControl && (hoistTarget.codeComponentControl.type === 'number' || hoistTarget.codeComponentControl.type === 'slider')
        ? {
            min: hoistTarget.codeComponentControl.min,
            max: hoistTarget.codeComponentControl.max,
            step: hoistTarget.codeComponentControl.step,
            unit: hoistTarget.codeComponentControl.unit,
            control: hoistTarget.codeComponentControl.displayStepper ? 'stepper' : 'slider',
          }
        : undefined}
      onCreateVariable={(name, defaultValue, numberMeta) => {
        queueMutation({
          type: 'hoistInstanceProp',
          instanceNodeId: selectedId,
          componentName,
          propName: hoistTarget.propName,
          variable: {
            name,
            type: hoistTarget.inferredType,
            default: defaultValue,
          },
          // Active viewport scope: on a replica this binds PER-VIEWPORT, not the base (Desktop) —
          // a variant hoist → `responsive[scope].fromVar`; a plain prop hoist → an inline
          // `prop={__mqN ? var : base}` ternary on this tile only. Null on the primary → base binding.
          scope: getActiveAnimationScope(),
        });
        // Carry the Number config onto the new variable so it's a full Number variable (range + display),
        // not a bare value — keeps it interchangeable with style number controls.
        if (numberMeta) {
          queueMutation({ type: 'setComponentPropNumberMeta', propName: name, meta: numberMeta });
        }
        // Force a code refresh so the registry re-scans the master file and
        // the new prop becomes available on higher-level instance editors
        // immediately, without waiting for the next user-initiated change.
        flushNow();
        const refreshed = projectFS.readFile(activeFile);
        if (refreshed) {
          setCode(refreshed);
          setVersion(v => v + 1);
        }
      }}
    />
  ) : null;

  // ─── Code component controls rendering (rich typed controls) ──────────────────────
  if (hasComponentControls) {
    // The wrapper carries the double-click reveal (see the effect at the top):
    // it scrolls the WHOLE component tool — header, Edit Code, and every
    // control row — into view and rings it in the component purple for a
    // beat. The ring is INSET: an outset box-shadow on this full-width block
    // painted outside the border box and the panel's scroll container clipped
    // its left/right edges ("borders cut off" report). The transition runs
    // both ways, so the ring fades out.
    return (
      <>
      <div
        ref={revealRef}
        className="rounded-[var(--radius-md)] transition-[box-shadow,background-color] duration-500"
        style={revealFlash ? {
          boxShadow: 'inset 0 0 0 1.5px var(--accent-secondary, #a855f7)',
          backgroundColor: 'color-mix(in srgb, var(--accent-secondary, #a855f7) 8%, transparent)',
        } : undefined}
      >
        {componentHeader}
        {/* Same px-2 + pl-3 as ToolSection so code component control labels line up
            with Styles / Layout / Position labels (ControlLabel's chevron
            offset only makes sense at this column). */}
        <div className="px-2">
          <div className="flex flex-col gap-2 pl-3">
            {Object.entries(componentControls).map(([propName, controlDef]) => {
              // Inside a component master, every Code component control gets the same
              // "Hoist Variable" chevron menu the design-component prop rows
              // have — so a code component dropped into a master can hoist
              // its controls (Intensity, Grain Scale, …) up into the
              // master's props. `ToolRow` reads this ambient item and renders
              // the menu. Control types without a simple value form
              // (slot/group/transition) return null → no hoist item.
              const hoistType = isInComponentMaster && componentName && selectedId
                ? codeComponentControlVariableType(controlDef.type)
                : null;
              const rawDefault = controlDef.default;
              const defaultStr = rawDefault != null && typeof rawDefault === 'object'
                ? JSON.stringify(rawDefault)
                : String(rawDefault ?? '');
              // On a REPLICA the per-viewport DATA-RESPONSIVE override is the live value — resolve it FIRST so
              // the row reflects THIS tile. Without this `currentLiteral` was always the BASE binding, so on a
              // replica the variable-pill branch (boundVarRef below) ALWAYS matched the base var and we never
              // fell through to `renderControl` (which already shows the overridden value + a Reset). Net
              // effect: per-replica override / removing the var on a replica appeared to do NOTHING. Mirrors
              // the design-component propValue (~2226). A per-viewport VARIABLE is handled by vpVarRef above.
              const currentLiteral = String(
                (isReplica ? responsiveOverrides.get(propName) : undefined)
                ?? currentValues.get(propName) ?? defaultStr,
              );
              // Label is "Create Variable" (not "Hoist Variable"): a code
              // component is a leaf — its control becomes a NEW variable on
              // the master we're editing. "Hoist" is reserved for lifting an
              // existing prop up from a nested DESIGN-component instance. Same
              // underlying mechanism (adds a prop to the current master), but
              // the wording matches what the user is doing.
              const hoistMenuItem = hoistType ? {
                label: 'Create Variable',
                show: true,
                hoverColor: 'accent-secondary' as const,
                onClick: () => instantHoist({
                  propName,
                  currentLiteral,
                  inferredType: hoistType,
                  cssProp: undefined,
                  // Carry the code component control so the modal renders its real
                  // default-value editor (color picker / slider) instead of a
                  // bare text input.
                  codeComponentControl: controlDef,
                }),
              } : null;

              // "Set Variable" — bind to an EXISTING master variable of the SAME data type. A code
              // control's type drives which variables are compatible: slider/number → number variables,
              // color → color, toggle → toggle, etc. (the reference's model — a number variable works on any
              // numeric control.) Hidden when none match.
              const setVarItem: MenuItem | null = (() => {
                if (!hoistType) return null;
                const wantFamily = resolveVariableIconKey({ pageVarType: codeComponentControlVariableType(controlDef.type) ?? undefined });
                const wantTypeId = codeControlVariableType(controlDef.type);
                const compatible = parentVars.filter(v =>
                  v.name !== propName && (v.family === wantFamily || (wantTypeId && getVariableType(wantTypeId)?.iconKey === v.family)),
                );
                if (compatible.length === 0) return null;
                return {
                  label: 'Set Variable',
                  show: true,
                  hoverColor: 'accent-secondary' as const,
                  onClick: () => { /* parent is a no-op; the submenu opens on hover */ },
                  submenuItems: compatible.map(v => ({
                    label: v.label,
                    show: true,
                    hoverColor: 'accent-secondary' as const,
                    onClick: () => bindCodeControlVariable(propName, v.name),
                  })),
                };
              })();

              const codeComponentMenuItems = [hoistMenuItem, setVarItem].filter(Boolean) as MenuItem[];

              // PER-VIEWPORT VARIABLE on a REPLICA: this @control has an inline `__mq ? var : base` binding
              // whose branch covers the current tile → show THAT variable as a per-viewport override (accent
              // label + × reverts THIS tile to the base via handleResetAttrVar → a data-responsive literal).
              // Parity with the design-component prop rows so code components support per-replica variables.
              const vpVarRef = isReplica ? responsiveAttrVars.get(propName) : undefined;
              if (vpVarRef && parentVarsByName.has(vpVarRef)) {
                return (
                  <div key={propName} className="flex items-center justify-between w-full">
                    <ControlLabel label={controlDef.label} property="" hideCreateVariable hideResetStyle hideCmsBinding overridden onResetOverride={() => handleResetAttrVar(propName)} />
                    <LegacyVariableBoundPill
                      property={propName}
                      propertyLabel={controlDef.label}
                      variableRef={vpVarRef}
                      currentValue={parentVarsByName.get(vpVarRef) ?? ''}
                      removeVariable={() => handleResetAttrVar(propName)}
                      iconKey={resolveVariableIconKey({ pageVarType: codeComponentControlVariableType(controlDef.type) ?? undefined })}
                    />
                  </div>
                );
              }

              // Once the control is bound to a master variable, its instance
              // value is a bare identifier (`intensity={intensityVar}`) that
              // `parseInstanceProps` returns as the variable name string. Show
              // the same purple `T <var> ×` pill the design-component prop rows
              // use instead of the raw slider/input (which would render the
              // identifier as a broken value). Clicking × reverts the prop to
              // the control's default. Same concept as style/prop variables.
              const boundVarRef = parentVarsByName.has(currentLiteral) ? currentLiteral : null;
              if (boundVarRef) {
                const removeBoundVar = () => {
                  const fallback = parentVarsByName.get(boundVarRef) ?? defaultStr;
                  handlePropChange(propName, fallback, defaultStr);
                };
                // Bound: render EXACTLY like the design-component bound rows —
                // a canonical `ControlLabel` (w-3/4) + the purple pill as a
                // direct flex child (w-full → standard value column). No
                // `HoistMenuItemProvider` and `hideCreateVariable` so the
                // label shows NO "Create Variable" menu (it's already a
                // variable — the pill's × removes it).
                return (
                  <div key={propName} className="flex items-center justify-between w-full">
                    <ControlLabel
                      label={controlDef.label}
                      property=""
                      hideCreateVariable
                      hideResetStyle
                      hideCmsBinding
                    />
                    <LegacyVariableBoundPill
                      property={propName}
                      propertyLabel={controlDef.label}
                      variableRef={boundVarRef}
                      currentValue={parentVarsByName.get(boundVarRef) ?? ''}
                      removeVariable={removeBoundVar}
                      // The data type comes from the @control's declared type (slider/number → #,
                      // color → droplet, toggle → switch, …) — propName isn't a CSS prop, so without
                      // this the pill falls back to the generic cube glyph.
                      iconKey={resolveVariableIconKey({ pageVarType: codeComponentControlVariableType(controlDef.type) ?? undefined })}
                    />
                  </div>
                );
              }

              return (
                <HoistMenuItemProvider key={propName} item={codeComponentMenuItems.length > 0 ? codeComponentMenuItems : null}>
                  {renderControl(propName, controlDef)}
                </HoistMenuItemProvider>
              );
            })}
          </div>
        </div>
      </div>
      {/* Divider + modal host sit OUTSIDE the reveal ring — the ring frames
          the tool itself, not the separator to the next section. */}
      <ToolDivider />
      {variableModal}
      </>
    );
  }

  // ─── Regular component props rendering (CSS-property-based) ──────────────

  // EVENT props are component callbacks (fired by a child via the Interactions
  // tool, handled by the instance's overlay triggers) — not editable data
  // values, so they get no row here. `style`/`initialVariant` are handled
  // separately (spread + Variant selector).
  // A variable is shown ONLY if it's actually APPLIED somewhere in the master. A created-then-never-bound
  // (or X-unbound) variable drives nothing, so listing it just clutters the instance editor (the reported
  // "unused 'content' plainText var still shows" bug). Previously ONLY transition variables were usage-checked;
  // every other type showed unconditionally. Cover every binding form the editor writes:
  //   prop={…name…}  (attr / forward into a nested instance / per-variant or per-viewport ternary)
  //   {name}         (text node)
  //   prop: name     (style or object value)
  //   (name          (a call arg — withCursor(name, …) / setTimeout(name, …))
  //   var(--name)    (CSS custom property, e.g. border/shadow overlays)
  // Default-to-HIDE when none match. Shared with the Template tool via isVariableAppliedInCode.
  const visibleProps = componentInfo.props.filter(
    p => p.name !== 'style' && p.name !== 'initialVariant' && p.varType !== 'event'
      // A cursor variable's paired `<prop>Opts` param is popup-managed
      // per-instance machinery, never a standalone row.
      && !(p.name.endsWith('Opts')
        && componentInfo.props.some(q => `${q.name}Opts` === p.name && q.varType === 'componentCursor'))
      && isVariableAppliedInCode(p.name, masterCode),
  );
  const hasRegularProps = visibleProps.length > 0;

  return (
    <>
      {componentHeader}

      {hasRegularProps && (
        // mt-2 separates the prop list from the Variant selector above so
        // the two read as distinct groupings — Variant is component-level,
        // the prop rows below are the per-instance variable values.
        // px-2 + pl-3 matches ToolSection's body so labels here line up with
        // Styles / Layout / Position labels (same column).
        <div className="px-2 mt-2">
          <div className="flex flex-col gap-2 pl-3">
            {visibleProps.map(prop => {

              // A `transition` variable is a framer-motion prop, NOT an inline-style one — its cssProp is ALWAYS
              // 'transition' so the rich editor (TransitionVariableEditor curve picker) resolves. We must take
              // PRECEDENCE over propCSSMap here, not fall back to it: detectPropCSSMapping/localCssPropForVar
              // false-positives on a CHAINED MotionConfig ternary (`…t2 : variant === 'v1' ? t1…` matches `t2` as
              // the cssProp for `t1`), returning a bogus non-registry cssProp → the curve picker turned into a raw
              // text input (the reported regression after per-variant chaining landed).
              const cssProp = prop.varType === 'transition' ? 'transition' : propCSSMap.get(prop.name);
              // While an editor (color picker, border panel, slider) is being
              // dragged, the persisted file write is debounced — `currentValues`
              // (parsed from the committed source) lags behind. `previewValues`
              // holds the in-flight value; read it first so the rich-atom row
              // and its panel show the live state without waiting for the
              // debounced commit. Same pattern Code component controls use above.
              // On a replica, the per-viewport override (data-responsive) wins over
              // the base attribute so the control shows THIS viewport's value.
              const propValue = resolveScopedPropDisplay(prop.name,
                pendingProps[prop.name]
                ?? previewValues[prop.name]
                ?? (isReplica ? responsiveOverrides.get(prop.name) : undefined)
                ?? resolveVariantBranchDisplay(currentValues.get(prop.name))
                ?? prop.defaultValue
                ?? '', prop.defaultValue);

              // Per-viewport override indicator. On a replica, if this prop has a
              // data-responsive override, its row label goes ACCENT + gets a "Reset
              // Override" menu item (revert to base) — the SAME system every other
              // control label uses. `overridden` forces the accent (the unified
              // hasOverride only knows the @media STYLE map, not instance props), and
              // forcing the label non-plain makes the menu/accent render. Mirrors the
              // Code component @control path (hasResponsiveOverride → labelStyle + resetOverride).
              const propVariantOv = variantOverrideFor(prop.name);
              const propOverridden = (isReplica && responsiveOverrides.has(prop.name)) || propVariantOv.overridden;
              const propResetOverride = (isReplica && responsiveOverrides.has(prop.name))
                ? () => handleResetOverride(prop.name)
                : propVariantOv.reset;

              // CMS-bound? A prop connected to a collection field reads back as
              // `item.field` (the iterator member) OR — for whole-value IMAGE props —
              // as the url-wrapped template `` `url(${item.field})` `` (Make Component
              // and image binds write the wrap at the binding site because the master
              // uses the bare `backgroundImage: prop` convention). Surface the field
              // name as a blue pill instead of the raw editor (Mechanism A bound state).
              const cmsBoundField = (() => {
                if (!cmsBinding || typeof propValue !== 'string') return null;
                if (propValue.startsWith(cmsBinding.itemVar + '.')) return propValue.slice(cmsBinding.itemVar.length + 1);
                const wrapped = propValue.match(new RegExp('^`url\\(\\$\\{' + cmsBinding.itemVar + '\\.(\\w+)\\}\\)`$', 'i'));
                return wrapped ? wrapped[1] : null;
              })();

              // Orphaned (detached) CMS binding — the instance was dragged out of
              // its collection list, so the live `item.field` was stripped and the
              // intent stashed in `data-cms-orphan` (node.orphanBindings). Show a
              // "Missing" pill (design-tool parity); dropping it back into a list re-binds.
              const orphanField = !cmsBoundField
                ? (node?.orphanBindings?.find((o) => o.prop === prop.name)?.field ?? null)
                : null;

              // "Hoist Variable" menu item — appended to every prop row's
              // ControlLabel chevron menu. Uses the existing chevron-on-
              // hover UI so it lives in the same place as "Create
              // Variable" / "Remove" / etc. — no separate button,
              // matches the rest of the editor's affordances.
              //
              // Gated: only shows when the active file is a component
              // master AND there's a nested instance whose props could be
              // hoisted into the parent's signature. Page files have no
              // ParentComponent to hoist INTO, so the option is meaningless
              // there.
              // Row menu item: on a component MASTER it's "Hoist Variable"
              // (lift the nested-instance prop up). On a PAGE instance it's
              // "Apply Preset" — a submenu of compatible presets (radius /
              // spacing / margin / shadow / border) that write `var(--token)`
              // (or a composed border shorthand) into the variable's value via
              // the instance-prop write. Color / image / video presets aren't
              // here — those live inside their own control popups already.
              const hoistMenuItem = (() => {
                const items: any[] = [];
                // CMS CONNECT (Mechanism A) — when the instance is inside a
                // collection list, let this prop bind to a same-typed CMS field
                // ("Set Variable" → field submenu). Sits first: it's the primary
                // affordance the user expects on a collection-list component.
                if (cmsBinding) {
                  const allowed = cmsFieldTypesForVarType(prop.varType);
                  const candidates = cmsBinding.fields.filter((f) => allowed.has(f.type));
                  if (candidates.length > 0) {
                    items.push({
                      label: 'Set Variable',
                      onClick: () => { /* parent no-op; submenu opens on hover */ },
                      show: true,
                      hoverColor: 'accent' as const,
                      submenuItems: candidates.map((f) => ({
                        label: f.name,
                        show: true,
                        hoverColor: 'accent' as const,
                        // urlWrap: whole-value image prop (default carries the url()
                        // wrap) → bind as `{`url(${item.field})`}` (see bindPropToCmsField).
                        onClick: () => bindPropToCmsField(prop.name, f.id, propValue, /^url\(/i.test(prop.defaultValue ?? '')),
                      })),
                    });
                  }
                  if (cmsBoundField) {
                    items.push({
                      label: 'Unbind Field',
                      // On a replica, "unbind" means THIS viewport only → inject the
                      // default (literal override), keeping the base binding elsewhere.
                      // On the base, remove the binding entirely.
                      onClick: () => isReplica
                        ? unbindPropForViewport(prop.name, prop.defaultValue ?? '')
                        : handlePropChange(prop.name, prop.defaultValue ?? '', prop.defaultValue),
                      show: true,
                      hoverColor: 'accent' as const,
                    });
                  }
                }
                if (isInComponentMaster && componentName && selectedId) {
                  items.push({
                    label: 'Hoist Variable',
                    onClick: () => instantHoist({
                      propName: prop.name,
                      currentLiteral: propValue,
                      // A componentCursor IS a valid PageVariableType — preserve it so the hoisted variable keeps
                      // its cursor icon + NO default row (inferTypeForProp would fall to 'text' = wrong icon + a
                      // default input). Mirrors the radius/transition type-preservation.
                      inferredType: prop.varType === 'componentCursor' ? 'componentCursor' : inferTypeForProp(cssProp, propValue),
                      cssProp,
                    }),
                    show: true,
                    hoverColor: 'accent-secondary' as const,
                  });
                } else if (cssProp && propertyHasPresets(cssProp)) {
                  // Page instance: offer Apply Preset when the prop maps to a
                  // preset-supporting CSS property.
                  const submenuItems = buildPresetSubmenuItems(cssProp, presetTokens, (cssValue) => {
                    handlePropChange(prop.name, cssValue, prop.defaultValue);
                  });
                  if (submenuItems.length > 0) {
                    items.push({
                      label: 'Apply Preset',
                      onClick: () => { /* parent no-op; submenu opens on hover */ },
                      show: true,
                      hoverColor: 'accent' as const,
                      submenuItems,
                    });
                  }
                }
                // "Set Variable" — bind an EXISTING parent variable of a COMPATIBLE type to THIS instance
                // PROP via setInstanceProp (`<Comp prop={var}/>`). The generic ControlLabel "Set Variable"
                // binds the CSS PROPERTY (a conditional/inline STYLE on the instance) — wrong for an
                // instance prop (it's how `hide` landed on `display` instead of `hide={…}`). Injecting this
                // here auto-suppresses the generic one (ControlLabel dedups on an injected 'Set Variable').
                if (componentInfo && selectedId && cssProp && !cmsBoundField) {
                  const wantFamilies = acceptedVariableFamilies(cssProp);
                  // NO `v.name !== prop.name` exclusion — the variable name coinciding with the prop name
                  // is the COMMON case (a hoisted `hide` var bound to the `hide` prop → `hide={hide}`).
                  // parentVars here are the page/template @pageVariables, a DIFFERENT namespace from the
                  // component's prop; excluding by name dropped exactly the variable the user wants to bind.
                  const compatible = parentVars.filter(v => wantFamilies.includes(v.family));
                  if (compatible.length > 0) {
                    items.push({
                      label: 'Set Variable',
                      onClick: () => { /* parent no-op; submenu opens on hover */ },
                      show: true,
                      hoverColor: 'accent-secondary' as const,
                      submenuItems: compatible.map(v => ({
                        label: v.label,
                        show: true,
                        hoverColor: 'accent-secondary' as const,
                        onClick: () => modifyProjectFile(activeFile, (c) => setInstanceProp(c, selectedId, componentInfo.name, prop.name, v.name, true)),
                      })),
                    });
                  }
                }
                return items.length === 0 ? null : items.length === 1 ? items[0] : items;
              })();

              // Detect parent-variable binding: after a hoist, the nested
              // instance's prop becomes `prop={parentVarName}`. parseInstanceProps
              // returns the identifier string as the value. If that string
              // is the name of a variable on the active component master,
              // we render the purple `T <varName> ×` pill instead of the
              // atom's normal editor — matching what style-level variable
              // bindings already do via UnifiedControlProvider + ControlRow.
              //
              // Restoring on × uses the parent variable's default value
              // (looked up from the same registry). That keeps the prop
              // semantically meaningful instead of empty.
              // CMS-bound prop → blue field pill (click × to unbind → master default).
              // Reuses the prop row's chevron menu (hoistMenuItem) so "Bind to Field"
              // can re-point it. Theme-token accent works in light + dark.
              if (cmsBoundField) {
                // Exact same blue CMS pill used everywhere else (chain icon + field
                // name + ×, click body to re-bind). Driven by the now-prop-aware
                // cmsBinding (getBindingForProperty reads propBindings; ×/re-bind
                // route to unbindPropFromMap/bindPropToMap).
                return (
                  <HoistMenuItemProvider key={prop.name} item={hoistMenuItem}>
                    <div className="flex items-center justify-between w-full">
                      <ControlLabel label={prop.label || prop.name} property={cssProp ?? ''} plain={false} hideLocalize extraMenuItems={localizeMenuItem(prop.name, propValue)} overridden={propOverridden || localePropOverride(prop.name).overridden} onResetOverride={localePropOverride(prop.name).reset ?? propResetOverride} />
                      {isReplica
                        // On a replica the binding can live in data-responsive (not the
                        // node's propBindings), so CmsBoundPill can't read it — show a
                        // standalone pill; × unbinds THIS viewport→default, rebind via
                        // the chevron "Set Variable". Reset Override (chevron) → base.
                        //
                        // `cmsBoundField` is the field's ID (`title`), which is what the
                        // JSX carries. Resolve it to the field's display NAME the way
                        // CmsBoundPill does, or the two pills disagree about the same
                        // binding — desktop read "Question" while tablet read "title"
                        // (user report 2026-08-08). The tooltip also has to say which
                        // binding it is: with no data-responsive entry for this prop the
                        // replica is simply INHERITING the base one.
                        ? <CmsFieldPill
                            field={cmsFieldLabel(cmsBinding?.fields, cmsBoundField)}
                            title={responsiveOverrides.has(prop.name)
                              ? `Bound to CMS field "${cmsBoundField}" for this viewport`
                              : `Inherits the CMS field "${cmsBoundField}" from the base viewport`}
                            onUnbind={() => {
                              setPropOptimistic(prop.name, prop.defaultValue ?? '');
                              unbindPropForViewport(prop.name, prop.defaultValue ?? '');
                            }}
                          />
                        : <CmsBoundPill
                            property={prop.name}
                            fallbackValue={prop.defaultValue ?? ''}
                            // Swap to the static editor in the SAME frame as the
                            // click; without it the row empties for a few frames
                            // while the write round-trips and the input visibly
                            // animates in (user report 2026-08-08).
                            onUnbound={(fallback) => setPropOptimistic(prop.name, fallback)}
                          />}
                    </div>
                  </HoistMenuItemProvider>
                );
              }

              // Detached CMS binding → "Missing" pill (same chrome, data source gone).
              // × forgets it (revert to default); re-entry into a collection re-binds.
              if (orphanField) {
                return (
                  <div className="flex items-center justify-between w-full" key={prop.name}>
                    <ControlLabel label={prop.label || prop.name} property={cssProp ?? ''} plain />
                    <CmsMissingPill
                      field={orphanField}
                      onClear={() => { if (selectedId) queueMutation({ type: 'clearCmsOrphan', nodeId: selectedId, propName: prop.name }); }}
                    />
                  </div>
                );
              }

              // PER-VIEWPORT VARIABLE pill (replica): this prop has an inline `__mqN ? var : base`
              // binding whose branch covers the current tile → show THAT variable as an override (accent
              // label + X reverts the band to the base). Takes precedence over the base binding pill so
              // the replica reads as its own value, exactly like the per-viewport style/text variables.
              const vpVarRef = isReplica ? responsiveAttrVars.get(prop.name) : undefined;
              if (vpVarRef && parentVarsByName.has(vpVarRef)) {
                trace.fn('ComponentPropsTool:per-viewport-var-pill', { propName: prop.name, vpVarRef, vpWidth });
                const vpSubLabel = humanizeStylePropName(cssProp) ?? propCodeComponentControlMap.get(prop.name)?.label ?? undefined;
                return (
                  <HoistMenuItemProvider key={prop.name} item={hoistMenuItem}>
                    <div className="flex items-center justify-between w-full">
                      <ControlLabel label={prop.label || prop.name} property={cssProp ?? ''} plain={false} overridden onResetOverride={() => handleResetAttrVar(prop.name)} subLabel={vpSubLabel} />
                      <LegacyVariableBoundPill
                        property={cssProp ?? prop.name}
                        propertyLabel={prop.name}
                        variableRef={vpVarRef}
                        currentValue={parentVarsByName.get(vpVarRef) ?? ''}
                        removeVariable={() => handleResetAttrVar(prop.name)}
                        iconKey={parentVars.find(v => v.name === vpVarRef)?.family}
                      />
                    </div>
                  </HoistMenuItemProvider>
                );
              }

              const boundVarRef = parentVarsByName.has(propValue) ? propValue : null;
              // LegacyVariableBoundPill signature: (property, varName, defValue)
              // We don't use any of the params — the pill is per-instance-prop
              // and the literal fallback is captured in closure from the
              // parent variable's default.
              const removeBoundVar = (_property: string, _name: string, _def: string) => {
                const fallback = parentVarsByName.get(propValue) ?? prop.defaultValue ?? '';
                handlePropChange(prop.name, fallback, prop.defaultValue);
              };

              if (boundVarRef) {
                trace.fn('ComponentPropsTool:variable-bound-pill', { propName: prop.name, boundVarRef });
                // Sub-label: CSS friendly name, else the Code component control's label
                // (so a HOISTED code component variable's purple pill keeps its
                // "Color" / "Font Size" sub-label instead of losing it).
                const boundSubLabel = humanizeStylePropName(cssProp) ?? propCodeComponentControlMap.get(prop.name)?.label ?? undefined;
                return (
                  <HoistMenuItemProvider key={prop.name} item={hoistMenuItem}>
                    <div className="flex items-center justify-between w-full">
                      <ControlLabel label={prop.label || prop.name} property={cssProp ?? ''} plain={false} hideLocalize extraMenuItems={localizeMenuItem(prop.name, propValue)} overridden={propOverridden || localePropOverride(prop.name).overridden} onResetOverride={localePropOverride(prop.name).reset ?? propResetOverride} subLabel={boundSubLabel} />
                      <LegacyVariableBoundPill
                        property={cssProp ?? prop.name}
                        propertyLabel={prop.name}
                        variableRef={boundVarRef}
                        currentValue={parentVarsByName.get(boundVarRef) ?? ''}
                        removeVariable={removeBoundVar}
                        // Glyph from the bound variable's declared type (toggle→switch, number→#, …) — the
                        // CSS prop (display/flexWrap) is ambiguous and would resolve to the generic cube.
                        iconKey={parentVars.find(v => v.name === boundVarRef)?.family}
                      />
                    </div>
                  </HoistMenuItemProvider>
                );
              }

              // TYPED-VARIABLE editors FIRST (the reference model): resolve the editor from the variable's
              // DECLARED data type, not the CSS property it happens to drive. A Toggle (Hide/Wrap) gets a
              // Yes/No segmented control — NOT the display/flex-wrap value <select>; an Option gets a
              // dropdown of its @propMeta choices; a Number gets a numeric input. Color/image/border/
              // shadow keep the richer atom path below (their full pickers beat a bare primitive editor).
              if (prop.varType === 'toggle') {
                return (
                  <HoistMenuItemProvider key={prop.name} item={hoistMenuItem}>
                    <div className="flex items-center justify-between w-full">
                      <ControlLabel label={prop.label || prop.name} property={cssProp ?? ''} plain={false} hideLocalize extraMenuItems={localizeMenuItem(prop.name, propValue)} overridden={propOverridden || localePropOverride(prop.name).overridden} onResetOverride={localePropOverride(prop.name).reset ?? propResetOverride} subLabel={humanizeStylePropName(cssProp) ?? undefined} />
                      <LocalePropPillOr nodeId={selectedId} componentName={componentName!} prop={prop.name} propLabel={prop.label || prop.name} fallback={cleanPropFallback(propValue, prop.defaultValue)} options={[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]}><ToolSegmentedControl
                        value={propValue === 'true' ? 'true' : 'false'}
                        onChange={(v) => handlePropChange(prop.name, v, prop.defaultValue)}
                        options={[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]}
                        size="sm"
                      /></LocalePropPillOr>
                    </div>
                  </HoistMenuItemProvider>
                );
              }
              if (prop.varType === 'option') {
                const opts = layoutAwareOptions(prop.name, cssProp, getPropOptions(masterCode, prop.name).map(o => ({ value: o, label: o })));
                return (
                  <HoistMenuItemProvider key={prop.name} item={hoistMenuItem}>
                    <div className="flex items-center justify-between w-full">
                      <ControlLabel label={prop.label || prop.name} property={cssProp ?? ''} plain={false} hideLocalize extraMenuItems={localizeMenuItem(prop.name, propValue)} overridden={propOverridden || localePropOverride(prop.name).overridden} onResetOverride={localePropOverride(prop.name).reset ?? propResetOverride} subLabel={humanizeStylePropName(cssProp) ?? undefined} />
                      <LocalePropPillOr nodeId={selectedId} componentName={componentName!} prop={prop.name} propLabel={prop.label || prop.name} fallback={cleanPropFallback(propValue, prop.defaultValue)} options={opts}><ToolSelect value={propValue} onChange={(v) => handlePropChange(prop.name, v, prop.defaultValue)} options={opts} /></LocalePropPillOr>
                    </div>
                  </HoistMenuItemProvider>
                );
              }
              if (prop.varType === 'number') {
                return (
                  <HoistMenuItemProvider key={prop.name} item={hoistMenuItem}>
                    <div className="flex items-center justify-between w-full">
                      <ControlLabel label={prop.label || prop.name} property={cssProp ?? ''} plain={false} hideLocalize extraMenuItems={localizeMenuItem(prop.name, propValue)} overridden={propOverridden || localePropOverride(prop.name).overridden} onResetOverride={localePropOverride(prop.name).reset ?? propResetOverride} subLabel={humanizeStylePropName(cssProp) ?? undefined} />
                      <LocalePropPillOr nodeId={selectedId} componentName={componentName!} prop={prop.name} propLabel={prop.label || prop.name} fallback={cleanPropFallback(propValue, prop.defaultValue)}><NumberVariableEditor
                        value={propValue}
                        onChange={(v) => handlePropChange(prop.name, v, prop.defaultValue)}
                        onChangeLive={(v) => previewProp(prop.name, v)}
                        meta={getPropNumberMeta(masterCode, prop.name)}
                      /></LocalePropPillOr>
                    </div>
                  </HoistMenuItemProvider>
                );
              }

              // Variable-editor registry FIRST: when the prop maps to a CSS
              // property with a rich atom (Shadow / Filter / Padding / etc.),
              // mount that atom in `variableDefault` mode so the instance gets
              // Preset applied to this variable → render the BLUE preset pill
              // (name + ×), exactly like the Styles tool when a style is bound
              // to a preset. Takes precedence over the raw editor. Clicking ×
              // clears the value (reverts to the master default). Detected for
              // single-token `var(--x)` and composed border shorthands.
              const presetRef = detectPresetRefValue(propValue);
              if (presetRef) {
                trace.fn('ComponentPropsTool:preset-pill', { propName: prop.name, presetRef });
                return (
                  <HoistMenuItemProvider key={prop.name} item={hoistMenuItem}>
                    <VariablePresetPillRow
                      rowLabel={prop.label || prop.name}
                      subLabel={humanizeStylePropName(cssProp) ?? undefined}
                      plain={!hoistMenuItem}
                      cssProp={cssProp ?? ''}
                      presetRef={presetRef}
                      presetTokens={presetTokens}
                      Atom={cssProp ? resolveVariableEditor(cssProp) : null}
                      onDetach={() => handlePropChange(prop.name, '', prop.defaultValue)}
                    />
                  </HoistMenuItemProvider>
                );
              }

              // Variable-editor registry FIRST: when the prop maps to a CSS
              // property with a rich atom (Shadow / Filter / Padding / etc.),
              // mount that atom in `variableDefault` mode so the instance gets
              // the same editor the master uses. Without this, compound props
              // fall to a plain text input — exactly the user-reported bug.
              const VariableAtom = cssProp ? resolveVariableEditor(cssProp) : null;
              if (VariableAtom) {
                trace.fn('ComponentPropsTool:rich-atom', { propName: prop.name, cssProp });
                const onChange = (v: string) => handlePropChange(prop.name, v, prop.defaultValue);
                // `LabelOverrideProvider` swaps the atom's hardcoded
                // label (e.g. "Background") with the user's prop /
                // variable name as the primary line and demotes the
                // atom's own label to the muted sub-line. Without this
                // wrap, every hoisted variable shows up as the generic
                // CSS name ("Background", "Padding", "Shadow") with
                // the user's variable name nowhere in the UI — exactly
                // the user-reported "I lost my hoisted variable
                // names" bug. Outside this branch (StylesTool, etc.)
                // the override context is null and atoms keep their
                // original hardcoded labels.
                const subLabel = humanizeStylePropName(cssProp) ?? undefined;
                return (
                  <HoistMenuItemProvider key={prop.name} item={hoistMenuItem}>
                    <LabelOverrideProvider label={prop.varType === 'transition' ? (prop.label || prop.name) : prop.name} subLabel={subLabel} overridden={propOverridden} onResetOverride={propResetOverride}>
                      {/* gap-2 (not gap-1) so multi-row atoms — Shadow / Mask
                          EntryList — space their stacked entries the same as
                          every other row in the panel (which uses gap-2). */}
                      <div className="flex flex-col gap-2 w-full">
                        {(() => {
                          // The instance stores a transition as a deploy-correct OBJECT LITERAL
                          // (`{ type: 'spring', duration: 0.5 }`), but TransitionVariableEditor reads JSON
                          // (`{"type":"spring","duration":"0.5"}`). Convert literal→JSON so the editor reflects the
                          // SAVED value instead of reverting to "Default" on commit (the live preview was JSON; the
                          // committed currentValue is the literal). Non-transition atoms read their value as-is.
                          const editorValue = prop.varType === 'transition' ? transitionLiteralToJSON(propValue) : propValue;
                          return (
                            <UnifiedControlProvider
                              property={cssProp!}
                              mode="variableDefault"
                              externalValue={editorValue}
                              externalOnChange={onChange}
                              externalOnChangeLive={(v) => previewProp(prop.name, v)}
                            >
                              <VariableAtom mode="variableDefault" externalValue={editorValue} externalOnChange={onChange} />
                            </UnifiedControlProvider>
                          );
                        })()}
                      </div>
                    </LabelOverrideProvider>
                  </HoistMenuItemProvider>
                );
              }

              const registryDef = cssProp ? resolveControl(cssProp) : null;

              trace.fn('ComponentPropsTool:resolve-control', { propName: prop.name, cssProp, resolvedType: registryDef?.type ?? 'text' });

              // Every non-rich-atom branch is wrapped in
              // `HoistMenuItemProvider` too so its inner `ControlLabel`
              // picks the Hoist item up via the same context as the
              // rich-atom branch above — single source for the item.

              // Custom component
              if (registryDef?.type === 'custom') {
                const Comp = registryDef.component;
                return (
                  <HoistMenuItemProvider key={prop.name} item={hoistMenuItem}>
                    <div>
                      <ControlLabel label={prop.label || prop.name} property={cssProp!} plain={false} hideLocalize extraMenuItems={localizeMenuItem(prop.name, propValue)} overridden={propOverridden || localePropOverride(prop.name).overridden} onResetOverride={localePropOverride(prop.name).reset ?? propResetOverride} subLabel={humanizeStylePropName(cssProp) ?? undefined} />
                      <Comp property={cssProp!} value={propValue}
                        onChange={(v) => handlePropChange(prop.name, v, prop.defaultValue)} label={prop.name} />
                    </div>
                  </HoistMenuItemProvider>
                );
              }

              // Numeric (slider + input)
              if (registryDef?.type === 'numeric') {
                const numValue = parseFloat(propValue) || 0;
                return (
                  <HoistMenuItemProvider key={prop.name} item={hoistMenuItem}>
                    <div className="flex items-center justify-between w-full">
                      <ControlLabel label={prop.label || prop.name} property={cssProp!} plain={false} hideLocalize extraMenuItems={localizeMenuItem(prop.name, propValue)} overridden={propOverridden || localePropOverride(prop.name).overridden} onResetOverride={localePropOverride(prop.name).reset ?? propResetOverride} subLabel={humanizeStylePropName(cssProp) ?? undefined} />
                      <div className="flex items-center gap-2 w-full">
                        <ToolSlider value={numValue} min={registryDef.min ?? 0} max={registryDef.max ?? 100}
                          step={registryDef.step ?? 1}
                          onChange={(v) => {
                            const unit = propValue.replace(/^-?[\d.]+/, '') || 'px';
                            handlePropChange(prop.name, `${v}${unit}`, prop.defaultValue);
                          }} />
                        <ToolInput value={String(numValue)}
                          onChange={(v) => {
                            const unit = propValue.replace(/^-?[\d.]+/, '') || 'px';
                            handlePropChange(prop.name, `${parseFloat(v) || 0}${unit}`, prop.defaultValue);
                          }}
                          step={registryDef.step ?? 1} />
                      </div>
                    </div>
                  </HoistMenuItemProvider>
                );
              }

              // Select (dropdown)
              if (registryDef?.type === 'select') {
                return (
                  <HoistMenuItemProvider key={prop.name} item={hoistMenuItem}>
                    <div className="flex items-center justify-between w-full">
                      <ControlLabel label={prop.label || prop.name} property={cssProp!} plain={false} hideLocalize extraMenuItems={localizeMenuItem(prop.name, propValue)} overridden={propOverridden || localePropOverride(prop.name).overridden} onResetOverride={localePropOverride(prop.name).reset ?? propResetOverride} subLabel={humanizeStylePropName(cssProp) ?? undefined} />
                      <LocalePropPillOr nodeId={selectedId} componentName={componentName!} prop={prop.name} propLabel={prop.label || prop.name} fallback={cleanPropFallback(propValue, prop.defaultValue)} options={registryDef.options}><ToolSelect value={propValue}
                        onChange={(v) => handlePropChange(prop.name, v, prop.defaultValue)}
                        options={registryDef.options} /></LocalePropPillOr>
                    </div>
                  </HoistMenuItemProvider>
                );
              }

              // Component-cursor row: the prop drives a
              // `withCursor(propName, …)` call somewhere down the chain
              // (direct on the master, or forwarded into a nested
              // instance whose corresponding prop is itself a cursor
              // var). Render a BUTTON that opens the full cursor-controls
              // popup (Component picker + Mode + Size + Position + Align +
              // Offset + Transition + Enter/Exit) — same editor the
              // master uses. The Component picker writes the instance prop
              // (`<Inst propName={Chosen} />` + import); the behaviour
              // opts write back to the master's `withCursor(propName, …)`
              // call. A plain ToolSelect (the old behaviour) only let the
              // user pick the component and hid every other cursor knob.
              if (propCursorVarSet.has(prop.name)) {
                return (
                  <HoistMenuItemProvider key={prop.name} item={hoistMenuItem}>
                    <CursorVariableInstanceRow
                      label={prop.name}
                      currentComponent={propValue}
                      masterFile={componentFile}
                      propName={prop.name}
                      instanceNodeId={selectedId!}
                      instanceComponentName={componentInfo.name}
                      activeFile={activeFile}
                      onChanged={() => {
                        const refreshed = projectFS.readFile(activeFile);
                        if (refreshed) { setCode(refreshed); setVersion(v => v + 1); }
                      }}
                    />
                  </HoistMenuItemProvider>
                );
              }

              // Variant select: the prop is forwarded as
              // `<NestedChild initialVariant={propName}/>` somewhere in
              // the active master file. Render a select with the child
              // component's variant names so the user can pick a
              // variant the same way the chevron-Variant row offers it
              // one level down. Without this, hoisted variant variables
              // surfaced as a plain text input on the parent — the
              // user-reported "type 'variant-1' instead of picking from
              // a list" bug.
              const variantOpts = propVariantOptionsMap.get(prop.name);
              if (variantOpts) {
                return (
                  <HoistMenuItemProvider key={prop.name} item={hoistMenuItem}>
                    <div className="flex items-center justify-between w-full">
                      <ControlLabel label={prop.label || prop.name} property={cssProp ?? ''} plain={false} hideLocalize extraMenuItems={localizeMenuItem(prop.name, propValue)} overridden={propOverridden || localePropOverride(prop.name).overridden} onResetOverride={localePropOverride(prop.name).reset ?? propResetOverride} subLabel={humanizeStylePropName(cssProp) ?? undefined} />
                      <ToolSelect value={propValue}
                        onChange={(v) => handlePropChange(prop.name, v, prop.defaultValue)}
                        options={variantOpts} />
                    </div>
                  </HoistMenuItemProvider>
                );
              }

              // Code component control: the prop forwards into a code component's
              // `@control` (e.g. `<FilmGrain intensity={prop}/>`). Render the
              // code component's REAL control (color picker / slider / etc.) so the
              // variable's editor matches what it controls — not a bare text
              // input. The variable was created FROM that control, so this
              // closes the loop.
              const codeComponentControl = propCodeComponentControlMap.get(prop.name);
              if (codeComponentControl) {
                return (
                  <HoistMenuItemProvider key={prop.name} item={hoistMenuItem}>
                    <div className="flex items-center justify-between w-full">
                      <ControlLabel label={prop.label || prop.name} property="" plain={false} hideLocalize extraMenuItems={localizeMenuItem(prop.name, propValue)} overridden={propOverridden || localePropOverride(prop.name).overridden} onResetOverride={localePropOverride(prop.name).reset ?? propResetOverride} subLabel={codeComponentControl.label} />
                      {/* Wrap in the standard value-column so the label↔control
                          gap matches the normal component-prop rows (CodeComponentControlField
                          otherwise renders a bare control with too little gap). */}
                      <div className="flex items-center gap-2 w-full">
                        <CodeComponentControlField
                          controlDef={codeComponentControl}
                          value={propValue}
                          onChange={(v) => handlePropChange(prop.name, v, prop.defaultValue)}
                          onChangeLive={(v) => previewProp(prop.name, v)}
                        />
                      </div>
                    </div>
                  </HoistMenuItemProvider>
                );
              }

              // Link-attribute variable (href / new-tab / smooth-scroll, made
              // via the Link tool). Render the matching control: href → text
              // input (the link); newTab / smooth → Yes/No toggle (the value
              // is a boolean variable). Without this they fell to a raw
              // text field showing `true`/`false`.
              const linkKind = propLinkAttrMap.get(prop.name);
              if (linkKind) {
                // href → a button opening the "Link" popup (page/CMS picker +
                // Section anchor dropdown). newTab/smooth → Yes/No toggle.
                if (linkKind === 'href') {
                  return (
                    <HoistMenuItemProvider key={prop.name} item={hoistMenuItem}>
                      <LinkVariableInstanceRow
                        label={prop.name}
                        subLabel="Link To"
                        propName={prop.name}
                        value={propValue}
                        defaultValue={prop.defaultValue}
                        labelPlain={!hoistMenuItem}
                        onChange={handlePropChange}
                        cmsBinding={cmsBinding}
                        onSetExpr={handleSetLinkExpr}
                      />
                    </HoistMenuItemProvider>
                  );
                }
                // tracking → a plain text id input (placeholder "ID").
                if (linkKind === 'tracking') {
                  return (
                    <HoistMenuItemProvider key={prop.name} item={hoistMenuItem}>
                      <div className="flex items-center justify-between w-full">
                        <ControlLabel label={prop.label || prop.name} property={cssProp ?? ''} plain={false} hideLocalize extraMenuItems={localizeMenuItem(prop.name, propValue)} overridden={propOverridden || localePropOverride(prop.name).overridden} onResetOverride={localePropOverride(prop.name).reset ?? propResetOverride} subLabel="Tracking" />
                        <div className="flex items-center gap-2 w-full">
                          <ToolInput value={propValue} onChange={(v) => handlePropChange(prop.name, v, prop.defaultValue)} placeholder="ID" text />
                        </div>
                      </div>
                    </HoistMenuItemProvider>
                  );
                }
                // rel → the same token-list editor as the master (No Follow /
                // No Referrer / Me / UGC / Sponsored + Add…).
                if (linkKind === 'rel') {
                  return (
                    <HoistMenuItemProvider key={prop.name} item={hoistMenuItem}>
                      {/* mt on the label centers it with the first token row
                          without a w-3/4 wrapper (which would shrink the value
                          column — the label's -ml-[18px] footprint must stay). */}
                      <div className="flex items-start justify-between w-full [&>:first-child]:mt-[5px]">
                        <ControlLabel label={prop.label || prop.name} property={cssProp ?? ''} plain={false} hideLocalize extraMenuItems={localizeMenuItem(prop.name, propValue)} overridden={propOverridden || localePropOverride(prop.name).overridden} onResetOverride={localePropOverride(prop.name).reset ?? propResetOverride} subLabel="Rel" />
                        <LinkRelControl value={propValue} onChange={(v) => handlePropChange(prop.name, v, prop.defaultValue)} />
                      </div>
                    </HoistMenuItemProvider>
                  );
                }
                // params → Keep/Ignore toggle.
                if (linkKind === 'params') {
                  return (
                    <HoistMenuItemProvider key={prop.name} item={hoistMenuItem}>
                      <div className="flex items-center justify-between w-full">
                        <ControlLabel label={prop.label || prop.name} property={cssProp ?? ''} plain={false} hideLocalize extraMenuItems={localizeMenuItem(prop.name, propValue)} overridden={propOverridden || localePropOverride(prop.name).overridden} onResetOverride={localePropOverride(prop.name).reset ?? propResetOverride} subLabel="Parameters" />
                        <ToolSegmentedControl
                          value={propValue === 'true' ? 'keep' : 'ignore'}
                          onChange={(v) => handlePropChange(prop.name, v === 'keep' ? 'true' : 'false', prop.defaultValue)}
                          options={[{ value: 'keep', label: 'Keep' }, { value: 'ignore', label: 'Ignore' }]}
                          size="sm"
                        />
                      </div>
                    </HoistMenuItemProvider>
                  );
                }
                // newTab / smooth → Yes/No toggle.
                return (
                  <HoistMenuItemProvider key={prop.name} item={hoistMenuItem}>
                    <div className="flex items-center justify-between w-full">
                      <ControlLabel label={prop.label || prop.name} property={cssProp ?? ''} plain={false} hideLocalize extraMenuItems={localizeMenuItem(prop.name, propValue)} overridden={propOverridden || localePropOverride(prop.name).overridden} onResetOverride={localePropOverride(prop.name).reset ?? propResetOverride} subLabel={linkKind === 'newTab' ? 'New Tab' : 'Smooth Scroll'} />
                      <ToolSegmentedControl
                        value={propValue === 'true' ? 'yes' : 'no'}
                        onChange={(v) => handlePropChange(prop.name, v === 'yes' ? 'true' : 'false', prop.defaultValue)}
                        options={YES_NO_OPTIONS}
                        size="sm"
                      />
                    </div>
                  </HoistMenuItemProvider>
                );
              }

              // Fallback: generic text input
              return (
                <HoistMenuItemProvider key={prop.name} item={hoistMenuItem}>
                  <div className="flex items-center justify-between w-full">
                    <ControlLabel label={prop.label || prop.name} property={cssProp ?? ''} plain={false} hideLocalize extraMenuItems={localizeMenuItem(prop.name, propValue)} overridden={propOverridden || localePropOverride(prop.name).overridden} onResetOverride={localePropOverride(prop.name).reset ?? propResetOverride} />
                    <LocalePropPillOr nodeId={selectedId} componentName={componentName!} prop={prop.name} propLabel={prop.label || prop.name} fallback={cleanPropFallback(propValue, prop.defaultValue)}><ToolInput value={propValue}
                      onChange={(v) => handlePropChange(prop.name, v, prop.defaultValue)} text /></LocalePropPillOr>
                  </div>
                </HoistMenuItemProvider>
              );
            })}
          </div>
        </div>
      )}
      <ToolDivider />
      {/* Shared "Create / Hoist Variable" modal (see `variableModal` above).
          For design-component prop rows this is the hoist flow; the modal's
          left rail lists the master's existing props and picking one binds to
          it, while creating a new one hoists the prop up. */}
      {variableModal}
    </>
  );
}
