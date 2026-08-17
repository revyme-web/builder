// border-radius-utils.ts — Parse/format 8-value CSS border-radius shorthand.
// Supports: "50%", "16px", "10px 20px", "60% 40% 30% 70% / 60% 30% 70% 40%"

import { trace } from '@/shared/debug-trace';

export interface FancyRadiusData {
  tlH: number; trH: number; brH: number; blH: number; // horizontal (% of width)
  tlV: number; trV: number; brV: number; blV: number; // vertical (% of height)
}

/**
 * Parse any CSS border-radius into 8 percentage values.
 * - "50%" → uniform 50 on all 8
 * - "10px 20px 30px 40px" → 4-value (horizontal = vertical per corner)
 * - "60% 40% 30% 70% / 60% 30% 70% 40%" → full 8-value
 */
export function parseFancyRadius(css: string): FancyRadiusData {
  if (!css || css === '0' || css === '0px') {
    return { tlH: 0, trH: 0, brH: 0, blH: 0, tlV: 0, trV: 0, brV: 0, blV: 0 };
  }

  const parts = css.split('/').map(s => s.trim());
  const hValues = parseValues(parts[0]);
  const vValues = parts[1] ? parseValues(parts[1]) : hValues;

  // Expand 1/2/3/4 values to 4 (CSS shorthand expansion)
  const h = expandToFour(hValues);
  const v = expandToFour(vValues);

  const result = {
    tlH: h[0], trH: h[1], brH: h[2], blH: h[3],
    tlV: v[0], trV: v[1], brV: v[2], blV: v[3],
  };

  trace.fn('parseFancyRadius', { css, result });
  return result;
}

/**
 * Format 8 values back to CSS border-radius shorthand.
 * Simplifies when possible (uniform → single value, h===v → no slash).
 */
export function formatFancyRadius(data: FancyRadiusData): string {
  const h = [data.tlH, data.trH, data.brH, data.blH];
  const v = [data.tlV, data.trV, data.brV, data.blV];

  const hStr = compactFour(h);
  const vStr = compactFour(v);

  // If horizontal === vertical, no need for the slash
  const hSame = h.every((val, i) => val === v[i]);
  const result = hSame ? hStr : `${hStr} / ${vStr}`;

  trace.fn('formatFancyRadius', { result });
  return result;
}

/**
 * Check if a border-radius value is "fancy" (8-value with /).
 */
export function isFancyRadius(css: string): boolean {
  return css.includes('/');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseValues(str: string): number[] {
  return str.trim().split(/\s+/).map(v => {
    const num = parseFloat(v);
    if (isNaN(num)) return 0;
    // Convert px to approximate % (assume 200px reference — rough but usable)
    if (v.endsWith('px')) return Math.min(50, num / 2);
    return num;
  });
}

function expandToFour(values: number[]): [number, number, number, number] {
  switch (values.length) {
    case 1: return [values[0], values[0], values[0], values[0]];
    case 2: return [values[0], values[1], values[0], values[1]];
    case 3: return [values[0], values[1], values[2], values[1]];
    default: return [values[0], values[1], values[2], values[3]];
  }
}

function compactFour(vals: number[]): string {
  const s = vals.map(v => `${Math.round(v)}%`);
  if (s[0] === s[1] && s[1] === s[2] && s[2] === s[3]) return s[0];
  if (s[0] === s[2] && s[1] === s[3]) return `${s[0]} ${s[1]}`;
  if (s[1] === s[3]) return `${s[0]} ${s[1]} ${s[2]}`;
  return s.join(' ');
}
