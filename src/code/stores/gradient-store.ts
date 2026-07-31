// gradient-store.ts — Shared state for active gradient editing.
// When gradient fill tab is open, these atoms hold the gradient data
// so the canvas overlay can render gradient handles + stops.

import { atom } from 'jotai';
import type { GradientData } from '@/shared/gradient-utils';

/** Active gradient being edited, or null when not editing */
export const activeGradientAtom = atom<GradientData | null>(null);

/** Currently selected stop ID in the gradient editor */
export const selectedGradientStopAtom = atom<string | null>(null);

/** Callback to update gradient data from the overlay handles */
export const gradientUpdateCallbackAtom = atom<((data: Partial<GradientData>) => void) | null>(null);

/** Callback to update a specific stop's position from overlay drag */
export const gradientStopUpdateCallbackAtom = atom<((id: string, position: number) => void) | null>(null);

/** Callback to select a stop from overlay click */
export const gradientStopSelectCallbackAtom = atom<((id: string) => void) | null>(null);

/** Commit callback — fired ONCE when an overlay handle drag ends (pointerup).
 *  The per-frame update callbacks above only LIVE-PATCH the canvas DOM (fast,
 *  no code mutation); this writes the final value to code on release. Mirrors
 *  the clip-path / fancy-radius overlays' `onCommit`. */
export const gradientCommitCallbackAtom = atom<(() => void) | null>(null);

/** Whether the active gradient is a mask (renders stop circles with visible grey fills) */
export const isMaskGradientAtom = atom<boolean>(false);
