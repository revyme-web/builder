// usePolledValue.ts — Shared RAF-poll hook for canvas overlays (9.4c).
//
// Consolidates the per-frame "poll a value from the bridge caches into React
// state" skeleton that HoverHighlight / ParentHighlight / ConnectionHandle /
// SlotConnectionHandle each hand-rolled:
//
//   let rafId: number;
//   const poll = () => { setValue(...); rafId = requestAnimationFrame(poll); };
//   rafId = requestAnimationFrame(poll);
//   return () => cancelAnimationFrame(rafId);
//
// The compute callback stays at the call site — only the scheduling skeleton
// is shared. `compute` receives the previous value so sites can keep their
// original setState semantics (equality-preserving like HoverHighlight's
// `cornersEqual` guard, or keep-last-on-miss like ConnectionHandle's
// "only set when corners exist").

import { useEffect, useState } from 'react';

export function usePolledValue<T>(
  /** When false the value is cleared to null and polling stops — mirrors the
   *  call sites' original `if (!shouldShow) { setX(null); return; }` guard. */
  enabled: boolean,
  /** Runs every animation frame inside a setState updater. Return the next
   *  value (return `prev` unchanged to skip the re-render). */
  compute: (prev: T | null) => T | null,
  /** Effect restart deps — same list the original effect used. */
  deps: readonly unknown[],
  opts?: {
    /** Also run compute synchronously when the effect (re)starts, before the
     *  first RAF — mirrors ParentHighlight's immediate first computation. */
    immediate?: boolean;
    /** When this key changes the value is cleared to null WITHOUT restarting
     *  the poll — mirrors SlotConnectionHandle's clear-on-file-switch effect. */
    resetKey?: unknown;
  },
): T | null {
  const [value, setValue] = useState<T | null>(null);

  // Clear on resetKey change — declared BEFORE the poll effect so the clear
  // lands first, mirroring the call sites' original effect order. No-op on
  // mount (state starts null) and for callers without a resetKey (undefined
  // never changes).
  useEffect(() => { setValue(null); }, [opts?.resetKey]);

  useEffect(() => {
    if (!enabled) { setValue(null); return; }
    let rafId: number;
    const poll = () => {
      setValue(prev => compute(prev));
      rafId = requestAnimationFrame(poll);
    };
    if (opts?.immediate) setValue(prev => compute(prev));
    rafId = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, opts?.immediate, ...deps]);

  return value;
}
