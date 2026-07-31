// motion-reinject.test.ts — Unit coverage for the transferable-motion-props
// decision table. The end-to-end copy→paste flow (mutation queue + generator)
// is covered by motion-props-paste.integration.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/code/mutation/mutation-queue', () => ({
  queueMutation: vi.fn(),
}));

import { queueMutation } from '@/code/mutation/mutation-queue';
import { transferableMotionProps, reinjectMotionProps } from './motion-reinject';
import { createIdMapper } from '../core/id-mapper';
import type { ClipboardNode } from '../types';

describe('transferableMotionProps', () => {
  it('plain flat object transfers as-is', () => {
    expect(transferableMotionProps({ opacity: '0', y: '26', width: '0' }))
      .toEqual({ opacity: '0', y: '26', width: '0' });
  });

  it('string variant refs (initial="hidden") do not transfer', () => {
    expect(transferableMotionProps({ _variantName: 'hidden' })).toBeNull();
  });

  it('scoped value WITH a base → the base transfers', () => {
    expect(transferableMotionProps({
      scale: '1.2', _scope: 'gate:__mq0',
      _base: JSON.stringify({ scale: '1.05' }),
      _chain: JSON.stringify([{ marker: 'gate:__mq0', props: { scale: '1.2' } }]),
    })).toEqual({ scale: '1.05' });
  });

  it('scoped value WITHOUT a base (on/off) → nothing transfers', () => {
    expect(transferableMotionProps({ scale: '1.2', _scope: 'variant:hover-state' })).toBeNull();
  });

  it('meta-only or empty objects → null', () => {
    expect(transferableMotionProps({})).toBeNull();
    expect(transferableMotionProps({ _base: '{}' })).toBeNull();
    expect(transferableMotionProps({ _base: 'not-json' })).toBeNull();
  });
});

describe('reinjectMotionProps', () => {
  beforeEach(() => {
    vi.mocked(queueMutation).mockClear();
  });

  const clipNode = (id: string, motionProps: ClipboardNode['motionProps']): ClipboardNode => ({
    id, type: 'div', parentId: null, children: [], order: 0, styles: {}, motionProps,
  });

  it('queues one updateMotionProp per prop per pasted copy (descendants included)', () => {
    const mapper = createIdMapper();
    mapper.mapClipboardToNew('chip', 'chip-new');
    reinjectMotionProps([
      clipNode('chip', {
        initial: { opacity: '0', y: '26', width: '0' },
        whileInView: { opacity: '1', y: '0', width: '148px' },
        viewport: { once: 'true', margin: '-60px' },
        transition: { type: 'spring', stiffness: '300', damping: '60', mass: '1', delay: '0.08' },
      }),
    ], mapper);

    const calls = vi.mocked(queueMutation).mock.calls.map(c => c[0] as any);
    expect(calls).toHaveLength(4);
    expect(calls.map(c => c.propName).sort()).toEqual(['initial', 'transition', 'viewport', 'whileInView']);
    for (const c of calls) {
      expect(c.type).toBe('updateMotionProp');
      expect(c.nodeId).toBe('chip-new');
    }
    expect(calls.find(c => c.propName === 'viewport')!.props).toEqual({ once: 'true', margin: '-60px' });
  });

  it('multi-target paste writes every mapped copy', () => {
    const mapper = createIdMapper();
    mapper.mapClipboardToNew('chip', 'copy-a');
    mapper.mapClipboardToNew('chip', 'copy-b');
    reinjectMotionProps([clipNode('chip', { whileHover: { scale: '1.05' } })], mapper);

    const ids = vi.mocked(queueMutation).mock.calls.map(c => (c[0] as any).nodeId).sort();
    expect(ids).toEqual(['copy-a', 'copy-b']);
  });

  it('nodes without motionProps or without a mapping queue nothing', () => {
    const mapper = createIdMapper();
    reinjectMotionProps([
      clipNode('plain', null),
      clipNode('unmapped', { whileHover: { scale: '1.1' } }),
    ], mapper);
    expect(queueMutation).not.toHaveBeenCalled();
  });
});
