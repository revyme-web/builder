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

// ─── Multi-select paste ─────────────────────────────────────────────────────
//
// User report 2026-08-09: with twelve cards selected, all carrying an Appear,
// Paste Style landed on ONE of them. The menu item lived on a card that
// `useControl()` hands the PRIMARY node only, so it pasted to `node.id` and
// ignored the rest of the selection — unlike every other control's paste, which
// fans out over `selectedIds`.
//
// The fan-out lives in AnimationTool/index.tsx (it owns the selection atom);
// what this pins is the part that makes fanning out CORRECT: each target must
// be applied against ITS OWN node, because the Appear reveal is derived from
// the target's existing enter keys and authored styles. Passing the primary's
// node for every target would paste twelve copies of the primary's reveal.
describe('applyCopiedAnimation — per-target derivation', () => {
  const copied = {
    kind: 'appear' as const, label: 'Appear',
    config: { initialProps: { opacity: '0', y: '18' }, transition: { duration: '0.6' } },
  };

  const mutationsFor = (nodeId: string) =>
    queueMutation.mock.calls.map((c) => c[0]).filter((m: any) => m.nodeId === nodeId);

  test('each node gets its own initial + whileInView + transition', () => {
    const nodes = [
      { id: 'a', styles: { width: '100px' }, motionProps: {} },
      { id: 'b', styles: { width: '200px' }, motionProps: {} },
      { id: 'c', styles: { width: '300px' }, motionProps: {} },
    ];
    for (const n of nodes) applyCopiedAnimation(copied, n.id, n);

    for (const n of nodes) {
      const props = mutationsFor(n.id).map((m: any) => m.propName);
      expect(props, n.id).toEqual(['initial', 'whileInView', 'transition']);
    }
  });

  test('the reveal is derived from EACH target, not shared', () => {
    // `a` already animates `x` on enter; `b` does not. The union of enter keys
    // differs, so their reveals must differ — proof the per-node lookup matters.
    applyCopiedAnimation(copied, 'a', { id: 'a', styles: {}, motionProps: { initial: { x: '-40' } } });
    applyCopiedAnimation(copied, 'b', { id: 'b', styles: {}, motionProps: {} });

    const revealOf = (id: string) =>
      mutationsFor(id).find((m: any) => m.propName === 'whileInView')!.props;
    expect(Object.keys(revealOf('a'))).toContain('x');
    expect(Object.keys(revealOf('b'))).not.toContain('x');
  });

  test('pasting onto N nodes queues N times the single-node mutations', () => {
    const ids = ['a', 'b', 'c', 'd'];
    for (const id of ids) applyCopiedAnimation(copied, id, { id, styles: {}, motionProps: {} });
    expect(queueMutation).toHaveBeenCalledTimes(ids.length * 3);
    expect(new Set(queueMutation.mock.calls.map((c) => (c[0] as any).nodeId))).toEqual(new Set(ids));
  });

  test('a target with no resolvable node still applies (no crash, no shared state)', () => {
    // getNodeFromCache can miss during a re-parse; the paste must still land.
    applyCopiedAnimation(copied, 'ghost', undefined);
    expect(mutationsFor('ghost').map((m: any) => m.propName)).toEqual(['initial', 'whileInView', 'transition']);
  });
});
