// closed-source-store.ts — hides the CODE surfaces for closed-source remixes.
//
// A website remixed from a CLOSED-SOURCE template carries
// `websites.closed_source = true` (stamped at remix time from the template's
// setting). The owner can use and edit the DESIGN freely, but the template
// author chose not to expose the source — so the editor hides the code
// affordances: the left-menu Code button and the CodeEditorPopup.
//
// Set once at project load (ProjectLoader.tsx). Same module-state +
// useSyncExternalStore pattern as viewer-mode-store so non-React contexts
// can read it synchronously.

import { useSyncExternalStore } from 'react';
import { trace } from '@/shared/debug-trace';

let _closedSource = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** Set at project load from `backend.getWebsiteClosedSource(id)`. */
export function setClosedSource(v: boolean): void {
  if (_closedSource === v) return;
  _closedSource = v;
  trace.action('closed-source:set', { closedSource: v });
  emit();
}

/** Sync read for non-React contexts. */
export function isClosedSource(): boolean {
  return _closedSource;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** React hook — true when the code panel must stay hidden. */
export function useIsClosedSource(): boolean {
  return useSyncExternalStore(subscribe, isClosedSource, isClosedSource);
}
