// NameInputModal.tsx — Compact name input dialog matching the context menu's "Name Component" design.
// Used for: naming components, keyframes, presets, etc.
// Portal to body, close on Escape/outside click, submit on Enter.
//
// Also exports `CompactModalShell` — the portal + backdrop + w-64 dialog +
// header chrome on its own, so sibling compact dialogs with different body
// content (e.g. `LinkedComponentModal`) share the exact same markup
// without duplicating it.

import { useState, useRef, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { trace } from '@/shared/debug-trace';

// ─── Shared compact modal shell ──────────────────────────────────────────────

interface CompactModalShellProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  /** Dialog body — callers render their own content container
   *  (e.g. `p-3 flex flex-col gap-3`) so padding/gap stay per-dialog. */
  children: ReactNode;
}

export function CompactModalShell({ isOpen, onClose, title, children }: CompactModalShellProps) {
  // Escape to close
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [isOpen, onClose]);

  // DID THIS PRESS START INSIDE THE DIALOG?
  //
  // A `click` fires on the nearest common ancestor of the mousedown and mouseup
  // targets — so if anything re-renders, re-mounts or reflows the button
  // between press and release, the click resolves on the BACKDROP and the
  // dismiss handler runs instead of the button's. That is exactly what the
  // Library panel's "Create Template" hit: mouse click dismissed the dialog
  // while Enter (which never involves a click target) worked (user report
  // 2026-08-08).
  //
  // The fix is the rule a dialog should follow anyway: a press that BEGAN
  // inside is never a dismiss, wherever it ends. That also makes text-selection
  // drags that run past the dialog edge stop closing it — same class of bug,
  // every dialog built on this shell.
  const pressStartedInside = useRef(false);

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <div
          className="fixed inset-0 flex items-center justify-center"
          style={{ zIndex: 99999 }}
          // Presses inside a modal must not reach document-level
          // outside-click listeners either — several editor surfaces close
          // themselves on any document mousedown, and this shell portals to
          // <body>, so without this it sits outside every one of their refs.
          // No preventDefault: the name input still has to take focus.
          onMouseDown={e => e.stopPropagation()}
          onPointerDown={e => e.stopPropagation()}
          onClick={() => {
            if (pressStartedInside.current) { pressStartedInside.current = false; return; }
            onClose();
          }}
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
            className="relative w-64 bg-[var(--bg-surface)] rounded-lg shadow-2xl"
            onMouseDown={() => { pressStartedInside.current = true; }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-light)]">
              <h3 className="text-xs font-bold text-[var(--text-primary)]">{title}</h3>
              <button
                onClick={onClose}
                className="p-1 hover:bg-[var(--bg-hover)] rounded-md transition-colors cursor-pointer"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-secondary)]">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

// ─── Name input modal ────────────────────────────────────────────────────────

interface NameInputModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
  title: string;
  /** Optional muted context line rendered under the title (e.g. drop counts). */
  description?: string;
  placeholder?: string;
  defaultValue?: string;
  submitLabel?: string;
  /** Validate name — return error string or null if valid */
  validate?: (name: string) => string | null;
  /**
   * Which accent the submit button wears.
   *  · `primary`   — the section accent (Pages / Plugins / Vectors).
   *  · `secondary` — the purple component-system accent. TEMPLATES share it:
   *    their folder icons and section visuals are purple everywhere else, so
   *    the modal has to match.
   *
   * Sets the FILL AND THE LABEL together. They used to be two independent
   * props with a doc-comment rule that a caller overriding one must override
   * the other — and every single call site broke it, leaving the near-black
   * `--accent-fg` label sitting on purple (user report 2026-08-08). A rule a
   * comment has to enforce is a rule that gets broken; one variant can't drift.
   */
  accent?: 'primary' | 'secondary';
  /** Escape hatch for a bespoke fill (destructive red, etc.). Prefer `accent`. */
  accentColor?: string;
  /** Escape hatch for a bespoke label colour. Prefer `accent`. */
  accentFg?: string;
}

export default function NameInputModal({
  isOpen, onClose, onSubmit, title,
  description,
  placeholder = 'Enter name...', defaultValue = '',
  submitLabel = 'Create Component',
  validate,
  accent = 'primary',
  accentColor,
  accentFg,
}: NameInputModalProps) {
  const isSecondary = accent === 'secondary';
  const fill = accentColor ?? (isSecondary ? 'var(--accent-secondary, #9a66ff)' : 'var(--accent, #3388ff)');
  const fg = accentFg ?? (isSecondary ? 'var(--accent-secondary-fg, #ffffff)' : 'var(--accent-fg)');
  const [value, setValue] = useState(defaultValue);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset + focus on open
  useEffect(() => {
    if (isOpen) {
      setValue(defaultValue);
      setError(null);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [isOpen, defaultValue]);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed) { setError('Name is required'); return; }
    if (validate) {
      const err = validate(trimmed);
      if (err) { setError(err); return; }
    }
    trace.action('name-input-modal:submit', { title, name: trimmed });
    onSubmit(trimmed);
    onClose();
  };

  return (
    <CompactModalShell isOpen={isOpen} onClose={onClose} title={title}>
      {/* Content */}
      <div
        className="p-3 flex flex-col gap-3"
        // Published as vars so every child (the input's focus ring, not just the
        // button) picks up the same accent — "accent-secondary with white text"
        // is a property of the whole dialog, not of one control.
        style={{ ['--modal-accent' as string]: fill, ['--modal-accent-fg' as string]: fg } as React.CSSProperties}
      >
        {description && (
          <p className="-mt-1 text-[11px] leading-snug text-[var(--text-tertiary)]">{description}</p>
        )}
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={e => { setValue(e.target.value); setError(null); }}
          onKeyDown={e => { if (e.key === 'Enter' && value.trim()) handleSubmit(); }}
          onFocus={e => e.target.select()}
          placeholder={placeholder}
          className="w-full h-[var(--control-height)] px-3 text-xs bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] focus:border-[var(--modal-accent)] text-[var(--text-primary)] rounded-[var(--radius-lg)] focus:outline-none transition-colors"
        />
        {error && <span className="text-[10px] text-red-400 -mt-1">{error}</span>}
        <button
          onClick={handleSubmit}
          disabled={!value.trim()}
          className="w-full h-8 text-xs font-medium rounded-[var(--radius-lg)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 cursor-pointer"
          style={{ backgroundColor: fill, color: fg }}
        >
          {submitLabel}
        </button>
      </div>
    </CompactModalShell>
  );
}
