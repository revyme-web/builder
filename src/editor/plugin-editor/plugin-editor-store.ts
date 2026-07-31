// editor/plugin-editor/plugin-editor-store.ts — open-state atom for the editor.
//
// One atom: `pluginEditorFileAtom`. Null means the editor isn't
// showing; set to a `plugins/{Name}.tsx` path mounts the editor over
// everything else. App.tsx watches this atom and renders the
// `<PluginEditor />` overlay when it's non-null.
//
// Mirrors `componentEditorFileAtom` for code components — same
// pattern, separate atom because the two editors mount independently.

import { atom } from 'jotai';

export const pluginEditorFileAtom = atom<string | null>(null);
