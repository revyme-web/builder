// control-menu-items.ts — Extensible menu item generators for ControlLabel dropdown.
//
// Each generator is a pure function: context → MenuItem[].
// Adding presets/tokens/locale later = adding new generators here. Zero changes to ControlLabel.

import { trace } from '@/shared/debug-trace';
import { overrideAliasKeys } from '@/code/stores/container-query-store';
import { forceRenderAfterExternalEdit } from '@/canvas/node-ops';
import { MOTION_TRANSFORM_PROPS } from '@/shared/motion-transform';
import type { PresetToken, FieldDefinition } from '@/shared/types';
import { groupBorderTokens, buildBorderApplyStyles, getBorderTokenVar } from '@/editor/ui/border-preset-utils';
import { TEXT_TAGS } from '@/shared/constants';
import { pageVariableTypeForProperty, type PageVariable } from '@/code/features/page-variables';
import { acceptedVariableFamilies, resolveVariableIconKey } from './VariableTypeIcon';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MenuItem {
  label: string;
  onClick: () => void;
  show: boolean;
  hoverColor?: 'accent' | 'accent-secondary';
  separator?: boolean;
  submenuItems?: MenuItem[];
}

export interface MenuContext {
  property: string;
  nodeId: string | null;
  value: string | undefined;
  hasVariable: boolean;
  variableRef: string | null;
  hasOverride: boolean;
  isComponentFile: boolean;
  isPrimary: boolean;
  // Locale context
  isDefaultLocale: boolean;
  activeLocale: string;
  hasLocaleOverride: boolean;
  // Preset context
  presetTokens?: PresetToken[];
  hasPreset?: boolean;
  removePreset?: (property: string) => void;
  onOpenPresetPicker?: () => void;
  /** Open a ToolPopup that creates a new preset token in the given category and
   *  applies it to the current property on commit. ControlLabel implements this. */
  onCreatePreset?: (category: PresetToken['category']) => void;
  // Actions from useControl()
  createVariable: (property: string, propName: string, defaultValue?: string) => void;
  removeVariable: (property: string, propName: string, defaultValue: string) => void;
  updateStyle: (key: string, value: string) => void;
  /** Multi-property writer — used by compound presets that apply more than one
   *  CSS property at once (e.g. a border preset writes width + style + color
   *  as three separate var() refs). Mirrors ControlProvider.updateMultipleStyles. */
  updateStyles?: (styles: Record<string, string>) => void;
  /** The node's resolved style map — so a shorthand control (margin/padding)
   *  can detect that its value lives in the per-side LONGHANDS and still offer
   *  "Remove". */
  styles?: Record<string, string>;
  resetLocaleOverride?: (property: string) => void;
  /** Open the Localize popup (Phase 4 convert flow) — ControlLabel implements. */
  onOpenLocalize?: () => void;
  /** Copy this control's current style into the in-memory style clipboard. */
  copyStyle?: () => void;
  /** Paste the clipboard style onto this control (only offered when compatible). */
  pasteStyle?: () => void;
  /** Whether the current style clipboard is pasteable onto THIS property. */
  canPasteStyle?: boolean;
  /** Caller-supplied "Reset Override" handler. When set, replaces the
   *  default `updateStyle(property, '')` action — used by ContentControl,
   *  whose override state lives outside the @media style map and needs to
   *  fire `removeTextOverride` instead. */
  onResetOverride?: () => void;
  /** Callback to open the VariableModal (replaces prompt()) */
  onOpenVariableModal?: () => void;
  /**
   * All page variables declared in the active file. Used to populate the
   * "Set Variable" submenu so the user can bind to an existing variable
   * without re-creating one. Empty/undefined on component master files —
   * those use the per-component prop registry, surfaced separately by the
   * VariableModal's left-list.
   */
  pageVariables?: PageVariable[];
  /**
   * Existing COMPONENT variables (props) that already drive THIS property somewhere in the
   * current component master, with their resolved default. Populates the component-file
   * "Set Variable" submenu so the user can bind this node's style to an existing component
   * variable of the same style (e.g. bind Border → an existing border prop) instead of
   * creating a duplicate. Empty/undefined on page files (those use `pageVariables`) and when
   * no same-style variable exists yet. Built in ControlLabel by scanning `nodesAtom`'s
   * `styleVariables[property]`.
   */
  componentVariables?: Array<{ name: string; default: string; label?: string }>;
  // CMS-collection-template context — exposes the field picker on every
  // bindable property when the selected node lives inside a `.map()` over
  // a CMS collection.
  cmsBinding?: {
    slug: string;
    itemVar: string;
    fields: FieldDefinition[];
    /** Selected node's tag (`p`, `div`, `img`, …) — narrows the per-property
     *  field-type filter so e.g. text Fill doesn't offer image-typed fields. */
    nodeTag?: string;
    currentField: string | null;  // bound fieldId for THIS property, or null
    bindToField: (fieldId: string) => void;
    unbindField: () => void;
  };
}

// ─── Variable Items ─────────────────────────────────────────────────────────

export function getVariableMenuItems(ctx: MenuContext, opts?: { hideCreate?: boolean; hideSet?: boolean }): MenuItem[] {
  // `hideSet` suppresses the generic "Set Variable" submenu — used when the control INJECTS its own
  // (a design-component instance prop binds via setInstanceProp, not the css-property style path). Unlike
  // `hideCreate` (Fill keeps its generic Set Variable), this only fires on an injected 'Set Variable'.
  const hideSet = opts?.hideSet ?? false;
  const items: MenuItem[] = [];
  // `hideCreate` suppresses ONLY the "Create Variable" entry (FillControl provides its own
  // Color/Gradient/Image/Video create submenu). "Set Variable" + "Remove Variable" must still show —
  // previously hideCreateVariable skipped this whole function, so Fill never detected existing variables.
  const hideCreate = opts?.hideCreate ?? false;

  // "Create Variable" appears in two contexts:
  //   1. Component master file → creates a component PROP (existing behavior).
  //   2. Regular page file → creates a PAGE VARIABLE in @pageVariables block,
  //      gated by `pageVariableTypeForProperty` so only properties with a
  //      sensible primitive type (number/color/text/boolean) get the entry.
  //      Enum-like properties (overflow, cursor, display) are hidden.
  //
  // Hidden inside collection templates regardless of file type: there the
  // user wants Bind to Field, not a variable. The purple pill looks
  // identical between a variable and a CMS binding, and the user has no way
  // to tell which they got.
  const showCreate = ctx.isPrimary && !ctx.hasVariable && !ctx.cmsBinding;
  const isPageFileWithCompatibleProperty =
    !ctx.isComponentFile && pageVariableTypeForProperty(ctx.property) !== null;
  // Variant-scoped create: on a NON-primary component variant, allow creating a variable that
  // applies ONLY on that variant (inline-ternary binding) — for ANY property (border uses the
  // `::after` overlay path, everything else a direct inline ternary). The createVariable
  // variant-branch handles both. Without this, non-primary variants offered no way to add a
  // variable at all ("it's not letting me").
  const showVariantCreate = ctx.isComponentFile && !ctx.isPrimary && !ctx.hasVariable && !ctx.cmsBinding;

  // Hover-color convention: purple (accent-secondary) marks "this affects
  // the component master file" — visually distinct so the user knows they're
  // about to edit a shared component. On regular pages there's no such
  // master/instance split, so we use the standard accent (blue). Same logic
  // applies to the variable-bound pill.
  const hoverColor: 'accent' | 'accent-secondary' = ctx.isComponentFile ? 'accent-secondary' : 'accent';

  if (!hideCreate && ((showCreate && (ctx.isComponentFile || isPageFileWithCompatibleProperty)) || showVariantCreate)) {
    items.push({
      label: 'Create Variable',
      show: true,
      hoverColor,
      onClick: () => {
        if (ctx.onOpenVariableModal) {
          ctx.onOpenVariableModal();
        }
        trace.action('control-menu:open-variable-modal', { property: ctx.property, isComponent: ctx.isComponentFile });
      },
    });
  }

  // "Set Variable" submenu — page files only, when there are existing
  // variables of a compatible type. Lets the user bind to an existing
  // variable (e.g. `gggg` color → bind to Fill on another node) without
  // creating a duplicate. Hidden when the property already has a binding —
  // the user would Remove first, then re-bind.
  if (
    !hideSet &&
    !ctx.isComponentFile &&
    !ctx.hasVariable &&
    !ctx.cmsBinding &&
    isPageFileWithCompatibleProperty &&
    ctx.pageVariables &&
    ctx.pageVariables.length > 0
  ) {
    // Match by type FAMILY so multi-paint controls (Fill) detect color AND image variables, while
    // single-type controls keep their exact match (a Number control only lists number variables).
    const families = acceptedVariableFamilies(ctx.property);
    const compatible = ctx.pageVariables.filter(v => families.includes(resolveVariableIconKey({ pageVarType: v.type })));
    if (compatible.length > 0) {
      const submenuItems: MenuItem[] = compatible.map(v => ({
        label: v.name,
        show: true,
        hoverColor,
        onClick: () => {
          // createVariable on an EXISTING name is the bind path — see the
          // ControlProvider's exists check; it skips addPageVariable and
          // only emits bindStylePageVariable.
          ctx.createVariable(ctx.property, v.name, v.default);
          trace.action('control-menu:bind-existing-variable', { property: ctx.property, varName: v.name });
        },
      }));
      items.push({
        label: 'Set Variable',
        show: true,
        hoverColor,
        onClick: () => { /* parent click is a no-op; submenu opens on hover */ },
        submenuItems,
      });
    }
  }

  // "Set Variable" submenu — COMPONENT master files, when an existing component variable (prop)
  // already drives THIS style somewhere in the component. Binds this node's style to that prop
  // (createVariable on an existing prop is idempotent at the signature level — see
  // addPropToFunction — so it adds the binding without duplicating the prop). Lets a user reuse
  // one border/color variable across nodes + variants instead of minting a new prop each time.
  if (
    !hideSet &&
    ctx.isComponentFile &&
    !ctx.hasVariable &&
    !ctx.cmsBinding &&
    ctx.componentVariables &&
    ctx.componentVariables.length > 0
  ) {
    const submenuItems: MenuItem[] = ctx.componentVariables.map(v => ({
      // Show the human DISPLAY label ("Justify 1"), not the camelCase prop id ("justify"); bind by id.
      label: v.label || v.name,
      show: true,
      hoverColor,
      onClick: () => {
        ctx.createVariable(ctx.property, v.name, v.default);
        trace.action('control-menu:bind-existing-component-variable', { property: ctx.property, varName: v.name });
      },
    }));
    items.push({
      label: 'Set Variable',
      show: true,
      hoverColor,
      onClick: () => { /* parent click is a no-op; submenu opens on hover */ },
      submenuItems,
    });
  }

  // "Remove Variable" — when variable exists. Identical wording for both
  // file types; the routed `removeVariable` callback (in ControlProvider)
  // dispatches the right unbind path per file context.
  if (ctx.hasVariable && ctx.variableRef) {
    const ref = ctx.variableRef;
    const defaultVal = ctx.value ?? '';
    items.push({
      label: 'Remove Variable',
      show: true,
      hoverColor,
      onClick: () => {
        ctx.removeVariable(ctx.property, ref, defaultVal);
        trace.action('control-menu:remove-variable', { property: ctx.property, ref });
      },
    });
  }

  return items;
}

// ─── Copy / Paste Style ──────────────────────────────────────────────────────

/** "Copy Style" + "Paste Style" — a custom in-memory clipboard, separate from the
 *  OS Cmd+C/V. Copy snapshots this control's value(s); Paste is only offered when the
 *  clipboard holds a COMPATIBLE style (same property, or universal colour / single
 *  number — see `style-clipboard.canPasteStyle`). Rendered in the same dropdown as
 *  Reset, so it appears on right-click / chevron of any property label. */
/** GENERAL RULE: no "Copy Style" when there is nothing to copy — the
 *  property (or any of its alias longhands) must actually carry a value on
 *  the node. Border/Shadow/Transform rows in their empty "Add" state were
 *  offering a pointless copy (user 2026-07-22). */
const COPYABLE_EXTRA_ALIASES: Record<string, string[]> = {
  border: ['border', 'borderWidth', 'borderStyle', 'borderColor', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'],
  backgroundColor: ['backgroundColor', 'background', 'backgroundImage'],
  background: ['background', 'backgroundColor', 'backgroundImage'],
  // Inside a DESIGN COMPONENT the Transform row's value lives in independent
  // motion props (`rotate: 30`, `scaleX: 1.2`, …) and `styles.transform` stays
  // EMPTY — a raw transform string would collide with motion's `layout` FLIP
  // (see `shared/motion-transform.ts`). Without these aliases the gate saw an
  // empty value and hid "Copy Style" on every rotated/scaled component element,
  // even though the row visibly read "Mixed" (user report 2026-07-25).
  transform: ['transform', ...MOTION_TRANSFORM_PROPS],
};

function hasCopyableStyle(ctx: MenuContext): boolean {
  if (ctx.value && ctx.value !== '') return true;
  const styleMap = ctx.styles;
  if (!styleMap) return false;
  const keys = new Set([...overrideAliasKeys(ctx.property), ...(COPYABLE_EXTRA_ALIASES[ctx.property] ?? [])]);
  return [...keys].some((k) => !!styleMap[k]);
}

function getCopyPasteStyleMenuItems(ctx: MenuContext): MenuItem[] {
  const items: MenuItem[] = [];
  if (ctx.copyStyle && hasCopyableStyle(ctx)) {
    items.push({
      label: 'Copy Style',
      show: true,
      separator: true,
      onClick: () => { ctx.copyStyle!(); trace.action('control-menu:copy-style', { property: ctx.property }); },
    });
  }
  if (ctx.pasteStyle) {
    items.push({
      label: 'Paste Style',
      show: !!ctx.canPasteStyle, // only when a compatible style is on the clipboard
      onClick: () => { ctx.pasteStyle!(); trace.action('control-menu:paste-style', { property: ctx.property }); },
    });
  }
  return items;
}

// ─── Override Items ─────────────────────────────────────────────────────────

export function getOverrideMenuItems(ctx: MenuContext, hideResetStyle?: boolean): MenuItem[] {
  const items: MenuItem[] = [];

  // "Reset Override" — when editing a non-primary variant/replica with individual value
  if (ctx.hasOverride && !ctx.isPrimary) {
    items.push({
      label: 'Reset Override',
      show: true,
      separator: true,
      onClick: () => {
        if (ctx.onResetOverride) {
          ctx.onResetOverride();
        } else {
          // Clear every alias key in ONE batch — a responsive block authored
          // as pure longhands (padding-top/-right/… !important) isn't touched
          // by clearing just the shorthand, so Reset Override silently no-op'd
          // on those tiles (the same exact-key gap that kept the label unlit).
          const keys = overrideAliasKeys(ctx.property);
          if (keys.length > 1 && ctx.updateStyles) {
            ctx.updateStyles(Object.fromEntries(keys.map((k) => [k, ''])));
          } else {
            ctx.updateStyle(ctx.property, '');
          }
        }
        // Locale band rules on this replica are overrides too — ONE Reset
        // Override returns the artboard fully to the primary state (clears
        // the per-replica :lang value/removal so it re-inherits).
        if (ctx.isDefaultLocale) ctx.resetLocaleOverride?.(ctx.property);
        // THE canvas-sync guarantee. Every branch above ends with the removal
        // in CODE, but none of them can make the CANVAS show it: the revealed
        // value lives in a render-baked stylesheet rule or in the variant
        // merge, and the imperative patch can only clear the inline. Whether
        // the DOM caught up used to depend on some unrelated later render
        // firing — hence "works one time out of two". Force it here, at the
        // ONE point every control's Reset Override passes through, so a
        // tool's bespoke `onResetOverride` (SvgShapeTool, OverlayTool,
        // ComponentPropsTool, CollectionListTool, SketchTool, …) is covered
        // identically to the generic `updateStyle(prop, '')` fallback.
        forceRenderAfterExternalEdit('control-menu:reset-override', {
          property: ctx.property,
          nodeId: ctx.nodeId,
          custom: !!ctx.onResetOverride,
        });
        trace.action('control-menu:reset-override', { property: ctx.property });
      },
    });
  }

  // "Remove" — delete the property from the node's BASE style, so it falls back
  // to inherited / initial. The only way to express "absent" from the panel: a
  // numeric input can't type it, and absent ≠ 0 for anything inherited
  // (color / fontSize / lineHeight) or with a non-zero initial (width: auto).
  //
  // PRIMARY / DEFAULT-VARIANT ONLY (`ctx.isPrimary`). On a replica or a
  // non-default variant this was a strict DUPLICATE of "Reset Override": both
  // end in `updateStyle(prop, '')`, which `updateNodeStyles` routes into that
  // viewport's `@media` rule (or variant object), where an empty value deletes
  // the line. Two labels for one action — and this was the worse copy, missing
  // the `forceRenderAfterExternalEdit` Reset Override ends with, so the removal
  // could land in code without repainting. It also showed on a replica with NO
  // override at all (its gate is the RESOLVED value, inherited from primary),
  // where clicking it deleted a line that didn't exist and appeared to do
  // nothing. Reset Override is the survivor for every non-primary tile.
  // (User decision 2026-07-26; it was labelled "Remove" until then, which
  // read as "reset to a default" and collided with "Reset Override".)
  //
  // Also suppressed when the caller sets `hideResetStyle` (e.g. viewport-frame
  // Width/Height rows, where the row's displayed value lives in the `@canvas`
  // viewport config, not in `styles[property]` — clearing the CSS would wipe an
  // unrelated value the user can't see and silently break the page).
  // Box-model shorthands (margin/padding) keep their value in the per-side
  // LONGHANDS once a single side is set (e.g. marginTop) — the shorthand is
  // then empty, so ctx.value is '' and Remove would wrongly hide even
  // though the element clearly has a margin. Treat the property as set when
  // the shorthand OR any longhand has a value, and reset clears the shorthand
  // AND every side.
  const SIDE_LONGHANDS: Record<string, string[]> = {
    margin: ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'],
    padding: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
    borderRadius: ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'],
    inset: ['top', 'right', 'bottom', 'left'],
  };
  const longhands = SIDE_LONGHANDS[ctx.property];
  const longhandSet = !!longhands && longhands.some((p) => !!ctx.styles?.[p]);

  if ((ctx.value || longhandSet) && !hideResetStyle && ctx.isPrimary) {
    items.push({
      label: 'Remove',
      show: true,
      onClick: () => {
        if (longhands) {
          const clear = { [ctx.property]: '', ...Object.fromEntries(longhands.map((p) => [p, ''])) };
          if (ctx.updateStyles) ctx.updateStyles(clear);
          else Object.keys(clear).forEach((p) => ctx.updateStyle(p, ''));
        } else {
          ctx.updateStyle(ctx.property, '');
        }
        trace.action('control-menu:reset-style', { property: ctx.property });
      },
    });
  }

  return items;
}

// ─── Locale Items ───────────────────────────────────────────────────────────

function getLocaleMenuItems(ctx: MenuContext): MenuItem[] {
  const items: MenuItem[] = [];

  // "Localize" — the Phase 4 convert flow (default mode only): opens the
  // When-<locale>-set-<value> popup that writes `:lang()` overrides.
  // Real element style properties only (nodeId present). COMPOUND properties
  // (border/shadow/transform) are excluded — their multi-part editors don't
  // map onto the single-value convert popup.
  const NON_LOCALIZABLE = new Set([
    'border', 'borderWidth', 'borderStyle', 'borderColor', 'boxShadow', 'textShadow',
    'transform', 'filter', 'backdropFilter',
    // Sizes are responsive via the normal per-viewport overrides — per-locale
    // dimensions were judged too confusing (user 2026-07-22).
    'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
  ]);
  if (ctx.isDefaultLocale && ctx.onOpenLocalize && ctx.nodeId && !NON_LOCALIZABLE.has(ctx.property)) {
    items.push({
      label: ctx.hasLocaleOverride ? 'Localize …' : 'Localize',
      show: true,
      separator: true,
      onClick: () => {
        ctx.onOpenLocalize!();
        trace.action('control-menu:open-localize', { property: ctx.property });
      },
    });
  }

  // "Reset Locale Override" — when editing in non-default locale and override exists
  if (!ctx.isDefaultLocale && ctx.hasLocaleOverride && ctx.resetLocaleOverride) {
    items.push({
      label: `Reset ${ctx.activeLocale.toUpperCase()} Override`,
      show: true,
      separator: true,
      onClick: () => {
        ctx.resetLocaleOverride!(ctx.property);
        trace.action('control-menu:reset-locale-override', { property: ctx.property, locale: ctx.activeLocale });
      },
    });
  }

  return items;
}

// ─── Preset Items ────────────────────────────────────────────────────────────

/** CSS properties grouped by which preset category applies to them. Mirrors
 *  the table in PresetPicker.tsx so the dropdown's "Apply Preset" submenu
 *  filters to compatible tokens only (no point in offering a color preset
 *  for borderRadius).
 *
 *  Two categories that USED to live here are intentionally absent:
 *
 *    1. **typography** (fontFamily, fontSize, fontWeight, letterSpacing,
 *       lineHeight, …). Typography presets are MULTI-PROPERTY bundles
 *       ("Heading" = font + size + weight + line-height); surfacing them
 *       on a per-property dropdown is misleading — the user clicks "Apply
 *       Heading" on lineHeight expecting a line-height preset and gets
 *       a font swap instead. Typography presets should be applied at the
 *       text-style ROW level, not per CSS property.
 *
 *    2. **color** (color, backgroundColor, borderColor, fill, stroke …).
 *       Every color slot already has a ColorInput with its own preset
 *       palette inside the picker popup; the dropdown entry was a
 *       duplicate surface that the user explicitly didn't want.
 *
 *  Re-adding either category in future means dealing with those issues
 *  first (per-property bundle filtering for typography, distinguishing
 *  the dropdown surface from the picker's surface for color).
 */
const PROPERTY_CATEGORY_MAP: Record<string, PresetToken['category'][]> = {
  // spacing/margin
  padding: ['spacing'], paddingTop: ['spacing'], paddingRight: ['spacing'],
  paddingBottom: ['spacing'], paddingLeft: ['spacing'],
  margin: ['margin', 'spacing'], marginTop: ['margin', 'spacing'],
  marginRight: ['margin', 'spacing'], marginBottom: ['margin', 'spacing'],
  marginLeft: ['margin', 'spacing'],
  gap: ['spacing'], rowGap: ['spacing'], columnGap: ['spacing'],
  top: ['spacing'], left: ['spacing'], right: ['spacing'], bottom: ['spacing'],
  // Intentionally NOT mapped: width / height / minWidth / minHeight /
  // maxWidth / maxHeight. The 'spacing' category is for padding / gap /
  // inset distances — sharing it with width/height made the Apply Preset
  // dropdown surface "Card Padding" / "Section Y" etc. on size rows,
  // which isn't a useful binding (a card's height = section padding-y is
  // coincidence, not a design token relationship). Leaving them off the
  // map means no presets surface for size, and the "Create preset" entry
  // is hidden for those rows too — same behaviour as opacity/cursor.
  // radius
  borderRadius: ['radius'],
  borderTopLeftRadius: ['radius'], borderTopRightRadius: ['radius'],
  borderBottomLeftRadius: ['radius'], borderBottomRightRadius: ['radius'],
  // shadow — only boxShadow shares the 'shadow' preset category. textShadow
  // is intentionally NOT mapped here: shadow presets store box-shadow
  // strings (offset-x offset-y blur spread color, plus optional inset),
  // which are not interchangeable with text-shadow values (no spread, no
  // inset). Surfacing box-shadow presets on the textShadow row created a
  // misleading "Card / Elevated" picker that wrote invalid CSS.
  boxShadow: ['shadow'],
  // border (whole shorthand)
  border: ['border'], borderTop: ['border'], borderRight: ['border'],
  borderBottom: ['border'], borderLeft: ['border'],
};

function matchingCategoriesFor(property: string): Set<PresetToken['category']> {
  // Only show preset entries on properties that map to a real preset
  // category (color, typography, spacing, radius, shadow, border, …).
  // 'other' is a fallback that piggy-backs on properties already handled by
  // a category — it is NOT a wildcard for unmapped properties. Without
  // this guard, properties like opacity/cursor/display would all surface
  // every 'other' preset on every dropdown, which is the bug the user
  // saw: "Apply Preset" showing on every style.
  const mapped = PROPERTY_CATEGORY_MAP[property];
  if (!mapped || mapped.length === 0) return new Set();
  const cats = new Set<PresetToken['category']>(mapped);
  cats.add('other');
  return cats;
}

/** The category the "Create … preset" entry should target. First mapped
 *  category for the property, or null when only the generic 'other' applies
 *  (in which case we hide the create entry). */
function primaryCategoryFor(property: string): PresetToken['category'] | null {
  const mapped = PROPERTY_CATEGORY_MAP[property];
  return mapped && mapped.length > 0 ? mapped[0] : null;
}

const CATEGORY_CREATE_LABELS: Record<PresetToken['category'], string> = {
  color: 'Create color preset',
  typography: 'Create typography preset',
  spacing: 'Create padding preset',
  margin: 'Create margin preset',
  radius: 'Create radius preset',
  shadow: 'Create shadow preset',
  border: 'Create border preset',
  image: 'Create image preset',
  video: 'Create video preset',
  other: 'Create preset',
};

/** Format a preset name into a display label: "color-brand-light" → "Brand Light". */
function presetDisplayLabel(token: PresetToken): string {
  if (token.label) return token.label;
  return token.name
    .replace(/^(?:color|typo|space|margin|radius|shadow|border|image|video)-/, '')
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function getPresetMenuItems(ctx: MenuContext): MenuItem[] {
  const items: MenuItem[] = [];

  // "Remove Preset" — when value is var(--*)
  if (ctx.hasPreset && ctx.removePreset) {
    items.push({
      label: 'Remove Preset',
      show: true,
      separator: true,
      onClick: () => {
        ctx.removePreset!(ctx.property);
        trace.action('control-menu:remove-preset', { property: ctx.property });
      },
    });
  }

  // "Apply Preset" — cascading submenu of compatible tokens for this property.
  // Falls back to the legacy onOpenPresetPicker only when no tokens fit (so
  // the user can still create one from scratch via the existing flow).
  if (ctx.presetTokens && ctx.presetTokens.length > 0) {
    const categories = matchingCategoriesFor(ctx.property);
    const compatible = ctx.presetTokens.filter(t => categories.has(t.category));

    // Special case: border presets are *compound* — one preset = a group of
    // 3+ tokens (width/style/color OR width/image-source/image-slice). Show
    // one submenu entry per GROUP, and apply by writing all the longhand
    // var() refs in a single updateStyles call.
    const isBorderProperty = categories.has('border');
    const submenuItems: MenuItem[] = isBorderProperty
      ? groupBorderTokens(compatible).map(group => ({
          label: group.label,
          show: true,
          onClick: () => {
            const styles = buildBorderApplyStyles(group);
            if (ctx.updateStyles) {
              ctx.updateStyles(styles);
            } else {
              for (const [k, v] of Object.entries(styles)) ctx.updateStyle(k, v);
            }
            trace.action('control-menu:apply-border-preset', { property: ctx.property, group: group.name, flavor: group.flavor });
          },
        }))
      : compatible.map(token => ({
          label: presetDisplayLabel(token),
          show: true,
          onClick: () => {
            ctx.updateStyle(ctx.property, `var(--${token.name})`);
            trace.action('control-menu:apply-preset', { property: ctx.property, token: token.name });
          },
        }));

    // Category-aware "Create … preset" entry. Only shown when the property
    // maps to a concrete category (color, typography, spacing, …). The old
    // `onOpenPresetPicker` fallback used to add a generic "Create new preset"
    // entry on EVERY property — which is what the user complained about
    // ("Apply Preset on basically every single style"). Dropped: properties
    // without a mapping get no preset menu at all.
    const createCategory = primaryCategoryFor(ctx.property);
    if (createCategory && ctx.onCreatePreset) {
      submenuItems.push({
        label: CATEGORY_CREATE_LABELS[createCategory],
        show: true,
        separator: submenuItems.length > 0,
        onClick: () => {
          ctx.onCreatePreset!(createCategory);
          trace.action('control-menu:create-preset', { property: ctx.property, category: createCategory });
        },
      });
    }

    if (submenuItems.length > 0) {
      items.push({
        label: 'Presets',
        show: true,
        onClick: () => { /* parent click is a no-op; the submenu opens on hover */ },
        submenuItems,
      });
    }
  }

  return items;
}

// ─── Apply-preset submenu for VARIABLE rows ─────────────────────────────────
//
// The component-instance editor lets the user apply a preset to a VARIABLE /
// hoisted-variable (e.g. set a radius variable to `var(--radius-md)`). Unlike
// `getPresetMenuItems` — which writes through `ctx.updateStyle` to the node —
// these submenu items take an `applyValue(cssValue)` writer so the caller can
// route the write to the instance prop instead. Returns [] for properties
// with no preset category (so the row shows no Apply-Preset entry).

/** True when `property` has at least one applicable preset category (radius,
 *  spacing, margin, shadow, border, …). Used to decide whether to add an
 *  Apply-Preset menu item to a variable row. */
export function propertyHasPresets(property: string): boolean {
  return matchingCategoriesFor(property).size > 0;
}

/**
 * Build the "Apply Preset" submenu for a variable row. Each item, when
 * clicked, calls `applyValue` with the CSS value to write into the variable:
 *   - normal categories → `var(--token-name)`
 *   - border (solid groups) → a composed `border` shorthand
 *     `var(--border-X-width) var(--border-X-style) var(--border-X-color)`
 *     (gradient border groups can't collapse to a single shorthand value, so
 *     they're omitted from the variable picker).
 */
export function buildPresetSubmenuItems(
  property: string,
  presetTokens: PresetToken[],
  applyValue: (cssValue: string) => void,
): MenuItem[] {
  const categories = matchingCategoriesFor(property);
  if (categories.size === 0) return [];
  const compatible = presetTokens.filter(t => categories.has(t.category));

  if (categories.has('border')) {
    return groupBorderTokens(compatible)
      .filter(g => g.flavor === 'solid')
      .map(group => ({
        label: group.label,
        show: true,
        onClick: () => {
          const shorthand = `${getBorderTokenVar(group.name, 'width')} ${getBorderTokenVar(group.name, 'style')} ${getBorderTokenVar(group.name, 'color')}`;
          applyValue(shorthand);
          trace.action('control-menu:apply-preset-variable', { property, group: group.name });
        },
      }));
  }

  return compatible.map(token => ({
    label: presetDisplayLabel(token),
    show: true,
    onClick: () => {
      applyValue(`var(--${token.name})`);
      trace.action('control-menu:apply-preset-variable', { property, token: token.name });
    },
  }));
}

// ─── CMS Field Binding ──────────────────────────────────────────────────────
//
// Type compatibility: the picker only shows fields whose type makes sense
// for the property. Picking an image field for `text` or a text field for
// a color produces broken JSX, so we hide the wrong types upfront. The map
// is intentionally generous — `text` + `richtext` are interchangeable for
// display, and most numeric props happily accept `number` fields.

export function fieldTypesForProperty(property: string, nodeTag?: string): Set<FieldDefinition['type']> {
  // ── Property-specific mappings that are RICHER than the bare variable type
  //    (extra field types the generic type wouldn't include). ──
  // `backgroundColor` is the property the Fill control writes to. On a
  // frame/div the user might want a colour OR a cover IMAGE (image URL → div
  // background); on a text element the same control is a text-highlight, where
  // an image binding is meaningless — narrow it to colour only there.
  if (property === 'backgroundColor') {
    return TEXT_TAGS.has(nodeTag ?? '')
      ? new Set(['color'])
      : new Set(['color', 'image', 'file']);
  }
  // Link href also accepts link / url / slug fields, not just plain text.
  if (property === 'href') return new Set(['link', 'url', 'text', 'slug']);
  // Text content & alt → any display-text field.
  if (property === 'text' || property === 'textContent' || property === 'alt') {
    return new Set(['text', 'textarea', 'richtext', 'slug']);
  }

  // ── Everything else: drive STRICTLY off the property's VARIABLE type — the
  //    SAME rule the Variable system uses (`pageVariableTypeForProperty`, which
  //    also gates the "Create Variable" entry). Only a same-typed field may
  //    bind: a number control → number fields, a boolean control (Hide →
  //    `display`) → boolean fields, etc. A property with no variable type
  //    (width, height, padding, transform, fontFamily, textAlign, …) is
  //    layout/structural, NOT content — it binds to NOTHING, so the whole
  //    "Bind to Field" entry disappears (candidates is empty). ──
  switch (pageVariableTypeForProperty(property)) {
    case 'number':  return new Set(['number']);
    case 'boolean': return new Set(['boolean']);
    case 'color':   return new Set(['color']);
    case 'image':   return new Set(['image', 'file']);
    case 'text':    return new Set(['text', 'textarea', 'richtext', 'slug']);
    default:        return new Set();
  }
}

export function getCmsBindingMenuItems(ctx: MenuContext): MenuItem[] {
  if (!ctx.cmsBinding) return [];
  // Some ControlLabel instances are decorative labels with `property=""`
  // (e.g. group headers in the typography preset row). Binding to those
  // would generate `style={{ : item.x }}` and crash the parser. Bail out.
  if (!ctx.property || !ctx.property.trim()) return [];
  const { fields, currentField, bindToField, unbindField, nodeTag } = ctx.cmsBinding;
  const compatibleTypes = fieldTypesForProperty(ctx.property, nodeTag);
  const candidates = fields.filter(f => compatibleTypes.has(f.type));

  const items: MenuItem[] = [];

  // Same convention as variable items: purple (accent-secondary) signals
  // "this affects the component master file"; on a regular page there's no
  // master/instance split, so use the standard blue accent.
  const hoverColor: 'accent' | 'accent-secondary' = ctx.isComponentFile ? 'accent-secondary' : 'accent';

  if (candidates.length > 0) {
    const submenuItems: MenuItem[] = candidates.map(field => ({
      label: field.name,
      show: true,
      hoverColor,
      onClick: () => {
        bindToField(field.id);
        trace.action('control-menu:bind-field', { property: ctx.property, fieldId: field.id });
      },
    }));

    items.push({
      label: 'Bind to Field',
      show: true,
      hoverColor,
      separator: true,
      onClick: () => { /* parent click is a no-op; submenu opens on hover */ },
      submenuItems,
    });
  }

  // "Unbind Field" — only when this property is currently bound.
  if (currentField) {
    items.push({
      label: 'Unbind Field',
      show: true,
      hoverColor,
      onClick: () => {
        unbindField();
        trace.action('control-menu:unbind-field', { property: ctx.property, fieldId: currentField });
      },
    });
  }

  return items;
}

// ─── Aggregate ──────────────────────────────────────────────────────────────

/** Get all menu items for a property. Extensible — add more generators here.
 *  When `hideCreateVariable` is true, the default Create / Remove Variable
 *  entries are skipped — used by FillControl which provides its own custom
 *  Create Variable submenu (Color/Gradient/Image/Video) via extraItems. */
export function getAllMenuItems(
  ctx: MenuContext,
  extraItems?: MenuItem[],
  options?: { hideCreateVariable?: boolean; hideSetVariable?: boolean; hideResetStyle?: boolean; hideCmsBinding?: boolean; hidePresets?: boolean; hideCopyPasteStyle?: boolean; hideVariableMenu?: boolean },
): MenuItem[] {
  return [
    // CMS bind first — when inside a collection template this is the
    // primary affordance the user expects ("how do I show the row's
    // title?"), so it sits at the top of every property's menu.
    // `hideCmsBinding` suppresses it for synthetic properties where
    // field-binding is meaningless (e.g. the Link tool's Slug control).
    ...(options?.hideCmsBinding ? [] : getCmsBindingMenuItems(ctx)),
    // `hidePresets` suppresses the standard "Presets" submenu — used in the
    // component-instance variable context where the row injects its OWN
    // "Apply Preset" item (one that writes to the instance prop instead of
    // the node style). Without this both would show (the user-reported
    // "Presets AND Apply Preset" duplicate).
    ...(options?.hidePresets ? [] : getPresetMenuItems(ctx)),
    // `hideVariableMenu` suppresses the ENTIRE variable menu (both "Create
    // Variable" AND the bind-to-existing "Set Variable"). Used by a control that
    // injects its OWN "Set Variable" via extraMenuItems (the Link tool's Slug
    // control) — otherwise the page/component-variable "Set Variable" shows
    // alongside the slug's, a duplicate. `hideCreateVariable` only hides "Create".
    ...(options?.hideVariableMenu ? [] : getVariableMenuItems(ctx, { hideCreate: options?.hideCreateVariable, hideSet: options?.hideSetVariable })),
    ...getOverrideMenuItems(ctx, options?.hideResetStyle),
    // `hideCopyPasteStyle` — for synthetic/non-style properties (e.g. the Scroll
    // Variant Section row) where copying a node style is meaningless.
    ...(options?.hideCopyPasteStyle ? [] : getCopyPasteStyleMenuItems(ctx)),
    ...getLocaleMenuItems(ctx),
    ...(extraItems ?? []),
  ].filter(item => item.show);
}
