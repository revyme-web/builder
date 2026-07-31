import { describe, it, expect } from 'vitest';
import {
  MOTION_TRANSFORM_PROPS,
  hasMotionTransformProp,
  motionPropsToCSSTransform,
  cssTransformToMotionProps,
} from './motion-transform';

describe('hasMotionTransformProp', () => {
  it('detects motion transform props, ignores plain styles', () => {
    expect(hasMotionTransformProp({ rotate: '30' })).toBe(true);
    expect(hasMotionTransformProp({ x: '40', backgroundColor: 'red' })).toBe(true);
    expect(hasMotionTransformProp({ left: '20px', width: '100px' })).toBe(false);
    expect(hasMotionTransformProp({ transform: 'rotate(30deg)' })).toBe(false); // a CSS string, not a motion prop
  });
});

describe('motionPropsToCSSTransform — motion props → CSS (for the static canvas)', () => {
  it('rotate adds deg unit', () => {
    expect(motionPropsToCSSTransform({ rotate: '30' })).toBe('rotate(30deg)');
  });
  it('x/y add px and become translateX/Y', () => {
    expect(motionPropsToCSSTransform({ x: '40', y: '-10' })).toBe('translateX(40px) translateY(-10px)');
  });
  it('x keeps a percentage unit', () => {
    expect(motionPropsToCSSTransform({ x: '16.0862%' })).toBe('translateX(16.0862%)');
  });
  it('scale is unitless', () => {
    expect(motionPropsToCSSTransform({ scale: '1.2' })).toBe('scale(1.2)');
  });
  it('composes in motion order: translate → scale → rotate → skew', () => {
    expect(motionPropsToCSSTransform({ rotate: '30', scale: '1.2', x: '40', skewX: '5' }))
      .toBe('translateX(40px) scale(1.2) rotate(30deg) skewX(5deg)');
  });
  it('returns empty string when no transform props', () => {
    expect(motionPropsToCSSTransform({ backgroundColor: 'red', left: '20px' })).toBe('');
  });
  it('skewX/skewY add deg; scaleX/scaleY unitless', () => {
    expect(motionPropsToCSSTransform({ skewX: '10', skewY: '-5' })).toBe('skewX(10deg) skewY(-5deg)');
    expect(motionPropsToCSSTransform({ scaleX: '2', scaleY: '0.5' })).toBe('scaleX(2) scaleY(0.5)');
  });
  it('rotateX/rotateY render with deg', () => {
    expect(motionPropsToCSSTransform({ rotateX: '30', rotateY: '15' })).toBe('rotateX(30deg) rotateY(15deg)');
  });
  it('transformPerspective renders FIRST as perspective(px)', () => {
    expect(motionPropsToCSSTransform({ rotate: '20', transformPerspective: '800' }))
      .toBe('perspective(800px) rotate(20deg)');
  });
  it('ignores empty values', () => {
    expect(motionPropsToCSSTransform({ rotate: '', x: '40' })).toBe('translateX(40px)');
  });

  // A motion prop bound to a motion motion value is stored as the parser's `var:<id>`
  // sentinel. Baking it as `scale(var:id)` is invalid CSS — the browser rejects the WHOLE
  // transform, which froze the drag base transform on an fx component instance.
  it('skips motion-value `var:` bindings (dynamic, not static CSS)', () => {
    expect(motionPropsToCSSTransform({ scale: 'var:cardFxCScale', rotate: 'var:cardFxLoopRotate' })).toBe('');
  });
  it('keeps static props alongside a skipped `var:` prop', () => {
    expect(motionPropsToCSSTransform({ scale: 'var:cardFxCScale', rotate: '30' })).toBe('rotate(30deg)');
  });
  it('does NOT skip a legit CSS `var(--x)` custom-property value', () => {
    expect(motionPropsToCSSTransform({ scale: 'var(--zoom)' })).toBe('scale(var(--zoom))');
  });
});

describe('cssTransformToMotionProps — CSS string → motion props (on author/make-component)', () => {
  it('rotate(30deg) → rotate: 30', () => {
    expect(cssTransformToMotionProps('rotate(30deg)')).toEqual({ rotate: '30' });
  });
  it('translate(40px, 10px) → x/y', () => {
    expect(cssTransformToMotionProps('translate(40px, 10px)')).toEqual({ x: '40', y: '10' });
  });
  it('scale(1.2) → scale', () => {
    expect(cssTransformToMotionProps('scale(1.2)')).toEqual({ scale: '1.2' });
  });
  it('compound: rotate + scale', () => {
    expect(cssTransformToMotionProps('rotate(15deg) scale(0.5)')).toEqual({ rotate: '15', scale: '0.5' });
  });
  it('rad / turn rotation converted to deg', () => {
    expect(cssTransformToMotionProps('rotate(1turn)')).toEqual({ rotate: '360' });
    expect(Number(cssTransformToMotionProps('rotate(3.14159rad)').rotate)).toBeCloseTo(180, 0);
  });
  it('translate keeps a percentage', () => {
    expect(cssTransformToMotionProps('translate(16.0862%, 0)')).toEqual({ x: '16.0862%', y: '0' });
  });
  it('skewX/skewY/scaleX/scaleY → individual props', () => {
    expect(cssTransformToMotionProps('skewX(10deg) skewY(-5deg)')).toEqual({ skewX: '10', skewY: '-5' });
    expect(cssTransformToMotionProps('scaleX(2) scaleY(0.5)')).toEqual({ scaleX: '2', scaleY: '0.5' });
  });
  it('perspective() → transformPerspective', () => {
    expect(cssTransformToMotionProps('perspective(800px) rotate(20deg)')).toEqual({ transformPerspective: '800', rotate: '20' });
  });
  it("'none' / empty → {}", () => {
    expect(cssTransformToMotionProps('none')).toEqual({});
    expect(cssTransformToMotionProps('')).toEqual({});
  });
  it('round-trips rotate through both directions', () => {
    const css = motionPropsToCSSTransform(cssTransformToMotionProps('rotate(30deg)'));
    expect(css).toBe('rotate(30deg)');
  });
});

describe('MOTION_TRANSFORM_PROPS set', () => {
  it('includes the independent transform family, excludes plain props', () => {
    for (const p of ['x', 'y', 'rotate', 'scale', 'skewX']) expect(MOTION_TRANSFORM_PROPS.has(p)).toBe(true);
    for (const p of ['transform', 'left', 'top', 'width']) expect(MOTION_TRANSFORM_PROPS.has(p)).toBe(false);
  });
});
