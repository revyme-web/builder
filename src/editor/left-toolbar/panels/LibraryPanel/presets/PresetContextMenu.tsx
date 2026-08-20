// PresetContextMenu — small floating rename/delete menu for a preset row.

import React from 'react';

interface ContextMenuProps {
  x: number;
  y: number;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function PresetContextMenu({ x, y, onRename, onDelete, onClose }: ContextMenuProps) {
  return (
    <>
      <div className="fixed inset-0 z-[10010]" onClick={onClose} />
      <div
        className="fixed z-[10011] bg-[var(--bg-surface)] border border-[var(--border-light)] cut-corners cut-lg cut-border [--cut-border-color:var(--border-light)] shadow-xl py-1 min-w-[120px]"
        style={{ left: x, top: y }}
      >
        <button
          onClick={() => { onRename(); onClose(); }}
          className="w-full text-left px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
        >
          Rename
        </button>
        <button
          onClick={() => { onDelete(); onClose(); }}
          className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-[var(--bg-hover)] transition-colors"
        >
          Delete
        </button>
      </div>
    </>
  );
}
