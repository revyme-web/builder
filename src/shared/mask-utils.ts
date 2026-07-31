// mask-utils.ts — Mask CSS parsing/formatting utilities.
// Split mask property by commas (respecting parentheses), extract composite keywords.

import { trace } from '@/shared/debug-trace';
import { splitStyleProps } from '@/shared/css-utils';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MaskEntry {
  id: string;
  gradient: string;     // CSS gradient string (same format as fill gradient)
  composite: string;    // 'add' | 'subtract' | 'intersect' | 'exclude' | ''
}

const COMPOSITE_KEYWORDS = new Set(['add', 'subtract', 'intersect', 'exclude']);

// ─── Detect ──────────────────────────────────────────────────────────────────

export function detectMaskType(gradient: string): string {
  if (gradient.includes('linear-gradient')) return 'Linear';
  if (gradient.includes('radial-gradient')) return 'Radial';
  if (gradient.includes('conic-gradient')) return 'Conic';
  if (gradient.includes('url(')) return 'Image';
  return 'Linear';
}

// ─── Parse ───────────────────────────────────────────────────────────────────

export function parseMaskEntries(maskCSS: string, compositeCSS?: string): MaskEntry[] {
  if (!maskCSS || maskCSS === 'none') return [];
  trace.fn('parseMaskEntries', { maskCSS, compositeCSS });
  const parts = splitStyleProps(maskCSS);

  // New format: gradients live in `mask-image` (no trailing keyword) and the
  // operators in a separate `mask-composite` list — UN-SHIFTED here (the list
  // is emitted shifted-up-one by formatMaskCSS so each op acts on the layer
  // below it; see that fn). entry[i].composite = compositeList[i-1].
  const compositeList = compositeCSS && compositeCSS !== 'none'
    ? splitStyleProps(compositeCSS).map(s => s.trim()).filter(Boolean)
    : null;

  return parts.map((part, i) => {
    let gradient = part.trim();
    let composite = '';
    if (compositeList) {
      composite = i >= 1 ? (compositeList[i - 1] || 'add') : '';
    } else {
      // Legacy inline format: a trailing composite keyword on the layer
      // (`linear-gradient(…) subtract`) — still parsed for old pages.
      const words = gradient.split(/\s+/);
      const lastWord = words[words.length - 1];
      if (COMPOSITE_KEYWORDS.has(lastWord)) {
        composite = lastWord;
        gradient = words.slice(0, -1).join(' ');
      }
    }
    return { id: `mask-${i}`, gradient, composite };
  });
}

// ─── Format ──────────────────────────────────────────────────────────────────

/** Legacy shorthand form (`A, B subtract`) — retained for round-trip tests and
 *  anywhere a single string is wanted. The DOM commit uses formatMaskCSS. */
export function formatMaskEntries(entries: MaskEntry[]): string {
  if (entries.length === 0) return 'none';
  return entries.map(e => {
    if (e.composite) return `${e.gradient} ${e.composite}`;
    return e.gradient;
  }).join(', ');
}

/** Standard-CSS keyword → legacy `-webkit-mask-composite` keyword. */
const WEBKIT_COMPOSITE: Record<string, string> = {
  add: 'source-over',
  subtract: 'source-out',
  intersect: 'source-in',
  exclude: 'xor',
};

/** Emit the DOM-correct multi-layer mask CSS from the panel's entry model.
 *
 *  `mask-image: 'A, B subtract'` is INVALID — `subtract` is not a `<image>`, so
 *  browsers drop that layer and a 2nd mask silently does nothing (live find
 *  2026-07-04). Masks must use `mask-image` (gradients only) + `mask-composite`
 *  (the operators).
 *
 *  CRITICAL — the operators are SHIFTED up one layer. `mask-composite[i]`
 *  composites layer i with the layers BELOW it, so the LAST layer's operator is
 *  a no-op. The panel models entry[i>0].composite as "how this entry combines
 *  with the ones before it", so we place entry[i].composite onto layer i-1 and
 *  give the final layer `add`. Verified with pixel probes: `mask-image: A, B` +
 *  `mask-composite: subtract, add` punches B out of A (the intuitive result).
 *
 *  Returns '' composite for < 2 layers (single masks need no compositing). */
export function formatMaskCSS(entries: MaskEntry[]): { image: string; composite: string; webkitComposite: string } {
  if (entries.length === 0) return { image: 'none', composite: '', webkitComposite: '' };
  const image = entries.map(e => e.gradient).join(', ');
  if (entries.length < 2) return { image, composite: '', webkitComposite: '' };
  const ops = entries.map((_, i) => (i + 1 < entries.length ? (entries[i + 1].composite || 'add') : 'add'));
  return {
    image,
    composite: ops.join(', '),
    webkitComposite: ops.map(o => WEBKIT_COMPOSITE[o] || 'source-over').join(', '),
  };
}

// ─── Presets ──────────────────────────────────────────────────────────────────

const edge = (deg: number) => `linear-gradient(${deg}deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 22%)`;
// Both-edge fade in one gradient: transparent → opaque → opaque → transparent.
const band = (deg: number) => `linear-gradient(${deg}deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 18%, rgb(0,0,0) 82%, rgba(0,0,0,0) 100%)`;

/** Named mask presets → entry list. Multi-entry presets use `intersect` so
 *  BOTH gradients must be opaque for a pixel to show (all-edge vignettes). */
export const MASK_PRESETS: Record<string, { label: string; entries: () => MaskEntry[] }> = {
  'fade-top':    { label: 'Fade Top',    entries: () => [{ id: 'mask-0', gradient: edge(180), composite: '' }] },
  'fade-bottom': { label: 'Fade Bottom', entries: () => [{ id: 'mask-0', gradient: edge(0),   composite: '' }] },
  'fade-left':   { label: 'Fade Left',   entries: () => [{ id: 'mask-0', gradient: edge(90),  composite: '' }] },
  'fade-right':  { label: 'Fade Right',  entries: () => [{ id: 'mask-0', gradient: edge(270), composite: '' }] },
  'fade-x':      { label: 'Fade Left & Right', entries: () => [{ id: 'mask-0', gradient: band(90),  composite: '' }] },
  'fade-y':      { label: 'Fade Top & Bottom', entries: () => [{ id: 'mask-0', gradient: band(180), composite: '' }] },
  'fade-edges':  { label: 'Fade All Edges', entries: () => [
    { id: 'mask-0', gradient: band(90),  composite: '' },
    { id: 'mask-1', gradient: band(180), composite: 'intersect' },
  ] },
  'vignette':    { label: 'Vignette', entries: () => [{ id: 'mask-0', gradient: 'radial-gradient(circle at 50% 50%, rgb(0,0,0) 55%, rgba(0,0,0,0) 100%)', composite: '' }] },
};

/** Options for the preset ToolSelect ('custom' = leave the current mask as-is). */
export const MASK_PRESET_OPTIONS: { value: string; label: string }[] = [
  { value: 'custom', label: 'Custom' },
  ...Object.entries(MASK_PRESETS).map(([value, p]) => ({ value, label: p.label })),
];

/** Best-effort: which preset key the current entries match (by gradient set),
 *  else 'custom'. Lets the select reflect an applied preset. */
export function detectMaskPreset(entries: MaskEntry[]): string {
  const key = (es: MaskEntry[]) => es.map(e => e.gradient.replace(/\s+/g, '')).join('|');
  const cur = key(entries);
  for (const [name, p] of Object.entries(MASK_PRESETS)) {
    if (key(p.entries()) === cur) return name;
  }
  return 'custom';
}

// ─── Active-entry resync ──────────────────────────────────────────────────────

/** Decide the mask editor's active entry index after the mask CSS or selected
 *  node changed. The trap this encodes (live find 2026-07-04): committing an
 *  edit to the 2nd+ mask entry rewrites maskImage, so the value-change effect
 *  re-fires for the SAME node — it must NOT snap back to entry 0, or entries
 *  past the first can never be edited (the popup jumps to entry 1 on the first
 *  drag). Only a NODE change resets to 0; a same-node value change PRESERVES the
 *  active entry (clamped into range in case an entry was removed). */
export function nextMaskActiveEntry(opts: {
  nodeChanged: boolean;
  maskChanged: boolean;
  prevActiveIdx: number;
  entryCount: number;
}): number {
  const { nodeChanged, maskChanged, prevActiveIdx, entryCount } = opts;
  if (nodeChanged) return 0;
  if (maskChanged) return Math.min(prevActiveIdx, Math.max(0, entryCount - 1));
  return prevActiveIdx;
}

// ─── Overlay helpers ─────────────────────────────────────────────────────────

/** Convert mask stop alpha to a visible grey fill for overlay circles.
 *  Alpha 0 (masked) → white, Alpha 1 (visible) → dark grey */
export function maskStopFill(color: string): string {
  if (color.startsWith('rgba(')) {
    // Extract alpha (4th component): rgba(0,0,0,0.5) → 0.5
    const m = color.match(/rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/);
    if (m) {
      const alpha = parseFloat(m[1]);
      const grey = Math.round(255 - alpha * 200); // 0 → #fff, 1 → #373737
      return `rgb(${grey},${grey},${grey})`;
    }
  }
  if (color.startsWith('rgb(')) return '#373737'; // fully opaque = dark
  return '#ffffff'; // fully transparent = white
}
