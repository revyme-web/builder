// useControlContext.ts — Hook to access unified control context.

import React, { createContext, useContext, useMemo } from 'react';
import type { UnifiedControlContextValue } from './types';

export const UnifiedControlContext = createContext<UnifiedControlContextValue | null>(null);

/**
 * Re-provide the current unified control context with labels FORCED VISIBLE. The Variable modal sets
 * `hideLabel` on an atom's Default row (the FieldRow already labels it), but that flag flows down into
 * the atom's EXPANDED editor popup (Shadow/Border) where the per-field labels (X / Y / Blur / Spread /
 * Width / Style / Color) ARE needed — without them you can't tell what you're editing. Wrapping the
 * popup body in this resets just `hideLabel`, leaving every other context field intact. No-op outside a
 * provider.
 */
export function ShowControlLabels({ children }: { children: React.ReactNode }) {
  const ctx = useContext(UnifiedControlContext);
  const next = useMemo(() => (ctx ? { ...ctx, hideLabel: false } : null), [ctx]);
  if (!next) return children as React.ReactElement;
  return React.createElement(UnifiedControlContext.Provider, { value: next }, children);
}

/** Access the unified control context. Must be used within a UnifiedControlProvider. */
export function useControlContext(): UnifiedControlContextValue {
  const ctx = useContext(UnifiedControlContext);
  if (!ctx) throw new Error('useControlContext must be used within UnifiedControlProvider');
  return ctx;
}

/** Optional access — returns null if no provider. */
export function useControlContextOptional(): UnifiedControlContextValue | null {
  return useContext(UnifiedControlContext);
}
