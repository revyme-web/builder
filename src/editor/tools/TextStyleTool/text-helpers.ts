// text-helpers.ts — Preview helpers for text style popup controls.

import { splitStyleProps } from '@/shared/css-utils';

// ─── Multi-entry text-shadow (standard: stack several shadows on one element) ───
//
// CSS `text-shadow` is a comma-separated list — `1px 1px 2px red, 0 0 5px blue` — exactly like
// `box-shadow`, but simpler: each layer is just offset-x / offset-y / blur / color (no spread, no
// inset, no drop-shadow split). These mirror shadow-utils.ts so the Text Shadow control can reuse the
// shared EntryList UI.

export interface TextShadowEntry {
  /** Stable id for React keys + EntryList. */
  id: string;
  x: number;
  y: number;
  blur: number;
  color: string;
}

/** Parse one comma-segment ("1px 2px 3px red" OR color-first "red 1px 2px 3px") into an entry. */
function parseTextShadowSegment(seg: string, idx: number): TextShadowEntry | null {
  const s = seg.trim();
  if (!s) return null;
  // Pull the color out first (it may sit before or after the lengths). Functional/hex/var() win over a
  // bare named color so `rgba(0,0,0,.5)` isn't mistaken for the word "rgba".
  const colorM = s.match(/(rgba?\([^)]*\)|hsla?\([^)]*\)|var\([^)]*\)|#[0-9a-fA-F]{3,8}|\b[a-zA-Z]{3,}\b)/);
  let color = '#000000';
  let rest = s;
  if (colorM) {
    color = colorM[0];
    rest = s.slice(0, colorM.index) + ' ' + s.slice(colorM.index! + colorM[0].length);
  }
  const nums = (rest.match(/-?[\d.]+/g) ?? []).map(Number);
  const [x = 0, y = 0, blur = 0] = nums;
  return { id: `text-shadow-${idx}`, x, y, blur, color };
}

/** Parse a full `text-shadow` value into editable entries. `none`/empty → []. */
export function parseTextShadowEntries(value: string | undefined): TextShadowEntry[] {
  if (!value || value.trim() === '' || value.trim() === 'none') return [];
  return splitStyleProps(value)
    .map((seg, i) => parseTextShadowSegment(seg, i))
    .filter((e): e is TextShadowEntry => e !== null);
}

/** Serialize entries back to a `text-shadow` CSS value. Empty → `none`. */
export function formatTextShadowEntries(entries: TextShadowEntry[]): string {
  if (entries.length === 0) return 'none';
  return entries.map(e => `${e.x}px ${e.y}px ${e.blur}px ${e.color}`).join(', ');
}

/** A fresh entry for the "Add" action — a subtle drop, matching the box-shadow default. */
export function createDefaultTextShadow(idx = 0): TextShadowEntry {
  return { id: `text-shadow-${idx}`, x: 0, y: 2, blur: 4, color: 'rgba(0, 0, 0, 0.25)' };
}

/** Short one-line summary for an entry row (mirrors box-shadow's "Xpx · Ypx"). */
export function textShadowSummary(e: TextShadowEntry): string {
  return `${e.x}px · ${e.y}px`;
}

/** Generate gradient CSS from array of mixed colors */
export function mixedColorGradient(colors: string[]): string {
  if (colors.length <= 1) return colors[0] || 'transparent';
  return `linear-gradient(90deg, ${colors.join(', ')})`;
}
