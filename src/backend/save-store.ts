// save-store.ts — Jotai atom for the current save status.

import { atom } from 'jotai';

/** `conflict` — the backend refused the save because another tab or device
 *  saved a newer version since this tab's copy was loaded (see
 *  save-revision.ts). Saving stops until the user reloads or overwrites. */
export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'error' | 'conflict';

export const saveStatusAtom = atom<SaveStatus>('saved');

/** The last save failure's message, for the banner. Null after a success. */
export const saveErrorAtom = atom<string | null>(null);
