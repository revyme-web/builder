import { describe, it, expect } from 'vitest';
import { getToolbarItemConfig } from './toolbar-item-config';

describe('getToolbarItemConfig', () => {
  // ─── Basic ────────────────────────────────────────────────────────
  it('returns config for frame', () => {
    const item = getToolbarItemConfig('frame');
    expect(item).not.toBeNull();
    expect(item!.elementType).toBe('div');
    expect(item!.defaultStyles.width).toBe('200px');
    expect(item!.ghostSize).toEqual({ width: 200, height: 200 });
  });

  it('returns config for column with flex styles and children factory', () => {
    const item = getToolbarItemConfig('column');
    expect(item).not.toBeNull();
    expect(item!.defaultStyles.flexDirection).toBe('column');
    expect(item!.children).toBeDefined();
    const children = item!.children!();
    expect(children.length).toBe(2);
  });

  it('returns config for row with flex styles and children factory', () => {
    const item = getToolbarItemConfig('row');
    expect(item).not.toBeNull();
    expect(item!.defaultStyles.flexDirection).toBe('row');
    const children = item!.children!();
    expect(children.length).toBe(2);
    // Unique IDs each call
    const children2 = item!.children!();
    expect(children2[0].id).not.toBe(children[0].id);
  });

  it('returns config for image with attrs', () => {
    const item = getToolbarItemConfig('image');
    expect(item).not.toBeNull();
    expect(item!.elementType).toBe('img');
    expect(item!.defaultAttrs!.alt).toBe('');
    expect(item!.defaultAttrs!.src).toContain('unsplash.com');
  });

  it('returns config for button with a real p text child (not intrinsic text)', () => {
    const item = getToolbarItemConfig('button');
    expect(item!.elementType).toBe('button');
    // The label is a CHILD text node — visible in the layers, styleable —
    // never intrinsic bare text inside <button> (2026-08-31 change).
    expect(item!.textContent).toBeUndefined();
    const kids = item!.children!();
    expect(kids).toHaveLength(1);
    expect(kids[0].tag).toBe('p');
    expect(kids[0].textContent).toBe('Button');
    // Padded element declares a layout (Padding control requirement).
    expect(item!.defaultStyles.display).toBe('flex');
    // Fresh ids per insert — two drops must not share the label's data-id.
    expect(item!.children!()[0].id).not.toBe(kids[0].id);
  });

  it('returns config for video', () => {
    const item = getToolbarItemConfig('video');
    expect(item!.elementType).toBe('video');
  });

  it('returns config for audio', () => {
    const item = getToolbarItemConfig('audio');
    expect(item!.elementType).toBe('audio');
    expect(item!.defaultAttrs).toEqual({ controls: 'true' });
  });

  // ─── Typography ───────────────────────────────────────────────────
  it('returns config for heading', () => {
    const item = getToolbarItemConfig('heading');
    expect(item!.elementType).toBe('h1');
    expect(item!.textContent).toBe('Heading');
  });

  it('returns config for paragraph', () => {
    const item = getToolbarItemConfig('paragraph');
    expect(item!.elementType).toBe('p');
    // Drops a real paragraph (Lorem-style) — not a "Start typing here…"
    // placeholder, so the dropped element has visible body shape on first
    // land. Asserts a long-enough block to catch a future regression to
    // the single-line placeholder.
    expect(item!.textContent!.length).toBeGreaterThan(50);
    expect(item!.textContent!.toLowerCase()).toContain('lorem');
  });

  it('returns config for text-link', () => {
    const item = getToolbarItemConfig('text-link');
    expect(item!.elementType).toBe('a');
    expect(item!.defaultAttrs!.href).toBe('#');
  });

  it('returns config for quote', () => {
    const item = getToolbarItemConfig('quote');
    expect(item!.elementType).toBe('blockquote');
  });

  // ─── Cards ────────────────────────────────────────────────────────
  it('returns config for card-basic with children', () => {
    const item = getToolbarItemConfig('card-basic');
    expect(item).not.toBeNull();
    const children = item!.children!();
    expect(children.length).toBe(2); // placeholder div + text container div
    expect(children[0].tag).toBe('div');
    expect(children[0].styles.backgroundColor).toBe('#e5e7eb');
  });

  it('returns config for card-pricing with children', () => {
    const item = getToolbarItemConfig('card-pricing');
    const children = item!.children!();
    expect(children.length).toBe(4); // h3 + price + per month + button
  });

  // ─── Layouts ──────────────────────────────────────────────────────
  it('returns config for layout-2col', () => {
    const item = getToolbarItemConfig('layout-2col');
    expect(item!.defaultStyles.flexDirection).toBe('row');
    expect(item!.children!().length).toBe(2);
  });

  it('returns config for layout-grid', () => {
    const item = getToolbarItemConfig('layout-grid');
    expect(item!.defaultStyles.display).toBe('grid');
    expect(item!.children!().length).toBe(4);
  });

  // `layout-split-top` was removed — it was a compound 2-Row + nested
  // 2-Col recipe the user can build in 2 drops from primitives. The
  // remaining layouts (2/3 Row, 2/3 Col, Grid, Sidebar, Header) are
  // atomic. The lookup should now return null for the removed id.
  it('returns null for the removed layout-split-top id', () => {
    expect(getToolbarItemConfig('layout-split-top')).toBeNull();
  });

  // ─── Shapes ───────────────────────────────────────────────────────
  // Shapes drop as real `<svg viewBox preserveAspectRatio=none>` wrappers
  // with primitive children (rect / ellipse / polygon), matching the
  // bottom-toolbar ShapeCreator output. The old clip-path-on-a-div
  // assertions are gone — the test asserts the new shape now.
  it('returns config for shape-circle', () => {
    const item = getToolbarItemConfig('shape-circle');
    expect(item!.elementType).toBe('svg');
    expect(item!.defaultAttrs!.viewBox).toBe('0 0 100 100');
    expect(item!.defaultAttrs!.preserveAspectRatio).toBe('none');
    const children = item!.children!();
    expect(children).toHaveLength(1);
    // Circle is now a Bezier <path> (absolute coords, standard) — a
    // %-based <ellipse> broke every geometry op (see toolbar-item-config).
    expect(children[0].tag).toBe('path');
    expect(children[0].attrs!.d).toMatch(/^M50,0 C/);
    expect(children[0].attrs!.fill).toBe('#3b82f6');
  });

  it('returns config for shape-star as polygon with star points', () => {
    const item = getToolbarItemConfig('shape-star');
    expect(item!.elementType).toBe('svg');
    const children = item!.children!();
    expect(children[0].tag).toBe('polygon');
    // Star uses 10 vertices (5 outer + 5 inner) in the points list.
    expect(children[0].attrs!.points!.split(' ')).toHaveLength(10);
  });

  // ─── Form widgets ─────────────────────────────────────────────────
  it('returns config for input', () => {
    const item = getToolbarItemConfig('input');
    expect(item!.elementType).toBe('input');
    expect(item!.defaultAttrs!.type).toBe('text');
  });

  it('returns config for form with children', () => {
    const item = getToolbarItemConfig('form');
    expect(item!.elementType).toBe('form');
    expect(item!.children!().length).toBe(3);
  });

  // ─── Divider (cs-*Divider) clip-path divs ─────────────────────────
  it('returns config for cs-lineDivider as a thin plain div', () => {
    const item = getToolbarItemConfig('cs-lineDivider');
    expect(item).not.toBeNull();
    expect(item!.elementType).toBe('div');
    expect(item!.defaultStyles.height).toBe('2px');
    expect(item!.defaultStyles.clipPath).toBeUndefined();
  });

  it('returns config for cs-curvedDivider with an ellipse clip-path', () => {
    const item = getToolbarItemConfig('cs-curvedDivider');
    expect(item).not.toBeNull();
    expect(item!.elementType).toBe('div');
    expect(item!.defaultStyles.clipPath).toMatch(/ellipse/);
  });

  it('all eight divider variants resolve to a clip-path div (or plain line)', () => {
    const cases: Array<[string, RegExp | null]> = [
      ['cs-lineDivider', null],
      ['cs-waveDivider', /polygon/],
      ['cs-angledDivider', /polygon/],
      ['cs-curvedDivider', /ellipse/],
      ['cs-zigzagDivider', /polygon/],
      ['cs-wavyLineDivider', /polygon/],
      ['cs-arrowDivider', /polygon/],
      ['cs-stepsDivider', /polygon/],
    ];
    for (const [id, pathExpect] of cases) {
      const item = getToolbarItemConfig(id);
      expect(item, id).not.toBeNull();
      expect(item!.elementType, id).toBe('div');
      if (pathExpect) {
        expect(item!.defaultStyles.clipPath, id).toMatch(pathExpect);
      }
    }
  });

  // ─── Code-snippet (cs-*) code components ───────────────────────────────────
  it('returns config for cs-filmGrain code component', () => {
    const item = getToolbarItemConfig('cs-filmGrain');
    expect(item).not.toBeNull();
    expect(item!.elementType).toBe('FilmGrain');
    expect(item!.defaultStyles.width).toBe('600px');
    expect(item!.defaultStyles.height).toBe('400px');
    expect(item!.ghostSize).toEqual({ width: 600, height: 400 });
  });

  it('returns config for all 6 noise code components', () => {
    const cases: Array<[string, string]> = [
      ['cs-filmGrain', 'FilmGrain'],
      ['cs-staticNoise', 'StaticTV'],
      ['cs-perlinNoise', 'PerlinNoise'],
      ['cs-halftone', 'Halftone'],
      ['cs-scanlines', 'Scanlines'],
      ['cs-chromaticNoise', 'ChromaticNoise'],
    ];
    for (const [id, tag] of cases) {
      const item = getToolbarItemConfig(id);
      expect(item, id).not.toBeNull();
      expect(item!.elementType, id).toBe(tag);
    }
  });

  it('returns null for unknown cs- code component id', () => {
    expect(getToolbarItemConfig('cs-doesNotExist')).toBeNull();
  });

  // ─── Unknown ──────────────────────────────────────────────────────
  it('returns null for unknown item', () => {
    expect(getToolbarItemConfig('unknown-thing')).toBeNull();
  });

  it('resolves slot-based effect code components', () => {
    const item = getToolbarItemConfig('cs-carousel');
    expect(item).not.toBeNull();
    expect(item!.elementType).toBe('Carousel');
    expect(getToolbarItemConfig('cs-marquee')!.elementType).toBe('Marquee');
  });
});
