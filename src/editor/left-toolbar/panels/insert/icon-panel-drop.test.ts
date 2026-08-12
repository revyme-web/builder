// icon-panel-drop.test.ts — icons drop as native shapes whenever the
// decomposer can hold them; <img> is a capability fallback, not a pack list.
//
// Regression (2026-08-12): colorful packs (flat-color-icons, logos,
// openmoji, twemoji…) were hard-wired to the <img> fallback on the theory
// that multi-color icons can't live in the shape dialect. Empirically
// false — they're mostly MULTIPLE flat-fill paths, which decompose into
// native groups. The gate is now the decomposer itself.

import { describe, it, expect } from 'vitest';
import { buildIconDragItem, normalizeIconColors, ICON_DROP_COLOR } from './IconPanel';

describe('buildIconDragItem — capability probe', () => {
  it('a flat multi-color icon drops as inline svg (shape-editable)', () => {
    const item = buildIconDragItem('flat-color-icons:bar-chart', {
      viewBox: '0 0 40 40',
      inner: '<path fill="#00BCD4" d="M5 15L12 15L12 35L5 35Z"/><path fill="#00BCD4" d="M17 5L24 5L24 35L17 35Z"/><path fill="#3F51B5" d="M29 20L36 20L36 35L29 35Z"/>',
    });
    expect(item.elementType).toBe('svg');
    expect(item.textContent).toContain('<path');
  });

  it('true complexity (gradients) falls back to <img>', () => {
    const item = buildIconDragItem('meteocons:clear-day', {
      viewBox: '0 0 24 24',
      inner: '<defs><linearGradient id="g"><stop offset="0" stop-color="#fa0"/></linearGradient></defs><path fill="url(#g)" d="M2 2L22 2L22 22L2 22Z"/>',
    });
    expect(item.elementType).toBe('img');
    expect(item.defaultAttrs!.src).toContain('meteocons:clear-day');
  });

  it('no cached markup still falls back to <img>', () => {
    expect(buildIconDragItem('mdi:home', null).elementType).toBe('img');
  });
});

describe('normalizeIconColors', () => {
  it('monochrome: currentColor AND hard blacks remap to the drop neutral', () => {
    const out = normalizeIconColors('<path fill="currentColor" stroke="#000"/>', false);
    expect(out).toBe(`<path fill="${ICON_DROP_COLOR}" stroke="${ICON_DROP_COLOR}"/>`);
  });

  it('colorful: palette preserved — black stays, only currentColor pins', () => {
    const out = normalizeIconColors('<path fill="#000"/><path fill="currentColor"/><path fill="#e33"/>', true);
    expect(out).toContain('fill="#000"');
    expect(out).toContain('fill="#e33"');
    expect(out).not.toContain('currentColor');
  });
});
