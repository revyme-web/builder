// EllipsisMenu.tsx — Three dots button that opens a DropdownMenu on click.
// Shows on hover (via parent group class). Used for component rows, layer rows, etc.

import { useState, useRef } from 'react';
import DropdownMenu, { type DropdownMenuEntry } from './DropdownMenu';

interface EllipsisMenuProps {
  items: DropdownMenuEntry[];
  /** Position relative to button */
  position?: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
  /** Always visible or only on hover (requires parent with 'group' class) */
  showOnHover?: boolean;
}

export default function EllipsisMenu({ items, position = 'bottom-left', showOnHover = true }: EllipsisMenuProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={btnRef}
        // Stop pointerdown too (not just click): when the row itself is a drag
        // source (e.g. dnd-kit sortable CMS items) a bubbling pointerdown would
        // arm a drag from the menu button. Keeps the `…` a pure click target.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className={`
          shrink-0 w-6 h-6 flex items-center justify-center rounded
          hover:bg-[var(--bg-hover)] text-[var(--text-disabled)] hover:text-[var(--text-primary)]
          transition-all cursor-pointer
          ${showOnHover ? 'opacity-0 group-hover:opacity-100' : ''}
        `}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
      </button>
      <DropdownMenu
        isOpen={open}
        onClose={() => setOpen(false)}
        items={items}
        anchorRef={btnRef}
        position={position}
      />
    </>
  );
}
