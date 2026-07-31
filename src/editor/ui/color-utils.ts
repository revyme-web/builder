// color-utils.ts — Pure color conversion utilities for ColorPicker.
// Handles hex, rgb, rgba, hsl, hsla, and named colors.
// No external dependencies.

export interface RGB { r: number; g: number; b: number; }
export interface HSV { h: number; s: number; v: number; }
export interface HSL { h: number; s: number; l: number; }

// ─── Hex ↔ RGB ───────────────────────────────────────────────────────────────

/** Parse #fff, #ffffff, #ffffffaa → RGB. Returns null on invalid input. */
export function hexToRgb(hex: string): RGB {
  let h = hex.replace(/^#/, '');

  // Expand 3-digit (#abc → aabbcc) or 4-digit (#abcd → aabbccdd)
  if (h.length === 3 || h.length === 4) {
    h = h.split('').map(c => c + c).join('');
  }

  // Take first 6 chars (ignore alpha channel if 8-digit)
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);

  if (isNaN(r) || isNaN(g) || isNaN(b)) {
    return { r: 0, g: 0, b: 0 };
  }
  return { r, g, b };
}

/** RGB → #rrggbb (always 6-digit lowercase). */
export function rgbToHex(rgb: RGB): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const r = clamp(rgb.r).toString(16).padStart(2, '0');
  const g = clamp(rgb.g).toString(16).padStart(2, '0');
  const b = clamp(rgb.b).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}

// ─── RGB ↔ HSV ───────────────────────────────────────────────────────────────

export function rgbToHsv(rgb: RGB): HSV {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;

  if (d !== 0) {
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }

  return { h: h * 360, s: s * 100, v: v * 100 };
}

export function hsvToRgb(hsv: HSV): RGB {
  const h = hsv.h / 360;
  const s = hsv.s / 100;
  const v = hsv.v / 100;

  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);

  let r: number, g: number, b: number;

  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
    default: r = 0; g = 0; b = 0;
  }

  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
  };
}

// ─── RGB ↔ HSL ───────────────────────────────────────────────────────────────

export function rgbToHsl(rgb: RGB): HSL {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) {
    return { h: 0, s: 0, l: l * 100 };
  }

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h = 0;
  switch (max) {
    case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
    case g: h = ((b - r) / d + 2) / 6; break;
    case b: h = ((r - g) / d + 4) / 6; break;
  }

  return { h: h * 360, s: s * 100, l: l * 100 };
}

export function hslToRgb(hsl: HSL): RGB {
  const h = hsl.h / 360;
  const s = hsl.s / 100;
  const l = hsl.l / 100;

  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }

  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

// ─── Parse / Format ──────────────────────────────────────────────────────────

/**
 * Parse any supported color string into { rgb, alpha }.
 * Handles: #fff, #ffffff, #ffffffaa, rgb(), rgba(), hsl(), hsla(), 'transparent'.
 */
export function parseColor(color: string): { rgb: RGB; alpha: number } {
  const c = color.trim().toLowerCase();

  // Named: transparent
  if (c === 'transparent') {
    return { rgb: { r: 0, g: 0, b: 0 }, alpha: 0 };
  }

  // Hex: #fff, #ffffff, #ffffffaa
  if (c.startsWith('#')) {
    const raw = c.replace(/^#/, '');
    let alpha = 1;

    if (raw.length === 4) {
      // #rgba → expand to rrggbbaa
      const a = parseInt(raw[3] + raw[3], 16);
      alpha = Math.round((a / 255) * 100) / 100;
    } else if (raw.length === 8) {
      const a = parseInt(raw.substring(6, 8), 16);
      alpha = Math.round((a / 255) * 100) / 100;
    }

    return { rgb: hexToRgb(c), alpha };
  }

  // rgb(r, g, b) or rgba(r, g, b, a)
  const rgbMatch = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (rgbMatch) {
    return {
      rgb: {
        r: parseInt(rgbMatch[1]),
        g: parseInt(rgbMatch[2]),
        b: parseInt(rgbMatch[3]),
      },
      alpha: rgbMatch[4] !== undefined ? parseFloat(rgbMatch[4]) : 1,
    };
  }

  // hsl(h, s%, l%) or hsla(h, s%, l%, a)
  const hslMatch = c.match(/^hsla?\(\s*(\d+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (hslMatch) {
    const hsl: HSL = {
      h: parseInt(hslMatch[1]),
      s: parseFloat(hslMatch[2]),
      l: parseFloat(hslMatch[3]),
    };
    return {
      rgb: hslToRgb(hsl),
      alpha: hslMatch[4] !== undefined ? parseFloat(hslMatch[4]) : 1,
    };
  }

  // Fallback: black
  return { rgb: { r: 0, g: 0, b: 0 }, alpha: 1 };
}

/**
 * Format RGB + alpha to a color string.
 * Returns hex (#rrggbb) when alpha=1, rgba(r,g,b,a) when alpha<1.
 */
export function formatColor(rgb: RGB, alpha: number): string {
  if (alpha >= 1) {
    return rgbToHex(rgb);
  }
  const a = Math.round(alpha * 100) / 100;
  return `rgba(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)}, ${a})`;
}

// ─── Display normalization (any CSS color → hex) ─────────────────────────────

/** RGB + alpha → `#RRGGBB` (alpha ≥ 1) or `#RRGGBBAA`. Uppercase. */
export function rgbaToHex(rgb: RGB, alpha: number): string {
  const hex2 = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  const base = `#${hex2(rgb.r)}${hex2(rgb.g)}${hex2(rgb.b)}`;
  const out = alpha >= 1 ? base : `${base}${hex2(alpha * 255)}`;
  return out.toUpperCase();
}

// Lazily-created 2D canvas context — used purely as the browser's CSS
// color parser. Its `fillStyle` setter accepts ANY valid CSS color
// (named, hsl, oklch, lab, color()…) and the getter hands back the
// normalized `#rrggbb` / `rgba(...)` form that `parseColor` understands.
let _colorCanvasCtx: CanvasRenderingContext2D | null | undefined;
function getColorCanvasCtx(): CanvasRenderingContext2D | null {
  if (_colorCanvasCtx !== undefined) return _colorCanvasCtx;
  _colorCanvasCtx = typeof document !== 'undefined'
    ? document.createElement('canvas').getContext('2d')
    : null;
  return _colorCanvasCtx;
}

/**
 * Normalize a CSS color the regex parser doesn't know (named colors,
 * `oklch`/`lab`/`lch`, `color()`…) to an `rgb()/rgba()` string via the
 * browser's own parser. Returns null when the input isn't a valid color.
 *
 * Two-baseline trick: assigning an invalid value to `ctx.fillStyle` is
 * silently ignored, so a valid color converges to the same output from
 * both the black and white baselines, while an invalid one keeps each
 * distinct baseline.
 */
function normalizeColorViaBrowser(value: string): string | null {
  const ctx = getColorCanvasCtx();
  if (!ctx) return null;
  ctx.fillStyle = '#000000';
  ctx.fillStyle = value;
  const fromBlack = ctx.fillStyle;
  ctx.fillStyle = '#ffffff';
  ctx.fillStyle = value;
  const fromWhite = ctx.fillStyle;
  return fromBlack === fromWhite ? fromBlack : null;
}

/**
 * Convert any color value to its HEX equivalent for DISPLAY in a control —
 * `#RRGGBB`, or `#RRGGBBAA` when there is transparency.
 *
 * Handles hex / rgb(a) / hsl(a) directly, and defers to the browser's CSS
 * parser for named colors, `oklch`, `lab`, `color()`, etc. Values that are
 * not a single resolvable color — `var(...)`, gradients, CSS-wide keywords
 * — and genuinely invalid input are returned unchanged.
 */
export function toHexDisplay(value: string): string {
  const v = (value ?? '').trim();
  if (!v) return v;
  const low = v.toLowerCase();

  // Not a single resolvable color — leave untouched.
  if (
    low.startsWith('var(') ||
    low.includes('gradient') ||
    low === 'currentcolor' || low === 'inherit' ||
    low === 'initial' || low === 'unset' || low === 'none'
  ) {
    return v;
  }

  // hex / rgb(a) / hsl(a) / transparent — pure-JS parse.
  if (/^#/.test(low) || /^rgba?\(/.test(low) || /^hsla?\(/.test(low) || low === 'transparent') {
    const { rgb, alpha } = parseColor(v);
    return rgbaToHex(rgb, alpha);
  }

  // Named colors, oklch, lab, lch, color()… — defer to the browser.
  const normalized = normalizeColorViaBrowser(v);
  if (!normalized) return v;  // genuinely invalid → don't mangle it
  const { rgb, alpha } = parseColor(normalized);
  return rgbaToHex(rgb, alpha);
}
