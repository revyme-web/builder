// style-clipboard.ts — in-memory "Copy style / Paste style" for property controls.
//
// A CUSTOM clipboard, deliberately SEPARATE from the OS Cmd+C/Cmd+V (which copy
// whole nodes). Right-clicking (or opening the menu on) a ControlLabel offers
// "Copy Style"; "Paste Style" is enabled only on a COMPATIBLE target.
//
// Compatibility (reuses the variable-family resolver so it matches the bind rules):
//   1. SAME property                          → always (padding→padding, fill→fill, …)
//   2. COLOR is universal                      → any slot that accepts a color
//   3. SINGLE-NUMBER is universal              → any single-number slot (opacity↔zIndex↔gap…)
// A multi-value box (padding/margin/radius) is NOT single-number, so it only
// pastes back into the SAME property — matching the user's "copy padding → paste
// only in padding" rule.
//
// Fill is special: it snapshots its FULL config (solid / gradient / image /
// multi-layer) and only a SOLID fill is tagged `color` (so a solid colour can be
// pasted into any colour slot); gradient/image/multi-layer stay `fill`-only.

import { atom } from 'jotai';
import { resolveVariableIconKey, acceptedVariableFamilies, type VariableIconKey } from './VariableTypeIcon';
import { isMultiLayerBackground } from '@/editor/ui/background-layer-utils';
import { parseShadowEntries, formatShadowEntries, mergeFilterWithDropShadows } from '@/editor/ui/shadow-utils';
import { BORDER_INLINE_KEYS } from '@/editor/ui/border-utils';
import {
  MOTION_TRANSFORM_PROPS, hasMotionTransformProp,
  motionPropsToCSSTransform, cssTransformToMotionProps,
} from '@/shared/motion-transform';

export interface CopiedStyle {
  /** Variable family of the source — drives universal-colour compatibility. */
  family: VariableIconKey;
  /** Exact source property (e.g. `padding`, `backgroundColor`, `opacity`). */
  sourceProperty: string;
  /** The source's primary single value — used to remap universal colour/number pastes. */
  value: string;
  /** The full set of CSS keys→values to restore on a SAME-property paste. */
  payload: Record<string, string>;
  /** Human label of the source control, for the menu ("Copy Padding"). */
  label: string;
  /** Border only: the `::after` overlay rule BODY when the source border renders
   *  in overlay mode (solid or gradient — the gradient border IS an overlay
   *  rule with the mask-composite technique). Null/absent when the source
   *  border is inline. The paste side re-creates the rule on the target via
   *  the `updateBorderOverlay` mutation — it can't travel through the style
   *  map, hence the dedicated slot. */
  borderOverlayCSS?: string | null;
  /** Transform only: the source's transform as a CANONICAL composed CSS string,
   *  regardless of which of the two storage forms it was authored in.
   *
   *  A transform has two representations in this codebase and the SAME control
   *  edits both (see `motion-transform.ts` + the `isMotion` branch in
   *  `TransformControl`):
   *    • plain page element → a CSS `transform: 'rotate(30deg) scale(1.2)'` string
   *    • design-component `motion.*` element → INDEPENDENT motion props
   *      (`rotate: 30`, `scaleX: 1.2`, …), because a raw `transform` string
   *      collides with motion's own `layout` FLIP projection.
   *
   *  Copy stores the canonical CSS form so a transform can travel BETWEEN the
   *  two worlds; paste converts it back to whichever form the TARGET needs. */
  transformCSS?: string;
}

/** Motion transform props as a plain array, in a stable order — the fixed key
 *  set a transform copy snapshots and a transform paste fully rewrites (absent
 *  props snapshot as '' so the paste CLEARS whatever the target had, same
 *  full-clear contract `border` uses via `BORDER_INLINE_KEYS`). */
const MOTION_TRANSFORM_KEYS: string[] = [...MOTION_TRANSFORM_PROPS];

/** The single in-memory style clipboard slot (separate from OS clipboard). */
export const copiedStyleAtom = atom<CopiedStyle | null>(null);

// ─── Property groups ─────────────────────────────────────────────────────────

const SIDE_LONGHANDS: Record<string, string[]> = {
  margin: ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'],
  padding: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
  borderRadius: ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'],
  inset: ['top', 'right', 'bottom', 'left'],
};

/** All `background*` keys the Fill control owns (solid + gradient + image + multi-layer). */
const FILL_KEYS = [
  'backgroundColor', 'background', 'backgroundImage', 'backgroundSize',
  'backgroundPosition', 'backgroundRepeat', 'backgroundAttachment', 'backgroundBlendMode',
];

/** A property whose value is a single bare number (universal-number paste). NOT the
 *  multi-value box-model shorthands, even though they resolve to the `number` family. */
export function isSingleNumberProperty(property: string): boolean {
  if (property in SIDE_LONGHANDS) return false;
  return resolveVariableIconKey({ property }) === 'number';
}

/** Does the property hold a paint (so a solid colour can be pasted into it)? */
function isFillProperty(property: string): boolean {
  return property === 'backgroundColor' || property === 'background' || property === 'backgroundImage';
}

/** The CSS keys a control "owns" — what Copy snapshots and a same-property Paste restores. */
function ownedStyleKeys(property: string, styles: Record<string, string>): string[] {
  if (property in SIDE_LONGHANDS) return [property, ...SIDE_LONGHANDS[property]];
  if (property === 'backgroundColor') return FILL_KEYS;
  // The Shadow control owns `boxShadow` AND the drop-shadow portion of `filter`
  // (a "Drop" shadow is written as `filter: drop-shadow(...)`). Without `filter`
  // here, copying a Drop shadow snapshotted an empty boxShadow → paste was a no-op.
  if (property === 'boxShadow') return ['boxShadow', 'filter'];
  if (property === 'border') {
    // The COMPLETE border inline key set (shorthand + axis + per-side longhands
    // + borderImage* for inline gradient borders) — radius excluded, that's the
    // separate Radius control. A fixed list (not just the keys present on the
    // source) so absent keys snapshot as '' and the paste CLEARS whatever
    // configuration the target had (empty string = remove property). The
    // `::after` OVERLAY rule (solid or gradient) can't live in the style map —
    // it rides in `CopiedStyle.borderOverlayCSS` instead.
    return [...BORDER_INLINE_KEYS];
  }
  // Transform owns BOTH storage forms — the CSS string AND every motion prop.
  // A design-component element keeps `transform` EMPTY and holds the value in
  // `rotate` / `scaleX` / `skewX` / …, so snapshotting `transform` alone copied
  // nothing (and `hasCopyableStyle` hid the Copy Style entry entirely — the
  // reported bug: "no Copy Style on Transform inside a design component").
  if (property === 'transform') return ['transform', ...MOTION_TRANSFORM_KEYS];
  return [property];
}

/** Does this node store its transform as MOTION PROPS rather than a CSS
 *  `transform` string? True for design-component elements (every element in a
 *  component file is `motion.*`), for anything carrying variant styles, and for
 *  overlay nodes — mirrors the `isMotion` branch in `TransformControl`, kept
 *  here as ONE exported predicate so copy and paste can never disagree with the
 *  control that authored the value.
 *
 *  Shape-typed (not `CanvasNode`) so this module stays free of parser imports
 *  and the predicate is trivially unit-testable. */
export function isMotionTransformTarget(input: {
  isComponentFile: boolean;
  node?: { motionVariants?: unknown; motionVariantsRef?: unknown; attrs?: Record<string, string> } | null;
}): boolean {
  if (input.isComponentFile) return true;
  const n = input.node;
  if (!n) return false;
  return !!n.motionVariants || !!n.motionVariantsRef || !!n.attrs?.['data-overlay'];
}

/** The canonical composed CSS `transform` for a style map, whichever form it's
 *  authored in. Motion props win when present (a design-component element keeps
 *  `transform` empty); otherwise the plain CSS string. */
export function canonicalTransformCSS(styles: Record<string, string>): string {
  if (hasMotionTransformProp(styles)) {
    const css = motionPropsToCSSTransform(styles);
    if (css) return css;
  }
  const raw = (styles.transform ?? '').trim();
  return raw === 'none' ? '' : raw;
}

/** Tag the Fill control's family by its CONTENT: a solid colour is universal `color`;
 *  gradient / image / multi-layer stay fill-only (`fill`-ish family → same-property paste). */
function fillFamily(styles: Record<string, string>): VariableIconKey {
  // `isMultiLayerBackground` splits at TOP-LEVEL commas (not the commas inside a single
  // `gradient(...)`/`rgb(...)`), so a lone gradient isn't mis-read as multi-layer.
  if (isMultiLayerBackground(styles)) return 'image'; // multi-layer → fill-only
  const bg = styles.background || '';
  const bgImg = styles.backgroundImage || '';
  if (/gradient\(/.test(bg) || /gradient\(/.test(bgImg)) return 'gradient';
  if (/url\(/.test(bg) || /url\(/.test(bgImg)) return 'image';
  return 'color'; // solid → universal colour
}

// ─── Build / compatibility / restore ─────────────────────────────────────────

/** Snapshot the current style of `property` into a CopiedStyle. `opts.borderOverlayCSS`
 *  carries the source node's `::after` overlay rule body when the Border control
 *  renders in overlay mode (solid or gradient) — the caller reads it from the
 *  file's `<style>` block (see ControlLabel), since it lives outside the style map. */
export function buildCopiedStyle(
  property: string,
  styles: Record<string, string>,
  label: string,
  opts?: { borderOverlayCSS?: string | null },
): CopiedStyle {
  const keys = ownedStyleKeys(property, styles);
  const payload: Record<string, string> = {};
  for (const k of keys) payload[k] = styles[k] ?? '';
  // Shadow: snapshot ONLY the drop-shadow() calls out of `filter` (blur/brightness
  // /etc. belong to the separate Filter control). Stored as a drop-shadow-only
  // string so paste can MERGE it into the target without clobbering its other
  // filters. Empty when the source has no drop-shadow (paste then clears the
  // target's drop-shadows to match the source — which may be a box-shadow only).
  if (property === 'boxShadow') {
    payload.filter = formatShadowEntries(parseShadowEntries('', styles.filter || '')).dropShadowFilter;
  }
  const family = property === 'backgroundColor' ? fillFamily(styles) : resolveVariableIconKey({ property });
  const copied: CopiedStyle = { family, sourceProperty: property, value: styles[property] ?? '', payload, label };
  if (property === 'border') copied.borderOverlayCSS = opts?.borderOverlayCSS ?? null;
  if (property === 'transform') {
    // Canonical form travels with the copy so it can be pasted into EITHER
    // world. `value` is normally `styles[property]`, which is '' on a motion
    // element — set it to the canonical CSS so the copy isn't "empty" to any
    // consumer that inspects `value` (menus, compatibility checks, traces).
    copied.transformCSS = canonicalTransformCSS(styles);
    copied.value = copied.transformCSS;
  }
  return copied;
}

/** Is the copied style pasteable onto `targetProperty`? */
export function canPasteStyle(copied: CopiedStyle | null, targetProperty: string): boolean {
  if (!copied) return false;
  if (copied.sourceProperty === targetProperty) return true; // same property — always
  // Universal COLOUR — any slot that accepts a colour.
  if (copied.family === 'color' && acceptedVariableFamilies(targetProperty).includes('color')) return true;
  // Universal SINGLE-NUMBER — any single-number slot.
  if (isSingleNumberProperty(copied.sourceProperty) && isSingleNumberProperty(targetProperty)) return true;
  return false;
}

/** The CSS record to write on paste into `targetProperty`. `targetStyles` (the
 *  target node's current styles) is used by the Shadow paste to MERGE the copied
 *  drop-shadow into the target's `filter` without clobbering its other filters. */
export function buildPastePayload(
  copied: CopiedStyle,
  targetProperty: string,
  targetStyles?: Record<string, string>,
  opts?: {
    /** The paste target is a design-component `motion.*` element, so its
     *  transform must be written as INDEPENDENT MOTION PROPS rather than a CSS
     *  `transform` string (a raw string collides with motion's `layout` FLIP —
     *  see `motion-transform.ts`). Computed by the caller with the same
     *  predicate `TransformControl` uses for its `isMotion` branch. */
    isMotionTarget?: boolean;
  },
): Record<string, string> {
  // Same property → restore the owned snapshot.
  if (copied.sourceProperty === targetProperty) {
    // Shadow: merge the copied drop-shadow(s) into the TARGET's filter (keeps the
    // target's blur/brightness/etc.); boxShadow is replaced verbatim. `payload.filter`
    // is already drop-shadow-only (see buildCopiedStyle), and mergeFilterWithDropShadows
    // strips the target's own drop-shadows first, so the result is target-non-shadow
    // + the copied drop-shadows.
    if (targetProperty === 'boxShadow') {
      return {
        boxShadow: copied.payload.boxShadow ?? '',
        filter: mergeFilterWithDropShadows(targetStyles?.filter ?? '', copied.payload.filter ?? ''),
      };
    }
    // Border copied in OVERLAY mode: the payload is already the full-clear set
    // (all inline keys ''), matching what the Border panel writes when switching
    // to overlay. The `::after` rule itself is applied by the caller via the
    // `updateBorderOverlay` mutation (see ControlLabel.pasteStyle). The overlay
    // pseudo-element is positioned `inset: 0` — the HOST must be a positioned
    // box, so mirror the panel's write: seed `position: relative` when the
    // target has none/static (never clobber an explicit absolute/fixed).
    if (targetProperty === 'border' && copied.borderOverlayCSS) {
      const payload = { ...copied.payload };
      const pos = targetStyles?.position;
      if (!pos || pos === 'static') payload.position = 'relative';
      return payload;
    }
    // Transform: rebuild in the TARGET's storage form from the canonical CSS,
    // so a transform copied on a design component pastes correctly onto a page
    // element and vice-versa. Both branches write the FULL key set (absent
    // values as '' = remove) so the paste REPLACES the target's transform
    // instead of merging into a stale half of it — e.g. pasting a scale-only
    // transform onto an element that was rotated must clear the rotation.
    if (targetProperty === 'transform') {
      const css = copied.transformCSS ?? canonicalTransformCSS(copied.payload);
      if (opts?.isMotionTarget) {
        const motion = cssTransformToMotionProps(css);
        const payload: Record<string, string> = { transform: '' };
        for (const k of MOTION_TRANSFORM_KEYS) payload[k] = motion[k] ?? '';
        return payload;
      }
      const payload: Record<string, string> = { transform: css };
      for (const k of MOTION_TRANSFORM_KEYS) payload[k] = '';
      return payload;
    }
    return copied.payload;
  }
  // Universal colour → write the colour into the target's paint, clearing any
  // conflicting layers when the target is a Fill (so a solid colour replaces a
  // gradient/image rather than layering under it).
  if (copied.family === 'color' && acceptedVariableFamilies(targetProperty).includes('color')) {
    if (isFillProperty(targetProperty)) {
      return { backgroundColor: copied.value, background: '', backgroundImage: '', backgroundSize: '', backgroundPosition: '', backgroundRepeat: '', backgroundAttachment: '', backgroundBlendMode: '' };
    }
    return { [targetProperty]: copied.value };
  }
  // Universal single-number.
  if (isSingleNumberProperty(copied.sourceProperty) && isSingleNumberProperty(targetProperty)) {
    return { [targetProperty]: copied.value };
  }
  return {};
}
