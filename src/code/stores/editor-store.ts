// editor-store.ts — Cross-frame text-edit state.
//
// Before the iframe migration this held the live TipTap Editor instance for
// the parent's toolbar to read. The editor now lives in the sandbox iframe,
// so the parent only sees a snapshot pushed over postMessage on every TipTap
// transaction. The toolbar reads that snapshot via useTextStyles().

import { atom } from 'jotai';
import type { TextEditSnapshot } from '@/canvas-sandbox/protocol';
import { leftPanelAtom } from '@/code/stores/left-panel-store';

/** Backwards-compatible flat selection-styles type — used by callers that
 *  only need single uniform values, not the mixed-value shape. Populated
 *  from the snapshot's `marks` / `paragraph` / `highlight` uniform values. */
export interface SelectionStyles {
  fontSize?: string;
  fontWeight?: string;
  fontFamily?: string;
  color?: string;
  letterSpacing?: string;
  lineHeight?: string;
  textDecoration?: string;
  textTransform?: string;
  textAlign?: string;
  backgroundColor?: string;
  backgroundGradient?: string;
}

/** True while a text edit session is active (parent doesn't hold the editor
 *  itself anymore — that's in the sandbox). useTextStyles uses this to
 *  decide whether to read from the snapshot or from node styles. */
export const isTextEditingAtom = atom<boolean>(false);

/** True while a popup that triggers fast canvas mutations (like the font-
 *  family hover preview) is open. SelectionOverlay reads this and bails
 *  out so the user doesn't see the box border lagging behind the text
 *  metrics as they hover row to row. Reset to false when the popup
 *  closes. Owned by the popup that opens it — flip true on open,
 *  false on unmount. */
export const suppressSelectionOverlayAtom = atom<boolean>(false);

/** True while a ColorPicker is mounted (Fill solid color, a gradient stop, or
 *  any other color edit). SelectionOverlay reads this to hide ONLY the
 *  selection box + handles while a color/gradient is being edited — the
 *  gradient and clip-path EDITING overlays stay visible (otherwise the blue/
 *  purple selection chrome sits on top of the gradient handles you're dragging
 *  and you can't see what you're doing). Flipped on the picker's mount/unmount. */
export const colorPickerOpenAtom = atom<boolean>(false);

/** Whole-app preview mode flag. When true: PropertiesPanel /
 *  CommentsListPanel / BottomToolbar hide and the
 *  fullscreen `<PreviewOverlay>` mounts on top of the canvas.
 *  Toggled from three places: the right-header Preview button, the
 *  View → "Toggle preview" menu item, and the Ctrl+P shortcut. Lifted
 *  from `App.tsx` local state so the menu + shortcut can flip it
 *  without prop-drilling. */
export const previewModeAtom = atom<boolean>(false);

/** Optional override for the file the preview overlay should load.
 *  When non-null, `PreviewOverlay` previews this file in
 *  component-isolation mode instead of falling back to
 *  `activeFilePathAtom`. Set by the play-icon affordance on
 *  `CanvasNodeNameDisplay` (component instances on pages, variant
 *  roots on master files) so the user can preview a component
 *  standalone without first navigating their canvas into the master.
 *  Cleared on preview close so the next Play press uses the active
 *  file again. */
export const previewComponentFileOverrideAtom = atom<string | null>(null);

/** Most recent selection snapshot from the sandbox. Updated on every TipTap
 *  transaction. Null when not editing. */
export const textEditSnapshotAtom = atom<TextEditSnapshot | null>(null);

// ─── AI chat docking ─────────────────────────────────────────────────────────
//
// The AI chat lives in one of two places:
//   - DOCKED   — a panel in the left toolbar, opened by the VIBE icon
//                (`leftPanelAtom === 'vibe'`).
//   - DETACHED — the floating draggable `AIChatSheet` popup.
// `aiChatDetachedAtom` says which. The chat component (`PageChat` /
// `IconSetChat`) stays mounted across the swap, so detaching mid-generation
// loses nothing — only the surrounding chrome changes.

/** Open/closed state of the DETACHED floating chat popup. */
export const aiChatSheetOpenAtom = atom<boolean>(false);

/** Keyboard Shortcuts help modal (logo menu → View → Keyboard shortcuts).
 *  Rendered by KeyboardShortcutsModal, mounted in LeftHeader. */
export const shortcutsModalOpenAtom = atom<boolean>(false);

/** Export section (PropertiesPanel) expanded state — GLOBAL, not per node:
 *  one + click opens it for every selection until the − collapses it again.
 *  Deliberately session-only (plain atom, no storage) — closed on each load. */
export const exportSectionOpenAtom = atom<boolean>(false);

/** Right-header Export dropdown (format picker + "Export project" button).
 *
 *  Lifted out of RightHeader's local state so other surfaces can open it:
 *  File ▸ Export code… in the left-header menu points here rather than
 *  duplicating the dropdown or silently exporting a format the user never
 *  chose. Session-only — a reload should not restore an open dropdown. */
export const exportDropdownOpenAtom = atom<boolean>(false);

/** false = docked in the VIBE left panel, true = floating popup. */
export const aiChatDetachedAtom = atom<boolean>(false);

/** Detach the docked chat into the floating popup. The VIBE left-menu icon
 *  hides while detached (it has nothing to toggle). */
export const detachAiChatAtom = atom(null, (_get, set) => {
  set(aiChatDetachedAtom, true);
  set(aiChatSheetOpenAtom, true);
  // Free the left panel — close the docked VIBE panel back to the default.
  set(leftPanelAtom, 'pages-layers');
});

/** Close the detached popup. Returns to docked mode — the VIBE left-menu icon
 *  comes back — but does NOT open the docked panel: the left panel stays on
 *  whatever the user had (Pages, Layers, …). They reopen the chat via VIBE. */
export const dockAiChatAtom = atom(null, (_get, set) => {
  set(aiChatDetachedAtom, false);
  set(aiChatSheetOpenAtom, false);
});

// (The oracleMode A/B toggle lived here until 2026-07: the vibe chat now
// ALWAYS routes through the freeform+oracle pipeline — the model writes the
// WHOLE file, checkFile gates it, violations bounce until it passes. The
// page-agent / design-spec Vibe routes were retired with it.)

/** Vibe model select: OpenRouter slug chosen in the chat input row. Empty
 *  string = let the server pick its default. Persisted per browser. */
export const vibeModelAtom = atom<string>(
  typeof localStorage !== 'undefined' ? (localStorage.getItem('revyme.vibeModel') ?? '') : '',
);
export const setVibeModelAtom = atom(null, (_get, set, value: string) => {
  set(vibeModelAtom, value);
  try { localStorage.setItem('revyme.vibeModel', value); } catch { /* private mode */ }
});

function snapshotToFlat(snap: TextEditSnapshot | null): SelectionStyles {
  if (!snap) return {};
  const out: SelectionStyles = {};
  // Uniform mark values become single string values; mixed → omit so the
  // toolbar shows the empty / mixed state through useTextStyles.
  const m = snap.marks;
  if (m.fontSize?.value) out.fontSize = m.fontSize.value;
  if (m.fontWeight?.value) out.fontWeight = m.fontWeight.value;
  if (m.fontFamily?.value) out.fontFamily = m.fontFamily.value;
  if (m.color?.value) out.color = m.color.value;
  if (m.letterSpacing?.value) out.letterSpacing = m.letterSpacing.value;
  if (m.backgroundGradient?.value) out.backgroundGradient = m.backgroundGradient.value;
  const p = snap.paragraph;
  if (p.lineHeight?.value) out.lineHeight = p.lineHeight.value;
  if (p.textAlign?.value) out.textAlign = p.textAlign.value;
  if (p.textDecoration?.value) out.textDecoration = p.textDecoration.value;
  if (p.textTransform?.value) out.textTransform = p.textTransform.value;
  if (snap.highlight?.value) out.backgroundColor = snap.highlight.value;
  if (snap.cursorMode) {
    const ca = snap.cursorMarkAttrs;
    if (!out.fontSize && ca.fontSize) out.fontSize = ca.fontSize;
    if (!out.fontWeight && ca.fontWeight) out.fontWeight = ca.fontWeight;
    if (!out.fontFamily && ca.fontFamily) out.fontFamily = ca.fontFamily;
    if (!out.color && ca.color) out.color = ca.color;
    if (!out.letterSpacing && ca.letterSpacing) out.letterSpacing = ca.letterSpacing;
    if (!out.backgroundGradient && ca.backgroundGradient) out.backgroundGradient = ca.backgroundGradient;
    const cp = snap.cursorParagraphAttrs;
    if (!out.lineHeight && cp.lineHeight) out.lineHeight = cp.lineHeight;
    if (!out.textAlign && cp.textAlign) out.textAlign = cp.textAlign;
    if (!out.textDecoration && cp.textDecoration) out.textDecoration = cp.textDecoration;
    if (!out.textTransform && cp.textTransform) out.textTransform = cp.textTransform;
    if (!out.backgroundColor && snap.cursorHighlightAttr) out.backgroundColor = snap.cursorHighlightAttr;
  }
  return out;
}

/**
 * Flat selection-styles view used by the toolbar. Read derives from the
 * latest snapshot (mixed values omitted so the UI shows blank / mixed).
 * Write resets the snapshot — the only writes today are clear-on-cancel
 * (`setSelectionStyles({})`); any non-empty write is a no-op since the
 * source of truth is the snapshot.
 */
export const selectionStylesAtom = atom(
  (get) => snapshotToFlat(get(textEditSnapshotAtom)),
  (_get, set, value: SelectionStyles) => {
    if (Object.keys(value).length === 0) set(textEditSnapshotAtom, null);
    // Non-empty writes ignored — the iframe owns the snapshot now.
  },
);

// ─── Backwards-compat shim for code still importing activeEditorAtom ──────
//
// Old type: atom<Editor | null>. New code only ever checked it for
// truthiness ("is editing right now?"). The boolean is enough; callers that
// dereferenced editor methods are the ones we're rewriting in this same
// migration and will be updated.
export const activeEditorAtom = isTextEditingAtom;
