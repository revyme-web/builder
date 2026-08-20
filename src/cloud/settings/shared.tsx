// shared.tsx — Shared UI pieces for the cloud settings sections
// (Backups / Staging / A/B tests / Plans).
//
// Extracted from the per-section confirm modals and row "Actions" menus so
// the common markup lives in exactly one place. Everything here is
// parameterized to reproduce each call site's original DOM byte-for-byte —
// pass the documented overrides instead of editing the defaults.
//
// NOTE: this intentionally does NOT reuse the editor overlay's
// `ConfirmModal` (src/editor/overlays/settings-shared.tsx) — that one owns
// its footer buttons (fixed message string, auto "-ing…" running label),
// while these sections need per-modal footers (sigmoid progress fill,
// spinner, danger/accent variants, custom running labels).

import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import DropdownMenu, { type DropdownMenuEntry } from '@/design-system/DropdownMenu';

// ─── Escape-to-close ───────────────────────────────────────────────────────

/** Escape closes the modal — but only while NOT locked (in-flight), so the
 *  user can't bail mid-request and end up in a weird state. Capture phase
 *  + stopPropagation so the editor's own Escape handling never sees the
 *  keypress while a settings modal is up. */
export function useEscapeToClose(active: boolean, locked: boolean, onCancel: () => void) {
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !locked) {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [active, locked, onCancel]);
}

// ─── Confirm modal shell ───────────────────────────────────────────────────

/** Default × close-button class (header, top-right). A/B tests passes its
 *  own shorter variant (no transition-colors / disabled cursor). */
const MODAL_CLOSE_BUTTON_CLASS =
  'p-1 hover:bg-[var(--bg-hover)] cut-corners transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed';

interface ConfirmModalShellProps {
  /** Render the overlay + dialog. The portal stays mounted while false so
   *  AnimatePresence can play the exit animation (Backups' restore modal
   *  relies on this; sections that early-return null before rendering the
   *  shell simply never see an exit — same as their original markup). */
  open: boolean;
  /** In-flight lock: disables backdrop click-to-close and the × button. */
  locked: boolean;
  onCancel: () => void;
  title: React.ReactNode;
  /** Dialog width classes. 'w-80' (compact, NameInputModal-style) by
   *  default; Staging + Plans use 'w-[420px] max-w-[calc(100vw-2rem)]'. */
  widthClassName?: string;
  closeButtonClassName?: string;
  /** Body content — rendered inside the `p-3 flex flex-col gap-3`
   *  container (body text + the two-button footer row). */
  children: React.ReactNode;
}

/** Shared confirm-dialog shell: portal → AnimatePresence → backdrop +
 *  compact dialog with header (title + × close) and a `p-3` body. The
 *  footer buttons stay at the call sites — they genuinely differ per
 *  modal (progress fill, spinner, danger/accent, label formats). */
export function ConfirmModalShell({
  open,
  locked,
  onCancel,
  title,
  widthClassName = 'w-80',
  closeButtonClassName = MODAL_CLOSE_BUTTON_CLASS,
  children,
}: ConfirmModalShellProps) {
  return createPortal(
    <AnimatePresence>
      {open && (
        <div
          className="fixed inset-0 flex items-center justify-center"
          style={{ zIndex: 99999 }}
          onClick={locked ? undefined : onCancel}
        >
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 bg-black/40"
          />
          {/* Dialog */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className={`relative ${widthClassName} bg-[var(--bg-surface)] cut-corners cut-lg shadow-2xl`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-light)]">
              <h3 className="text-xs font-bold text-[var(--text-primary)]">{title}</h3>
              <button onClick={onCancel} disabled={locked} className={closeButtonClassName}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-secondary)]">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            {/* Content */}
            <div className="p-3 flex flex-col gap-3">
              {children}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

// ─── Footer cancel button ──────────────────────────────────────────────────

const MODAL_CANCEL_BUTTON_CLASS =
  'flex-1 h-8 text-xs font-medium text-[var(--text-primary)] bg-[var(--grid-line)] hover:bg-[var(--bg-hover)] cut-corners transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer';

/** The left "Cancel" footer button — identical across the confirm modals
 *  (A/B tests overrides `className` with its shorter class string). */
export function ModalCancelButton({
  onClick,
  disabled,
  className = MODAL_CANCEL_BUTTON_CLASS,
  children = 'Cancel',
}: {
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <button onClick={onClick} disabled={disabled} className={className}>
      {children}
    </button>
  );
}

// ─── Row "Actions" dropdown ────────────────────────────────────────────────
//
// Trigger button + items wired up to the shared design-system
// `DropdownMenu` (same component MenuTabs / LogoMenu / PagesPanel use).
// Portals to document.body so it never gets clipped by the settings
// overlay or the row's own scroll context. `hoverStyle="accent"` matches
// the LeftHeader menu tabs (File / Edit / Insert / View).

interface RowActionsMenuProps {
  items: DropdownMenuEntry[];
  isOpen: boolean;
  disabled: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** Backups dims its disabled trigger to opacity-50; Staging + A/B tests
   *  use opacity-60. Both literals kept verbatim for the Tailwind scanner. */
  disabledOpacity?: '50' | '60';
}

export function RowActionsMenu({ items, isOpen, disabled, onToggle, onClose, disabledOpacity = '60' }: RowActionsMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={onToggle}
        disabled={disabled}
        className={`inline-flex items-center justify-center gap-1 w-[110px] h-[30px] text-xs font-medium bg-neutral-800 dark:bg-white/10 hover:bg-neutral-700 dark:hover:bg-white/20 text-white cut-corners cursor-pointer ${
          disabledOpacity === '50' ? 'disabled:opacity-50' : 'disabled:opacity-60'
        } disabled:cursor-not-allowed`}
      >
        Actions
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <DropdownMenu
        isOpen={isOpen}
        onClose={onClose}
        items={items}
        anchorRef={triggerRef}
        position="bottom-right"
        minWidth={200}
        hoverStyle="accent"
      />
    </>
  );
}
