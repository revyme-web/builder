// left-panel-store.ts — Jotai atom for left panel open/close state.
// The panel can never be fully closed — it falls back to DEFAULT_LEFT_PANEL.

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

/** The HOME panel: what the builder opens on, and what "close" falls back to.
 *  Layers, not Pages — it is what you reach for on almost every edit, while
 *  Pages is a navigation action taken once per session.
 *
 *  Named rather than inlined because "the home panel" and "the Pages panel" are
 *  no longer the same value: several call sites navigate to Pages DELIBERATELY
 *  (the page + component breadcrumbs) and must keep doing that. Only the
 *  fall-back-to-home sites follow this constant. */
export const DEFAULT_LEFT_PANEL: LeftPanelId = 'layers';

/** Which left panel is currently open. Never null. */
export const leftPanelAtom = atom<LeftPanelId>(DEFAULT_LEFT_PANEL);

/** Whether the floating code editor popup is open. */
export const codeEditorOpenAtom = atom(false);

/** Derived write atom: clicking the active panel falls back to the home panel
 *  instead of closing. */
export const togglePanelAtom = atom(
  (get) => get(leftPanelAtom),
  (get, set, panelId: LeftPanelId) => {
    const current = get(leftPanelAtom);
    // If clicking the already-active panel, go home (never close)
    const next = current === panelId ? DEFAULT_LEFT_PANEL : panelId;
    trace.action('left-panel:toggle', { from: current, to: next });
    set(leftPanelAtom, next);
  },
);
