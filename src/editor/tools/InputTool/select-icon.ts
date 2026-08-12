// select-icon.ts — the <select> dropdown caret icon (Input tool "Icon" row).
//
// A native select's chevron isn't styleable, so the Icon control REPLACES it:
// `appearance: none` plus a color-baked `background-image` SVG data URI —
// self-contained, so the published site never depends on the iconify CDN at
// runtime (the editor fetches once at pick time). The chosen icon name +
// color live in a `data-select-icon` JSON attr; the panel reads that back
// for the row chip and re-bakes the URI on a color change.

import { trace } from '@/shared/debug-trace';

export interface SelectIconSpec {
  /** Full iconify name, e.g. `lucide:chevron-down`. */
  icon: string;
  /** Baked ink color, e.g. `#ABABAB`. */
  color: string;
}

export const SELECT_ICON_ATTR = 'data-select-icon';
export const DEFAULT_SELECT_ICON_COLOR = '#ABABAB';

export function parseSelectIconSpec(raw: string | undefined | null): SelectIconSpec | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (p && typeof p.icon === 'string' && typeof p.color === 'string') return p as SelectIconSpec;
  } catch { /* malformed attr — treat as unset */ }
  return null;
}

/** The color-baked `background-image` value. PURE — `rawSvg` is the iconify
 *  RAW markup (kebab attrs; NOT the camelCased JSX form the insert panel
 *  caches — a data URI must be real SVG), and the string work is cheap
 *  enough to run PER FRAME during a color-picker drag (the live-preview
 *  channel injects it via canvas CSS; the full style set commits once on
 *  release). Monochrome iconify icons mostly ink with `currentColor`; some
 *  packs use explicit `#000`/`black`, and a path with NO fill attribute
 *  renders black — the bake covers all three: replace the ink colors, then
 *  stamp the color on the root `<svg>` so it cascades to fill-less paths
 *  (explicit fills, incl. `fill="none"` outline icons, still win). Same
 *  monochrome reasoning as the insert panel's `normalizeIconColors`. */
export function bakeSelectIconDataUri(rawSvg: string, color: string): string {
  let colored = rawSvg
    .replace(/currentColor/g, color)
    .replace(/fill="(#000|#000000|black)"/gi, `fill="${color}"`)
    .replace(/stroke="(#000|#000000|black)"/gi, `stroke="${color}"`);
  if (!/<svg\b[^>]*\sfill=/.test(colored)) {
    colored = colored.replace(/<svg\b/, `<svg fill="${color}"`);
  }
  return `url("data:image/svg+xml,${encodeURIComponent(colored)}")`;
}

export function bakeSelectIconStyles(rawSvg: string, color: string): Record<string, string> {
  return {
    appearance: 'none',
    WebkitAppearance: 'none',
    backgroundImage: bakeSelectIconDataUri(rawSvg, color),
    backgroundRepeat: 'no-repeat',
    // content-box origin: the position resolves against the CONTENT box, so
    // the caret tracks the select's own paddingRight — increase the padding
    // and the icon moves inward with the text (a fixed `right 12px` offset
    // ignored padding: the text moved, the icon stayed glued to the border —
    // user report 2026-08-12).
    backgroundOrigin: 'content-box',
    backgroundPosition: 'right center',
    backgroundSize: '16px 16px',
  };
}

/** `''`-valued twin — clears every style the bake set, restoring the
 *  native chevron ('' = delete the property, the mutation-layer convention). */
export function clearSelectIconStyles(): Record<string, string> {
  return {
    appearance: '',
    WebkitAppearance: '',
    backgroundImage: '',
    backgroundRepeat: '',
    backgroundOrigin: '',
    backgroundPosition: '',
    backgroundSize: '',
  };
}

// RAW svg cache — separate from the insert panel's cache on purpose: that one
// stores camelCased-for-JSX markup, which is invalid inside a data URI.
const rawSvgCache = new Map<string, Promise<string | null>>();
// Sync-readable mirror (same trick as the insert panel's svgResolved): the
// color picker's PER-FRAME live preview can't await, but by the time a drag
// starts the apply's fetch has long resolved — it just peeks here.
const rawSvgResolved = new Map<string, string | null>();

export function getRawIconSvgSync(iconName: string): string | null {
  return rawSvgResolved.get(iconName) ?? null;
}

export function fetchRawIconSvg(iconName: string): Promise<string | null> {
  const cached = rawSvgCache.get(iconName);
  if (cached) return cached;
  const promise = (async () => {
    try {
      const res = await fetch(`https://api.iconify.design/${iconName}.svg`);
      if (!res.ok) return null;
      const text = await res.text();
      if (!text.trimStart().startsWith('<svg')) return null; // iconify 404 body is plain text
      rawSvgResolved.set(iconName, text);
      return text;
    } catch (err) {
      trace.error('select-icon:fetch-failed', { iconName, error: String(err) });
      rawSvgResolved.set(iconName, null);
      return null;
    }
  })();
  rawSvgCache.set(iconName, promise);
  return promise;
}
