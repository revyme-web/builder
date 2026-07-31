// page-variables-store.ts — Derived atom for page-level variables.
//
// Source of truth is the /** @pageVariables { ... } */ annotation in the
// active file's code; this atom re-parses it on every codeAtom change.
// Runtime preview values (Phase 2) will live in a separate atom that merges
// declared defaults with user overrides — keeping declarations and runtime
// state on different atoms makes it cheap to update one without invalidating
// the other.

import { atom } from 'jotai';
// Stable code mirror — page-variable annotations don't change on reparent so
// freezing this during drag avoids a full re-parse cascade.
import { stableCodeAtom as codeAtom } from './store';
import { parsePageVariables, type PageVariable } from '@/code/features/page-variables';
import { trace } from '@/shared/debug-trace';

/** All variables declared on the active page. Empty array if no annotation. */
export const pageVariablesAtom = atom<PageVariable[]>((get) => {
  const code = get(codeAtom);
  const config = parsePageVariables(code);
  const vars = config?.variables ?? [];
  trace.fn('page-variables-store:pageVariablesAtom', { count: vars.length });
  return vars;
});

/** Whether the page-variables modal is open (UI state, not persisted). */
export const pageVariablesModalOpenAtom = atom<boolean>(false);
