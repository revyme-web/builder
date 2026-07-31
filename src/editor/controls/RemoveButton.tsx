// RemoveButton — small inline "x" button for removing entries in lists.

import React from 'react';

export function RemoveButton({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  return (
    <span
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
      className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer text-sm ml-2 shrink-0"
    >
      &times;
    </span>
  );
}

