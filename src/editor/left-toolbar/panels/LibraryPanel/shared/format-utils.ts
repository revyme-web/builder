// Pure formatting helpers for LibraryPanel. Extracted as part of
// the LibraryPanel folder split. No React, no jotai — only depend
// on DATA_CATEGORIES from constants.ts.

import { DATA_CATEGORIES } from './constants';

export function formatTokenLabel(name: string): string {
  let display = name;
  for (const cat of DATA_CATEGORIES) {
    if (display.startsWith(cat.prefix + '-')) {
      display = display.slice(cat.prefix.length + 1);
      break;
    }
  }
  return display
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Build a CSS shorthand string from 4 sides in [T, R, B, L] order, using
 *  the shortest canonical form. Inverse of parseShorthand. */
export function formatShorthand([t, r, b, l]: [string, string, string, string]): string {
  if (t === r && r === b && b === l) return t;
  if (t === b && r === l) return `${t} ${r}`;
  if (r === l) return `${t} ${r} ${b}`;
  return `${t} ${r} ${b} ${l}`;
}

/** Extract URL from `url(...)` wrapper, or return value as-is if already bare URL. */
export function extractAssetUrl(value: string): string | null {
  if (!value) return null;
  const m = value.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/);
  if (m) return m[1];
  if (/^https?:\/\//i.test(value) || value.startsWith('/')) return value;
  return null;
}

export function sanitizeName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
