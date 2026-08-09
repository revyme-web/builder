// left-panel-store.ts — Jotai atoms for WHERE THE USER IS in the editor chrome:
// which left panel is open, and whether a full-screen overlay is covering the
// canvas. The panel can never be fully closed — it falls back to
// DEFAULT_LEFT_PANEL.

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

/** Manage Translations overlay open?
 *
 *  Write-through: OPENING also selects the locale panel in the left menu — the
 *  overlay may only exist while the globe is the active panel (CMS-panel
 *  parity; App.tsx closes it when the panel changes away), so openers from
 *  elsewhere (LocalePropPill, LocaleStylePopup) must carry the panel along or
 *  the close-on-switch effect would immediately dismiss them.
 *
 *  Lives HERE rather than in LocalePanel.tsx because undo/redo restore it (see
 *  `UiLocation` in mutation/history.ts), and the canvas may not import an
 *  editor panel component to read one atom. */
const _translationsOverlayOpenAtom = atom(false);
export const translationsOverlayOpenAtom = atom(
  (get) => get(_translationsOverlayOpenAtom),
  (get, set, open: boolean) => {
    set(_translationsOverlayOpenAtom, open);
    if (open) set(leftPanelAtom, 'locale');
    trace.action('locale:translations-overlay', { open });
  },
);
