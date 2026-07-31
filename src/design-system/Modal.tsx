// Modal.tsx — Centralized modal shell matching the builder's design system.
// Portal to body, animated backdrop + panel (framer-motion), close on Escape.
// Design reference: builder/CollaboratorsModal.tsx

import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { trace } from '@/shared/debug-trace';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Modal panel width (default 384px = max-w-sm) */
  width?: number;
  /** Optional element rendered in the header, to the LEFT of the × close button (e.g. a "+" add button). */
  headerAction?: ReactNode;
  /** Hide the × close button (modal still closes via Escape / backdrop click). */
  hideClose?: boolean;
}

export default function Modal({ isOpen, onClose, title, children, width = 384, headerAction, hideClose }: ModalProps) {
  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', handleKey, true);
    trace.action('modal:open', { title });
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [isOpen, onClose, title]);

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        /* z-index sits ABOVE ToolPopup (100001) so modals opened from a
           tool popup — e.g. the Fill > Image > "Choose Image" media
           picker — render in front of the popup that triggered them
           instead of disappearing behind it. Stays below ContextMenu
           (1000001) which is meant to override everything. */
        // `data-modal-root` is the marker the canvas KeyboardManager
        // checks to disable ALL shortcuts while a modal is open — a
        // single querySelector hit is enough to swallow Enter, Delete,
        // arrow nudges, etc. that would otherwise leak through and run
        // canvas commands (e.g. "select children") in addition to the
        // user's modal interaction. See `isEditingText` in
        // `canvas/KeyboardManager.ts`.
        <div
          data-modal-root
          className="fixed inset-0 flex items-center justify-center"
          style={{ zIndex: 100010 }}
          // React dispatches synthetic events along the REACT tree, not the DOM tree — so even though
          // this modal is portaled to <body>, a mousedown/pointerdown inside it bubbles (via React) to
          // the Canvas's onMouseDown and would deselect / hit-test the canvas BEHIND the modal. Stop
          // pointer-down events at the modal root so canvas interaction never fires while a modal is up.
          // (onClick still bubbles on the backdrop → onClose; the panel stops its own click.)
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          // Same reason for RIGHT-CLICK: a contextmenu inside the modal bubbles (via React) to the
          // Canvas's onContextMenu and opens the CANVAS context menu (Make Component / Cut / …) on top
          // of the modal. Stop it here. We DON'T preventDefault, so text inputs keep their native
          // cut/copy/paste menu and any in-modal row menu still opens from its own handler.
          onContextMenu={(e) => e.stopPropagation()}
        >
          {/* Backdrop — dims AND blurs everything behind (the canvas iframe included; backdrop-filter
              blurs whatever is painted behind it). Inline `backdropFilter` so it can't be missed by a
              Tailwind purge. Clicking it closes the modal. */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 bg-black/50"
            style={{ backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)' }}
            onClick={onClose}
          />

          {/* Panel */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className="relative rounded-lg shadow-2xl overflow-hidden bg-[var(--bg-surface)] flex flex-col max-h-[80vh]"
            style={{ width }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-light)] shrink-0">
              <h3 className="text-xs font-bold text-[var(--text-primary)]">{title}</h3>
              <div className="flex items-center gap-1">
                {headerAction}
                {!hideClose && (
                  <button
                    onClick={onClose}
                    className="p-1 hover:bg-[var(--bg-hover)] rounded-md transition-colors cursor-pointer"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-secondary)]">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto">
              {children}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
