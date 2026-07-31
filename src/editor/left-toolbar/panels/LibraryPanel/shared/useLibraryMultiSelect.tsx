// useLibraryMultiSelect.tsx — Shared shift-click multi-select + bulk-delete
// flow for every Library panel section (Components, Vectors,
// Templates, …). Mirrors the FileExplorer Pages-panel implementation so
// the UX is identical across both surfaces.
//
// Each section instantiates the hook once, wires the row's click handler
// to `togglePath` on shift+click (falling back to the normal navigate /
// select action otherwise), reads `isMultiSelected(path)` to draw the
// accent outline, and renders the returned `bulkDeleteModal` somewhere
// in its tree to surface the design-system Confirm modal.
//
// Keyboard wiring is centralised here: while any path is selected, a
// document-level keydown listener watches for Delete / Backspace and
// opens the confirmation. We skip the keystroke when focus is in an
// input / textarea / contenteditable (renaming flows) so typing a name
// can't accidentally nuke a multi-select.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Modal from '@/design-system/Modal';
import { trace } from '@/shared/debug-trace';

interface Options {
  /** Human-readable label of the things being deleted ("components",
   *  "vectors", "templates"). Used in the modal title +
   *  message so each section reads naturally. */
  itemLabel: string;
  /** Map a stored path / id to its display name. Used in the modal
   *  preview ("Foo, Bar, Baz + 2 more"). */
  getDisplayName: (path: string) => string;
  /** Runs the per-path delete. Called once per path on confirm. Caller
   *  owns the actual mutation (registry calls, file deletes, etc.). */
  onDelete: (path: string) => void | Promise<void>;
}

export interface LibraryMultiSelect {
  /** True when this path is part of the active multi-select set.
   *  Rows pass their own path to render the accent outline. */
  isMultiSelected: (path: string) => boolean;
  /** Number of currently picked paths. Driver for the "Delete N items"
   *  menu-entry label and for hiding per-row menu items in bulk mode. */
  size: number;
  /** Shift+click handler — toggles a path in/out of the set. Must be
   *  called from a row's onClick when the event has `shiftKey` true. */
  togglePath: (path: string) => void;
  /** Clears the set. Sections call this from their normal single-row
   *  click path so non-shift clicks read as "back to single selection". */
  clearSelection: () => void;
  /** Open the confirmation modal for the current selection. Wires the
   *  per-row ⋯ menu's "Delete N items" entry to the same flow as the
   *  Delete-key shortcut. */
  requestBulkDelete: () => void;
  /** Render this somewhere in your section tree so the Confirm modal
   *  has a portal mount point. Already includes all the modal copy. */
  bulkDeleteModal: React.ReactElement;
}

export function useLibraryMultiSelect({
  itemLabel,
  getDisplayName,
  onDelete,
}: Options): LibraryMultiSelect {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Pending confirm — null when the modal is closed. Holds the SNAPSHOT
  // of paths to delete so the user can shift-click further while the
  // modal is open without changing what's about to be removed.
  const [pending, setPending] = useState<{ paths: string[]; names: string[] } | null>(null);

  const togglePath = useCallback((path: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      trace.action('library-multi-select:toggle', { itemLabel, path, total: next.size });
      return next;
    });
  }, [itemLabel]);

  const clearSelection = useCallback(() => {
    setSelected(prev => (prev.size === 0 ? prev : new Set()));
  }, []);

  const requestBulkDelete = useCallback(() => {
    if (selected.size === 0) return;
    const paths = [...selected];
    setPending({ paths, names: paths.map(getDisplayName) });
    trace.action('library-multi-select:request-delete', { itemLabel, count: paths.length });
  }, [selected, getDisplayName, itemLabel]);

  // Delete / Backspace shortcut. Same gates as FileExplorer's Pages
  // panel — skip when focus is in an input / textarea / contenteditable
  // so inline renames don't trigger a bulk wipe on every Backspace.
  useEffect(() => {
    if (selected.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable) return;
      }
      e.preventDefault();
      requestBulkDelete();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected.size, requestBulkDelete]);

  const isMultiSelected = useCallback(
    (path: string) => selected.has(path),
    [selected],
  );

  const bulkDeleteModal = useMemo(() => (
    <Modal
      isOpen={!!pending}
      onClose={() => setPending(null)}
      title={pending ? `Delete ${pending.paths.length} ${itemLabel}?` : ''}
      width={256}
    >
      <div className="px-3 py-3 flex flex-col gap-3">
        <p className="text-xs text-[var(--text-primary)] leading-relaxed">
          {pending ? (() => {
            const preview = pending.names.slice(0, 4).join(', ');
            const extra = pending.names.length > 4 ? ` + ${pending.names.length - 4} more` : '';
            return `${preview}${extra}. This cannot be undone.`;
          })() : ''}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setPending(null)}
            className="flex-1 h-8 text-xs font-medium text-[var(--text-primary)] bg-[var(--btn-secondary-bg)] hover:bg-[var(--btn-secondary-bg-hover,var(--bg-hover))] rounded-[var(--radius-lg)] cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              if (!pending) return;
              const paths = pending.paths;
              setPending(null);
              setSelected(new Set());
              for (const p of paths) void onDelete(p);
              trace.action('library-multi-select:confirm-delete', { itemLabel, count: paths.length });
            }}
            className="flex-1 h-8 text-xs font-medium text-white bg-[var(--accent-danger,#dc2626)] hover:opacity-90 rounded-[var(--radius-lg)] cursor-pointer"
          >
            Delete
          </button>
        </div>
      </div>
    </Modal>
  ), [pending, itemLabel, onDelete]);

  return {
    isMultiSelected,
    size: selected.size,
    togglePath,
    clearSelection,
    requestBulkDelete,
    bulkDeleteModal,
  };
}
