// palette-store.ts — Cross-layer atoms for the bottom-toolbar cmd+K command
// palette. The open flag + query live here (code/stores) because canvas
// shortcuts toggle them; the palette's editor-internal atoms (filter tab,
// result list, selected index) stay in editor/command-palette/palette-store.ts.

import { atom } from 'jotai';

/** Whether the palette is currently visible. */
export const paletteOpenAtom = atom(false);

/** Free-text query the user is typing. Debounce reads downstream. */
export const paletteQueryAtom = atom('');
