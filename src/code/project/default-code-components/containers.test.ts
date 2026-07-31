/**
 * @vitest-environment jsdom
 *
 * Container code components (LensBox, MagnetBox, …) are slot-based code components:
 * they render connected canvas nodes as real JSX `{children}`. Each must
 * compile and expose a `slot`-typed control so the connection UI knows it
 * accepts children + how many.
 */
import { describe, it, expect } from 'vitest';
import {
  LENS_BOX_COMPONENT, MAGNET_BOX_COMPONENT,
  MARQUEE_COMPONENT, CAROUSEL_COMPONENT, RIBBON_MARQUEE_COMPONENT,
  MARQUEE_3D_COMPONENT, MOTION_TRAIL_COMPONENT, HORIZONTAL_SCROLL_COMPONENT,
} from './index';
import { compileCodeComponent } from '@/canvas/code-component-runtime';
import { parseComponentControlsMeta } from '@/code/components/controls-parser';

/** Compiled code components are wrapped in `withResponsiveProps` → `React.forwardRef(...)`,
 *  a React "exotic" OBJECT (`$$typeof: react.forward_ref`), no longer a plain function —
 *  the runtime accepts these since the forwardRef-aware `isRenderableComponent` check. */
function expectForwardRefComponent(C: unknown): void {
  expect(C).not.toBeNull();
  // withResponsiveProps returns React.forwardRef → exotic object, not a function
  expect(typeof C).toBe('object');
  expect((C as any).$$typeof).toBe(Symbol.for('react.forward_ref'));
  expect(typeof (C as any).render).toBe('function');
}

describe('Container Code components', () => {
  it('LensBox compiles through code-component-runtime to a forwardRef component', () => {
    const C = compileCodeComponent(LENS_BOX_COMPONENT, 'LensBox');
    expectForwardRefComponent(C);
  });

  it('LensBox declares a single-connection slot control for children', () => {
    const meta = parseComponentControlsMeta(LENS_BOX_COMPONENT);
    expect(meta).not.toBeNull();
    expect(meta!.label).toBe('Lens Box');
    const slot = meta!.controls.children;
    expect(slot).toBeDefined();
    expect(slot.type).toBe('slot');
    expect(slot.slotMax).toBe(1);
  });

  it('LensBox keeps its numeric effect controls', () => {
    const meta = parseComponentControlsMeta(LENS_BOX_COMPONENT)!;
    // Number controls with min/max/step render as sliders (the reference ControlType.Number) — the old
    // `slider` type was unified into `number`.
    expect(meta.controls.zoomFactor?.type).toBe('number');
    expect(meta.controls.lensSize?.type).toBe('number');
  });

  it('MagnetBox compiles through code-component-runtime to a forwardRef component', () => {
    const C = compileCodeComponent(MAGNET_BOX_COMPONENT, 'MagnetBox');
    expectForwardRefComponent(C);
  });

  it('MagnetBox declares a single-connection slot control for children', () => {
    const meta = parseComponentControlsMeta(MAGNET_BOX_COMPONENT);
    expect(meta).not.toBeNull();
    expect(meta!.label).toBe('Magnet Box');
    const slot = meta!.controls.children;
    expect(slot).toBeDefined();
    expect(slot.type).toBe('slot');
    expect(slot.slotMax).toBe(1);
  });

  it('MagnetBox keeps its range + strength number controls', () => {
    const meta = parseComponentControlsMeta(MAGNET_BOX_COMPONENT)!;
    expect(meta.controls.range?.type).toBe('number');
    expect(meta.controls.strength?.type).toBe('number');
  });
});

// ── Effect Code components — multi-slot containers that animate connected nodes ──────
describe('Effect Code components', () => {
  const effects: [string, string, string][] = [
    ['Marquee', MARQUEE_COMPONENT, 'Marquee'],
    ['Carousel', CAROUSEL_COMPONENT, 'Carousel'],
    ['RibbonMarquee', RIBBON_MARQUEE_COMPONENT, 'Path Marquee'],
    ['Marquee3D', MARQUEE_3D_COMPONENT, '3D Marquee'],
    ['MotionTrail', MOTION_TRAIL_COMPONENT, 'Motion Trail'],
    ['HorizontalScroll', HORIZONTAL_SCROLL_COMPONENT, 'Horizontal Scroll'],
  ];

  for (const [name, source, label] of effects) {
    it(name + ' compiles through code-component-runtime to a forwardRef component', () => {
      const C = compileCodeComponent(source, name);
      expectForwardRefComponent(C);
    });

    it(name + ' declares an infinite multi-slot for children', () => {
      const meta = parseComponentControlsMeta(source);
      expect(meta).not.toBeNull();
      expect(meta!.label).toBe(label);
      const slot = meta!.controls.children;
      expect(slot).toBeDefined();
      expect(slot.type).toBe('slot');
      expect(slot.slotMax).toBe('infinite');
    });
  }

  it('Carousel exposes group + transition controls', () => {
    const meta = parseComponentControlsMeta(CAROUSEL_COMPONENT)!;
    expect(meta.controls.transitionConfig?.type).toBe('transition');
    expect(meta.controls.effects?.type).toBe('group');
    expect(meta.controls.arrows?.type).toBe('group');
    expect(meta.controls.dots?.type).toBe('group');
    // Nested group controls are reachable as flat props.
    expect(meta.controls.arrows.controls?.arrowsShow?.type).toBe('toggle');
    expect(meta.controls.dots.controls?.dotsActiveColor?.type).toBe('color');
  });

  it('Marquee / Marquee3D / HorizontalScroll expose group controls', () => {
    expect(parseComponentControlsMeta(MARQUEE_COMPONENT)!.controls.fade?.type).toBe('group');
    expect(parseComponentControlsMeta(MARQUEE_3D_COMPONENT)!.controls.tilt?.type).toBe('group');
    expect(parseComponentControlsMeta(HORIZONTAL_SCROLL_COMPONENT)!.controls.fade?.type).toBe('group');
  });
});
