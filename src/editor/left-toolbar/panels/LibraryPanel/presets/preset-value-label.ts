// preset-value-label — the compact value text shown on the right of each
// Presets-panel row ("Section Y   80px"), so a preset reads without opening
// its edit popup. Pure: no React, no jotai.

import type { PresetToken } from '@/shared/types';
import type { TypoGroup } from '@/editor/tools/typography-utils';
import { getTypoTokenValue } from '@/editor/tools/typography-utils';
import type { BorderGroup } from '@/editor/ui/border-preset-utils';
import { parseBorderShorthand } from '@/editor/ui/border-utils';
import { parseShadowEntries } from '@/editor/ui/shadow-utils';

const squash = (v: string) => v.trim().replace(/\s+/g, ' ');

/** `0 4px 12px` — offsets + blur (+ spread when set) of the FIRST layer, colour
 *  dropped (long, and the row swatch is not the place for it); `+N` counts the
 *  extra layers. */
function shadowLabel(value: string): string {
  const v = squash(value);
  if (!v) return '';
  if (v === 'none') return 'None';
  const entries = parseShadowEntries(v);
  if (entries.length === 0) return v;
  const e = entries[0];
  const px = (n: number) => (n === 0 ? '0' : `${n}px`);
  const parts = [px(e.x), px(e.y), px(e.blur)];
  if (e.spread) parts.push(px(e.spread));
  const head = `${e.inset ? 'inset ' : ''}${parts.join(' ')}`;
  return entries.length > 1 ? `${head} +${entries.length - 1}` : head;
}

/** Value text for a simple (single-token) preset row. Empty → no text. */
export function presetValueLabel(token: PresetToken): string {
  const v = squash(token.value ?? '');
  switch (token.category) {
    case 'image':
    case 'video':
      // The thumbnail is the preview; a URL says nothing.
      return '';
    case 'color':
      return /^#[0-9a-f]{3,8}$/i.test(v) ? v.toUpperCase() : v;
    case 'shadow':
      return shadowLabel(v);
    case 'border': {
      if (!v) return '';
      const side = parseBorderShorthand(v);
      return side.width ? `${side.width}px ${side.style}` : v;
    }
    default:
      return v;
  }
}

/** Typography group → its desktop font size (`48px`) — the value that tells
 *  Heading from Body at a glance. */
export function typographyValueLabel(group: TypoGroup): string {
  return squash(getTypoTokenValue(group, 'size'));
}

/** Border group → `1px solid` / `2px gradient`. */
export function borderGroupValueLabel(group: BorderGroup): string {
  const get = (suffix: string) => squash(group.tokens.find(t => t.name.endsWith(`-${suffix}`))?.value ?? '');
  const width = get('width') || '1px';
  const style = group.flavor === 'gradient' ? 'gradient' : (get('style') || 'solid');
  return `${width} ${style}`;
}
