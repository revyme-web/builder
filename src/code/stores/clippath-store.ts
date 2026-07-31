// clippath-store.ts — Jotai atoms for clip-path overlay communication.
// Same pattern as gradient-store.ts: data atom + callback atoms.

import { atom } from 'jotai';
import type { ClipPathData } from '@/shared/clippath-utils';

/** The clip-path data currently being edited. null = overlay hidden. */
export const activeClipPathAtom = atom<ClipPathData | null>(null);

/**
 * LIVE update callback — fires on every drag pointermove. Should be DOM-only
 * (no mutation queue). Updates the editor's local state + patches inline style
 * on the iframe element. NO parser run, NO renderer cycle — the renderer
 * would otherwise overwrite the inline value with a stale parsed value on the
 * next pointermove and the overlay would oscillate.
 */
export const clipPathUpdateCallbackAtom = atom<((data: ClipPathData) => void) | null>(null);

/**
 * COMMIT callback — fires once on drag pointerup. This is the only write that
 * goes through the mutation queue / code generator.
 */
export const clipPathCommitCallbackAtom = atom<((data: ClipPathData) => void) | null>(null);
