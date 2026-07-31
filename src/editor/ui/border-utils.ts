// border-utils.ts — Border CSS parsing utilities.
// Supports per-side borders with full CSS cascade: global shorthand → axis shorthands
// → per-side shorthands → per-side longhands.

import { trace } from '@/shared/debug-trace';
import { splitStyleProps } from '@/shared/css-utils';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BorderSide {
  width: number;   // px
  style: string;   // none/solid/dashed/dotted/double/groove/ridge/inset/outset
  color: string;   // hex/rgba
}

export interface BorderState {
  top: BorderSide;
  right: BorderSide;
  bottom: BorderSide;
  left: BorderSide;
  isUniform: boolean; // derived: all 4 sides identical
}

// ─── Constants ───────────────────────────────────────────────────────────────

const BORDER_STYLES = new Set([
  'none', 'hidden', 'solid', 'dashed', 'dotted', 'double',
  'groove', 'ridge', 'inset', 'outset',
]);

const DEFAULT_SIDE: BorderSide = { width: 0, style: 'none', color: '#000000' };

// ─── Tokenize ────────────────────────────────────────────────────────────────

/**
 * Split a CSS value string into tokens, respecting parentheses.
 * e.g. "3px solid rgba(255, 0, 0, 0.5)" → ["3px", "solid", "rgba(255, 0, 0, 0.5)"]
 */
function tokenize(value: string): string[] {
  trace.fn('tokenize', { value });
  // Shared parenthesis-aware splitter on top-level spaces; drop empty tokens
  // (consecutive spaces produce empty segments).
  return splitStyleProps(value, ' ').filter((s) => s !== '');
}

// ─── parseBorderShorthand ─────────────────────────────────────────────────────

/**
 * Parse a CSS border shorthand like "1px solid red" into a BorderSide.
 * Tokens can appear in any order. Respects parentheses (for rgba/etc.).
 */
export function parseBorderShorthand(value: string): BorderSide {
  trace.fn('parseBorderShorthand', { value });

  const trimmed = (value ?? '').trim();
  if (!trimmed) return { ...DEFAULT_SIDE };

  const tokens = tokenize(trimmed);
  let width = 0;
  let style = 'none';
  let color = '#000000';

  for (const token of tokens) {
    if (BORDER_STYLES.has(token)) {
      style = token;
    } else if (/^\d/.test(token)) {
      // Starts with a digit → treat as width (e.g. "1px", "0", "2.5px")
      width = parseFloat(token);
    } else {
      // Anything else → color
      color = token;
    }
  }

  // If width > 0 but style is still 'none', default to 'solid'
  if (width > 0 && style === 'none') {
    style = 'solid';
  }

  trace.action('parseBorderShorthand:result', { width, style, color });
  return { width, style, color };
}

// ─── Multi-value splitting ────────────────────────────────────────────────────

/**
 * Split a CSS multi-value property (e.g. "1px 2px 3px 4px") into T/R/B/L values.
 * Follows CSS box model expansion rules:
 *   1 value  → all 4 sides
 *   2 values → TB, RL
 *   3 values → T, RL, B
 *   4 values → T, R, B, L
 */
function expandFourValues(value: string): [string, string, string, string] {
  trace.fn('expandFourValues', { value });
  const parts = value.trim().split(/\s+/);

  if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
  if (parts.length === 3) return [parts[0], parts[1], parts[2], parts[1]];
  return [parts[0], parts[1], parts[2], parts[3]];
}

// ─── parseBorderState ─────────────────────────────────────────────────────────

/**
 * Parse any combination of CSS border properties into a normalized BorderState.
 *
 * Priority layers (each overrides the previous):
 *   1. styles.border (global shorthand → base for all 4 sides)
 *   2. styles.borderWidth / borderStyle / borderColor (axis shorthands)
 *   3. styles.borderTop / borderRight / borderBottom / borderLeft (per-side shorthands)
 *   4. styles.borderTopWidth / borderTopStyle / borderTopColor (per-side longhands, highest)
 */
export function parseBorderState(styles: Record<string, string>): BorderState {
  trace.fn('parseBorderState', { keys: Object.keys(styles) });

  // Start with defaults for all 4 sides
  const top: BorderSide = { ...DEFAULT_SIDE };
  const right: BorderSide = { ...DEFAULT_SIDE };
  const bottom: BorderSide = { ...DEFAULT_SIDE };
  const left: BorderSide = { ...DEFAULT_SIDE };

  // ── Layer 1: global border shorthand ──────────────────────────────────────
  if (styles.border) {
    const base = parseBorderShorthand(styles.border);
    Object.assign(top, base);
    Object.assign(right, base);
    Object.assign(bottom, base);
    Object.assign(left, base);
    trace.action('parseBorderState:globalBorder', { base });
  }

  // ── Layer 2: axis shorthands ──────────────────────────────────────────────
  if (styles.borderWidth) {
    const [t, r, b, l] = expandFourValues(styles.borderWidth);
    top.width = parseFloat(t) || 0;
    right.width = parseFloat(r) || 0;
    bottom.width = parseFloat(b) || 0;
    left.width = parseFloat(l) || 0;
    trace.action('parseBorderState:borderWidth', { t, r, b, l });
  }

  if (styles.borderStyle) {
    const [t, r, b, l] = expandFourValues(styles.borderStyle);
    top.style = t;
    right.style = r;
    bottom.style = b;
    left.style = l;
    trace.action('parseBorderState:borderStyle', { t, r, b, l });
  }

  if (styles.borderColor) {
    const [t, r, b, l] = expandFourValues(styles.borderColor);
    top.color = t;
    right.color = r;
    bottom.color = b;
    left.color = l;
    trace.action('parseBorderState:borderColor', { t, r, b, l });
  }

  // ── Layer 3: per-side shorthands ──────────────────────────────────────────
  const perSideMap: [string, BorderSide][] = [
    ['borderTop', top],
    ['borderRight', right],
    ['borderBottom', bottom],
    ['borderLeft', left],
  ];

  for (const [prop, side] of perSideMap) {
    if (styles[prop]) {
      const parsed = parseBorderShorthand(styles[prop]);
      Object.assign(side, parsed);
      trace.action(`parseBorderState:${prop}`, { parsed });
    }
  }

  // ── Layer 4: per-side longhands (highest priority) ────────────────────────
  const sides: [string, BorderSide][] = [
    ['Top', top],
    ['Right', right],
    ['Bottom', bottom],
    ['Left', left],
  ];

  for (const [sideName, side] of sides) {
    const wKey = `border${sideName}Width`;
    const sKey = `border${sideName}Style`;
    const cKey = `border${sideName}Color`;

    // Empty string means "remove this property" — treat as absent, skip.
    if (styles[wKey] !== undefined && styles[wKey] !== '') {
      side.width = parseFloat(styles[wKey]) || 0;
      trace.action(`parseBorderState:${wKey}`, { width: side.width });
    }
    if (styles[sKey] !== undefined && styles[sKey] !== '') {
      side.style = styles[sKey];
      trace.action(`parseBorderState:${sKey}`, { style: side.style });
    }
    if (styles[cKey] !== undefined && styles[cKey] !== '') {
      side.color = styles[cKey];
      trace.action(`parseBorderState:${cKey}`, { color: side.color });
    }
  }

  // ── Fix-up: width > 0 but style 'none' → default to 'solid' ─────────────
  for (const side of [top, right, bottom, left]) {
    if (side.width > 0 && side.style === 'none') {
      side.style = 'solid';
    }
  }

  // ── Derived: isUniform ────────────────────────────────────────────────────
  const isUniform =
    top.width === right.width && top.width === bottom.width && top.width === left.width &&
    top.style === right.style && top.style === bottom.style && top.style === left.style &&
    top.color === right.color && top.color === bottom.color && top.color === left.color;

  trace.action('parseBorderState:result', { top, right, bottom, left, isUniform });

  return { top, right, bottom, left, isUniform };
}

// ─── formatBorderShorthand ────────────────────────────────────────────────────

/**
 * Format a BorderSide back to a CSS shorthand string.
 * Returns "none" when width is 0 (regardless of style/color).
 * e.g. {width:2, style:'solid', color:'#ff0000'} → "2px solid #ff0000"
 * e.g. {width:0, style:'none',  color:'#000000'} → "none"
 */
export function formatBorderShorthand(side: BorderSide): string {
  trace.fn('formatBorderShorthand', { side });

  if (side.width === 0) {
    trace.action('formatBorderShorthand:none', {});
    return 'none';
  }

  const result = `${side.width}px ${side.style} ${side.color}`;
  trace.action('formatBorderShorthand:result', { result });
  return result;
}

// ─── Per-side longhand key lists ──────────────────────────────────────────────

const SIDE_LONGHANDS = [
  'borderTopWidth', 'borderTopStyle', 'borderTopColor',
  'borderRightWidth', 'borderRightStyle', 'borderRightColor',
  'borderBottomWidth', 'borderBottomStyle', 'borderBottomColor',
  'borderLeftWidth', 'borderLeftStyle', 'borderLeftColor',
] as const;

const AXIS_SHORTHANDS = ['borderWidth', 'borderStyle', 'borderColor'] as const;

// ─── formatBorderUniform ──────────────────────────────────────────────────────

/**
 * Format a uniform border (all sides identical) → single `border` shorthand.
 * Clears all per-side longhands and axis shorthands so there are no conflicts.
 * Empty string '' means "remove this property" in the style system.
 *
 * Returns 16 keys total:
 *   - border (shorthand value)
 *   - 12 per-side longhands (all '')
 *   - 3 axis shorthands (all '')
 */
export function formatBorderUniform(side: BorderSide): Record<string, string> {
  trace.fn('formatBorderUniform', { side });

  const result: Record<string, string> = {
    border: formatBorderShorthand(side),
  };

  // Clear all per-side longhands
  for (const key of SIDE_LONGHANDS) {
    result[key] = '';
  }

  // Clear axis shorthands
  for (const key of AXIS_SHORTHANDS) {
    result[key] = '';
  }

  trace.action('formatBorderUniform:result', { keys: Object.keys(result).length });
  return result;
}

// ─── formatBorderIndividual ───────────────────────────────────────────────────

/**
 * Format per-side borders → 12 longhand props + clears the 4 shorthands.
 * Use this when sides differ (isUniform === false) or when forcing explicit control.
 *
 * Returns 16 keys total:
 *   - 12 per-side longhands (borderTopWidth, borderTopStyle, borderTopColor, …)
 *   - 4 shorthands cleared: border, borderWidth, borderStyle, borderColor
 */
export function formatBorderIndividual(state: BorderState): Record<string, string> {
  trace.fn('formatBorderIndividual', { state });

  const result: Record<string, string> = {};

  const sides: [string, BorderSide][] = [
    ['Top', state.top],
    ['Right', state.right],
    ['Bottom', state.bottom],
    ['Left', state.left],
  ];

  for (const [sideName, side] of sides) {
    result[`border${sideName}Width`] = side.width === 0 ? '0px' : `${side.width}px`;
    result[`border${sideName}Style`] = side.style;
    result[`border${sideName}Color`] = side.color;
  }

  // Clear global shorthands to avoid cascade conflicts
  result.border = '';
  for (const key of AXIS_SHORTHANDS) {
    result[key] = '';
  }

  trace.action('formatBorderIndividual:result', { keys: Object.keys(result).length });
  return result;
}

// ─── Overlay (::after) helpers ──────────────────────────────────────────────

/** All border-related inline style keys to strip when using overlay mode. */
export const BORDER_INLINE_KEYS = [
  'border', 'borderWidth', 'borderStyle', 'borderColor',
  ...SIDE_LONGHANDS,
  'borderTop', 'borderRight', 'borderBottom', 'borderLeft',
  'borderImage', 'borderImageSource', 'borderImageSlice',
] as const;

/** Format the CSS declarations for a ::after border overlay rule. */
export function formatBorderAfterCSS(state: BorderState): string {
  trace.fn('formatBorderAfterCSS', { state });
  const { top, right, bottom, left } = state;
  const lines: string[] = [
    'content: \'\';',
    'position: absolute;',
    'inset: 0;',
    'border-radius: inherit;',
    'pointer-events: none;',
    'z-index: 1;',
  ];

  if (state.isUniform) {
    lines.push(`border-width: ${top.width}px;`);
    lines.push(`border-style: ${top.style};`);
    lines.push(`border-color: ${top.color};`);
  } else {
    lines.push(`border-width: ${top.width}px ${right.width}px ${bottom.width}px ${left.width}px;`);
    lines.push(`border-style: ${top.style} ${right.style} ${bottom.style} ${left.style};`);
    lines.push(`border-color: ${top.color} ${right.color} ${bottom.color} ${left.color};`);
  }

  return lines.map(l => '  ' + l).join('\n');
}

// ─── Gradient border (::after mask technique) ────────────────────────────────

/**
 * Format a gradient border ::after rule using the mask composite technique.
 * The gradient is set as `background`. A mask with content-box + full-box layers
 * combined with `mask-composite: exclude` clips it to the border area only.
 */
export function formatGradientBorderAfterCSS(gradientCSS: string, width: number): string {
  trace.fn('formatGradientBorderAfterCSS', { width, gradientCSS: gradientCSS.slice(0, 60) });
  const lines = [
    "  content: '';",
    '  position: absolute;',
    '  inset: 0;',
    '  border-radius: inherit;',
    `  padding: ${width}px;`,
    `  background: ${gradientCSS};`,
    '  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);',
    '  -webkit-mask-composite: xor;',
    '  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);',
    '  mask-composite: exclude;',
    '  pointer-events: none;',
    '  z-index: 1;',
  ];
  return lines.join('\n');
}

/**
 * Parse a gradient border from a ::after CSS rule body.
 * Detects `mask-composite` as the gradient border signature.
 * Extracts `background` as gradientCSS and `padding` as width (px number).
 * Returns null if the CSS body does not contain `mask-composite` (i.e. solid border).
 *
 * The `background` value is extracted with parenthesis-aware parsing since
 * gradients contain commas.
 */
export function parseGradientBorderAfterCSS(cssBody: string): { gradientCSS: string; width: number } | null {
  trace.fn('parseGradientBorderAfterCSS', { cssBody: cssBody.slice(0, 80) });
  if (!cssBody) return null;

  // Check for mask-composite signature
  if (!cssBody.includes('mask-composite')) {
    trace.action('parseGradientBorderAfterCSS:notGradient', {});
    return null;
  }

  // Parse declarations with parenthesis-aware splitting on ';'
  let gradientCSS: string | null = null;
  let width: number | null = null;

  // Split on ';' outside parentheses (shared parenthesis-aware splitter)
  const declarations = splitStyleProps(cssBody, ';');

  for (const decl of declarations) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const key = decl.slice(0, colon).trim();
    const val = decl.slice(colon + 1).trim();
    if (!key || !val) continue;

    if (key === 'background') {
      gradientCSS = val;
    } else if (key === 'padding') {
      width = parseFloat(val);
    }
  }

  if (gradientCSS === null || width === null) {
    trace.action('parseGradientBorderAfterCSS:incomplete', { gradientCSS, width });
    return null;
  }

  trace.action('parseGradientBorderAfterCSS:result', { width, gradientCSS: gradientCSS.slice(0, 60) });
  return { gradientCSS, width };
}

/**
 * Check if inline styles contain a gradient border.
 * A gradient border is indicated by `borderImageSource` containing 'gradient'.
 */
export function isGradientBorder(styles: Record<string, string>): boolean {
  trace.fn('isGradientBorder', { keys: Object.keys(styles) });
  const src = styles.borderImageSource ?? '';
  const result = src.includes('gradient');
  trace.action('isGradientBorder:result', { result, src: src.slice(0, 60) });
  return result;
}

/**
 * Extract the `::after` border-overlay rule BODY for a node from a CSS text
 * (the `<style>` block contents, i.e. `extractStyleCSS(code)`), or null when
 * the node has no overlay rule. Matches both `data-id` (source) and
 * `data-node-id` (sandbox) selector spellings — the same regex BorderControl
 * uses to detect overlay render mode.
 */
export function extractBorderAfterRuleBody(css: string, nodeId: string): string | null {
  trace.fn('extractBorderAfterRuleBody', { nodeId });
  if (!css || !nodeId) return null;
  const esc = nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(`\\[data-(?:node-)?id="${esc}"\\]::after\\s*\\{([^}]*)\\}`, 's'));
  return m ? m[1] : null;
}

/** Parse border props from a ::after CSS rule body string. */
export function parseBorderAfterCSS(cssBody: string): BorderState | null {
  trace.fn('parseBorderAfterCSS', { cssBody: cssBody.slice(0, 80) });
  if (!cssBody) return null;

  const props = new Map<string, string>();
  for (const decl of cssBody.split(';')) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const key = decl.slice(0, colon).trim();
    const val = decl.slice(colon + 1).trim();
    if (key && val) props.set(key, val);
  }

  if (!props.has('border-width') && !props.has('border-top-width')) return null;

  // Build a styles Record in camelCase for parseBorderState to handle
  const styles: Record<string, string> = {};
  for (const [k, v] of props) {
    // Skip non-border props (content, position, inset, etc.)
    if (!k.startsWith('border')) continue;
    // Convert kebab to camelCase
    const camel = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    styles[camel] = v;
  }

  return parseBorderState(styles);
}
