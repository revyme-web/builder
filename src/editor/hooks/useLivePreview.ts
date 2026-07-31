// useLivePreview.ts — live-preview state that auto-clears on commit.
//
// The canonical editor pattern for continuous interactions (color-picker /
// slider drags, canvas drag/resize): the per-frame change is an imperative
// DOM/bridge patch that never writes code, so the committed source value the
// panel renders from stays frozen until release. Controls mirror the in-flight
// value in this local state so their swatch/input tracks the drag in real
// time; the effect clears it the moment the committed value catches up (the
// release re-parse) — no flicker, because by then the committed value equals
// the last previewed one — and it never masks a later external edit (preset
// apply, undo), since any real change to the committed deps resets it.

import { useEffect, useState, type Dispatch, type DependencyList, type SetStateAction } from 'react';

/**
 * `useState<T | null>(null)` plus an auto-clear effect keyed on the committed
 * value(s). Pass the committed source value(s) the preview shadows as `deps`.
 *
 *   const [livePreview, setLivePreview] = useLivePreview<string>([value]);
 *   const display = livePreview ?? value;
 */
export function useLivePreview<T>(
  deps: DependencyList,
): [T | null, Dispatch<SetStateAction<T | null>>] {
  const [livePreview, setLivePreview] = useState<T | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setLivePreview(null); }, deps);
  return [livePreview, setLivePreview];
}
