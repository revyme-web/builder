// borderradius-store.ts — Atoms for fancy border-radius overlay communication.
// Same pattern as clippath-store: tool sets data + callback, overlay reads + drags.

import { atom } from 'jotai';
import type { FancyRadiusData } from '@/shared/border-radius-utils';

/** Active fancy radius data — null means overlay is hidden */
export const activeFancyRadiusAtom = atom<FancyRadiusData | null>(null);

/** Live-update callback fired on every drag pointermove. Should be DOM-only
 *  (no mutation queue) so the renderer's patchElement doesn't race with the
 *  in-flight drag and overwrite the inline style with a stale parsed value. */
export const fancyRadiusCallbackAtom = atom<((data: FancyRadiusData) => void) | null>(null);

/** Commit callback fired once on drag end. This is where the final value goes
 *  through the mutation queue / code generator / parser. */
export const fancyRadiusCommitAtom = atom<((data: FancyRadiusData) => void) | null>(null);
