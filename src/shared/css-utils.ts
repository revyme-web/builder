// css-utils.ts — CSS property conversion utilities.
// camelCase ↔ kebab-case, style string parsing, HTML↔JSX style conversion.

import { trace } from '@/shared/debug-trace';
import type { PresetToken } from '@/shared/types';

/**
 * Convert camelCase CSS property to kebab-case.
 * fontSize → font-size, backgroundColor → background-color
 */
/** See-through fill, spelled the way the builder's controls can represent it.
 *
 *  The `transparent` KEYWORD is banned across page / design-component code: the
 *  ColorPicker has no such swatch (see-through is alpha 0), so a `transparent`
 *  value shows as an empty, uneditable fill in the panel — and a quote-stripped
 *  `transparent` historically poisoned the motion composer. The oracle enforces
 *  this on AI submits (TRANSPARENT_COLOR); the builder must satisfy it natively,
 *  or its own output fails its own gate (user report 2026-07-26: a page that had
 *  only ever been edited in the builder carried 14 of these). */
export const TRANSPARENT_FILL = 'rgba(0, 0, 0, 0)';

/** Swap the banned `transparent` keyword on ANY property of a style map.
 *  Returns the SAME object when there is nothing to change, so callers on hot
 *  paths pay one scan and no allocation. */
export function normalizeTransparent<T extends Record<string, string>>(styles: T): T {
  let hit = false;
  for (const k in styles) {
    if (typeof styles[k] === 'string' && styles[k].trim() === 'transparent') { hit = true; break; }
  }
  if (!hit) return styles;
  const out: Record<string, string> = { ...styles };
  for (const k in out) {
    if (typeof out[k] === 'string' && out[k].trim() === 'transparent') out[k] = TRANSPARENT_FILL;
  }
  return out as T;
}

/** POSITION_OFFSET_REQUIRES_ABSOLUTE (oracle, tier 2) — clear coordinate
 *  offsets that provably do NOTHING, so one edit heals a legacy node.
 *
 *  `left/top/right/bottom` only place an element when position is
 *  absolute/fixed/sticky. On a relative (or position-less/static) node a ZERO
 *  offset is dead CSS — but not harmless: the Position tool's pin detector
 *  matches /^-?[\d.]+px$/, so '0px' reads as a PIN in the panel and the first
 *  drag rewrites it. AI/template-authored pages carried 39 of these (user report
 *  2026-07-26).
 *
 *  ZEROS ONLY, on purpose. A non-zero offset on a relative node is equally
 *  inert, but it encodes an intent someone typed — silently deleting it would
 *  discard authored data, and the oracle already asks the author to resolve it
 *  (make it absolute, or drop the offset). Returns null when there is nothing
 *  to heal. */
export function healInertOffsets(
  nodeStyles: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!nodeStyles) return null;
  const pos = (nodeStyles.position ?? '').trim();
  if (pos && pos !== 'relative' && pos !== 'static') return null;
  const out: Record<string, string> = {};
  for (const k of ['left', 'top', 'right', 'bottom'] as const) {
    const v = (nodeStyles[k] ?? '').trim();
    if (v === '0px' || v === '0') out[k] = '';
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function toKebab(s: string): string {
  return s.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
}

/**
 * Convert kebab-case CSS property to camelCase.
 * font-size → fontSize, background-color → backgroundColor
 */
export function toCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Parse a CSS style string into a Record.
 * "width: 100px; color: red" → { width: '100px', color: 'red' }
 */
export function parseStyleString(styleStr: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const decl of styleStr.split(';')) {
    const trimmed = decl.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const prop = trimmed.slice(0, colonIdx).trim();
    const val = trimmed.slice(colonIdx + 1).trim();
    result[prop] = val;
  }
  return result;
}

/**
 * Convert HTML inline styles to JSX object notation.
 * <span style="font-size: 14px; color: red"> → <span style={{fontSize: '14px', color: 'red'}}>
 * Also handles <br> → <br />
 */
/**
 * Convert JSX style syntax to HTML inline styles (for innerHTML rendering).
 * <span style={{fontSize: '14px', color: 'red'}}> → <span style="font-size: 14px; color: red">
 */
/**
 * Split a JSX style object string by commas, respecting parentheses.
 * "fontSize: '14px', color: 'rgb(0, 0, 0)'" → ["fontSize: '14px'", "color: 'rgb(0, 0, 0)'"]
 * Pass `separator` to split on a different top-level character (e.g. ' ' or ';').
 */
export function splitStyleProps(str: string, separator: string = ','): string[] {
  const results: string[] = [];
  let current = '';
  let parenDepth = 0;
  // Square brackets too — a motion cubic-bezier `ease: [0.16, 1, 0.3, 1]` (or a
  // CSS grid line name `[full-start]`) must NOT split at its inner commas.
  // Without this, a transition-object rewrite truncated the ease to the string
  // `'[0.16'` → motion threw "Invalid easing type" at runtime and every
  // whileInView below the element stayed at opacity 0 (live find 2026-07-03).
  let bracketDepth = 0;
  let inQuote: string | null = null;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (inQuote) {
      current += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }

    if (ch === "'" || ch === '"') {
      inQuote = ch;
      current += ch;
    } else if (ch === '(') {
      parenDepth++;
      current += ch;
    } else if (ch === ')') {
      parenDepth--;
      current += ch;
    } else if (ch === '[') {
      bracketDepth++;
      current += ch;
    } else if (ch === ']') {
      bracketDepth--;
      current += ch;
    } else if (ch === separator && parenDepth === 0 && bracketDepth === 0) {
      results.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) results.push(current.trim());
  return results;
}

/**
 * Extract the token name from the first `var(--token-name)` reference in a
 * CSS value. "var(--color-primary)" → "color-primary". Returns null when the
 * value contains no var() reference.
 */
export function parseVarRef(value: string): string | null {
  const m = value.match(/var\(--([^)]+)\)/);
  return m ? m[1] : null;
}

/**
 * Resolve a `var(--color-...)` reference to its underlying token value so the
 * tiny entry-list swatch paints correctly in the parent UI. The CSS custom
 * properties only live on the canvas iframe's contentRoot, so a raw var()
 * inside a parent-frame style object would resolve to nothing (transparent).
 * Only exact `var(--name)` values resolve; composite values (e.g. a border
 * shorthand containing a var()) are returned unchanged.
 */
export function resolvePresetColor(color: string, tokens: PresetToken[]): string {
  if (!color) return color;
  const m = color.match(/^var\(\s*--([^)\s,]+)\s*\)$/);
  if (!m) return color;
  return tokens.find(t => t.name === m[1])?.value ?? color;
}

export function jsxStyleToHTML(jsx: string): string {
  try {
    // Normalize MOTIONIZED inline tags to their plain HTML forms. A design
    // component's variant pass rewrites spans to `<motion.span layout={true}>`;
    // materializing that literally creates an UNKNOWN `<motion.span>` DOM
    // element — it still renders (unknown elements are inline, the style
    // applies, so the canvas LOOKED right) but TipTap's ProseMirror parser
    // drops unknown tags and keeps bare text, so entering text edit and
    // blurring committed PLAIN text: the span's color mark vanished and
    // white-on-white text "disappeared" (user repro 2026-08-05). The
    // committed round-trip (htmlToJSX) re-emits plain `<span>`, which every
    // layer handles.
    const normalized = jsx
      .replace(/<motion\.([a-zA-Z][\w-]*)/g, '<$1')
      .replace(/<\/motion\.([a-zA-Z][\w-]*)>/g, '</$1>')
      // The variantizer's `layout={true}` is a JSX-only prop — as HTML it
      // would serialize into a junk attribute.
      .replace(/\s+layout=\{true\}/g, '');
    return normalized.replace(
      /style=\{\{([^}]*(?:\{[^}]*\}[^}]*)*)\}\}/g,
      (_, propsStr: string) => {
        const pairs = splitStyleProps(propsStr)
          .filter(Boolean)
          .map(s => {
            const colonIdx = s.indexOf(':');
            if (colonIdx === -1) return '';
            const prop = s.slice(0, colonIdx).trim();
            const raw = s.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '');
            // Escape for the DOUBLE-quoted HTML style attribute. A quoted font
            // family (`"Playfair Display", serif`) would otherwise close the
            // attribute early — `style="font-family: "Playfair…"` — so the canvas
            // (which renders rich text via innerHTML) silently drops the font even
            // though the live site (React) is fine. `&quot;` round-trips back via
            // htmlToJSX's entity decode.
            const val = raw.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
            return `${toKebab(prop)}: ${val}`;
          })
          .filter(Boolean);
        return `style="${pairs.join('; ')}"`;
      }
    );
  } catch (err) {
    trace.error('css-utils:jsxStyleToHTML-failed', { error: err instanceof Error ? err.message : String(err) });
    return jsx;
  }
}

export function htmlToJSX(html: string): string {
  try {
    return html
      .replace(/<br\s*\/?>/g, '<br />')
      .replace(/<hr(\s[^>]*)?>/g, '<hr$1 />')
      // Convert style="..." to style={{...}} wherever it appears in a tag (any attribute order)
      .replace(/(<\w+[^>]*?)\s+style="([^"]*)"([^>]*>)/g, (_full: string, before: string, styleStr: string, after: string) => {
        // Decode the entities the serializer escapes (a quoted font family comes
        // back as `&quot;Playfair Display&quot;`) BEFORE splitting on `;` — `&quot;`
        // itself ends in `;`, so splitting first shreds the value into garbage.
        const decoded = styleStr.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
        const pairs = decoded
          .split(';')
          .map(s => s.trim())
          .filter(Boolean)
          .map(s => {
            const colonIdx = s.indexOf(':');
            const prop = s.slice(0, colonIdx).trim();
            const val = s.slice(colonIdx + 1).trim();
            // Pick a JSX string quote the value doesn't contain, else escape it.
            // A font family like `'Playfair Display', serif` MUST NOT be wrapped in
            // single quotes → `''Playfair Display', serif'` is INVALID JSX, the
            // parse silently fails (parseJSX returns null), and the WHOLE text gets
            // wiped on commit. Quote with `"` when the value contains a `'`.
            const quote = val.includes("'") ? '"' : "'";
            const escaped = quote === '"' ? val.replace(/"/g, '\\"') : val.replace(/'/g, "\\'");
            return `${toCamel(prop)}: ${quote}${escaped}${quote}`;
          });
        return `${before} style={{${pairs.join(', ')}}}${after}`;
      });
  } catch (err) {
    trace.error('css-utils:htmlToJSX-failed', { error: err instanceof Error ? err.message : String(err) });
    return html;
  }
}

/**
 * Parse a CSS shorthand value (margin, padding, borderRadius) into 4 individual values.
 * Follows CSS shorthand rules:
 *   1 value  → all four
 *   2 values → vertical | horizontal
 *   3 values → top | horizontal | bottom
 *   4 values → top | right | bottom | left
 *
 * Returns [top, right, bottom, left] for margin/padding,
 * or [TL, TR, BR, BL] for borderRadius.
 */
// CSS properties that take a UNITLESS number (React's list). A bare number for any OTHER property gets
// 'px' appended — mirroring how React renders `style={{ gap: 61 }}` as `61px`. Needed because raw-number
// VARIABLES store the value as the bare string "61"; `el.style.gap = "61"` is invalid CSS (ignored), so
// the value wouldn't render on the canvas even though it works live (where React gets the number).
const UNITLESS_CSS_PROPS = new Set([
  'opacity', 'zIndex', 'order', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink',
  'columnCount', 'columns', 'fillOpacity', 'floodOpacity', 'stopOpacity', 'strokeOpacity',
  'strokeMiterlimit', 'strokeDashoffset', 'tabSize', 'widows', 'orphans', 'zoom',
  'gridRow', 'gridRowStart', 'gridRowEnd', 'gridColumn', 'gridColumnStart', 'gridColumnEnd',
  'animationIterationCount', 'aspectRatio', 'scale', 'lineClamp',
]);
const BARE_NUMBER_RE = /^-?\d+(\.\d+)?$/;

/** Append 'px' to a bare numeric value for a px-property (React-equivalent), else pass through. Custom
 *  properties (`--x`) are never coerced (set verbatim via setProperty). The single source of truth used
 *  by the Renderer AND the iframe bridge's live-patch path so the canvas matches the live site. */
/** CSS properties whose bare-number values mean DEGREES, not px. Written by
 *  motion-convention flows (framer-motion accepts numeric rotate) onto nodes
 *  that render as PLAIN elements — e.g. a code-component instance's style —
 *  where `rotate: 180` is invalid CSS and silently ignored (user report
 *  2026-07-31: rotated code components not rotated on the canvas). `deg`
 *  strings stay valid for framer-motion too. */
const ANGLE_CSS_PROPS = new Set(['rotate']);

export function coerceCssNumberToPx(key: string, v: string): string {
  if (key.startsWith('--')) return v;
  if (BARE_NUMBER_RE.test(v) && ANGLE_CSS_PROPS.has(key)) return `${v}deg`;
  if (BARE_NUMBER_RE.test(v) && !UNITLESS_CSS_PROPS.has(key)) return `${v}px`;
  return v;
}

/** Effective T/R/B/L sides of a padding/margin from a style object that may
 *  MIX the shorthand with longhands (legacy Figma imports emit
 *  `paddingTop: '66px', …, padding: '34px'` in ONE object). React resolves
 *  a style object in KEY ORDER — a trailing shorthand overrides earlier
 *  longhands — so any reader that prefers longhands over the shorthand
 *  (`styles.paddingTop || sh[0]`) disagrees with what canvas + deploy
 *  actually render. This walks the object in insertion order, expanding
 *  the shorthand when it appears, so the result is exactly React's
 *  last-write-wins outcome. Empty string = side not set. */
export function resolveSpacingSides(
  styles: Record<string, string | undefined>,
  base: 'padding' | 'margin',
): [string, string, string, string] {
  const sideKeys = [`${base}Top`, `${base}Right`, `${base}Bottom`, `${base}Left`];
  const sides: [string, string, string, string] = ['', '', '', ''];
  for (const [k, v] of Object.entries(styles)) {
    if (v == null || v === '') continue;
    if (k === base) {
      const sh = parseShorthand(String(v));
      sides[0] = sh[0]; sides[1] = sh[1]; sides[2] = sh[2]; sides[3] = sh[3];
    } else {
      const i = sideKeys.indexOf(k);
      if (i >= 0) sides[i] = String(v);
    }
  }
  return sides;
}

/** Write-side companion of `resolveSpacingSides`: when a style WRITE sets a
 *  padding/margin longhand on a node whose source still carries the
 *  shorthand, the mix must not survive the commit — otherwise the source
 *  stays ambiguous forever and every undo back to it re-opens the
 *  panel-vs-render disagreement. Returns extra entries to merge into the
 *  write: the effective value for each side the write doesn't set, plus
 *  `base: ''` to delete the shorthand. Null = nothing to heal (no shorthand
 *  in the source, no longhand in the write, or the write already handles
 *  the shorthand itself). */
export function healSpacingShorthand(
  write: Record<string, string>,
  nodeStyles: Record<string, string | undefined>,
  base: 'padding' | 'margin',
): Record<string, string> | null {
  if (!nodeStyles[base]) return null;
  if (Object.prototype.hasOwnProperty.call(write, base)) return null;
  const sideKeys = [`${base}Top`, `${base}Right`, `${base}Bottom`, `${base}Left`];
  if (!sideKeys.some((k) => Object.prototype.hasOwnProperty.call(write, k) && write[k] !== '')) return null;
  const effective = resolveSpacingSides(nodeStyles, base);
  const extra: Record<string, string> = { [base]: '' };
  sideKeys.forEach((k, i) => {
    if (!Object.prototype.hasOwnProperty.call(write, k) && effective[i] !== '') extra[k] = effective[i];
  });
  return extra;
}

export function parseShorthand(value: string | undefined): [string, string, string, string] {
  if (!value || value === '0') return ['0', '0', '0', '0'];
  const parts = value.trim().split(/\s+/);
  switch (parts.length) {
    case 1: return [parts[0], parts[0], parts[0], parts[0]];
    case 2: return [parts[0], parts[1], parts[0], parts[1]];
    case 3: return [parts[0], parts[1], parts[2], parts[1]];
    case 4: return [parts[0], parts[1], parts[2], parts[3]];
    default: return [parts[0], parts[1], parts[2], parts[3]];
  }
}
