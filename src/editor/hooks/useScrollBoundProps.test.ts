import { describe, it, expect } from 'vitest';
import { getScrollBoundProps } from './useScrollBoundProps';
import type { ScrollAnimData } from '@/code/parsing/scroll-parser';

describe('getScrollBoundProps', () => {
  it('returns empty map when no bindings exist', () => {
    const data: ScrollAnimData = { refs: [], sources: [], transforms: [], bindings: [] };
    expect(getScrollBoundProps(data, 'hero-sticky')).toEqual({});
  });

  it('returns bound properties with their transform var names', () => {
    const data: ScrollAnimData = {
      refs: [], sources: [],
      transforms: [{ varName: 'heroScale', sourceVar: 'heroProgress', inputRange: '[0,1]', outputRange: '[1,0.85]', isSpring: false }],
      bindings: [{ nodeId: 'hero-sticky', property: 'scale', transformVar: 'heroScale' }],
    };
    const result = getScrollBoundProps(data, 'hero-sticky');
    expect(result).toEqual({ scale: 'heroScale' });
  });

  it('returns multiple bound properties', () => {
    const data: ScrollAnimData = {
      refs: [], sources: [],
      transforms: [
        { varName: 'heroScale', sourceVar: 'p', inputRange: '[0,1]', outputRange: '[1,0.85]', isSpring: false },
        { varName: 'heroOpacity', sourceVar: 'p', inputRange: '[0,1]', outputRange: '[1,0]', isSpring: false },
      ],
      bindings: [
        { nodeId: 'hero-sticky', property: 'scale', transformVar: 'heroScale' },
        { nodeId: 'hero-sticky', property: 'opacity', transformVar: 'heroOpacity' },
      ],
    };
    const result = getScrollBoundProps(data, 'hero-sticky');
    expect(result).toEqual({ scale: 'heroScale', opacity: 'heroOpacity' });
  });

  it('ignores bindings for other nodes', () => {
    const data: ScrollAnimData = {
      refs: [], sources: [],
      transforms: [
        { varName: 'heroScale', sourceVar: 'p', inputRange: '[0,1]', outputRange: '[1,0.85]', isSpring: false },
        { varName: 'otherY', sourceVar: 'p', inputRange: '[0,1]', outputRange: '[0,100]', isSpring: false },
      ],
      bindings: [
        { nodeId: 'hero-sticky', property: 'scale', transformVar: 'heroScale' },
        { nodeId: 'other-node', property: 'y', transformVar: 'otherY' },
      ],
    };
    const result = getScrollBoundProps(data, 'hero-sticky');
    expect(result).toEqual({ scale: 'heroScale' });
  });
});
