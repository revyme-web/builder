import { describe, it, expect } from 'vitest';
import {
  sideToTransform,
  maskToClip,
  springToLinearEasing,
  resolveTiming,
  buildViewTransitionCSS,
  PRESETS,
  applyPreset,
  resolvePageEffect,
} from './view-transition-css';
import { createDefaultSide, createDefaultTransition, type PageEffectsMap } from '../project/page-effects-config';

describe('view-transition-css: sideToTransform', () => {
  it('identity side → none', () => {
    expect(sideToTransform(createDefaultSide())).toBe('none');
  });
  it('relative offset → %, fixed offset → px', () => {
    expect(sideToTransform({ ...createDefaultSide(), offsetX: 100, offsetXUnit: 'relative', offsetY: -50, offsetYUnit: 'relative' }))
      .toBe('translate(100%, -50%)');
    expect(sideToTransform({ ...createDefaultSide(), offsetX: 20, offsetXUnit: 'fixed', offsetY: 0, offsetYUnit: 'fixed' }))
      .toBe('translate(20px, 0px)');
  });
  it('scale + 2D rotate compose translate→scale→rotate', () => {
    expect(sideToTransform({ ...createDefaultSide(), offsetX: 10, offsetXUnit: 'fixed', offsetY: 0, offsetYUnit: 'fixed', scale: 2, rotateZ: 45 }))
      .toBe('translate(10px, 0px) scale(2) rotate(45deg)');
  });
  it('3D rotate emits perspective + rotateX/Y/Z', () => {
    expect(sideToTransform({ ...createDefaultSide(), rotate: '3d', rotateX: 30, rotateY: 60, rotateZ: 90 }))
      .toBe('perspective(1200px) rotateX(30deg) rotateY(60deg) rotateZ(90deg)');
  });
  it('opacity alone does NOT add a transform', () => {
    expect(sideToTransform({ ...createDefaultSide(), opacity: 0 })).toBe('none');
  });
});

describe('view-transition-css: maskToClip', () => {
  const circle = { type: 'circle' as const, originX: 50, originXUnit: 'rel' as const, originY: 50, originYUnit: 'rel' as const };
  it('circle full vs clipped with rel origins', () => {
    expect(maskToClip(circle, 'full')).toBe('circle(150% at 50% 50%)');
    expect(maskToClip(circle, 'clipped')).toBe('circle(0% at 50% 50%)');
  });
  it('circle abs origin → px', () => {
    expect(maskToClip({ ...circle, originX: 100, originXUnit: 'abs', originY: 200, originYUnit: 'abs' }, 'full'))
      .toBe('circle(150% at 100px 200px)');
  });
  it('wipes: full = inset 0, clipped per direction', () => {
    expect(maskToClip({ ...circle, type: 'wipe-left' }, 'full')).toBe('inset(0 0 0 0)');
    expect(maskToClip({ ...circle, type: 'wipe-left' }, 'clipped')).toBe('inset(0 0 0 100%)');
    expect(maskToClip({ ...circle, type: 'wipe-right' }, 'clipped')).toBe('inset(0 100% 0 0)');
    expect(maskToClip({ ...circle, type: 'wipe-up' }, 'clipped')).toBe('inset(100% 0 0 0)');
    expect(maskToClip({ ...circle, type: 'wipe-down' }, 'clipped')).toBe('inset(0 0 100% 0)');
  });
});

describe('view-transition-css: easing', () => {
  it('ease → cubic-bezier from configured bezier', () => {
    const t = resolveTiming({ kind: 'ease', bezier: [0.1, 0.2, 0.3, 0.4], duration: 0.5, delay: 0.1 });
    expect(t.easing).toBe('cubic-bezier(0.1, 0.2, 0.3, 0.4)');
    expect(t.duration).toBe(0.5);
    expect(t.delay).toBe(0.1);
  });
  it('spring → linear() with stops + derived duration', () => {
    const t = resolveTiming({ kind: 'spring', stiffness: 100, damping: 10, mass: 1, duration: 0, delay: 0 });
    expect(t.easing).toMatch(/^linear\(0, /);
    expect(t.easing).toMatch(/, 1\)$/);
    expect(t.duration).toBeGreaterThan(0);
  });
  it('bouncy spring overshoots (a stop > 1)', () => {
    const { easing } = springToLinearEasing({ stiffness: 400, damping: 8, mass: 1 });
    const stops = easing.slice('linear('.length, -1).split(',').map((s) => parseFloat(s));
    expect(Math.max(...stops)).toBeGreaterThan(1);
  });
});

describe('view-transition-css: buildViewTransitionCSS', () => {
  it('both sides → old + new pseudo + keyframes', () => {
    const css = buildViewTransitionCSS(createDefaultSide(), { ...createDefaultSide(), opacity: 0 });
    expect(css).toContain('::view-transition-old(root)');
    expect(css).toContain('::view-transition-new(root)');
    expect(css).toContain('@keyframes revyme-vt-exit');
    expect(css).toContain('@keyframes revyme-vt-enter');
    expect(css).toContain('prefers-reduced-motion: reduce');
    // Pure opacity crossfade (no transform/mask) → browser-default plus-lighter +
    // isolated pair, so the two fades sum to full coverage — no <html> backdrop
    // bleed (the white-flash bug on the live site).
    expect(css).toContain('isolation: isolate');
    expect(css).toContain('mix-blend-mode: plus-lighter');
    expect(css).not.toContain('mix-blend-mode: normal');
  });
  it('transform effect (slide) → normal blend (opaque overlap, no bright seam)', () => {
    const css = buildViewTransitionCSS(undefined, { ...createDefaultSide(), offsetX: 100 });
    // A moving opaque page must NOT plus-lighter — it would brighten the overlap.
    expect(css).toContain('isolation: auto');
    expect(css).toContain('mix-blend-mode: normal');
    expect(css).not.toContain('plus-lighter');
  });
  it('missing exit → old animation:none', () => {
    const css = buildViewTransitionCSS(undefined, { ...createDefaultSide(), offsetX: 100 });
    expect(css).toContain('::view-transition-old(root) { animation: none; }');
    expect(css).toContain('transform: translate(100%, 0%)');
  });
  it('enter mask reveals clipped→full', () => {
    const enter = { ...createDefaultSide(), mask: { type: 'circle' as const, originX: 50, originXUnit: 'rel' as const, originY: 50, originYUnit: 'rel' as const } };
    const css = buildViewTransitionCSS(undefined, enter);
    expect(css).toContain('from { opacity: 1; transform: none; clip-path: circle(0% at 50% 50%);');
    expect(css).toContain('to { opacity: 1; transform: none; clip-path: circle(150% at 50% 50%);');
  });
});

describe('view-transition-css: PRESETS', () => {
  it('crossfade fades both sides', () => {
    const p = PRESETS.crossfade();
    expect(p.exit?.opacity).toBe(0);
    expect(p.enter?.opacity).toBe(0);
  });
  it('slide-left = new page only, +100% X', () => {
    const p = PRESETS['slide-left']();
    expect(p.exit).toBeUndefined();
    expect(p.enter?.offsetX).toBe(100);
  });
  it('push-left = both move in lockstep', () => {
    const p = PRESETS['push-left']();
    expect(p.exit?.offsetX).toBe(-100);
    expect(p.enter?.offsetX).toBe(100);
  });
  it('fade-out-in sequences the enter (delay = exit duration)', () => {
    const p = PRESETS['fade-out-in']();
    expect(p.enter?.transition.delay).toBe(p.exit?.transition.duration);
  });
  it('wipe-left enter gets a wipe-left mask', () => {
    expect(PRESETS['wipe-left']().enter?.mask?.type).toBe('wipe-left');
  });
  it('applyPreset(custom|unknown) → empty', () => {
    expect(applyPreset('custom')).toEqual({});
    expect(applyPreset('nope')).toEqual({});
  });
});

describe('view-transition-css: resolvePageEffect', () => {
  const eff = (preset: string): any => ({ preset, target: 'x' });
  const map: PageEffectsMap = {
    __default: eff('site'),
    pages: {
      '/team': { all: eff('team-all'), byTarget: { '/': eff('team-to-home') } },
      '/blog': { byTarget: {} },
    },
  };
  it('byTarget wins', () => {
    expect(resolvePageEffect(map, '/team', '/')?.preset).toBe('team-to-home');
  });
  it('falls back to source all', () => {
    expect(resolvePageEffect(map, '/team', '/contact')?.preset).toBe('team-all');
  });
  it('falls back to __default', () => {
    expect(resolvePageEffect(map, '/blog', '/x')?.preset).toBe('site');
  });
  it('null when no default + no bucket', () => {
    expect(resolvePageEffect({ pages: {} }, '/a', '/b')).toBeNull();
  });
});

describe('view-transition-css: defaults', () => {
  it('default transition is ease easeInOut 0.4s', () => {
    const t = createDefaultTransition();
    expect(t.kind).toBe('ease');
    expect(t.duration).toBe(0.4);
    expect(t.delay).toBe(0);
  });
});
