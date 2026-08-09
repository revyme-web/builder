// KeyboardManager.ts — Centralized keyboard shortcut system.
// All shortcuts registered here. Organized by category.
// Suppresses shortcuts during text editing (input, textarea, contentEditable, TipTap).
//
// Usage: call registerShortcuts() once on mount, cleanup on unmount.
// Each shortcut is { key, modifiers, handler, label }.
// New shortcuts added by calling keyboard.register().

import { trace } from '@/shared/debug-trace';
import { isViewerMode } from '@/code/stores/viewer-mode-store';

/** Shortcut categories that stay live in view-only mode. Everything
 *  else (tools, edit, selection, general) is a write/edit action and
 *  gets swallowed for viewers. Ctrl+P preview is NOT here — it runs on
 *  a separate window listener in App.tsx, not through this manager. */
const VIEWER_ALLOWED_CATEGORIES = new Set(['zoom', 'navigation']);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ShortcutSpec {
  /** Key to match (lowercase). Use e.key values: 'f', 'escape', 'delete', '+', '-', etc. */
  key: string | string[];
  /** Required modifier keys. Omitted = must NOT be pressed. */
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Human-readable label for help/tooltips */
  label?: string;
  /** Category for organization */
  category?: string;
  /** Omit this registration from the Keyboard Shortcuts help modal — for
   *  sibling registrations of one logical shortcut (e.g. the four arrow
   *  directions of a nudge step register separately; only one row shows). */
  hideFromHelp?: boolean;
  /** Display override for the KEY chips in the help modal (modifiers still
   *  derive from the spec). E.g. the nudge row shows ['↑','↓','←','→']. */
  helpKeys?: string[];
  /** Opt this shortcut into view-only mode even when its category is
   *  not viewer-allowed. Used for the cursor / hand tools — viewers can
   *  still select nodes for inspection and pan the canvas. */
  viewerAllowed?: boolean;
  /** Handler — called when shortcut matches */
  handler: () => void;
  /** Skip auto-repeat (default true — most shortcuts shouldn't repeat) */
  allowRepeat?: boolean;
}

// ─── Editing Detection ──────────────────────────────────────────────────────

function isEditingText(eventTarget?: EventTarget | null): boolean {
  // Check the event's original target FIRST — this matters when an
  // input's own onKeyDown unmounts itself (e.g. VariableModal's name
  // input handles Enter by calling handleCreate, which closes the
  // modal). The SAME Enter event keeps bubbling to the window
  // listener, but by then `document.activeElement` has fallen back to
  // <body> and `isEditingText` would falsely return false — letting
  // the canvas's Enter shortcut ("select children") fire as a
  // collateral effect of confirming the modal. The original target is
  // still the now-detached input, so checking it first catches the
  // case correctly.
  const targets: (HTMLElement | null)[] = [
    eventTarget as HTMLElement | null,
    document.activeElement as HTMLElement | null,
  ];

  for (const el of targets) {
    if (!el) continue;

    // Standard TEXT inputs only. A focused <select> is intentionally NOT
    // treated as "editing text": you can't type into it in a way that
    // conflicts with editor shortcuts, and selects in the properties panel
    // keep focus after use — which was silently swallowing every canvas
    // shortcut (cmd+Z, etc.) until the user clicked elsewhere to blur it.
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true;

    // ContentEditable (TipTap, ProseMirror, etc.)
    if (el.isContentEditable) return true;
    if (el.closest && el.closest('.ProseMirror')) return true;

    // Monaco code editor (uses a hidden textarea inside .monaco-editor)
    if (el.closest && el.closest('.monaco-editor')) return true;

    // Any focused element inside a modal/overlay/popup that captures keyboard
    if (el.closest && el.closest('[data-code-editor]')) return true;
  }

  // Any modal mounted in the DOM (design-system Modal sets
  // `data-modal-root` on its portal container). When ANY modal is up
  // the canvas should never receive shortcuts — closing the modal
  // shouldn't double-fire the keystroke as a canvas action. This is
  // the broader sibling to the per-target check above: catches the
  // case where the event target is something neutral (a Cancel
  // button, the modal backdrop) but the user is clearly interacting
  // with the modal, not the canvas.
  if (document.querySelector('[data-modal-root]')) return true;

  return false;
}

/** Marks a surface whose text fields still hand UNDO/REDO to the app.
 *
 *  A plain value field (a translation cell, a properties-panel input) commits
 *  on blur/Enter and holds a local draft in React state, so the browser's own
 *  textarea undo would roll the DOM back behind that draft and desync it —
 *  while the change the user actually wants to take back is the committed one,
 *  which only the project history knows about. A real text EDITOR (TipTap,
 *  Monaco) is the opposite: its undo is the meaningful one, so those surfaces
 *  never carry this and keep the early return below.
 *
 *  Opt-in per surface rather than global: the guard exists because canvas
 *  shortcuts must not fire mid-typing, and that is still true for everything
 *  except undo/redo. */
function allowsAppUndo(eventTarget?: EventTarget | null): boolean {
  for (const el of [eventTarget as HTMLElement | null, document.activeElement as HTMLElement | null]) {
    if (el?.closest?.('[data-app-undo]')) return true;
  }
  return false;
}

/** Cmd/Ctrl+Z, Cmd+Shift+Z, Cmd+Y. */
function isUndoRedoCombo(e: KeyboardEvent): boolean {
  if (!e.metaKey && !e.ctrlKey) return false;
  const k = e.key.toLowerCase();
  return k === 'z' || k === 'y';
}

// ─── Manager ────────────────────────────────────────────────────────────────

class KeyboardManager {
  private shortcuts: ShortcutSpec[] = [];
  private keyUpHandlers: Map<string, () => void> = new Map();
  private boundKeyDown: ((e: KeyboardEvent) => void) | null = null;
  private boundKeyUp: ((e: KeyboardEvent) => void) | null = null;

  /** Register a shortcut. Returns unregister function. */
  register(spec: ShortcutSpec): () => void {
    this.shortcuts.push(spec);
    return () => {
      this.shortcuts = this.shortcuts.filter(s => s !== spec);
    };
  }

  /** Register a key-up handler (for hold-to-activate like Space). */
  registerKeyUp(key: string, handler: () => void): () => void {
    this.keyUpHandlers.set(key.toLowerCase(), handler);
    return () => { this.keyUpHandlers.delete(key.toLowerCase()); };
  }

  /** Start listening. Call once on mount. Returns cleanup function. */
  listen(): () => void {
    this.boundKeyDown = this.handleKeyDown.bind(this);
    this.boundKeyUp = this.handleKeyUp.bind(this);
    window.addEventListener('keydown', this.boundKeyDown);
    window.addEventListener('keyup', this.boundKeyUp);
    trace.action('keyboard:listen');
    return () => {
      if (this.boundKeyDown) window.removeEventListener('keydown', this.boundKeyDown);
      if (this.boundKeyUp) window.removeEventListener('keyup', this.boundKeyUp);
    };
  }

  /** Get all registered shortcuts (for help menu/tooltips) */
  getAll(): ShortcutSpec[] {
    return [...this.shortcuts];
  }

  private handleKeyDown(e: KeyboardEvent): void {
    // Skip during text editing — only allow Escape. Pass the event
    // target so the check catches keystrokes whose origin was an
    // input that has already been unmounted by its own handler (the
    // typical Enter-confirms-modal flow — see `isEditingText`).
    if (isEditingText(e.target)) {
      if (e.key === 'Escape') {
        // Let Escape through for text commit
      } else if (isUndoRedoCombo(e) && allowsAppUndo(e.target)) {
        // Let project undo/redo through — see `allowsAppUndo`.
      } else {
        return;
      }
    }

    const keyLower = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    const alt = e.altKey;
    // macOS composes Option/Alt+letter into a symbol (Option+R → "®", Shift+
    // Option+A → "Å"), so a pure-Alt shortcut's e.key never matches its letter.
    // When Alt is held, fall back to the PHYSICAL key from e.code ("KeyR" → "r",
    // "Digit1" → "1") so Alt-letter shortcuts (Rename Alt+R, Create Frame
    // Shift+Alt+A) fire on Mac. Only computed under Alt, so normal (non-Alt)
    // shortcuts keep their exact e.key matching on every layout.
    const altCodeKey = !alt ? null
      : /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase()
      : /^Digit\d$/.test(e.code) ? e.code.slice(5)
      : null;

    for (const spec of this.shortcuts) {
      // Match key (e.key, or the Alt physical-key fallback for macOS)
      const keys = Array.isArray(spec.key) ? spec.key : [spec.key];
      if (!keys.some(k => { const kl = k.toLowerCase(); return kl === keyLower || (altCodeKey !== null && kl === altCodeKey); })) continue;

      // Match modifiers (undefined = must NOT be pressed)
      if ((spec.ctrl ?? false) !== ctrl) continue;
      if ((spec.shift ?? false) !== shift) continue;
      if ((spec.alt ?? false) !== alt) continue;

      // Skip auto-repeat unless explicitly allowed
      if (e.repeat && !(spec.allowRepeat ?? false)) continue;

      e.preventDefault();
      e.stopPropagation();

      // View-only gate. A matched shortcut still gets its key swallowed
      // (preventDefault above) so the browser default doesn't leak
      // through, but the handler only runs for zoom / navigation
      // shortcuts. Everything else (tools, undo/redo, delete, paste,
      // selection, …) is a no-op for viewers.
      if (isViewerMode() && !spec.viewerAllowed && !VIEWER_ALLOWED_CATEGORIES.has(spec.category ?? '')) {
        trace.action('keyboard:shortcut-blocked-viewer', { key: keyLower, label: spec.label });
        return;
      }

      trace.action('keyboard:shortcut', { key: keyLower, ctrl, shift, alt, label: spec.label });
      spec.handler();
      return;
    }
  }

  private handleKeyUp(e: KeyboardEvent): void {
    const keyLower = e.key.toLowerCase();
    const handler = this.keyUpHandlers.get(keyLower);
    if (handler) handler();
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

export const keyboard = new KeyboardManager();
