// linked-component-modal-store.ts — Atom for the LinkedComponentModal's
// open state. The modal mounts globally in App.tsx and reads this atom;
// the canvas double-click handler writes the CDN URL + the clicked
// instance's node id into it to open the modal. Set to null to close.
//
// We carry `nodeId` because "Unlink Instance" needs to rewrite ONLY
// that one JSX tag — without it we'd fall back to "Unlink & Replace All"
// (rewriting the URL import) which silently drags every sibling
// instance along, defeating the per-instance unlink semantics.

import { atom } from 'jotai';

export interface LinkedComponentModalState {
  /** CDN URL the instance is imported from. */
  url: string;
  /** The instance node that opened the modal — used by
   *  "Unlink Instance" to retarget JUST that one JSX tag.
   *  Null when the modal was opened from a discovery surface
   *  (e.g. the Library panel's Linked-component row) where no
   *  specific instance is selected; in that case "Unlink Instance"
   *  is disabled and only "Unlink & Replace All" works. */
  nodeId: string | null;
}

export const linkedComponentModalUrlAtom = atom<LinkedComponentModalState | null>(null);
