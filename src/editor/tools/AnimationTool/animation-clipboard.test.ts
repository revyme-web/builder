// animation-clipboard.test.ts — copy/paste of animation entries
// (text effect + Appear / Hover / Tap motion-props).

import { describe, test, expect, vi, beforeEach } from 'vitest';

const queueMutation = vi.fn();
vi.mock('@/code/mutation/mutation-queue', () => ({ queueMutation: (m: unknown) => queueMutation(m) }));
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
// Control the "active tile" scope so paste-routing is deterministic in tests.
const getActiveAnimationScope = vi.fn(() => null as any);
vi.mock('./animation-scope-source', () => ({ getActiveAnimationScope: () => getActiveAnimationScope() }));

import { buildCopiedAnimation, canPasteAnimation, applyCopiedAnimation, isAnimCopyable } from './animation-clipboard';

const TEXT_CONFIG = { animationType: 'character', trigger: 'view', opacity: 0, y: 20, delay: 0.04 };

beforeEach(() => { queueMutation.mockClear(); getActiveAnimationScope.mockReturnValue(null); });

describe('isAnimCopyable', () => {
  test('text effect / appear / hover / tap are copyable; an unsupported kind is not', () => {
    expect(isAnimCopyable('textEffect')).toBe(true);
    expect(isAnimCopyable('appear')).toBe(true);
    expect(isAnimCopyable('hover')).toBe(true);
    expect(isAnimCopyable('tap')).toBe(true);
    expect(isAnimCopyable('keyframe')).toBe(false);
  });
});

describe('buildCopiedAnimation', () => {
  test('snapshots a text effect config (deep-cloned)', () => {
    const data = { config: TEXT_CONFIG };
    const copied = buildCopiedAnimation('textEffect', data)!;
    expect(copied).toMatchObject({ kind: 'textEffect', label: 'Text' });
    expect(copied.config).toEqual(TEXT_CONFIG);
    // Deep clone: mutating the source must not change the clipboard snapshot.
    (data.config as any).animationType = 'word';
    expect((copied.config as any).animationType).toBe('character');
  });

  test('returns null for an unsupported kind or missing config', () => {
    expect(buildCopiedAnimation('keyframe', { config: TEXT_CONFIG })).toBeNull();
    expect(buildCopiedAnimation('textEffect', {})).toBeNull();
    expect(buildCopiedAnimation('textEffect', undefined)).toBeNull();
  });

  test('snapshots a plain motion-props Appear (initialProps + transition)', () => {
    const data = { trigger: 'appear', initialProps: { opacity: '0', y: '30' }, transition: { duration: '0.5' }, isVariantMode: false };
    const copied = buildCopiedAnimation('appear', data)!;
    expect(copied).toMatchObject({ kind: 'appear', label: 'Appear' });
    expect(copied.config).toEqual({ initialProps: { opacity: '0', y: '30' }, transition: { duration: '0.5' } });
    // Deep clone independence.
    data.initialProps.opacity = '1';
    expect((copied.config as any).initialProps.opacity).toBe('0');
  });

  test('skips the non-portable Appear variants (scroll / overlay / instance-fx / combined-fx)', () => {
    expect(buildCopiedAnimation('appear', { trigger: 'scroll', scrollPayload: {} })).toBeNull();
    expect(buildCopiedAnimation('appear', { trigger: 'appear', isOverlay: true, initialProps: { opacity: '0' } })).toBeNull();
    expect(buildCopiedAnimation('appear', { trigger: 'appear', initialProps: { opacity: '0' }, instanceFx: {}, fxKind: 'appear' })).toBeNull();
    expect(buildCopiedAnimation('appear', { trigger: 'appear', initialProps: { opacity: '0' }, fxSpec: {}, fxKind: 'appear' })).toBeNull();
    // empty enter → nothing to copy
    expect(buildCopiedAnimation('appear', { trigger: 'appear', initialProps: {} })).toBeNull();
  });

  test('snapshots a live motion hover / tap gesture, skips fx-spec ones', () => {
    const hover = buildCopiedAnimation('hover', { engine: 'motion', payload: { props: { scale: '1.05' } }, transition: { type: 'spring', duration: '0.3' } })!;
    expect(hover).toMatchObject({ kind: 'hover', label: 'Hover' });
    expect(hover.config).toEqual({ props: { scale: '1.05' }, transition: { type: 'spring', duration: '0.3' } });
    const tap = buildCopiedAnimation('tap', { engine: 'motion', payload: { props: { scale: '0.95' } } })!;
    expect(tap.config).toEqual({ props: { scale: '0.95' }, transition: {} });
    // combined-node (fxSpec) hover carries engine:'motion' too — but is NOT portable here.
    expect(buildCopiedAnimation('hover', { engine: 'motion', payload: { props: { scale: '1.05' } }, fxSpec: {}, fxKind: 'hover' })).toBeNull();
    // instance-fx hover has no engine:'motion'
    expect(buildCopiedAnimation('hover', { instanceFx: {}, fxKind: 'hover' })).toBeNull();
    expect(buildCopiedAnimation('hover', { engine: 'motion', payload: { props: {} } })).toBeNull();
  });
});

describe('canPasteAnimation', () => {
  const copied = buildCopiedAnimation('textEffect', { config: TEXT_CONFIG });
  test('same kind → true, different kind → false, null → false', () => {
    expect(canPasteAnimation(copied, 'textEffect')).toBe(true);
    expect(canPasteAnimation(copied, 'appear')).toBe(false);
    expect(canPasteAnimation(null, 'textEffect')).toBe(false);
  });
});

describe('applyCopiedAnimation', () => {
  test('text effect pastes via updateTextAnim onto the target node', () => {
    const copied = buildCopiedAnimation('textEffect', { config: TEXT_CONFIG })!;
    applyCopiedAnimation(copied, 'target-node');
    expect(queueMutation).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledWith({ type: 'updateTextAnim', nodeId: 'target-node', config: TEXT_CONFIG });
  });

  test('appear pastes scoped initial + derived whileInView + transition', () => {
    const copied = buildCopiedAnimation('appear', { trigger: 'appear', initialProps: { opacity: '0', y: '30' }, transition: { duration: '0.5' } })!;
    applyCopiedAnimation(copied, 'target', { motionProps: { initial: null }, styles: {} });
    // initial (scoped null = base here), whileInView (derived reveal), transition
    expect(queueMutation).toHaveBeenCalledWith({ type: 'updateMotionProp', nodeId: 'target', propName: 'initial', props: { opacity: '0', y: '30' }, scope: null });
    expect(queueMutation).toHaveBeenCalledWith({ type: 'updateMotionProp', nodeId: 'target', propName: 'whileInView', props: { opacity: '1', y: '0' } });
    expect(queueMutation).toHaveBeenCalledWith({ type: 'updateMotionProp', nodeId: 'target', propName: 'transition', props: { duration: '0.5' } });
    expect(queueMutation).toHaveBeenCalledTimes(3);
  });

  test('appear paste routes to the active REPLICA scope (per-viewport override)', () => {
    getActiveAnimationScope.mockReturnValue({ query: '(max-width: 375px)' });
    const copied = buildCopiedAnimation('appear', { trigger: 'appear', initialProps: { opacity: '0' }, transition: {} })!;
    applyCopiedAnimation(copied, 'target', { motionProps: { initial: null }, styles: {} });
    // initial carries the replica scope; whileInView stays non-scoped (rest is global)
    expect(queueMutation).toHaveBeenCalledWith({ type: 'updateMotionProp', nodeId: 'target', propName: 'initial', props: { opacity: '0' }, scope: { query: '(max-width: 375px)' } });
    expect(queueMutation).toHaveBeenCalledWith({ type: 'updateMotionProp', nodeId: 'target', propName: 'whileInView', props: { opacity: '1' } });
    // empty transition → not written
    expect(queueMutation).toHaveBeenCalledTimes(2);
  });

  test('hover / tap paste scoped whileHover / whileTap — WITH the copied transition', () => {
    // The reported half-paste: hover gesture pasted but the target kept its own
    // spring. The transition must travel with the gesture (same write the
    // HoverPopup Transition row uses: unscoped tag-level `transition`).
    const hover = buildCopiedAnimation('hover', { engine: 'motion', payload: { props: { scale: '1.05' } }, transition: { type: 'spring', duration: '0.3' } })!;
    applyCopiedAnimation(hover, 'target');
    expect(queueMutation).toHaveBeenCalledWith({ type: 'updateMotionProp', nodeId: 'target', propName: 'whileHover', props: { scale: '1.05' }, scope: null });
    expect(queueMutation).toHaveBeenCalledWith({ type: 'updateMotionProp', nodeId: 'target', propName: 'transition', props: { type: 'spring', duration: '0.3' } });
    expect(queueMutation).toHaveBeenCalledTimes(2);
    queueMutation.mockClear();
    // No transition on the source → gesture only, target's timing untouched.
    const tap = buildCopiedAnimation('tap', { engine: 'motion', payload: { props: { scale: '0.95' } } })!;
    applyCopiedAnimation(tap, 'target');
    expect(queueMutation).toHaveBeenCalledWith({ type: 'updateMotionProp', nodeId: 'target', propName: 'whileTap', props: { scale: '0.95' }, scope: null });
    expect(queueMutation).toHaveBeenCalledTimes(1);
  });
});
