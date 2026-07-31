// left-panel-store.ts — Jotai atom for left panel open/close state.
// Panel can never be fully closed — defaults to 'pages-layers'.

import { atom } from 'jotai';
import { trace } from '@/shared/debug-trace';

export type LeftPanelId =
  | 'insert'
  | 'pages-layers'  // Pages tab (file explorer). ID kept for back-compat — old
                    // combined Pages+Layers panel; the Layers tree split into
                    // its own `'layers'` tab below.
  | 'layers'        // Layers tree (selected file's node hierarchy).
  | 'library'
  | 'presets'
  | 'media'
  | 'locale'
  | 'cms'
  | 'vibe';         // VIBE AI chat (docked). Has no PANEL_MAP entry — the chat
                    // component renders its own self-positioned panel overlay
                    // when this is active. See LeftPanel.tsx / VibeDockShell.

/** Which left panel is currently open. Defaults to pages-layers, never null. */
export const leftPanelAtom = atom<LeftPanelId>('pages-layers');

/** Whether the floating code editor popup is open. */
export const codeEditorOpenAtom = atom(false);

/** Derived write atom: clicking active panel falls back to pages-layers instead of closing. */
export const togglePanelAtom = atom(
  (get) => get(leftPanelAtom),
  (get, set, panelId: LeftPanelId) => {
    const current = get(leftPanelAtom);
    // If clicking the already-active panel, go back to pages-layers (never close)
    const next = current === panelId ? 'pages-layers' : panelId;
    trace.action('left-panel:toggle', { from: current, to: next });
    set(leftPanelAtom, next);
  },
);
