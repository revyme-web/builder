// ControlLabel.tsx — Clickable property label with dropdown menu for variable/override ops.
// Exact UX port from old builder's ControlLabel.
//
// Visual states:
//   Default:      text-xs font-bold text-[var(--text-secondary)]
//   Has override: text-[var(--accent-text)] (blue)
//   Hover master: text-[var(--accent-secondary)] (purple)
//   Hover page:   text-[var(--text-primary)]
//   Has variable: two-line stack (var name + property label)
//
// Left chevron arrow on hover, shifts 2px left.
// Dropdown menu portal'd to document.body with backdrop.

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useAtomValue, useSetAtom } from 'jotai';
import { isComponentFileAtom, variableModalRequestAtom, canvasInteractingAtom } from '@/code/stores/store';
import { buildComponentRegistry, parseComponentInfoFromSource, STRUCTURAL_PROPS, type ComponentProp } from '@/code/components/component-registry';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { getPropLabel } from '@/code/components/prop-meta';
import { localCssPropForVar } from '@/code/components/prop-css-mapping';
import { resolveVariableIconKey, acceptedVariableFamilies } from './VariableTypeIcon';
import { copiedStyleAtom, buildCopiedStyle, canPasteStyle, buildPastePayload, isMotionTransformTarget } from './style-clipboard';
import { getVariableType } from './variable-types';
import { activeLocaleAtom, isDefaultLocaleAtom, localeOverridesAtom } from '@/code/stores/locale-store';
import { activeFilePathAtom, isTemplateFilePath } from '@/code/project/active-file-store';
import { setNodeOverride } from '@/code/project/locale-ops';
import { presetTokensAtom } from '@/code/stores/preset-store';
import { pageVariablesAtom } from '@/code/stores/page-variables-store';
import { resolveTokenValue } from '@/code/project/preset-ops';
import { useControl } from './ControlProvider';
import { useControlContextOptional } from './unified/useControlContext';
import { getAllMenuItems, type MenuItem, type MenuContext } from './control-menu-items';
import { useHoistMenuItems } from './hoist-context';
import { useCreateVariableHidden } from './create-variable-gate';
import { instantCreateAndEditVariable } from './instant-create-variable';
import { isPrimaryViewport, findNodeComputedStyleAsync, injectCanvasCSS, removeCanvasCSS, forceRenderAfterExternalEdit } from '@/canvas/node-ops';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { extractStyleCSS } from '@/code/parsing/parser';
import { extractBorderAfterRuleBody } from '../ui/border-utils';
import { trace } from '@/shared/debug-trace';
import { MAP_TEMPLATE_COLOR } from '@/shared/constants';
import PresetPicker from '../ui/PresetPicker';
import LocaleStylePopup from '../ui/LocaleStylePopup';
import { useLocaleStyleState, localeScopeOf } from './LocaleBoundPill';
import { localeOffMarker } from '@/code/generation/locale-gen';
import { toKebab } from '@/shared/css-utils';
import { useLocalizeHidden } from './localize-gate';
import CreatePresetPopup from '../ui/CreatePresetPopup';
import type { PresetToken } from '@/shared/types';

interface ControlLabelProps {
  label: string;
  property: string;
  /** Width-agnostic mode for the shared control-row GRID (ToolRow /
   *  unified ControlRow): the label track is sized by --tool-label-col,
   *  so the legacy flex geometry (w-3/4 + mr-[2px] shim) must not apply.
   *  Legacy hand-rolled flex rows omit this until they migrate (12.3). */
  cell?: boolean;
  /** Render as a plain non-interactive label (no menu, no chevron, no variable). Use inside popups for sub-labels. */
  plain?: boolean;
  /** Render even when the unified context sets `hideLabel`. `hideLabel` hides the atom's redundant OUTER row
   *  label (Variable modal / Template-tool Default editor) — but a popup's structural sub-labels (Transform's
   *  Rotate / Skew / Scale rows) must stay visible. ControlRow's outer label is ALSO `plain`, so we can't key
   *  off `plain`; popup sub-labels set this flag explicitly. */
  forceShow?: boolean;
  hideCreateVariable?: boolean;
  /** Suppress the "Remove" menu entry. Use when the row's displayed
   *  value does NOT come from `styles[property]` (e.g. viewport-frame
   *  Width/Height rows where the value is sourced from the `@canvas`
   *  config) — clearing the CSS would wipe an unrelated value the user
   *  can't see and silently break the page. */
  hideResetStyle?: boolean;
  /** Suppress the "Bind to Field" CMS entry. Use for synthetic properties
   *  where field-binding is meaningless (e.g. the Link tool's Slug control). */
  hideCmsBinding?: boolean;
  /** Suppress the ENTIRE variable menu (Create + bind-to-existing "Set
   *  Variable"). Use when the control injects its own "Set Variable" via
   *  extraMenuItems (the Link tool's Slug control) so the page/component
   *  variable "Set Variable" doesn't show as a duplicate. */
  hideVariableMenu?: boolean;
  /** Hide the built-in STYLE Localize item — instance-PROP rows supply their
   *  own Localize via extraMenuItems (LocalePropPill flow); showing both put
   *  two "Localize" entries in one menu. */
  hideLocalize?: boolean;
  /** Suppress "Copy Style" / "Paste Style". Use for synthetic/non-style
   *  properties (e.g. the Scroll Variant Section row) where there is no node
   *  style to copy. */
  hideCopyPasteStyle?: boolean;
  extraMenuItems?: MenuItem[];
  /** Force the "responsive override" accent on the label even when
   *  `hasOverride(property)` would return false. Used by ContentControl to
   *  show the blue indicator when a per-viewport `textOverrides` entry
   *  applies — overrides for text content live outside the @media style
   *  map that `hasOverride` consults, so we plumb the signal directly. */
  overridden?: boolean;
  /** Custom handler for the "Reset Override" menu item. When provided,
   *  replaces the default `updateStyle(property, '')` action — useful for
   *  properties whose override state lives outside the @media style map
   *  (e.g. ContentControl needs to fire `removeTextOverride` instead). */
  onResetOverride?: () => void;
  /** Secondary label shown on a second line beneath the primary label.
   *  Used by ComponentPropsTool's prop rows to show what underlying
   *  style the user-named prop binds to ("zjeofoizejf" big, "Background"
   *  small) so the user can see which row drives which CSS property. */
  subLabel?: string;
}

/** A `plain` ControlLabel that has an active override: accent-coloured (purple in a
 *  component file, blue on a page) + a chevron that opens a one-item "Reset Override"
 *  dropdown — the same affordance non-plain labels get, for the Collection List
 *  Filters/Sorting rows when editing a replica / variant artboard. */
function PlainOverrideLabel({ label, subLabel, onReset, cell }: { label: string; subLabel?: string; onReset?: () => void; cell?: boolean }) {
  const isComponentFile = useAtomValue(isComponentFileAtom);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const accent = isComponentFile ? 'var(--accent-secondary)' : 'var(--accent)';
  return (
    <div ref={ref} className={`relative min-w-0 pl-[18px] -ml-[18px] select-none${cell ? '' : ' w-3/4 mr-[2px]'}`}>
      <button
        type="button"
        onClick={() => { if (onReset) setOpen(v => !v); }}
        className="flex items-center gap-1 w-full text-left bg-transparent border-none cursor-pointer p-0"
        title={label}
      >
        <span className="text-xs font-bold truncate" style={{ color: accent }}>{label}</span>
        {onReset && (
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" style={{ color: accent }}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>
      {subLabel && <span className="text-[10px] text-[var(--text-disabled)] font-normal block truncate" title={subLabel}>{subLabel}</span>}
      {open && onReset && (
        <>
          <div className="fixed inset-0 z-[100040]" onClick={() => setOpen(false)} />
          <div className="absolute left-[18px] top-full mt-1 z-[100041] bg-[var(--dropdown-bg)] border border-[var(--border-light)] rounded-[var(--radius-md)] shadow-2xl py-1 min-w-[140px]">
            <button
              type="button"
              onClick={() => {
                onReset();
                // Same canvas-sync guarantee the MENU path gets in
                // `getOverrideMenuItems`. This dropdown is a separate
                // affordance that never goes through the menu builder, so
                // without the call here plain-label rows (Collection List
                // Filters/Sorting, hoisted-variable rows, SketchTool rows, …)
                // would reset the code and leave the canvas stale — the exact
                // half of the "works one time out of two" report.
                forceRenderAfterExternalEdit('control-label:plain-reset-override', { label });
                setOpen(false);
              }}
              className="group flex items-center w-full px-3 py-1.5 text-left cursor-pointer bg-transparent hover:!bg-[var(--accent)] border-none whitespace-nowrap"
            >
              <span className="text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-fg)]">Reset Override</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default function ControlLabel({ label, property, plain, forceShow, hideCreateVariable, hideResetStyle, hideCmsBinding, hideVariableMenu, hideCopyPasteStyle, hideLocalize, extraMenuItems, overridden, onResetOverride, subLabel, cell }: ControlLabelProps) {
  // Hidden entirely when the unified context requests it (Variable modal's Default row — the FieldRow
  // already labels it; the atom's own "Background"/"Border" label would be redundant). Hook is called
  // unconditionally (Rules of Hooks); the optional variant returns null outside a unified provider.
  const unifiedCtx = useControlContextOptional();
  // `hideLabel` suppresses the atom's OWN (redundant) OUTER row label in the Variable modal / Template-tool
  // Default editor (the FieldRow / variable row already names it). ControlRow sets `plain` on that outer label
  // too, so we CANNOT key off `plain` — doing so also un-hid the outer label → a DOUBLE "Transform" (in the
  // panel AND the variable modal's Default row). A popup's structural SUB-labels (Transform's Rotate / Skew /
  // Scale rows) opt back in explicitly via `forceShow` so they stay visible while the outer label stays hidden.
  if (unifiedCtx?.hideLabel && !forceShow) return null;

  // Plain mode: simple styled label, no menu/variable/override logic.
  // Typography + `pl-[18px] -ml-[18px]` gutter match the non-plain
  // (button) variant so a row mixing plain and non-plain labels (or two
  // rows with different mode choices stacked together) still align
  // perfectly in the value column. The negative margin pulls the box
  // 18 px LEFT into the chevron's gutter zone — there's no chevron to
  // render here, but the recovered horizontal space gives the value
  // column the same width as siblings that DO have a chevron.
  //
  // The `mr-[2px]` shim is what makes a plain-label row (`<span>`) sit
  // in the same column as a non-plain-label row (`<button>`) elsewhere
  // in the panel. Empirically the `<button>` flex sibling measures 2 px
  // wider than the `<span>` equivalent with otherwise-identical width /
  // padding / negative-margin classes — so without this margin the
  // plain row's value-button visibly extends 2 px further left than its
  // non-plain neighbour. Visible symptom in the user-reported case:
  // a hoisted-variable Background row's color pill 2 px wider on the
  // left than the Border row directly below it.
  if (plain) {
    // A plain label that carries a responsive/variant OVERRIDE renders in the
    // accent (blue page / purple component) with a chevron → "Reset Override",
    // matching the standard non-plain override UX. Used by the Collection List
    // Filters/Sorting rows on a replica / variant artboard.
    if (overridden) {
      return <PlainOverrideLabel label={label} subLabel={subLabel} onReset={onResetOverride} cell={cell} />;
    }
    // `truncate` + `block` keeps long label names (`initialVarianthoist`,
    // `transitiontransition2`, etc.) from pushing the value column to the
    // right. The w-3/4 box already caps the row's left half — truncation
    // inside it means the value-column widths stay stable regardless of
    // how long the user-chosen variable name is. `min-w-0` lets the flex
    // child shrink below its content's intrinsic min-width so the
    // ellipsis actually appears instead of overflowing.
    if (subLabel) {
      // `pr-2` keeps the truncated variable name (the two-line component-tool
      // label) from butting right up against the value column. Short labels
      // never truncate so they keep natural whitespace; a long name like
      // `zeagzegazeg…` would otherwise touch the value without this gap.
      return (
        <span className={`min-w-0 select-none pl-[18px] -ml-[18px] pr-2 flex flex-col leading-tight${cell ? '' : ' w-3/4 mr-[2px]'}`}>
          <span className="text-xs font-bold text-[var(--text-secondary)] block truncate" title={label}>{label}</span>
          <span className="text-[10px] text-[var(--text-disabled)] font-normal block truncate" title={subLabel}>{subLabel}</span>
        </span>
      );
    }
    return (
      <span className={`min-w-0 text-xs font-bold text-[var(--text-secondary)] select-none pl-[18px] -ml-[18px] block truncate${cell ? '' : ' w-3/4 mr-[2px]'}`} title={label}>
        {label}
      </span>
    );
  }

  const {
    nodeId, node, styles, vpId, isReplica, vpWidth,
    hasOverride, getValueSource,
    createVariable, removeVariable, updateStyle, updateStyleLive, updateMultipleStyles,
    mapOverride, cmsBinding,
  } = useControl();

  const isMapOverridden = mapOverride?.isOverridden(property) ?? false;

  // Custom in-memory style clipboard (Copy Style / Paste Style on the label menu).
  const copiedStyle = useAtomValue(copiedStyleAtom);
  const setCopiedStyle = useSetAtom(copiedStyleAtom);

  const isComponentFile = useAtomValue(isComponentFileAtom);
  const isPrimary = isPrimaryViewport(vpId);

  // Locale awareness
  const activeLocale = useAtomValue(activeLocaleAtom);
  const isDefaultLocale = useAtomValue(isDefaultLocaleAtom);
  const localizeHidden = useLocalizeHidden();
  const localeOverrides = useAtomValue(localeOverridesAtom);
  const setLocaleOverrides = useSetAtom(localeOverridesAtom);
  const activeFilePath = useAtomValue(activeFilePathAtom);

  // Preset tokens
  const presetTokens = useAtomValue(presetTokensAtom);
  const pageVariables = useAtomValue(pageVariablesAtom);
  // Bumped on every mutation flush — memos that read the registry/code must subscribe or they go stale
  // (e.g. a color variable created on one node wouldn't appear in another node's "Set Variable" until
  // the property/file changed). Reused by componentVariables AND the bound-label resolver below.
  const projectVersion = useAtomValue(projectVersionAtom);
  // Existing COMPONENT variables (props) for the "Set Variable" submenu. Mirrors the VariableModal:
  // read the component's function-signature props from the registry — NOT just the ones currently
  // bound to this property — so ORPHAN variables (created then ×-unbound, which now keeps the prop)
  // still show up to re-bind. Structural props (style/initialVariant/ref/…) are excluded.
  //
  // TYPE MATCH: only show variables of the SAME type as this control — a Border control offers only
  // border variables, Shadow only shadow, etc. We compare the "type family" via the icon-key mapping
  // (the same one that drives the variable glyphs): a variable's family comes from its stored varType
  // (typed "+" variables) or, for style-bound variables, from the CSS prop it drives / its value shape;
  // the control's family comes from its `property`. Equal family ⇒ compatible. Without this the submenu
  // listed EVERY variable (e.g. a border slot offered transition/shadow/cursor), letting you bind a
  // type-mismatched variable. Page files use `pageVariables` (already type-filtered); skip here.
  // Reuse the last result WHILE a drag/resize/pan is in flight. This memo runs `buildComponentRegistry` + a
  // full-file `parseComponentInfoFromSource` for EVERY ControlLabel in the panel, and it only fires for
  // component-like files (templates), which is the entire reason a template feels heavier to drag than a Page
  // (a Page has isComponentFile=false → this returns undefined immediately). The properties panel re-renders
  // continuously during an interaction and projectVersion can bump on each commit, so without this gate the
  // whole registry+parse re-runs mid-drag. Variable bindings can't change during a drag, so hold the last
  // value in a ref and recompute ONCE when `canvasInteractingAtom` flips back to false (drop). This is what
  // makes a template drag finally match a Page.
  const isCanvasInteracting = useAtomValue(canvasInteractingAtom);
  const lastComponentVarsRef = useRef<Array<{ name: string; default: string; label: string }> | undefined>(undefined);
  const componentVariables = useMemo(() => {
    if (isCanvasInteracting) return lastComponentVarsRef.current;
    const compute = (): Array<{ name: string; default: string; label: string }> | undefined => {
    if (!isComponentFile) return undefined;
    const registry = buildComponentRegistry(projectFS, projectVersion);
    let props: ComponentProp[] = [];
    for (const info of registry.values()) {
      if (info.filePath === activeFilePath) { props = info.props; break; }
    }
    const code = projectFS.readFile(activeFilePath) ?? '';
    // Templates (LayoutClient.tsx) aren't scanned into the `components/` registry,
    // so parse the source directly — otherwise a template's color/etc. variables
    // never populate the "Set Variable" submenu (mirrors VariableModal /
    // ComponentPropsTool's same fallback).
    if (props.length === 0 && isTemplateFilePath(activeFilePath) && code) {
      props = parseComponentInfoFromSource(activeFilePath, code, String(code.length))?.props ?? [];
    }
    const controlFamilies = acceptedVariableFamilies(property);
    // A control whose own type is unknown ('generic') can't determine compatibility — offer NOTHING
    // rather than cross-matching every other unknown variable (the bug where a text Content control
    // listed direction/align because all three resolved to 'generic').
    if (controlFamilies.every(f => f === 'generic')) return undefined;
    const out = props
      .filter(p => !STRUCTURAL_PROPS.has(p.name))
      .filter(p => {
        // `componentCursor` and the CSS `cursor` property share the cursor icon but are DISTINCT types.
        // Component cursors are bound only via the Cursor tool's own menu — never offered in a style
        // control's "Set Variable" (so the web-cursor control can't pick a component-cursor variable).
        if (p.varType === 'componentCursor') return false;
        const varFamily = getVariableType(p.varType)?.iconKey
          // Pass the declared page-var type (boolean/number/text/color/image) so a typed variable resolves
          // its family even when ORPHANED (no live binding to infer a CSS prop from) — e.g. a boolean
          // `hide` var that was just ×-unbound still shows in a Hide control's "Set Variable".
          ?? resolveVariableIconKey({ pageVarType: p.varType, property: localCssPropForVar(p.name, code), value: p.defaultValue ?? '' });
        // A variable of unknown family is never offered — only exact, known family matches.
        if (varFamily === 'generic') return false;
        return controlFamilies.includes(varFamily);
      })
      .map(p => ({ name: p.name, default: p.defaultValue ?? '', label: p.label || p.name }));
    return out.length > 0 ? out : undefined;
    };
    const result = compute();
    lastComponentVarsRef.current = result;
    return result;
  }, [isComponentFile, activeFilePath, property, projectVersion, isCanvasInteracting]);

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  // "Create Variable" creates the variable immediately (auto-name) and opens the SAME manage modal as
  // the header "+", focused on the new entry — no separate create form. We drive that modal through a
  // GLOBAL atom + single <VariableModalHost>, not local state: compound controls (Shadow/Fill/Border)
  // re-render into a different ControlLabel the instant a variable binds, which would unmount a locally
  // owned modal before it could render. See `variableModalRequestAtom`.
  const setVariableModalRequest = useSetAtom(variableModalRequestAtom);
  const [presetPickerOpen, setPresetPickerOpen] = useState(false);
  const [localizeOpen, setLocalizeOpen] = useState(false);
  const [createPresetCategory, setCreatePresetCategory] = useState<PresetToken['category'] | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Cascading submenu state — when an item with `submenuItems` is hovered,
  // we render a second menu portal positioned next to the parent menu. Two
  // separate portals (parent + child) ensures the child sits above the parent
  // even if a future change wraps the parent in a stacking-context-creating
  // ancestor.
  const [submenuOpen, setSubmenuOpen] = useState<{ items: MenuItem[]; pos: { x: number; y: number } } | null>(null);
  const menuPortalRef = useRef<HTMLDivElement>(null);
  const submenuPortalRef = useRef<HTMLDivElement>(null);

  // textContent is sourced from node.textContent, not node.styles. Treat it
  // here so the variable modal opens with the actual text as its default
  // and the reset/menu logic sees a non-empty value to act on.
  // transition is also outside `styles` — it lives on `node.motionProps`
  // (or inside variant entries / a wrapping <MotionConfig>). Surfacing
  // the resolved object as a JSON-encoded string lets the variable
  // modal's Default Value field pre-fill via the TransitionVariableEditor
  // registered for `'transition'` in variable-editor-registry. Empty
  // object → modal opens with the panel in its "Default" preset.
  const value = property === 'textContent'
    ? (node?.textContent ?? '').replace(/<[^>]*>/g, '')
    : property === 'transition'
      ? JSON.stringify(node?.motionProps?.transition ?? {})
      : styles[property];
  const valueSource = getValueSource(property);
  const hasVar = valueSource.source === 'prop';
  const varRef = valueSource.ref;
  // Show the variable's friendly LABEL (from @propMeta), not the raw camelCase prop id — and keep it in
  // sync when the label is renamed in the modal (re-reads on every projectVersion bump).
  const varDisplayName = useMemo(
    () => (varRef && isComponentFile ? (getPropLabel(projectFS.readFile(activeFilePath) ?? '', varRef) || varRef) : varRef),
    [varRef, isComponentFile, activeFilePath, projectVersion],
  );
  // OR with the caller-supplied `overridden` so callers (notably
  // ContentControl, which manages text-override state outside the @media
  // styles map) can force the blue indicator without having to fake a
  // style override entry.
  // Replica-band locale state — hoisted above isOverride (used there).
  const localeBandState = useLocaleStyleState(property, nodeId ?? null);
  const isOverride = hasOverride(property) || !!overridden
    // Replica :lang band rules (per-replica locale value or removal) are a
    // normal override: same blue label, same Reset Override affordance.
    || (isDefaultLocale && localeBandState.hasBandRules);

  // Check if this property has a locale override. `textContent` is special:
  // text overrides live in `override.text`, not `override.styles[textContent]`,
  // so a text-only override (TipTap commit in non-default locale) wouldn't
  // light the orange indicator without this branch.
  const nodeLocaleOverride = nodeId ? localeOverrides.get(nodeId) : undefined;
  const hasLocaleOverride = (property === 'textContent'
    ? nodeLocaleOverride?.text !== undefined
    : !!(nodeLocaleOverride?.styles?.[property]))
    || (isDefaultLocale && localeBandState.hasBandRules);

  // Check if current value is a preset reference
  const hasPreset = value?.startsWith('var(--') ?? false;

  // Reset Override default for a per-variant CMS override (Fill image rebind/unbind→value,
  // bound Content text, …): when the caller didn't supply its own handler, drop THIS variant's
  // CMS branch so the property reverts to the primary's base binding. Without this the menu's
  // generic fallback (`updateStyle(prop, '')`) writes to the variant object, not the CMS
  // ternary — so "Reset Override" appeared to do nothing on a CMS-bound replica.
  const cmsVariantReset = cmsBinding?.hasVariantOverride(property)
    ? () => cmsBinding.resetVariantOverride(property)
    : undefined;
  // Per-VIEWPORT override living in an inline `__mq` ternary (a variable branch, or a frozen text
  // literal) — NOT a @media rule, so the generic menu reset (`updateStyle(prop,'')`) can't touch it.
  // Route "Reset Override" through `removeVariable`, which drops THIS tile's branch → reverts to the
  // cascaded base. textContent always (its overrides are never @media); styles only when the value is
  // a variable here (a plain @media literal style override still uses the generic clear below).
  const responsiveVarReset = (isReplica && !!vpWidth && isOverride && (property === 'textContent' || hasVar))
    ? () => removeVariable(property, varRef ?? '', value ?? '')
    : undefined;
  const effectiveResetOverride = onResetOverride ?? responsiveVarReset ?? cmsVariantReset;

  // Build menu context
  const menuCtx: MenuContext = {
    property,
    nodeId,
    value,
    hasVariable: hasVar,
    variableRef: varRef,
    hasOverride: isOverride,
    isComponentFile,
    isPrimary,
    isDefaultLocale,
    activeLocale,
    hasLocaleOverride,
    onResetOverride: effectiveResetOverride,
    createVariable,
    removeVariable,
    updateStyle,
    updateStyles: updateMultipleStyles,
    // Full style map (from the unified atom context) so shorthand controls
    // like Margin/Padding can detect a value sitting in the per-side longhands.
    styles: unifiedCtx?.allProps,
    // Copy / Paste Style — snapshot from / restore into the full style map.
    copyStyle: () => {
      // Border may render as a `::after` OVERLAY rule (solid or gradient) in the
      // file's <style> block instead of inline styles — snapshot that too, or a
      // copied overlay/gradient border pastes as nothing (the reported bug).
      // flushNow first: a just-edited overlay may still sit in the mutation queue.
      let borderOverlayCSS: string | null = null;
      if (property === 'border' && nodeId) {
        flushNow();
        const code = projectFS.readFile(activeFilePath) ?? '';
        borderOverlayCSS = extractBorderAfterRuleBody(extractStyleCSS(code), nodeId);
      }
      const copied = buildCopiedStyle(property, unifiedCtx?.allProps ?? styles ?? {}, label, { borderOverlayCSS });
      // `transformCSS` in the trace makes a mis-pasted transform diagnosable
      // from the log alone: it's the canonical form, so an empty value on a
      // component element means the motion props never reached `allProps`
      // (variant-merge problem), not a clipboard problem.
      trace.action('control-label:copy-style', {
        property, nodeId, hasOverlay: !!borderOverlayCSS,
        transformCSS: copied.transformCSS,
        motionSource: isMotionTransformTarget({ isComponentFile, node }),
      });
      setCopiedStyle(copied);
    },
    canPasteStyle: canPasteStyle(copiedStyle, property),
    pasteStyle: () => {
      if (!copiedStyle) return;
      // Pass the target's current styles so a Shadow paste can MERGE the copied
      // drop-shadow into the target's existing `filter` (keeping blur/etc.).
      // `isMotionTarget` decides which of the two transform storage forms the
      // payload is written in — motion props for a design-component element, a
      // CSS `transform` string for a plain page element. Irrelevant for every
      // other property, so it's always passed and ignored downstream.
      updateMultipleStyles(buildPastePayload(
        copiedStyle,
        property,
        unifiedCtx?.allProps ?? styles ?? {},
        { isMotionTarget: isMotionTransformTarget({ isComponentFile, node }) },
      ));
      // Border: the copied configuration may live in a `::after` overlay rule
      // (solid overlay OR gradient border) rather than the style map. Recreate
      // it on the target — or REMOVE the target's stale overlay when the copied
      // border is inline — so paste transfers the full render mode. Mirrors
      // exactly what the Border panel writes for each mode.
      if (property === 'border' && copiedStyle.sourceProperty === 'border' && nodeId) {
        if (copiedStyle.borderOverlayCSS) {
          queueMutation({ type: 'updateBorderOverlay', nodeId, afterCSS: copiedStyle.borderOverlayCSS });
          injectCanvasCSS(`[data-id="${nodeId}"]::after`, copiedStyle.borderOverlayCSS);
        } else {
          queueMutation({ type: 'removeBorderOverlay', nodeId });
          removeCanvasCSS(`[data-id="${nodeId}"]::after`);
        }
        trace.action('control-label:paste-style-border', { nodeId, overlay: !!copiedStyle.borderOverlayCSS });
      }
    },
    pageVariables,
    componentVariables,
    resetLocaleOverride: nodeId ? (prop: string) => {
      // DEFAULT mode + replica band rules → clear THIS artboard's banded
      // :lang rules (value + removal marker) so it re-inherits the base.
      if (isDefaultLocale && localeBandState.hasBandRules && (localeBandState.vpWidth || localeBandState.variantName)) {
        const kebabProp = toKebab(prop);
        // bandLocales, NOT baseLocales∪locales: a band holding only the
        // removal marker zeroes `locales`, and with no global rules the
        // union was EMPTY → zero mutations queued → Reset Override no-op'd
        // and the label stayed blue (the instance-replica Opacity find).
        const affected = new Set(localeBandState.bandLocales);
        for (const locale of affected) {
          queueMutation({
            type: 'updateLocaleStyle', nodeId: nodeId!, locale, ...localeScopeOf(localeBandState),
            styles: { [prop]: '', [localeOffMarker(kebabProp)]: '' },
          });
        }
        flushNow();
        trace.action('control-label:reset-locale-band', { property: prop, vpWidth: localeBandState.vpWidth, variantName: localeBandState.variantName });
        return;
      }
      // Default mode with no band rules → nothing locale-ish to reset.
      if (isDefaultLocale) return;
      // Remove this property from locale override. `textContent` lives in
      // `override.text`, every other property lives in `override.styles`.
      const existing = localeOverrides.get(nodeId!) || {};
      const isTextProp = prop === 'textContent';
      // For style-prop resets, leave text alone; for text-prop resets,
      // leave styles alone and pass an empty `text` so locale-ops marks
      // the node entry empty (and cleans it up if nothing else remains).
      const writePayload = isTextProp
        ? { text: '' }
        : (() => {
          const updatedStyles = { ...(existing.styles || {}) };
          delete updatedStyles[prop];
          return { styles: updatedStyles };
        })();
      setNodeOverride(activeLocale, activeFilePath, nodeId!, writePayload);
      // Mirror to the atom so the canvas Renderer + ContentControl pick up
      // the change without waiting for a Canvas reload pass.
      const next = new Map(localeOverrides);
      const updatedStyles = isTextProp
        ? (existing.styles || {})
        : (() => {
          const s = { ...(existing.styles || {}) };
          delete s[prop];
          return s;
        })();
      const updatedText = isTextProp ? undefined : existing.text;
      const stillHasStyles = Object.keys(updatedStyles).length > 0;
      const stillHasText = updatedText !== undefined && updatedText !== '';
      if (!stillHasStyles && !stillHasText && existing.visible === undefined) {
        next.delete(nodeId!);
      } else {
        next.set(nodeId!, { ...existing, styles: updatedStyles, text: updatedText });
      }
      setLocaleOverrides(next);
    } : undefined,
    onOpenVariableModal: async () => {
      setMenuOpen(false);
      // Seed the variable's default from the EFFECTIVE value, not just the inline style. A text node whose
      // font-size comes from inheritance or a typography preset has NO inline `fontSize`, so `value`
      // (= styles[property]) is empty — creating a Number variable from '' would inject `0` and collapse the
      // text. Fall back to the computed (rendered) px so the default matches what the user sees. The unique
      // auto-name + bind + open-in-edit-mode is the SHARED instantCreateAndEditVariable flow (used by Fill too).
      let seedValue = value ?? '';
      if (!seedValue && nodeId && vpId && property !== 'textContent' && property !== 'transition') {
        const computed = await findNodeComputedStyleAsync(nodeId, vpId, property);
        if (computed && computed !== 'normal' && computed !== 'auto') seedValue = computed;
      }
      instantCreateAndEditVariable({
        property, propertyLabel: label, value: seedValue,
        activeFilePath, pageVariables, createVariable, setVariableModalRequest,
      });
    },
    presetTokens,
    hasPreset,
    removePreset: (prop: string) => {
      // Replace var(--X) with the resolved token value
      const resolved = resolveTokenValue(value ?? '', presetTokens);
      updateStyle(prop, resolved ?? '');
      trace.action('control-label:remove-preset', { property: prop, resolved });
    },
    onOpenPresetPicker: () => { setMenuOpen(false); setPresetPickerOpen(true); },
    onCreatePreset: (category) => {
      setMenuOpen(false);
      setCreatePresetCategory(category);
    },
    // `initialVariant` is a component STATE choice, not a style/text value —
    // "Localize" makes no sense on a variant row (per-locale variant
    // selection isn't a thing; user rule 2026-07-30). Central gate so every
    // Variant row (ComponentPropsTool, instance panels) drops the item.
    onOpenLocalize: (localizeHidden || hideLocalize || property === 'initialVariant') ? undefined : () => { setMenuOpen(false); setLocalizeOpen(true); },
    // CMS-template field binding context — `getCmsBindingMenuItems` reads
    // this to render the "Bind to Field" submenu and the per-property
    // unbind action. Null when the selected node isn't inside a `.map()`
    // over a CMS collection.
    cmsBinding: cmsBinding ? {
      slug: cmsBinding.slug,
      itemVar: cmsBinding.itemVar,
      fields: cmsBinding.fields,
      nodeTag: cmsBinding.nodeTag,
      currentField: cmsBinding.getBindingForProperty(property),
      bindToField: (fieldId: string) => {
        cmsBinding.bindToField(property, fieldId);
        setMenuOpen(false);
      },
      unbindField: () => {
        cmsBinding.unbindField(property, value ?? '');
        setMenuOpen(false);
      },
    } : undefined,
  };

  // Ambient hoist menu item — set by `<HoistMenuItemProvider>` higher
  // in the tree (`ComponentPropsTool` wraps every nested-instance prop
  // row with one). Merging via context instead of an explicit prop lets
  // compound atoms like `FillControl` — which render their OWN
  // `<ControlLabel>` internally — surface the Hoist item on their own
  // chevron without ComponentPropsTool having to fork each atom to
  // forward extraMenuItems through. Null outside the provider, so
  // regular style controls in StylesTool / page-level instance editors
  // stay unaffected.
  const hoistItems = useHoistMenuItems();
  const hasHoistItems = hoistItems.length > 0;
  const mergedExtraItems = hasHoistItems
    ? [...(extraMenuItems ?? []), ...hoistItems]
    : extraMenuItems;

  // When the hoist context is active, suppress the standard "Create
  // Variable" / "Remove" / CMS-binding items. They were designed
  // for ELEMENT-LEVEL style properties — on an instance prop row there
  // is no element style to bind a variable to, no override to reset,
  // and no field to bind. The only relevant affordance here is
  // "Hoist Variable", which moves the prop up one parent level.
  // A `CreateVariableGate` ancestor (e.g. the Text tool wrapping all but
  // Content/Color/Font Size) can suppress "Create Variable" without each atom
  // threading the prop.
  const createVarHiddenFromGate = useCreateVariableHidden();
  const effectiveHideCreateVariable = hasHoistItems ? true : (hideCreateVariable || createVarHiddenFromGate);
  const effectiveHideResetStyle = hasHoistItems ? true : hideResetStyle;
  const effectiveHideCmsBinding = hasHoistItems ? true : hideCmsBinding;
  // Also hide the standard "Presets" submenu in the hoist/variable context —
  // those write through `updateStyle` to the node, which is wrong for a
  // variable row. The injected extra item (e.g. ComponentPropsTool's
  // "Apply Preset") is the correct, instance-prop-aware version. Without
  // this, BOTH "Presets" and "Apply Preset" showed (duplicate).
  const effectiveHidePresets = hasHoistItems;
  // The Collection List controls use SYNTHETIC `collection*` properties
  // (collectionSource/Filters/Sort/Pagination/Limit/Offset) — none are real CSS
  // styles, so "Copy Style" / "Paste Style" is meaningless on them.
  const effectiveHideCopyPasteStyle = hideCopyPasteStyle || property.startsWith('collection');

  // Auto-dedup: when a control INJECTS its OWN "Set Variable" (a design-component instance prop binds via
  // setInstanceProp, NOT the css-property style path), suppress the generic page/component "Set Variable"
  // so both don't show — and the wrong (style-binding) one can't be picked. Unlike `hideCreateVariable`
  // (which Fill keeps for its existing-variable detection), this fires ONLY on an injected 'Set Variable'.
  const injectedHasSetVariable = (mergedExtraItems ?? []).some(i => i.label === 'Set Variable');
  const items = getAllMenuItems(menuCtx, mergedExtraItems, {
    hideCreateVariable: effectiveHideCreateVariable,
    hideSetVariable: injectedHasSetVariable,
    hideResetStyle: effectiveHideResetStyle,
    hideCmsBinding: effectiveHideCmsBinding,
    hidePresets: effectiveHidePresets,
    hideCopyPasteStyle: effectiveHideCopyPasteStyle,
    hideVariableMenu,
  });
  // Show the dropdown whenever there's anything to put in it. `hideCreateVariable`
  // used to suppress the entire dropdown — that broke FillControl's submenu
  // path where we want extraMenuItems to be reachable while the default
  // Create Variable entry stays hidden.
  const hasDropdownContent = items.length > 0;

  // ─── Positioning constants ────────────────────────────────────────────
  // Sized so the math stays predictable. Item height comes from the
  // `py-1.5 px-2.5` spec (~30px each) so we can guess menu height from the
  // item count without measuring. Caps at MAX_HEIGHT for the rare case of
  // a long preset list — that's where the dropdown falls back to scrolling.
  const VIEWPORT_PADDING = 8;
  // Two different gaps: the MAIN menu sits clear of the properties-panel
  // column so it doesn't visually overlap, but 28px felt too far —
  // 16px is enough breathing room without making the menu feel detached
  // from the row that opened it. The SUBMENU is anchored to that main
  // menu and hugs it tightly so the cascade looks like one connected unit.
  const PANEL_GAP = 16;
  const SUBMENU_GAP = 4;
  const MENU_WIDTH = 180;
  const SUB_WIDTH = 200;
  const ITEM_HEIGHT = 30;
  const MENU_PADDING = 12;
  const MAX_HEIGHT = 320;

  /** Pick an x-coordinate that prefers the LEFT side of `anchorRect` and
   *  falls back to the RIGHT when there's no room. `gap` is the spacing
   *  between the anchor and the panel — main menu uses a wide one to clear
   *  the properties panel; submenus use a tight one so the cascade hugs
   *  its parent. Final clamp keeps the panel inside the viewport. */
  const chooseHorizontal = useCallback(
    (anchorRect: DOMRect, panelWidth: number, gap: number) => {
      const leftX = anchorRect.left - panelWidth - gap;
      const rightX = anchorRect.right + gap;
      let x = leftX >= VIEWPORT_PADDING ? leftX : rightX;
      // Right-edge clamp — if the right-side fallback also overflows, push
      // the panel back inside.
      if (x + panelWidth > window.innerWidth - VIEWPORT_PADDING) {
        x = window.innerWidth - panelWidth - VIEWPORT_PADDING;
      }
      // Last-resort left clamp.
      if (x < VIEWPORT_PADDING) x = VIEWPORT_PADDING;
      return x;
    },
    [],
  );

  /** Pick a y-coordinate that anchors the menu's TOP to `anchorTop`, but if
   *  the menu would spill off the bottom, FLIP it upward so the menu's
   *  BOTTOM aligns with `anchorBottom`. The user's complaint was that
   *  near-bottom labels ended up with menus floating mid-screen — flipping
   *  keeps them visually adjacent to the click point. */
  const chooseVertical = useCallback((anchorTop: number, anchorBottom: number, panelHeight: number) => {
    let y = anchorTop;
    if (y + panelHeight > window.innerHeight - VIEWPORT_PADDING) {
      // Flip up: menu bottom = anchor bottom (so it grows upward from there)
      y = anchorBottom - panelHeight;
    }
    if (y < VIEWPORT_PADDING) y = VIEWPORT_PADDING;
    return y;
  }, []);

  const openMenu = useCallback(() => {
    if (!hasDropdownContent || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const menuHeight = Math.min(items.length * ITEM_HEIGHT + MENU_PADDING, MAX_HEIGHT);
    const x = chooseHorizontal(rect, MENU_WIDTH, PANEL_GAP);
    const y = chooseVertical(rect.top, rect.bottom, menuHeight);
    setMenuPos({ x, y });
    setMenuOpen(true);
    trace.action('control-label:open-menu', { property, itemCount: items.length });
  }, [hasDropdownContent, property, items.length, chooseHorizontal, chooseVertical]);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setSubmenuOpen(null);
  }, []);

  /** Open the cascading submenu next to a hovered parent item. Same flip
   *  logic as the parent menu — submenus prefer to open on the LEFT and
   *  align with the parent menu, but flip right / up when there's no room.
   *  Y anchor is the HOVERED ITEM's rect, so the submenu opens BESIDE the
   *  item the user pointed at (its first row lines up with the item) — not
   *  pinned to the parent menu's top, which left submenus from lower items
   *  (e.g. "Set Variable") floating up at the menu top, disconnected. On
   *  flip-up the submenu's bottom anchors to the item's bottom so it stays
   *  attached to the item even when it grows upward. X still uses the parent
   *  menu rect so it sits beside the whole panel. */
  const openSubmenu = useCallback((items: MenuItem[], itemEl: HTMLElement) => {
    const portal = menuPortalRef.current;
    if (!portal) return;
    const portalRect = portal.getBoundingClientRect();
    const itemRect = itemEl.getBoundingClientRect();
    const submenuHeight = Math.min(items.length * ITEM_HEIGHT + MENU_PADDING, MAX_HEIGHT);
    const x = chooseHorizontal(portalRect, SUB_WIDTH, SUBMENU_GAP);
    // `- MENU_PADDING / 2` cancels the submenu container's top padding so its FIRST item
    // row sits at the same y as the hovered item (not one pad-height below it).
    const y = chooseVertical(itemRect.top - MENU_PADDING / 2, itemRect.bottom + MENU_PADDING / 2, submenuHeight);
    setSubmenuOpen({ items, pos: { x, y } });
  }, [chooseHorizontal, chooseVertical]);

  // Close on Escape
  useEffect(() => {
    if (!menuOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); }
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [menuOpen, closeMenu]);

  // Close on any outside pointerdown — the `fixed inset-0` backdrop only
  // catches clicks BELOW its z-10000 (canvas, panels). When this menu is
  // opened from inside a ToolPopup (z-index 100001, ABOVE the backdrop),
  // clicking back on the popup never reaches the backdrop and the menu stayed
  // open. This capture-phase listener is z-index-independent: it closes on any
  // pointerdown outside the menu, its submenu, and the trigger button (the
  // button re-opens via its own onClick, so excluding it avoids a flicker).
  useEffect(() => {
    if (!menuOpen) return;
    const handlePointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuPortalRef.current?.contains(t)) return;
      if (submenuPortalRef.current?.contains(t)) return;
      if (buttonRef.current?.contains(t)) return;
      closeMenu();
    };
    document.addEventListener('pointerdown', handlePointer, true);
    return () => document.removeEventListener('pointerdown', handlePointer, true);
  }, [menuOpen, closeMenu]);

  // ─── Determine label color ─────────────────────────────────
  let labelColorClass = 'text-[var(--text-secondary)]';
  let hoverColorClass = isComponentFile
    ? 'group-hover:text-[var(--accent-secondary)]'
    : 'group-hover:text-[var(--text-primary)]';
  const chevronHoverColor = isComponentFile
    ? 'group-hover:text-[var(--accent-secondary)]'
    : 'group-hover:text-[var(--accent-text)]';

  if (isOverride) {
    // Component-file overrides use the purple secondary accent (matching the bound pill + the rest of the
    // component-editing chrome); page overrides use the standard blue accent.
    labelColorClass = isComponentFile ? 'text-[var(--accent-secondary)]' : 'text-[var(--accent-text)]';
    hoverColorClass = '';
  }

  // Locale override indicator — show when non-default locale has an override for this property
  const showLocaleIndicator = !isDefaultLocale && hasLocaleOverride;
  if (showLocaleIndicator) {
    labelColorClass = 'text-orange-400';
    hoverColorClass = '';
  }

  // While the menu is OPEN we want the label to keep the same "active" look
  // it has under :hover — coloured chevron (accent), translated chevron, and
  // the label text in the file-aware hover colour. Otherwise the user moves
  // their cursor onto the dropdown, the button loses :hover, and the label
  // visually goes back to neutral despite still being the source of the
  // open menu. Skipped when the label is already in a special state
  // (override / locale) so we don't trample those colours.
  const forceActive = menuOpen && !isOverride && !showLocaleIndicator;
  const activeLabelColor = isComponentFile ? 'text-[var(--accent-secondary)]' : 'text-[var(--text-primary)]';
  const activeChevronColor = isComponentFile ? 'text-[var(--accent-secondary)]' : 'text-[var(--accent-text)]';
  const effectiveLabelColor = forceActive ? activeLabelColor : labelColorClass;
  // When there's no dropdown to open (no chevron), the label is not interactive
  // — strip the hover color class so it stays neutral instead of lighting up
  // like a clickable affordance. Override / locale states already clear
  // hoverColorClass to '', so this only affects the plain default case.
  const effectiveLabelHover = forceActive
    ? ''
    : hasDropdownContent
      ? hoverColorClass
      : '';

  return (
    <>
      <button
        ref={buttonRef}
        onClick={openMenu}
        // Right-click opens the SAME menu (Copy/Paste Style live here, standard).
        onContextMenu={(e) => { e.preventDefault(); openMenu(); }}
        // `pl-[18px] -ml-[18px]` extends the button's hit-area LEFT to swallow
        // the chevron + the gap between chevron and label. Without it the
        // chevron sits at `absolute -left-[14px]` (outside the button), so
        // hovering on the chevron — or the few pixels between chevron and
        // label text — didn't trigger the row's hover state. Net visual is
        // unchanged because the negative margin pulls the box back where it
        // was; only the click/hover region grows.
        // `min-w-0` lets the button shrink below its content's
        // intrinsic min-width so the `truncate` on the inner label
        // span actually clips overflow. Without it the button keeps
        // growing past `w-3/4` to fit a long label and pushes the
        // row's value column to the right.
        className={`group relative min-w-0 select-none text-left pl-[18px] -ml-[18px]${cell ? '' : ' w-3/4'} ${hasDropdownContent ? 'cursor-pointer' : 'cursor-default'}`}
      >
        {/* Left chevron arrow — always visible, translates left on hover.
            When `menuOpen` is true we apply the translated/coloured state
            directly so the chevron stays "active" while the dropdown is up
            (otherwise moving the cursor onto the menu drops the :hover and
            the chevron snaps back to neutral). */}
        {hasDropdownContent && (
          // The chevron is absolute-positioned relative to the button. The
          // button gained `-ml-[18px]` (to extend its hit-area left), which
          // also shifted the chevron's reference point 18px left — leaving
          // it clipped behind the panel edge. Counter-shift here with
          // `left-[4px]` so the chevron's screen position stays where it
          // was: (-18 + 4) = -14, matching the original `-left-[14px]`.
          <span
            className={`absolute left-[4px] top-1/2 -translate-y-1/2 transition-all duration-200 ${
              forceActive
                ? `${activeChevronColor} -translate-x-0.5`
                : `text-[var(--text-secondary)] ${chevronHoverColor} group-hover:-translate-x-0.5`
            }`}
          >
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </span>
        )}

        {/* Map item override dot — same +18px counter-shift as the chevron
            so the dot stays at its original screen position despite the
            button's hit-area negative margin. */}
        {isMapOverridden && (
          <button
            onClick={(e) => { e.stopPropagation(); mapOverride?.resetOverride(property); trace.action('control-label:reset-map-override', { property }); }}
            title="Reset map override"
            className="absolute left-[10px] top-1/2 -translate-y-1/2 w-2 h-2 rounded-full shrink-0 cursor-pointer border-none p-0"
            style={{ backgroundColor: MAP_TEMPLATE_COLOR }}
          />
        )}

        {/* Label text. CMS bindings used to render `⚡ FieldName` above the
            label here, but the blue value-column pill already communicates
            the binding state — duplicating it on the label was noisy. So
            CMS-bound rows fall through to the plain label. Component
            variables still show their two-line "varRef above label" form. */}
        {hasVar && varRef ? (
          <span className="flex flex-col min-w-0">
            <span className={`text-xs font-bold ${effectiveLabelColor} ${effectiveLabelHover} truncate max-w-20 transition-colors`} title={varDisplayName ?? undefined}>
              {varDisplayName}
            </span>
            <span className="text-[10px] text-[var(--text-disabled)] leading-tight font-normal truncate" title={label}>
              {label}
            </span>
          </span>
        ) : subLabel ? (
          // Same two-line shape as the variable-bound case above —
          // primary label on top, sub-label (the underlying CSS
          // property name) below in muted text. ComponentPropsTool
          // uses this for instance-prop rows so the user can see
          // which row drives which CSS property at a glance.
          // `pr-2` keeps a long truncated name off the value column.
          <span className="flex flex-col min-w-0 leading-tight pr-2">
            <span className={`text-xs font-bold ${effectiveLabelColor} ${effectiveLabelHover} block truncate transition-colors`} title={label}>{label}</span>
            <span className="text-[10px] text-[var(--text-disabled)] font-normal block truncate" title={subLabel}>{subLabel}</span>
          </span>
        ) : (
          // Same truncation guard as the plain branch above — long label
          // names (`initialVarianthoist`, `transitiontransition2`) would
          // otherwise push the value column right and produce ragged
          // rows when sitting next to short-labelled siblings.
          <span className={`block truncate text-xs font-bold ${effectiveLabelColor} ${effectiveLabelHover} transition-colors`} title={label}>
            {label}
          </span>
        )}
      </button>

      {/* Preset picker */}
      <PresetPicker
        property={property}
        tokens={presetTokens}
        isOpen={presetPickerOpen}
        onClose={() => setPresetPickerOpen(false)}
        anchorRef={buttonRef}
        onSelect={(tokenName) => {
          updateStyle(property, `var(--${tokenName})`);
          setPresetPickerOpen(false);
          trace.action('control-label:apply-preset', { property, tokenName });
        }}
      />

      {/* Create preset popup — shown when "Create … preset" is picked from
          the Apply Preset submenu. On Save & Apply it writes the new token
          AND applies var(--name) to this control's property in one gesture.
          Compound presets (border) write multiple longhands via onApplyMultiple. */}
      {createPresetCategory && (
        <CreatePresetPopup
          isOpen={true}
          category={createPresetCategory}
          anchorRef={buttonRef}
          initialValue={value || ''}
          onClose={() => setCreatePresetCategory(null)}
          onApply={(varRef) => updateStyle(property, varRef)}
          onApplyMultiple={(styles) => updateMultipleStyles(styles)}
        />
      )}

      {/* Localize popup — When <locale> set <value> :lang() overrides (Phase 4). */}
      {localizeOpen && nodeId && (
        <LocaleStylePopup
          property={property}
          propertyLabel={label}
          nodeId={nodeId}
          baseValue={value || ''}
          isOpen={true}
          onClose={() => setLocalizeOpen(false)}
          anchorRef={buttonRef}
          onChangeBase={(v) => updateStyle(property, v)}
          onChangeBaseLive={updateStyleLive ? (v) => updateStyleLive(property, v) : undefined}
        />
      )}

      {/* Variable manage modal is rendered ONCE by <VariableModalHost> (driven by variableModalRequestAtom),
          not here — so it survives the control re-rendering into its bound branch on create. */}

      {/* Dropdown menu — portal to body so it renders above any
          stacking-context ancestors (popups, panels, transformed wrappers). */}
      {menuOpen && createPortal(
        <>
          {/* Backdrop — z must sit ABOVE the ToolPopup (100001) + Modal/picker
              cluster (…100031) so this label menu floats over the left-hand
              ToolPopup it was opened from, not behind it. Stays below the canvas
              right-click ContextMenu (1000000). */}
          <div
            className="fixed inset-0 z-[100040]"
            onClick={closeMenu}
            onContextMenu={(e) => { e.preventDefault(); closeMenu(); }}
          />

          {/* Parent menu */}
          <div
            ref={menuPortalRef}
            className="fixed bg-[var(--dropdown-bg)] shadow-[var(--shadow-lg)] rounded-[var(--radius-md)] py-1.5 z-[100041] min-w-45 border border-[var(--border-light)] space-y-0.5"
            style={{ left: menuPos.x, top: menuPos.y }}
            onMouseLeave={() => {
              // Don't close the submenu if the cursor is moving toward it.
              // The submenu's own onMouseEnter handler keeps it alive, and
              // submenu close is handled in its own onMouseLeave.
            }}
          >
            {items.map((item, i) => {
              const hasSubmenu = !!(item.submenuItems && item.submenuItems.length > 0);
              return (
                <div key={i}>
                  {item.separator && i > 0 && (
                    <div className="h-px bg-white/10 mx-2 my-1" />
                  )}
                  <button
                    onMouseEnter={(e) => {
                      // Hovering an item with a submenu opens the cascade;
                      // hovering a leaf item closes any open submenu.
                      if (hasSubmenu) openSubmenu(item.submenuItems!, e.currentTarget);
                      else setSubmenuOpen(null);
                    }}
                    onClick={(e) => {
                      // Submenu parents: open (or keep open) the submenu — don't
                      // close the main menu, since the user is still navigating.
                      if (hasSubmenu) {
                        openSubmenu(item.submenuItems!, e.currentTarget);
                        return;
                      }
                      item.onClick();
                      closeMenu();
                    }}
                    className={`group flex items-center justify-between gap-2 mx-1.5 px-2.5 py-1.5 rounded-[var(--radius-sm)] w-[calc(100%-12px)] text-left cursor-pointer ${
                      item.hoverColor === 'accent-secondary'
                        ? 'hover:bg-[var(--accent-secondary)]'
                        : 'hover:bg-[var(--accent)]'
                    } transition-colors`}
                  >
                    <span className="text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-fg)] flex-1">
                      {item.label}
                    </span>
                    {/* Submenu chevron — RIGHT side, pointing RIGHT (standard cascade
                        indicator). `justify-between` on the row pushes it to the edge. */}
                    {hasSubmenu && (
                      <span className="text-[var(--text-secondary)] group-hover:text-[var(--accent-fg)] flex-shrink-0">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </span>
                    )}
                  </button>
                </div>
              );
            })}
          </div>

          {/* Cascading submenu portal — renders above the parent at z+1. */}
          {submenuOpen && (
            <div
              ref={submenuPortalRef}
              className="fixed bg-[var(--dropdown-bg)] shadow-[var(--shadow-lg)] rounded-[var(--radius-md)] py-1.5 z-[100042] min-w-[200px] max-h-[320px] overflow-y-auto border border-[var(--border-light)] space-y-0.5"
              style={{ left: submenuOpen.pos.x, top: submenuOpen.pos.y }}
              onMouseLeave={() => setSubmenuOpen(null)}
            >
              {submenuOpen.items.length === 0 ? (
                <div className="px-3 py-2 text-xs text-[var(--text-disabled)]">
                  No matching presets
                </div>
              ) : submenuOpen.items.map((sub, i) => (
                <div key={i}>
                  {sub.separator && i > 0 && (
                    <div className="h-px bg-white/10 mx-2 my-1" />
                  )}
                  <button
                    onClick={() => { sub.onClick(); closeMenu(); }}
                    className="group flex items-center mx-1.5 px-2.5 py-1.5 rounded-[var(--radius-sm)] w-[calc(100%-12px)] text-left cursor-pointer hover:bg-[var(--accent)] transition-colors"
                  >
                    <span className="text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-fg)] truncate">
                      {sub.label}
                    </span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </>,
        document.body,
      )}
    </>
  );
}
