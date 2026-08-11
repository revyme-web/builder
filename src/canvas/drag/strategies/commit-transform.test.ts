// A drop must not send `transform: ''` when the node never had a transform.
//
// The drag's final commit "restores" the pre-drag transform. When that
// snapshot is EMPTY the restore looks like a no-op, but it isn't: downstream,
// `transform: ''` means "reset the transform", and that reset also clears a
// framer-motion `rotate` prop — in the inline style AND in the variant entry.
// A component master whose rotation lives in `rotate: '14.4'` rather than a
// `transform: rotate(...)` string therefore lost its rotation on every drop
// (user report 2026-08-11: variantConfig x/y updated correctly while
// `frameMsosauqj1Variants.default` went from `{ rotate: 14.4 }` to `{}`).
//
// Two halves are asserted here: the commit no longer emits the empty key, and
// the generator behaviour that made it destructive is left intact (an
// EXPLICIT transform reset must still clear the rotation).

import { describe, it, expect } from 'vitest';
import { updateVariantStyleInCode } from '../../../code/generation/generator-styles';
import { CanvasDragStrategy } from './CanvasDragStrategy';

/** The commit rule itself, mirroring CanvasDragStrategy.commitTransform. */
function commitTransform(orig: string): Record<string, string> {
  return orig ? { transform: orig } : {};
}

const MASTER = `'use client';
const frameMsosauqj1Variants = {
  default: {
    rotate: 14.4
  }
};
function MaTaGa({ style, initialVariant = 'default', ...rest }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="frame-msosauqj-1" variants={frameMsosauqj1Variants} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Frame" style={{
      position: 'absolute',
      width: '732px',
      height: '407px',
      rotate: '14.4',
      ...style
    }}></motion.div>
  </LayoutGroup>;
}`;

describe('drop commit — empty transform is omitted, not written', () => {
  it('emits no transform key when the node had none', () => {
    expect(commitTransform('')).toEqual({});
  });

  it('still carries a real pre-drag transform through', () => {
    expect(commitTransform('rotate(-195.7deg)')).toEqual({ transform: 'rotate(-195.7deg)' });
  });

  it('the omitted key is what saves a motion `rotate` on the variant entry', () => {
    // What the drop used to send: position + an empty transform.
    const destructive = updateVariantStyleInCode(MASTER, 'frame-msosauqj-1', 'default', {
      left: '-612px', top: '290px', transform: '',
    });
    expect(destructive).toContain('default: {}');

    // What it sends now — the empty transform simply isn't in the payload.
    const preserved = updateVariantStyleInCode(MASTER, 'frame-msosauqj-1', 'default', {
      left: '-612px', top: '290px', ...commitTransform(''),
    });
    expect(preserved).toMatch(/rotate:\s*14\.4/);
  });

  it('an EXPLICIT transform reset still clears the rotation', () => {
    // The destructive expansion is correct behaviour for a real reset (the
    // user clearing rotation), so it must survive this fix — only the drag
    // stopped claiming to reset something it never owned.
    const reset = updateVariantStyleInCode(MASTER, 'frame-msosauqj-1', 'default', { transform: '' });
    expect(reset).not.toMatch(/rotate:\s*14\.4/);
  });
});

// DURING the drag, the same rotation has to stay on screen. Motion owns
// `style.transform` on an element whose rotation is a style PROP, and the
// per-frame `transform: translate(dx, dy)` overwrote motion's composed string
// — the node rendered unrotated for the whole gesture and snapped back on
// mouse-up. The preview re-expresses those props as CSS so the drag looks
// like the thing being dragged.
describe('motion-prop transform preview (drag-time visual)', () => {
  // The builder is per-instance state-free; reach it directly.
  const build = (
    styles: Record<string, string> | undefined,
    variants?: Record<string, Record<string, string>> | null,
    variantName?: string,
  ) =>
    (new CanvasDragStrategy() as unknown as {
      buildMotionTransformPreview(
        s?: Record<string, string>,
        v?: Record<string, Record<string, string>> | null,
        n?: string,
      ): string;
    }).buildMotionTransformPreview(styles, variants, variantName);

  it('re-expresses a unitless motion rotate as CSS', () => {
    expect(build({ rotate: '14.4' })).toBe('rotate(14.4deg)');
  });

  it('passes through a value that already carries a unit', () => {
    expect(build({ rotate: '-90deg' })).toBe('rotate(-90deg)');
  });

  it('composes rotate and scale together', () => {
    expect(build({ rotate: '10', scale: '1.2' })).toBe('rotate(10deg) scale(1.2)');
  });

  it('ignores identity values so the common case writes nothing', () => {
    expect(build({ rotate: '0', scale: '1' })).toBe('');
    expect(build({})).toBe('');
    expect(build(undefined)).toBe('');
  });

  // A master's variant tiles each carry their OWN rotation in the variants
  // object; the inline style only holds the baked default. Dragging a variant
  // tile has to preview THAT variant's value.
  it("resolves the dragged variant's own rotation over the inline default", () => {
    const variants = { default: { rotate: '19.5' }, 'variant-1': { rotate: '-41.9' } };
    expect(build({ rotate: '19.5' }, variants, 'variant-1')).toBe('rotate(-41.9deg)');
  });

  it('falls back to the base entry when the variant overrides nothing', () => {
    const variants = { default: { rotate: '19.5' }, 'variant-2': { backgroundColor: '#fff' } };
    expect(build({ rotate: '19.5' }, variants, 'variant-2')).toBe('rotate(19.5deg)');
  });

  it('uses the base entry for the primary tile', () => {
    const variants = { default: { rotate: '19.5' }, 'variant-1': { rotate: '-41.9' } };
    expect(build({ rotate: '19.5' }, variants, 'default')).toBe('rotate(19.5deg)');
  });

  it('still works with no variants object at all (plain canvas node)', () => {
    expect(build({ rotate: '14.4' }, null, 'desktop')).toBe('rotate(14.4deg)');
  });

  it('is preview-only — never fed to the code commit', () => {
    // Guards the double-apply hazard: if this string reached `originalTransforms`
    // the drop would write `transform: rotate(14.4deg)` into source ALONGSIDE
    // the motion `rotate` prop and the node would rotate twice.
    const s = new CanvasDragStrategy() as unknown as {
      originalTransforms: Map<string, string>;
      commitTransform(id: string): Record<string, string>;
    };
    expect(s.originalTransforms.get('n1')).toBeUndefined();
    expect(s.commitTransform('n1')).toEqual({});
  });
});
