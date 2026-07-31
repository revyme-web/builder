// LibraryPanel jotai atoms. Extracted as part of the LibraryPanel folder split.

import { atom } from 'jotai';

// Library-panel-internal drag target (folder id under the cursor while
// a component-row drag is in flight). Atom-driven so `UserFolder` can
// subscribe to render its hover highlight without prop drilling. Set
// from the component-row drag handler on each pointermove tick;
// cleared on drag end. NOT used for the canvas drag — only for "drop
// component into folder" reorganization within the panel.
export const libraryDragHoverFolderIdAtom = atom<string | null>(null);
