// shadow-utils.ts — Parse and format CSS box-shadow + filter drop-shadow into
// a unified ShadowEntry[] list. Supports multi-layer shadows like the Mask tool.

import { trace } from '@/shared/debug-trace';
import { splitStyleProps } from '@/shared/css-utils';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ShadowEntry {
  id: string;            // deterministic: `shadow-${index}`
  type: 'box' | 'drop';  // box-shadow vs filter: drop-shadow()
  inset: boolean;         // only for box type
  x: number;
  y: number;
  blur: number;
  spread: number;         // only for box type (drop-shadow has no spread)
  color: string;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

export function createDefaultShadow(): ShadowEntry {
  trace.fn('createDefaultShadow', {});
  return {
    id: 'shadow-0',
    type: 'box',
    inset: false,
    x: 0, y: 4, blur: 8, spread: 0,
    color: 'rgba(0, 0, 0, 0.25)',
  };
}

// ─── Color extraction helpers ────────────────────────────────────────────────

/** Match a CSS color at the END of a string (rgb/rgba/hsl/hsla/hex/named/var()).
 *  `var(--name)` is included so a shadow whose color is bound to a color preset
 *  (e.g. `0 1px 3px var(--color-brand)`) round-trips through the editor with the
 *  preset reference intact — instead of falling through to the rgba fallback. */
const COLOR_END_RE = /((?:rgba?|hsla?)\([^)]+\)|var\(--[a-zA-Z0-9_-]+\)|#[0-9a-fA-F]{3,8}|[a-z]{3,20})\s*$/i;

/** Match a CSS color at the START of a string */
const COLOR_START_RE = /^((?:rgba?|hsla?)\([^)]+\)|var\(--[a-zA-Z0-9_-]+\)|#[0-9a-fA-F]{3,8})/i;

/**
 * Extract color from a shadow value string. Color can appear at start or end.
 * Returns [color, remainingString].
 */
function extractColor(s: string): [string, string] {
  // Try color at end first (most common: `0px 4px 8px rgba(0,0,0,0.25)`)
  const endMatch = s.match(COLOR_END_RE);
  if (endMatch) {
    const color = endMatch[1];
    const rest = s.slice(0, s.length - endMatch[0].length).trim();
    // Verify rest looks like numbers (avoid matching named color as the whole string)
    if (rest.length > 0 || !s.match(/^[a-z]/i)) {
      return [color, rest];
    }
  }
  // Try color at start (less common: `red 0px 4px 8px`)
  const startMatch = s.match(COLOR_START_RE);
  if (startMatch) {
    return [startMatch[1], s.slice(startMatch[0].length).trim()];
  }
  return ['rgba(0, 0, 0, 0.25)', s];
}

// ─── Parse box-shadow ────────────────────────────────────────────────────────

/** Split a box-shadow string into individual shadow strings (paren-aware comma split). */
const splitBoxShadows = splitStyleProps;

/** Parse a single box-shadow value string into a partial ShadowEntry. */
function parseOneBoxShadow(raw: string): Omit<ShadowEntry, 'id'> {
  let s = raw.trim();
  let inset = false;

  // Check for inset at start or end
  if (s.startsWith('inset ') || s.startsWith('inset\t')) {
    inset = true;
    s = s.slice(6).trim();
  } else if (s.endsWith(' inset') || s.endsWith('\tinset')) {
    inset = true;
    s = s.slice(0, -6).trim();
  }

  const [color, rest] = extractColor(s);
  const parts = rest.split(/\s+/).map(p => parseFloat(p) || 0);

  return {
    type: 'box',
    inset,
    x: parts[0] || 0,
    y: parts[1] || 0,
    blur: parts[2] || 0,
    spread: parts[3] || 0,
    color,
  };
}

// ─── Parse filter drop-shadow ────────────────────────────────────────────────

/** Extract all drop-shadow(...) calls from a filter string. Returns [dropShadowArgs[], remainingFilter]. */
function extractDropShadows(filter: string): [string[], string] {
  const args: string[] = [];
  let remaining = filter;
  // Manually find drop-shadow( and extract balanced-paren content
  let idx: number;
  while ((idx = remaining.toLowerCase().indexOf('drop-shadow(')) !== -1) {
    const start = idx + 'drop-shadow('.length;
    let depth = 1;
    let end = start;
    while (end < remaining.length && depth > 0) {
      if (remaining[end] === '(') depth++;
      else if (remaining[end] === ')') depth--;
      if (depth > 0) end++;
    }
    args.push(remaining.slice(start, end).trim());
    remaining = (remaining.slice(0, idx) + remaining.slice(end + 1)).replace(/\s+/g, ' ').trim();
  }
  return [args, remaining];
}

/** Parse a single drop-shadow() argument string into a partial ShadowEntry. */
function parseOneDropShadow(raw: string): Omit<ShadowEntry, 'id'> {
  const [color, rest] = extractColor(raw.trim());
  const parts = rest.split(/\s+/).map(p => parseFloat(p) || 0);

  return {
    type: 'drop',
    inset: false,
    x: parts[0] || 0,
    y: parts[1] || 0,
    blur: parts[2] || 0,
    spread: 0, // drop-shadow doesn't support spread
    color,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse box-shadow + filter into a unified ShadowEntry[] list.
 * Box entries come first, drop entries second.
 */
export function parseShadowEntries(boxShadow?: string, filter?: string): ShadowEntry[] {
  trace.fn('parseShadowEntries', {
    boxShadow: boxShadow?.slice(0, 60),
    filter: filter?.slice(0, 60),
  });

  const entries: ShadowEntry[] = [];
  let idx = 0;

  // Parse box-shadow
  if (boxShadow && boxShadow !== 'none') {
    const parts = splitBoxShadows(boxShadow);
    for (const part of parts) {
      const parsed = parseOneBoxShadow(part);
      entries.push({ ...parsed, id: `shadow-${idx++}` });
    }
  }

  // Parse drop-shadow from filter
  if (filter && filter !== 'none') {
    const [dropArgs] = extractDropShadows(filter);
    for (const arg of dropArgs) {
      const parsed = parseOneDropShadow(arg);
      entries.push({ ...parsed, id: `shadow-${idx++}` });
    }
  }

  return entries;
}

/**
 * Format ShadowEntry[] back to CSS strings.
 * Returns { boxShadow, filter } where filter contains ONLY the drop-shadow parts.
 * The caller must merge `filter` with existing non-shadow filter values.
 */
export function formatShadowEntries(entries: ShadowEntry[]): { boxShadow: string; dropShadowFilter: string } {
  trace.fn('formatShadowEntries', { count: entries.length });
  const boxParts: string[] = [];
  const dropParts: string[] = [];

  for (const e of entries) {
    if (e.type === 'box') {
      const parts: string[] = [];
      if (e.inset) parts.push('inset');
      parts.push(`${e.x}px`, `${e.y}px`, `${e.blur}px`, `${e.spread}px`, e.color);
      boxParts.push(parts.join(' '));
    } else {
      // drop-shadow: no spread, no inset
      dropParts.push(`drop-shadow(${e.x}px ${e.y}px ${e.blur}px ${e.color})`);
    }
  }

  return {
    boxShadow: boxParts.join(', '),
    dropShadowFilter: dropParts.join(' '),
  };
}

/**
 * Extract non-drop-shadow filter functions from a CSS filter string.
 * Returns the filter string with all drop-shadow() removed.
 */
export function extractNonShadowFilter(filter: string): string {
  if (!filter || filter === 'none') return '';
  trace.fn('extractNonShadowFilter', { filter: filter.slice(0, 60) });
  const [, remaining] = extractDropShadows(filter);
  return remaining;
}

/**
 * Merge drop-shadow filter parts with existing non-shadow filter functions.
 */
export function mergeFilterWithDropShadows(existingFilter: string, dropShadowFilter: string): string {
  trace.fn('mergeFilterWithDropShadows', { existing: existingFilter.slice(0, 40), drop: dropShadowFilter.slice(0, 40) });
  const nonShadow = extractNonShadowFilter(existingFilter);
  const parts = [nonShadow, dropShadowFilter].filter(Boolean);
  return parts.join(' ');
}

/** Format a shadow entry as a short summary string for the panel list. */
export function shadowSummary(e: ShadowEntry): string {
  return `${e.x}, ${e.y}, ${e.blur}`;
}
