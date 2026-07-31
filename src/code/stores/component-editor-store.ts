// component-editor-store.ts — State for the Code component Editor overlay.
// When componentEditorFileAtom is non-null, the overlay is visible.

import { atom } from 'jotai';

/** The code component file path being edited, or null when closed. */
export const componentEditorFileAtom = atom<string | null>(null);

/** Current prop values for the preview (keyed by prop name). */
export const componentEditorPropsAtom = atom<Record<string, any>>({});

/** True while AI is streaming code into the editor. Editor becomes read-only + auto-scrolls. */
export const componentEditorStreamingAtom = atom(false);

/** True while waiting for the first code chunk (thinking phase). Shows loader overlay. */
export const componentEditorThinkingAtom = atom(false);
