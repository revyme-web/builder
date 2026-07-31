// VariableTypeIcon.tsx — standard filled type glyph for a variable.
//
// Each variable kind gets a distinct filled icon (color = droplet, number = #, boolean = toggle, …)
// shown in the Variable modal's list AND on the purple variable pill in the controls panel. The SVG
// paths are sourced from Iconify (mingcute / material-symbols / mdi / phosphor — all filled style) and
// were each vision-checked to confirm they read as the right concept. Rendered with `currentColor` so
// they inherit the pill's white text on the purple background.

import React from 'react';
import { inferPropertyFromValue } from '@/code/components/prop-css-mapping';

export type VariableIconKey =
  | 'color' | 'number' | 'text' | 'boolean' | 'image'
  | 'radius' | 'shadow' | 'border' | 'gradient' | 'opacity'
  | 'link' | 'option' | 'event' | 'date' | 'cursor' | 'file' | 'transition'
  | 'generic';

interface IconDef { viewBox: string; d: string; }

// Single-path filled glyphs. Sources (Iconify, vision-verified):
//   color mingcute:drop-fill · number mingcute:hashtag-fill · text material-symbols:title-rounded ·
//   boolean mingcute:toggle-right-fill · image mingcute:pic-fill · radius mingcute:border-radius-fill ·
//   shadow mdi:box-shadow · border material-symbols:border-style-rounded · gradient ph:gradient-fill ·
//   opacity ph:drop-half-bottom-fill · generic ph:cube-fill
const ICONS: Record<VariableIconKey, IconDef> = {
  color:    { viewBox: '0 0 24 24', d: 'M11.249 2.321a1.18 1.18 0 0 1 1.502 0A28.6 28.6 0 0 1 16.682 6.3C18.322 8.339 20 11.106 20 14a8 8 0 0 1-16 0c0-2.894 1.678-5.661 3.318-7.701a28.6 28.6 0 0 1 3.93-3.978Z' },
  number:   { viewBox: '0 0 24 24', d: 'M9.686 2.512a1.5 1.5 0 0 1 1.303 1.674L10.637 7h3.976l.399-3.186a1.5 1.5 0 0 1 2.977.372L17.637 7H20a1.5 1.5 0 0 1 0 3h-2.738l-.5 4H19.5a1.5 1.5 0 0 1 0 3h-3.113l-.398 3.186a1.5 1.5 0 0 1-2.977-.372L13.363 17H9.388l-.398 3.186a1.5 1.5 0 1 1-2.977-.372L6.363 17H4.5a1.5 1.5 0 1 1 0-3h2.238l.5-4H5a1.5 1.5 0 1 1 0-3h2.613l.399-3.186A1.5 1.5 0 0 1 9.686 2.51ZM13.74 14l.5-4h-3.977l-.5 4z' },
  text:     { viewBox: '0 0 24 24', d: 'M10.5 7h-4q-.625 0-1.062-.437T5 5.5t.438-1.062T6.5 4h11q.625 0 1.063.438T19 5.5t-.437 1.063T17.5 7h-4v11.5q0 .625-.437 1.063T12 20t-1.062-.437T10.5 18.5z' },
  boolean:  { viewBox: '0 0 24 24', d: 'M7 6a6 6 0 1 0 0 12h10a6 6 0 0 0 0-12zm10 10a4 4 0 1 0 0-8a4 4 0 0 0 0 8' },
  image:    { viewBox: '0 0 24 24', d: 'M20 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 2H4v10.1l4.995-4.994a1.25 1.25 0 0 1 1.768 0l4.065 4.066l1.238-1.238a1.25 1.25 0 0 1 1.768 0L20 15.101zm-4.5 2a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3' },
  radius:   { viewBox: '0 0 24 24', d: 'M4 2.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3m4 0a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3m-4 4a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3m0 4a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3m0 4a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3m16 0a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3m-16 4a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3m4 0a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3m4 0a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3m4 0a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3m4 0a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3m-8-16a1.5 1.5 0 0 0 0 3h2a4.5 4.5 0 0 1 4.5 4.5v2a1.5 1.5 0 0 0 3 0v-2A7.5 7.5 0 0 0 14 2.5z' },
  shadow:   { viewBox: '0 0 24 24', d: 'M3 3h15v15H3zm16 16h2v2h-2zm0-3h2v2h-2zm0-3h2v2h-2zm0-3h2v2h-2zm0-3h2v2h-2zm-3 12h2v2h-2zm-3 0h2v2h-2zm-3 0h2v2h-2zm-3 0h2v2H7z' },
  border:   { viewBox: '0 0 24 24', d: 'M19.288 8.713Q19 8.425 19 8t.288-.712T20 7t.713.288T21 8t-.288.713T20 9t-.712-.288m0 4Q19 12.426 19 12t.288-.712T20 11t.713.288T21 12t-.288.713T20 13t-.712-.288m0 4Q19 16.426 19 16t.288-.712T20 15t.713.288T21 16t-.288.713T20 17t-.712-.288m-12 4Q7 20.426 7 20t.288-.712T8 19t.713.288T9 20t-.288.713T8 21t-.712-.288m4 0Q11 20.426 11 20t.288-.712T12 19t.713.288T13 20t-.288.713T12 21t-.712-.288m4 0Q15 20.426 15 20t.288-.712T16 19t.713.288T17 20t-.288.713T16 21t-.712-.288m4 0Q19 20.426 19 20t.288-.712T20 19t.713.288T21 20t-.288.713T20 21t-.712-.288M3 20V5q0-.825.588-1.412T5 3h15q.425 0 .713.288T21 4t-.288.713T20 5H5v15q0 .425-.288.713T4 21t-.712-.288T3 20' },
  gradient: { viewBox: '0 0 256 256', d: 'M80 192a8 8 0 0 1-8 8H32a8 8 0 0 1 0-16h40a8 8 0 0 1 8 8m144-8h-40a8 8 0 0 0 0 16h40a8 8 0 0 0 0-16m-72 0h-48a8 8 0 0 0 0 16h48a8 8 0 0 0 0-16M32 168h80a8 8 0 0 0 0-16H32a8 8 0 0 0 0 16m192-16h-80a8 8 0 0 0 0 16h80a8 8 0 0 0 0-16m0-96H32a8 8 0 0 0-8 8v24a8 8 0 0 0 8 8h192a8 8 0 0 0 8-8V64a8 8 0 0 0-8-8m0 56H32a8 8 0 0 0-8 8v8a8 8 0 0 0 8 8h192a8 8 0 0 0 8-8v-8a8 8 0 0 0-8-8' },
  opacity:  { viewBox: '0 0 256 256', d: 'M174 47.75a254.2 254.2 0 0 0-41.45-38.3a8 8 0 0 0-9.18 0A254.2 254.2 0 0 0 82 47.75C54.51 79.32 40 112.6 40 144a88 88 0 0 0 176 0c0-31.4-14.51-64.68-42-96.25M128 26c14.16 11.1 56.86 47.74 68.84 94H59.16C71.14 73.76 113.84 37.12 128 26' },
  generic:  { viewBox: '0 0 256 256', d: 'm223.68 66.15l-88-48.15a15.88 15.88 0 0 0-15.36 0l-88 48.17a16 16 0 0 0-8.32 14v95.64a16 16 0 0 0 8.32 14l88 48.17a15.88 15.88 0 0 0 15.36 0l88-48.17a16 16 0 0 0 8.32-14V80.18a16 16 0 0 0-8.32-14.03M128 120L47.65 76L128 32l80.35 44Zm8 99.64v-85.81l80-43.78v85.76Z' },
  // Data-type icons (mingcute fill, vision-verified): link, option (list), event (bolt), date
  // (calendar), cursor (pointer), file, transition (swap arrows).
  link:       { viewBox: '0 0 24 24', d: 'm17.303 9.524l3.182 3.182a5.5 5.5 0 1 1-7.778 7.778l-1.06-1.06a1.5 1.5 0 1 1 2.12-2.122l1.062 1.061a2.5 2.5 0 0 0 3.535-3.536l-3.182-3.182a2.5 2.5 0 0 0-2.681-.56q-.242.096-.454.196l-.464.217c-.62.28-1.097.4-1.704-.206c-.872-.872-.646-1.677.417-2.41a5.5 5.5 0 0 1 7.007.642m-6.01-6.01l1.06 1.06a1.5 1.5 0 0 1-2.12 2.122l-1.061-1.06A2.5 2.5 0 1 0 5.636 9.17l3.182 3.182a2.5 2.5 0 0 0 2.681.56q.242-.096.454-.196l.464-.217c.62-.28 1.098-.4 1.704.206c.872.872.646 1.677-.417 2.41a5.5 5.5 0 0 1-7.007-.642l-3.182-3.182a5.5 5.5 0 1 1 7.778-7.778Z' },
  option:     { viewBox: '0 0 24 24', d: 'M20 17.5a1.5 1.5 0 0 1 0 3H9a1.5 1.5 0 0 1 0-3zm-15.5 0a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3m15.5-7a1.5 1.5 0 0 1 .144 2.993L20 13.5H9a1.5 1.5 0 0 1-.144-2.993L9 10.5zm-15.5 0a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3m0-7a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3m15.5 0a1.5 1.5 0 0 1 .144 2.993L20 6.5H9a1.5 1.5 0 0 1-.144-2.993L9 3.5z' },
  event:      { viewBox: '0 0 24 24', d: 'M8.084 2.6c.162-.365.523-.6.923-.6h7.977c.75 0 1.239.79.903 1.462L15.618 8h3.358c.9 0 1.35 1.088.714 1.724L7.737 21.677c-.754.754-2.01-.022-1.672-1.033L8.613 13H5.015a1.01 1.01 0 0 1-.923-1.42z' },
  date:       { viewBox: '0 0 24 24', d: 'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7zm-5-9a1 1 0 0 1 1 1v1h2a2 2 0 0 1 2 2v3H3V7a2 2 0 0 1 2-2h2V4a1 1 0 0 1 2 0v1h6V4a1 1 0 0 1 1-1' },
  cursor:     { viewBox: '0 0 24 24', d: 'M6.682 3.396a1.088 1.088 0 0 1 1.807-.745l9.951 8.827c.724.642.312 1.84-.655 1.9l-3.117.191l2.092 4.999a2 2 0 0 1-1.062 2.612l-.868.37a2 2 0 0 1-2.626-1.061l-2.226-5.262l-2.323 2.007c-.73.63-1.858.07-1.797-.892z' },
  file:       { viewBox: '0 0 24 24', d: 'M12 2v6.5a1.5 1.5 0 0 0 1.356 1.493L13.5 10H20v10a2 2 0 0 1-1.85 1.995L18 22H6a2 2 0 0 1-1.995-1.85L4 20V4a2 2 0 0 1 1.85-1.995L6 2zm2 .043a2 2 0 0 1 .877.43l.123.113L19.414 7a2 2 0 0 1 .502.84l.04.16H14z' },
  transition: { viewBox: '0 0 24 24', d: 'M8.56 11.9a1.5 1.5 0 0 1 0 2.12l-.974.976H16a1.5 1.5 0 0 1 0 3H7.586l.975.974a1.5 1.5 0 1 1-2.122 2.122l-3.535-3.536a1.5 1.5 0 0 1 0-2.121l3.535-3.536a1.5 1.5 0 0 1 2.122 0Zm6.88-9a1.5 1.5 0 0 1 2.007-.104l.114.103l3.535 3.536a1.5 1.5 0 0 1 .103 2.007l-.103.114l-3.535 3.536a1.5 1.5 0 0 1-2.225-2.008l.103-.114l.975-.974H8a1.5 1.5 0 0 1-.144-2.994L8 5.996h8.414l-.975-.975a1.5 1.5 0 0 1 0-2.122Z' },
};

export function VariableTypeIcon({ iconKey, size = 16, className }: { iconKey: VariableIconKey; size?: number; className?: string }) {
  const def = ICONS[iconKey] ?? ICONS.generic;
  return (
    <svg width={size} height={size} viewBox={def.viewBox} fill="currentColor" className={className} aria-hidden="true">
      <path d={def.d} />
    </svg>
  );
}

// ─── Resolver ────────────────────────────────────────────────────────────────

const PROP_TO_ICON: Record<string, VariableIconKey> = {
  backgroundColor: 'color', color: 'color', borderColor: 'color', fill: 'color',
  caretColor: 'color', outlineColor: 'color', textDecorationColor: 'color', stroke: 'color',
  borderRadius: 'radius',
  boxShadow: 'shadow', textShadow: 'shadow',
  border: 'border', borderWidth: 'border', borderStyle: 'border',
  // Opacity is a single number → the Number type (the reference model: there is no "opacity variable", just a
  // number you can attach to any single-number control). Toggle-style booleans use the boolean glyph.
  opacity: 'number',
  // Hide/Wrap toggles: display + visibility + flexWrap all bind via a boolean ternary
  // (`display: hideVar ? 'none' : ''`). `display` was missing → the Hide control resolved 'generic',
  // so its "Set Variable" submenu (which suppresses on generic) never offered the boolean variables.
  display: 'boolean', flexWrap: 'boolean', visibility: 'boolean',
  transition: 'transition',
  cursor: 'cursor',
  // backgroundImage can be a gradient OR an image; the Fill editor it opens is the image picker, so
  // the image glyph is the more intuitive default. (Pure-gradient vars are rare as standalone vars.)
  backgroundImage: 'image',
  // Text content → the text family (a Content variable is plain/formatted text).
  textContent: 'text',
  // Enum/segmented layout + alignment controls → the Option family (Direction, Align, Justify, …). Without
  // these they fell through to 'generic', and generic↔generic cross-matched (a text Content control then
  // listed direction/align in "Set Variable").
  flexDirection: 'option', alignItems: 'option', justifyContent: 'option', alignContent: 'option',
  alignSelf: 'option', justifySelf: 'option', textAlign: 'option', overflow: 'option', position: 'option',
};

const PAGEVAR_TYPE_TO_ICON: Record<string, VariableIconKey> = {
  color: 'color', number: 'number', text: 'text', boolean: 'boolean', image: 'image', componentCursor: 'generic',
};

// Dimension / spacing / typography-size props → the numeric glyph.
const NUMERIC_PROP_RE = /^(width|height|gap|columnGap|rowGap|padding|margin|inset|top|left|right|bottom|fontSize|lineHeight|letterSpacing|zIndex|order|flexGrow|flexShrink|flexBasis|minWidth|maxWidth|minHeight|maxHeight)/;

/** Pick the icon for a variable from whatever identity info is available: a page-var `type`, the CSS
 *  `property` it drives, or (orphan fallback) the shape of its default `value`. Defaults to 'generic'. */
export function resolveVariableIconKey(opts: { property?: string; pageVarType?: string; value?: string }): VariableIconKey {
  const { property, pageVarType, value } = opts;
  if (pageVarType && PAGEVAR_TYPE_TO_ICON[pageVarType]) return PAGEVAR_TYPE_TO_ICON[pageVarType];
  if (property) {
    if (PROP_TO_ICON[property]) return PROP_TO_ICON[property];
    if (NUMERIC_PROP_RE.test(property)) return 'number';
  }
  // Orphan variable with no live binding — infer from the default value's shape.
  const inferred = value ? inferPropertyFromValue(value) : '';
  if (inferred && PROP_TO_ICON[inferred]) return PROP_TO_ICON[inferred];
  return 'generic';
}

/** The set of variable "families" (types) a control accepts for binding in its "Set Variable" submenu.
 *  Almost every control accepts exactly one family (its own); the FILL control is special — it paints
 *  with a color, a gradient, OR an image, so it accepts all three. This is the single source of truth
 *  for which existing variables a control offers to bind. */
export function acceptedVariableFamilies(property: string): VariableIconKey[] {
  // Fill: backgroundColor / background drive any paint type.
  if (property === 'backgroundColor' || property === 'background') return ['color', 'gradient', 'image'];
  if (property === 'backgroundImage') return ['image', 'gradient'];
  return [resolveVariableIconKey({ property })];
}
