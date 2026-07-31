// ConfirmDialog.tsx — Centralized confirmation dialog.
//
// Matches the compact in-app confirm style used by the Pages-panel and
// Library-panel bulk-delete modals (FileExplorer.ConfirmDeleteModal,
// useLibraryMultiSelect). One width, one padding scale, side-by-side
// Cancel / action buttons — so every destructive confirm in the editor
// reads identically.
//
// Replaces an older `p-5 / w-360 / design-system Button` shell that
// was visually heavier than the rest of the editor's confirms (the
// "Delete Component" modal that prompted this rewrite).

import Modal from './Modal';

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** When true the confirm button uses the danger (red) treatment.
   *  Defaults to false (accent). Most callers in the codebase set this
   *  because the dialog usually fronts a destructive op. */
  danger?: boolean;
  loading?: boolean;
}

export default function ConfirmDialog({
  isOpen, onClose, onConfirm, title, message,
  confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  danger = false, loading = false,
}: ConfirmDialogProps) {
  const confirmBg = danger ? 'var(--accent-danger, #dc2626)' : 'var(--accent)';
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} width={256}>
      <div className="px-3 py-3 flex flex-col gap-3">
        <p className="text-xs text-[var(--text-primary)] leading-relaxed whitespace-pre-line">
          {message}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="flex-1 h-8 text-xs font-medium text-[var(--text-primary)] bg-[var(--btn-secondary-bg)] hover:bg-[var(--btn-secondary-bg-hover,var(--bg-hover))] rounded-[var(--radius-lg)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            style={{ backgroundColor: confirmBg }}
            className="flex-1 h-8 text-xs font-medium text-white hover:opacity-90 rounded-[var(--radius-lg)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
