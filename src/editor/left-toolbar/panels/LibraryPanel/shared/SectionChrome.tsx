// SectionChrome — shared visual skeleton for the Library panel's
// top-level sections (Components / Templates / Vectors). Every section
// renders the same chrome: an `md` SectionLabel header with a `+`
// create-dropdown, an icon + one-liner empty state, a "Project"
// drop-target header row, and SidebarRow-based folder rows inside the
// shared FolderTree. These are markup-identical extractions of what
// each section used to duplicate inline; the genuine per-section
// differences (menu items, icons, drop-sentinel attributes, accent
// colors) flow in as props.

import { useRef, useState, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import DropdownMenu, { type DropdownMenuEntry } from '@/design-system/DropdownMenu';
import { folderTreeIndicatorAtom } from '@/design-system/FolderTree';
import SidebarRow from '@/design-system/SidebarRow';
import SectionLabel from '@/design-system/SectionLabel';
import AddButton from '@/design-system/AddButton';
import { useIsViewer } from '@/code/stores/viewer-mode-store';
import { CreatorFolderIcon } from './icons';

// ─── Section header ─────────────────────────────────────────────────────────
// SectionLabel + `+` button + anchored dropdown. Viewers can browse the
// Library but not create — the `+` header button is hidden so the only
// interaction left is clicking rows.
export function LibrarySectionHeader({ title, addTitle, items }: {
  title: string;
  /** Tooltip for the `+` button, e.g. "Create component". */
  addTitle: string;
  /** Dropdown entries shown when the `+` button is clicked. */
  items: DropdownMenuEntry[];
}) {
  const plusButtonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const isViewer = useIsViewer();
  return (
    <SectionLabel size="md" right={isViewer ? undefined :
      <>
        <AddButton ref={plusButtonRef} onClick={() => setOpen(o => !o)} title={addTitle} />
        <DropdownMenu
          isOpen={open}
          onClose={() => setOpen(false)}
          items={items}
          anchorRef={plusButtonRef}
          position="bottom-left"
        />
      </>
    }>{title}</SectionLabel>
  );
}

// ─── Empty state ────────────────────────────────────────────────────────────
// Icon + one-liner, centered — shown when the section has nothing to
// list (no local files, no folders, no linked entries).
export function LibraryEmptyState({ icon, message }: {
  icon: ReactNode;
  message: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-4 py-4 text-center">
      {icon}
      <p className="text-[10px] text-[var(--text-disabled)] max-w-[180px] leading-relaxed">
        {message}
      </p>
    </div>
  );
}

// ─── "Project" header row ───────────────────────────────────────────────────
// Purely visual header above the section's FolderTree (Project itself
// isn't a real folder). Wrapped in the section's kind-specific
// drop-sentinel attribute (e.g. `data-component-folder-drop`) so
// dropping ON the header (not just inside the body) routes to
// "section root" too — that's how the user drags an item OUT of a
// user folder and back to the top level. Subscribes to the FolderTree
// indicator atom — when a drag hovers the section root (no row
// underneath), `useComponentDrag` writes a synthetic indicator with
// `rowId === rootId` and we light up the header with the purple
// accent outline. Per-kind sentinel ids ('component-root' /
// 'vector-root') keep cross-section drag traffic isolated.
export function LibraryProjectHeader({ dropAttr, rootId, expanded, onToggle, iconColor }: {
  /** Kind-specific drop-sentinel attribute name, e.g. `data-vector-folder-drop`. */
  dropAttr: string;
  /** Section-root sentinel id the drag layer writes, e.g. `vector-root`. */
  rootId: string;
  expanded: boolean;
  onToggle: () => void;
  /** Optional SidebarRow icon accent (Vectors passes `var(--accent)`;
   *  Components keeps SidebarRow's purple default). */
  iconColor?: string;
}) {
  const folderTreeIndicator = useAtomValue(folderTreeIndicatorAtom);
  const isProjectDropTarget = folderTreeIndicator?.rowId === rootId;
  return (
    <div
      {...{ [dropAttr]: rootId }}
      style={{
        outline: isProjectDropTarget ? '1px solid var(--accent-secondary, #a78bfa)' : 'none',
        outlineOffset: -1,
        borderRadius: 6,
      }}
    >
      <SidebarRow
        icon={<CreatorFolderIcon />}
        label="Project"
        iconColor={iconColor}
        expandable={{ expanded }}
        onClick={onToggle}
      />
    </div>
  );
}

// ─── Folder row ─────────────────────────────────────────────────────────────
// The FolderTree `renderFolder` body every section shares: collapsible
// SidebarRow with rename / delete context menu and the inline-rename
// input. A freshly-created folder (pending its first name commit)
// renders the inline edit with an EMPTY `initialValue` so an empty
// commit is unambiguously a cancellation — the section's
// `onCommitRename` (useLibraryFolderCrud) translates that into a
// folder delete. Empty folders don't show a chevron — there's nothing
// to expand.
export function LibraryFolderRow({
  folder, expanded, toggle,
  renamingFolderId, pendingNewFolderId,
  onStartRename, onCommitRename, onDelete,
  iconColor,
}: {
  folder: { id: string; name: string; children: string[] };
  expanded: boolean;
  toggle: () => void;
  renamingFolderId: string | null;
  pendingNewFolderId: string | null;
  onStartRename: (id: string) => void;
  onCommitRename: (id: string, newName: string) => void;
  onDelete: (id: string) => void;
  /** Optional SidebarRow icon accent (Vectors passes `var(--accent)`). */
  iconColor?: string;
}) {
  const isRenaming = renamingFolderId === folder.id;
  const isPendingCreation = pendingNewFolderId === folder.id;
  const isEmpty = folder.children.length === 0;
  const menuItems: DropdownMenuEntry[] = [
    { id: 'rename', label: 'Rename', onClick: () => onStartRename(folder.id) },
    { type: 'separator' },
    { id: 'delete', label: 'Delete', onClick: () => onDelete(folder.id) },
  ];
  return (
    <SidebarRow
      icon={<CreatorFolderIcon />}
      label={folder.name}
      iconColor={iconColor}
      expandable={isEmpty ? undefined : { expanded }}
      menuItems={menuItems}
      onClick={() => {
        if (isRenaming) return;
        if (isEmpty) return;
        toggle();
      }}
      inlineEdit={isRenaming ? {
        initialValue: isPendingCreation ? '' : folder.name,
        onCommit: (name) => onCommitRename(folder.id, name),
      } : undefined}
    />
  );
}
