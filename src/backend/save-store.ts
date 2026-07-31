// save-store.ts — Jotai atom for the current save status.

import { atom } from 'jotai';

export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'error';

export const saveStatusAtom = atom<SaveStatus>('saved');
