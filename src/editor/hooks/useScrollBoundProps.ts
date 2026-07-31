// useScrollBoundProps.ts — Detect which style properties are bound to scroll animations.
import { useAtomValue } from 'jotai';
import { useMemo } from 'react';
import { scrollAnimDataAtom } from '@/code/stores/animation-store';
import type { ScrollAnimData } from '@/code/parsing/scroll-parser';
import { trace } from '@/shared/debug-trace';

/**
 * Pure function: get map of property → transformVar for a node's scroll-bound props.
 * e.g., { scale: 'heroScale', opacity: 'heroOpacity' }
 */
export function getScrollBoundProps(data: ScrollAnimData, nodeId: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const b of data.bindings) {
    if (b.nodeId === nodeId) result[b.property] = b.transformVar;
  }
  return result;
}

/**
 * Hook: returns map of scroll-bound properties for the given node.
 * Returns {} when no scroll animations exist.
 */
export function useScrollBoundProps(nodeId: string | null): Record<string, string> {
  const scrollData = useAtomValue(scrollAnimDataAtom);
  return useMemo(() => {
    if (!nodeId) return {};
    const result = getScrollBoundProps(scrollData, nodeId);
    if (Object.keys(result).length > 0) {
      trace.fn('useScrollBoundProps', { nodeId, boundProps: Object.keys(result) });
    }
    return result;
  }, [scrollData, nodeId]);
}
