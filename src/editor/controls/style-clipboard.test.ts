import { describe, it, expect } from 'vitest';
import {
  buildCopiedStyle, canPasteStyle, buildPastePayload, isSingleNumberProperty,
  canonicalTransformCSS, isMotionTransformTarget,
} from './style-clipboard';

describe('style-clipboard', () => {
  it('padding: same-property only (not margin, not opacity)', () => {
    const c = buildCopiedStyle('padding', { padding: '10px', paddingTop: '5px' }, 'Padding');
    expect(c.family).toBe('number');
    expect(c.payload).toEqual({ padding: '10px', paddingTop: '5px', paddingRight: '', paddingBottom: '', paddingLeft: '' });
    expect(canPasteStyle(c, 'padding')).toBe(true);
    expect(canPasteStyle(c, 'margin')).toBe(false);   // multi-value box ≠ universal number
    expect(canPasteStyle(c, 'opacity')).toBe(false);
    expect(buildPastePayload(c, 'padding')).toEqual(c.payload);
  });

  it('opacity: universal single-number (opacity ↔ zIndex ↔ gap), not padding', () => {
    const c = buildCopiedStyle('opacity', { opacity: '0.5' }, 'Opacity');
    expect(canPasteStyle(c, 'opacity')).toBe(true);
    expect(canPasteStyle(c, 'zIndex')).toBe(true);
    expect(canPasteStyle(c, 'gap')).toBe(true);
    expect(canPasteStyle(c, 'padding')).toBe(false);
    expect(canPasteStyle(c, 'color')).toBe(false);
    expect(buildPastePayload(c, 'zIndex')).toEqual({ zIndex: '0.5' });
  });

  it('color: universal across colour slots + into Fill (clears layers)', () => {
    const c = buildCopiedStyle('color', { color: '#fff' }, 'Color');
    expect(c.family).toBe('color');
    expect(canPasteStyle(c, 'color')).toBe(true);
    expect(canPasteStyle(c, 'backgroundColor')).toBe(true);
    expect(canPasteStyle(c, 'borderColor')).toBe(true);
    expect(canPasteStyle(c, 'opacity')).toBe(false);
    expect(buildPastePayload(c, 'color')).toEqual({ color: '#fff' });
    // Into Fill → solid colour, clearing any gradient/image layers.
    expect(buildPastePayload(c, 'backgroundColor')).toMatchObject({ backgroundColor: '#fff', background: '', backgroundImage: '' });
  });

  it('Fill SOLID → universal colour; Fill GRADIENT/IMAGE → Fill-only', () => {
    const solid = buildCopiedStyle('backgroundColor', { backgroundColor: '#7CBFFF' }, 'Fill');
    expect(solid.family).toBe('color');
    expect(solid.payload).toHaveProperty('backgroundImage'); // full snapshot
    expect(canPasteStyle(solid, 'color')).toBe(true);          // solid colour is universal
    expect(buildPastePayload(solid, 'color')).toEqual({ color: '#7CBFFF' });

    const grad = buildCopiedStyle('backgroundColor', { backgroundColor: '', background: 'linear-gradient(0deg,#000,#fff)' }, 'Fill');
    expect(grad.family).toBe('gradient');
    expect(canPasteStyle(grad, 'backgroundColor')).toBe(true);  // Fill→Fill
    expect(canPasteStyle(grad, 'color')).toBe(false);           // NOT into a text colour
    expect(buildPastePayload(grad, 'backgroundColor')).toEqual(grad.payload);

    const img = buildCopiedStyle('backgroundColor', { backgroundColor: '', backgroundImage: 'url(x.png)' }, 'Fill');
    expect(img.family).toBe('image');
    expect(canPasteStyle(img, 'color')).toBe(false);
    expect(canPasteStyle(img, 'backgroundColor')).toBe(true);
  });

  it('radius / shadow / overflow: same-property only', () => {
    const r = buildCopiedStyle('borderRadius', { borderRadius: '8px' }, 'Radius');
    expect(r.family).toBe('radius');
    expect(canPasteStyle(r, 'borderRadius')).toBe(true);
    expect(canPasteStyle(r, 'padding')).toBe(false);
    const s = buildCopiedStyle('boxShadow', { boxShadow: '0 4px 16px #000' }, 'Shadow');
    expect(canPasteStyle(s, 'boxShadow')).toBe(true);
    expect(canPasteStyle(s, 'border')).toBe(false);
    const o = buildCopiedStyle('overflow', { overflow: 'hidden' }, 'Overflow');
    expect(canPasteStyle(o, 'overflow')).toBe(true);
    expect(canPasteStyle(o, 'opacity')).toBe(false);
  });

  it('isSingleNumberProperty', () => {
    expect(isSingleNumberProperty('opacity')).toBe(true);
    expect(isSingleNumberProperty('zIndex')).toBe(true);
    expect(isSingleNumberProperty('padding')).toBe(false);
    expect(isSingleNumberProperty('color')).toBe(false);
    expect(isSingleNumberProperty('borderRadius')).toBe(false);
  });

  it('null clipboard → never pasteable', () => {
    expect(canPasteStyle(null, 'padding')).toBe(false);
  });
});

describe('style-clipboard — Shadow (boxShadow + drop-shadow filter)', () => {
  it('copies a DROP shadow out of `filter` (the bug: was a no-op)', () => {
    const c = buildCopiedStyle(
      'boxShadow',
      { filter: 'drop-shadow(1px 23px 6px rgba(0, 0, 0, 0.25))' },
      'Shadow',
    );
    expect(c.sourceProperty).toBe('boxShadow');
    expect(c.payload.boxShadow).toBe('');
    expect(c.payload.filter).toContain('drop-shadow(');
    expect(c.payload.filter).toContain('23px');
    expect(canPasteStyle(c, 'boxShadow')).toBe(true);
  });

  it('pastes the drop-shadow, preserving the target node\'s OTHER filters (blur)', () => {
    const c = buildCopiedStyle(
      'boxShadow',
      { filter: 'drop-shadow(1px 23px 6px rgba(0,0,0,0.25))' },
      'Shadow',
    );
    const out = buildPastePayload(c, 'boxShadow', { filter: 'blur(4px)' });
    expect(out.filter).toContain('blur(4px)');       // target's own filter kept
    expect(out.filter).toContain('drop-shadow(');     // copied shadow merged in
    expect(out.boxShadow).toBe('');
  });

  it('replaces the target\'s existing drop-shadow (no accumulation)', () => {
    const c = buildCopiedStyle('boxShadow', { filter: 'drop-shadow(0px 2px 4px #000)' }, 'Shadow');
    const out = buildPastePayload(c, 'boxShadow', { filter: 'drop-shadow(9px 9px 9px #fff)' });
    expect(out.filter).toContain('#000');
    expect(out.filter).not.toContain('#fff');
    expect((out.filter.match(/drop-shadow/g) || []).length).toBe(1);
  });

  it('copies a BOX shadow too (and clears the target\'s drop-shadow on paste)', () => {
    const c = buildCopiedStyle('boxShadow', { boxShadow: '0 4px 8px rgba(0,0,0,0.2)' }, 'Shadow');
    expect(c.payload.boxShadow).toBe('0 4px 8px rgba(0,0,0,0.2)');
    const out = buildPastePayload(c, 'boxShadow', { filter: 'drop-shadow(1px 1px 1px #000) blur(2px)' });
    expect(out.boxShadow).toBe('0 4px 8px rgba(0,0,0,0.2)');
    expect(out.filter).toContain('blur(2px)');          // non-shadow kept
    expect(out.filter).not.toContain('drop-shadow');     // source had none → cleared
  });

  it('does NOT cross-paste a shadow into a non-shadow slot', () => {
    const c = buildCopiedStyle('boxShadow', { filter: 'drop-shadow(1px 1px 1px #000)' }, 'Shadow');
    expect(canPasteStyle(c, 'opacity')).toBe(false);
    expect(canPasteStyle(c, 'color')).toBe(false);
  });
});

// ── Border — every render mode must survive copy/paste ──────────────────────
// The Border tool writes 4 distinct configurations: inline solid, inline
// gradient (borderImage*), overlay solid and overlay gradient (both a
// `::after` rule carried via `borderOverlayCSS`). Copy must snapshot the full
// configuration and paste must CLEAR the target's previous one.
describe('style-clipboard — Border (inline / gradient / overlay)', () => {
  const GRADIENT_OVERLAY_CSS =
    "  content: '';\n  position: absolute;\n  inset: 0;\n  border-radius: inherit;\n  padding: 2px;\n" +
    '  background: linear-gradient(135deg, #00ff88, #0066ff);\n' +
    '  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);\n' +
    '  -webkit-mask-composite: xor;\n  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);\n' +
    '  mask-composite: exclude;\n  pointer-events: none;\n  z-index: 1;';

  it('INLINE SOLID: snapshots the full key set with clears; same-property only', () => {
    const c = buildCopiedStyle('border', { border: '2px solid #ff0000' }, 'Border');
    expect(c.family).toBe('border');
    expect(c.payload.border).toBe('2px solid #ff0000');
    // Absent keys snapshot as '' so paste CLEARS the target's other config
    // (e.g. pasting a solid over a gradient border removes borderImage*).
    expect(c.payload.borderImageSource).toBe('');
    expect(c.payload.borderTopWidth).toBe('');
    expect(c.borderOverlayCSS).toBeNull();
    expect(canPasteStyle(c, 'border')).toBe(true);
    expect(canPasteStyle(c, 'color')).toBe(false);
    expect(canPasteStyle(c, 'backgroundColor')).toBe(false);
    expect(buildPastePayload(c, 'border')).toEqual(c.payload);
  });

  it('INLINE GRADIENT: borderImageSource/Slice ride the payload (border-only family)', () => {
    const c = buildCopiedStyle('border', {
      borderImageSource: 'linear-gradient(90deg, #f00, #00f)', borderImageSlice: '1',
      borderWidth: '3px', borderStyle: 'solid',
    }, 'Border');
    expect(c.family).toBe('border'); // gradient border must NOT become colour/gradient-universal
    expect(c.payload.borderImageSource).toBe('linear-gradient(90deg, #f00, #00f)');
    expect(c.payload.borderImageSlice).toBe('1');
    expect(c.payload.borderWidth).toBe('3px');
    expect(c.payload.border).toBe(''); // clears the target's shorthand
    expect(buildPastePayload(c, 'border')).toEqual(c.payload);
  });

  it('OVERLAY (solid or gradient): carries the ::after body; paste clears inline + seeds position', () => {
    // Overlay sources have NO inline border keys — the config is the rule body.
    const c = buildCopiedStyle('border', {}, 'Border', { borderOverlayCSS: GRADIENT_OVERLAY_CSS });
    expect(c.borderOverlayCSS).toBe(GRADIENT_OVERLAY_CSS);
    // Every inline key clears on paste (target may have had an inline border).
    const onStatic = buildPastePayload(c, 'border', {});
    expect(onStatic.border).toBe('');
    expect(onStatic.borderImageSource).toBe('');
    // ::after is inset:0 → host must be positioned; seed relative on static targets…
    expect(onStatic.position).toBe('relative');
    // …but never clobber an explicit position.
    const onAbsolute = buildPastePayload(c, 'border', { position: 'absolute' });
    expect(onAbsolute.position).toBeUndefined();
    const onRelative = buildPastePayload(c, 'border', { position: 'relative' });
    expect(onRelative.position).toBeUndefined();
  });

  it('INLINE copy has no overlay → paste payload untouched (overlay removal is the caller\'s mutation)', () => {
    const c = buildCopiedStyle('border', { border: '1px dashed #000' }, 'Border');
    expect(c.borderOverlayCSS).toBeNull();
    const out = buildPastePayload(c, 'border', { position: 'static' });
    expect(out.position).toBeUndefined(); // inline borders don't need a positioned host
    expect(out.border).toBe('1px dashed #000');
  });

  it('individual per-side longhands survive the round-trip', () => {
    const c = buildCopiedStyle('border', {
      borderTopWidth: '4px', borderTopStyle: 'solid', borderTopColor: '#123456',
      borderBottomWidth: '1px', borderBottomStyle: 'dotted', borderBottomColor: '#abcdef',
    }, 'Border');
    const out = buildPastePayload(c, 'border');
    expect(out.borderTopWidth).toBe('4px');
    expect(out.borderBottomStyle).toBe('dotted');
    expect(out.borderRightWidth).toBe(''); // unset side clears on the target
  });
});

// ─── Transform: two storage forms, one clipboard ─────────────────────────────
//
// A transform is authored either as a CSS `transform` string (plain page
// element) or as INDEPENDENT MOTION PROPS (`rotate: 30`, `scaleX: 1.2`, …) on a
// design-component `motion.*` element — a raw transform string there would
// collide with motion's `layout` FLIP projection (see shared/motion-transform).
//
// The reported bug (2026-07-25): inside a design component the Transform row
// had NO "Copy Style" entry at all, because the copy only ever looked at
// `styles.transform` — which is empty on a motion element, so the row read as
// "nothing to copy" even while visibly showing "Mixed".

describe('isMotionTransformTarget', () => {
  it('every element in a component file is motion', () => {
    expect(isMotionTransformTarget({ isComponentFile: true, node: null })).toBe(true);
  });
  it('a plain page element is not', () => {
    expect(isMotionTransformTarget({ isComponentFile: false, node: { attrs: {} } })).toBe(false);
  });
  it('a node carrying variant styles is motion (instance on a page)', () => {
    expect(isMotionTransformTarget({ isComponentFile: false, node: { motionVariants: { default: {} } } })).toBe(true);
    expect(isMotionTransformTarget({ isComponentFile: false, node: { motionVariantsRef: 'cardVariants' } })).toBe(true);
  });
  it('an overlay node is motion (it animates via AnimatePresence)', () => {
    expect(isMotionTransformTarget({ isComponentFile: false, node: { attrs: { 'data-overlay': '{}' } } })).toBe(true);
  });
});

describe('canonicalTransformCSS', () => {
  it('reads the CSS string on a plain element', () => {
    expect(canonicalTransformCSS({ transform: 'rotate(30deg)' })).toBe('rotate(30deg)');
  });
  it('composes motion props when present (design component)', () => {
    const css = canonicalTransformCSS({ transform: '', rotate: '30', scaleX: '1.2' });
    expect(css).toContain('rotate(30deg)');
    expect(css).toContain('scaleX(1.2)');
  });
  it('treats `none` as empty', () => {
    expect(canonicalTransformCSS({ transform: 'none' })).toBe('');
  });
});

describe('style-clipboard — transform copy', () => {
  it('COMPONENT source: snapshots the motion props (the row that had no Copy Style)', () => {
    const c = buildCopiedStyle('transform', { transform: '', rotate: '30', scaleX: '1.2' }, 'Transform');
    // The canonical CSS travels with the copy AND backfills `value`, so nothing
    // downstream sees the copy as empty.
    expect(c.transformCSS).toContain('rotate(30deg)');
    expect(c.value).toBe(c.transformCSS);
    // The motion props are in the payload verbatim for a same-world paste.
    expect(c.payload.rotate).toBe('30');
    expect(c.payload.scaleX).toBe('1.2');
  });

  it('PAGE source: snapshots the CSS string', () => {
    const c = buildCopiedStyle('transform', { transform: 'rotate(45deg) scale(2)' }, 'Transform');
    expect(c.transformCSS).toBe('rotate(45deg) scale(2)');
    expect(c.payload.transform).toBe('rotate(45deg) scale(2)');
  });
});

describe('style-clipboard — transform paste converts to the TARGET form', () => {
  const fromComponent = () => buildCopiedStyle('transform', { transform: '', rotate: '30', scaleX: '1.2' }, 'Transform');
  const fromPage = () => buildCopiedStyle('transform', { transform: 'rotate(45deg)' }, 'Transform');

  it('component → component: motion props, CSS string cleared', () => {
    const out = buildPastePayload(fromComponent(), 'transform', {}, { isMotionTarget: true });
    expect(out.rotate).toBe('30');
    expect(out.scaleX).toBe('1.2');
    expect(out.transform).toBe('');
  });

  it('component → page: composed CSS string, motion props cleared', () => {
    const out = buildPastePayload(fromComponent(), 'transform', {}, { isMotionTarget: false });
    expect(out.transform).toContain('rotate(30deg)');
    expect(out.transform).toContain('scaleX(1.2)');
    expect(out.rotate).toBe('');
    expect(out.scaleX).toBe('');
  });

  it('page → component: CSS string converted to motion props', () => {
    const out = buildPastePayload(fromPage(), 'transform', {}, { isMotionTarget: true });
    expect(out.rotate).toBe('45');
    expect(out.transform).toBe('');
  });

  it('page → page: the CSS string round-trips', () => {
    const out = buildPastePayload(fromPage(), 'transform', {}, { isMotionTarget: false });
    expect(out.transform).toBe('rotate(45deg)');
  });

  it('paste REPLACES rather than merges — unset props clear on the target', () => {
    // Copy a scale-only transform, paste onto an element that was rotated: the
    // rotation must go, or the target ends up with a half-stale transform.
    const scaleOnly = buildCopiedStyle('transform', { transform: '', scaleX: '2', scaleY: '2' }, 'Transform');
    const out = buildPastePayload(scaleOnly, 'transform', { rotate: '90' }, { isMotionTarget: true });
    expect(out.scaleX).toBe('2');
    expect(out.rotate).toBe('');
    expect(out.skewX).toBe('');
  });

  it('defaults to the CSS-string form when the caller omits the flag', () => {
    // Back-compat: existing callers that don't pass `opts` keep page semantics.
    const out = buildPastePayload(fromPage(), 'transform');
    expect(out.transform).toBe('rotate(45deg)');
  });

  it('transform stays SAME-PROPERTY only (never a universal number/colour paste)', () => {
    const c = fromComponent();
    expect(canPasteStyle(c, 'transform')).toBe(true);
    expect(canPasteStyle(c, 'opacity')).toBe(false);
    expect(canPasteStyle(c, 'color')).toBe(false);
  });
});
