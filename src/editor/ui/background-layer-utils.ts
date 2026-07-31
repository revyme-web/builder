// background-layer-utils.ts — Multi-layer CSS background parsing/formatting.
// Handles composite backgroundImage like "linear-gradient(...), url(...)" as a layer list.

import { trace } from '@/shared/debug-trace';
import { splitStyleProps } from '@/shared/css-utils';

// ─── Types ───────────────────────────────────────────────────────────────────

export type BgLayerType = 'color' | 'gradient' | 'image';

export interface BgLayer {
  id: string;
  type: BgLayerType;
  value: string;        // gradient CSS, url(...), or color value
  size: string;         // 'cover' | 'contain' | 'auto' | '100% 100%'
  position: string;     // 'center' | 'top' | 'bottom left' | etc
  repeat: string;       // 'no-repeat' | 'repeat' | 'repeat-x' | 'repeat-y'
  attachment: string;   // 'scroll' | 'fixed' | 'local'
  blendMode: string;    // 'normal' | 'multiply' | 'screen' | etc
}

let _nextId = 1;
export function makeLayerId(): string {
  return `bgl-${_nextId++}-${Math.random().toString(36).slice(2, 6)}`;
}

// ─── Split CSS Layers ────────────────────────────────────────────────────────

/**
 * Split a CSS value by commas, respecting parentheses depth and quotes.
 * e.g. "linear-gradient(red, blue), url(photo.jpg)" → ["linear-gradient(red, blue)", "url(photo.jpg)"]
 */
export function splitCSSLayers(value: string): string[] {
  if (!value) return [];
  // Delegates to the shared parenthesis/quote-aware splitter; this variant
  // additionally drops empty segments between consecutive commas.
  return splitStyleProps(value).filter((s) => s !== '');
}

// ─── Detect Layer Type ───────────────────────────────────────────────────────

/**
 * A SOLID COLOR can't live bare in `backgroundImage`, so multi-layer fills
 * encode it as the CSS trick `linear-gradient(C, C)` (two identical stops, no
 * angle) — see `createDefaultLayer('color')`. This recognises that form on
 * re-parse so a color layer doesn't read back as a "Linear Gradient". A REAL
 * gradient has an angle/direction OR differing stops, so it's left as 'gradient'.
 */
function isSolidColorGradient(value: string): boolean {
  const m = value.trim().match(/^linear-gradient\(([\s\S]*)\)$/i);
  if (!m) return false;
  const inner = m[1].trim();
  // A direction/angle (`to right`, `180deg`, `0.5turn`, …) means a real gradient.
  if (/^(to\s|[-\d.]+(deg|turn|rad|grad)\b)/i.test(inner)) return false;
  const stops = splitCSSLayers(inner);
  if (stops.length !== 2) return false;
  // Drop any trailing position (e.g. "red 0%") → compare just the colour token.
  const colourOf = (s: string) => s.trim().replace(/\s+[-\d.]+(%|px)?$/, '').trim().toLowerCase();
  const a = colourOf(stops[0]);
  const b = colourOf(stops[1]);
  return a.length > 0 && a === b;
}

function detectLayerType(value: string): BgLayerType {
  const lower = value.toLowerCase();
  if (lower.includes('url(')) return 'image';
  if (lower.includes('gradient(')) return isSolidColorGradient(value) ? 'color' : 'gradient';
  return 'color';
}

// ─── Parse ───────────────────────────────────────────────────────────────────

/**
 * Parse CSS background properties into a structured layer list.
 * Reads backgroundImage and splits matching backgroundSize/Position/Repeat/Attachment/BlendMode.
 */
export function parseBackgroundLayers(styles: Record<string, string>): BgLayer[] {
  const bgImage = styles.backgroundImage || styles.background || '';
  if (!bgImage || bgImage === 'none') return [];

  const imageValues = splitCSSLayers(bgImage);
  if (imageValues.length === 0) return [];

  const sizeValues = splitCSSLayers(styles.backgroundSize || '');
  const posValues = splitCSSLayers(styles.backgroundPosition || '');
  const repeatValues = splitCSSLayers(styles.backgroundRepeat || '');
  const attachValues = splitCSSLayers(styles.backgroundAttachment || '');
  const blendValues = splitCSSLayers(styles.backgroundBlendMode || '');

  const layers: BgLayer[] = imageValues.map((value, i) => ({
    id: makeLayerId(),
    type: detectLayerType(value),
    value,
    size: sizeValues[i] || sizeValues[0] || 'cover',
    position: posValues[i] || posValues[0] || 'center',
    repeat: repeatValues[i] || repeatValues[0] || 'no-repeat',
    attachment: attachValues[i] || attachValues[0] || 'scroll',
    blendMode: blendValues[i] || blendValues[0] || 'normal',
  }));

  // Fold a separate backgroundColor INTO the fill as the bottom (last) layer —
  // the builder's fill is single-color OR multi-layer, never both, so a
  // multi-layer fill expresses its base colour as a layer, not a separate prop.
  // backgroundColor paints behind every backgroundImage layer, so it becomes the
  // LAST layer (stacking preserved). formatBackgroundLayers then clears the
  // now-redundant backgroundColor. (Keeps the colour when an element switches to
  // Multiple, and resolves the BG_COLOR_WITH_IMAGE oracle violation.)
  const bgColor = (styles.backgroundColor || '').trim();
  if (bgColor && bgColor !== 'transparent' && bgColor !== 'rgba(0, 0, 0, 0)' && bgColor !== 'rgba(0,0,0,0)') {
    layers.push({
      id: makeLayerId(), type: 'color', value: `linear-gradient(${bgColor}, ${bgColor})`,
      size: 'cover', position: 'center', repeat: 'no-repeat', attachment: 'scroll', blendMode: 'normal',
    });
  }

  trace.fn('parseBackgroundLayers', { layerCount: layers.length, types: layers.map(l => l.type) });
  return layers;
}

// ─── Format ──────────────────────────────────────────────────────────────────

/**
 * Format a layer list back into comma-separated CSS properties.
 * Returns a flat style object ready for onChangeMultiple().
 */
export function formatBackgroundLayers(layers: BgLayer[]): Record<string, string> {
  if (layers.length === 0) {
    return {
      // A multi-layer fill never keeps a separate backgroundColor — the colour
      // is a layer. Clear it so we don't leave the un-editable both-state.
      backgroundColor: '',
      backgroundImage: '',
      backgroundSize: '',
      backgroundPosition: '',
      backgroundRepeat: '',
      backgroundAttachment: '',
      backgroundBlendMode: '',
    };
  }

  const result = {
    backgroundColor: '',
    backgroundImage: layers.map(l => l.value).join(', '),
    backgroundSize: layers.map(l => l.size).join(', '),
    backgroundPosition: layers.map(l => l.position).join(', '),
    backgroundRepeat: layers.map(l => l.repeat).join(', '),
    backgroundAttachment: layers.map(l => l.attachment).join(', '),
    backgroundBlendMode: layers.map(l => l.blendMode).join(', '),
  };

  trace.fn('formatBackgroundLayers', { layerCount: layers.length, bgImage: result.backgroundImage.slice(0, 100) });
  return result;
}

// ─── Detect ──────────────────────────────────────────────────────────────────

/**
 * Returns true if backgroundImage contains multiple comma-separated layers.
 */
export function isMultiLayerBackground(styles: Record<string, string>): boolean {
  const bgImage = styles.backgroundImage || '';
  if (!bgImage || bgImage === 'none') return false;
  const layers = splitCSSLayers(bgImage);
  return layers.length > 1;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

export function createDefaultLayer(type: BgLayerType): BgLayer {
  const id = makeLayerId();
  const base: BgLayer = {
    id,
    type,
    value: '',
    size: 'cover',
    position: 'center',
    repeat: 'no-repeat',
    attachment: 'scroll',
    blendMode: 'normal',
  };

  switch (type) {
    case 'color':
      base.value = 'linear-gradient(rgba(0,0,0,0.5), rgba(0,0,0,0.5))';
      // Solid colors in backgroundImage need to be expressed as a flat gradient
      break;
    case 'gradient':
      base.value = 'linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.8) 100%)';
      break;
    case 'image':
      base.value = '';  // URL set after image selection
      break;
  }

  trace.action('createDefaultLayer', { type, id });
  return base;
}

/**
 * Get a short label for a layer for display in the layer list.
 */
export function getLayerLabel(layer: BgLayer): string {
  const { type, value } = layer;
  if (type === 'gradient') {
    if (value.includes('linear-gradient')) return 'Linear Gradient';
    if (value.includes('radial-gradient')) return 'Radial Gradient';
    if (value.includes('conic-gradient')) return 'Conic Gradient';
    return 'Gradient';
  }
  if (type === 'image') {
    // Extract filename hint from url
    const urlMatch = value.match(/url\(['"]?([^'")\s]+)/);
    if (urlMatch) {
      const url = urlMatch[1];
      if (url.includes('unsplash.com')) return 'Unsplash Image';
      // Show last path segment
      const segments = url.split('/');
      const last = segments[segments.length - 1]?.split('?')[0] || 'Image';
      return last.length > 20 ? last.slice(0, 17) + '...' : last;
    }
    return 'Image';
  }
  // color type — expressed as flat gradient
  const colorMatch = value.match(/rgba?\([^)]+\)/);
  return colorMatch ? colorMatch[0] : 'Color Overlay';
}
