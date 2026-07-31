// Generic icons used by LibraryPanel rows. Item-specific icons
// (DesignComponentIcon, IconSetIcon, etc.) live next to
// the rows that use them.

import React from 'react';

export function ComponentIcon({ className }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

export function InfoIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={11}
      height={11}
      viewBox="0 0 24 24"
      className="flex-shrink-0"
    >
      <path
        fill="currentColor"
        d="M12 1.999c5.524 0 10.002 4.478 10.002 10.002c0 5.523-4.478 10.001-10.002 10.001S2 17.524 2 12.001C1.999 6.477 6.476 1.999 12 1.999"
        opacity={0.3}
      />
      <path
        fill="currentColor"
        d="M12.001 6.5a1.252 1.252 0 1 0 .002 2.503A1.252 1.252 0 0 0 12 6.5zm-.005 3.749a1 1 0 0 0-.992.885l-.007.116l.004 5.502l.006.117a1 1 0 0 0 1.987-.002L13 16.75l-.004-5.501l-.007-.117a1 1 0 0 0-.994-.882z"
      />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function MoreIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </svg>
  );
}

// Folder glyph for creator groups in the Linked components list. Same
// shape as the Templates / Vectors section icons elsewhere in the
// Library panel — keeps the visual language consistent. We deliberately
// don't render the creator's avatar here: it adds noise and most
// creators won't have one set.
export const CreatorFolderIcon = React.memo(function CreatorFolderIcon({
  // Default to currentColor so SidebarRow's `iconColor` flows in via
  // its wrapper `style={{ color: iconColor }}`. Component / linked-
  // components rows leave SidebarRow's iconColor at its purple default,
  // and Vectors sections override it to `var(--accent)`
  // — that way the same icon picks up the section-appropriate accent
  // without the call site having to pass a color prop everywhere.
  color = 'currentColor',
}: { color?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" style={{ color }}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M2.07 5.258C2 5.626 2 6.068 2 6.95V14c0 3.771 0 5.657 1.172 6.828S6.229 22 10 22h4c3.771 0 5.657 0 6.828-1.172S22 17.771 22 14v-2.202c0-2.632 0-3.949-.77-4.804a3 3 0 0 0-.224-.225C20.151 6 18.834 6 16.202 6h-.374c-1.153 0-1.73 0-2.268-.153a4 4 0 0 1-.848-.352C12.224 5.224 11.816 4.815 11 4l-.55-.55c-.274-.274-.41-.41-.554-.53a4 4 0 0 0-2.18-.903C7.53 2 7.336 2 6.95 2c-.883 0-1.324 0-1.692.07A4 4 0 0 0 2.07 5.257M12.25 10a.75.75 0 0 1 .75-.75h5a.75.75 0 0 1 0 1.5h-5a.75.75 0 0 1-.75-.75"
        clipRule="evenodd"
      />
    </svg>
  );
});

// "New Folder" entry icon for the section-header `+` dropdowns
// (Components / Templates / Vectors). Same glyph as CreatorFolderIcon
// above (an organizational container, not an item) but plain
// currentColor — DropdownMenu tints entry icons itself.
export function NewFolderMenuIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M2.07 5.258C2 5.626 2 6.068 2 6.95V14c0 3.771 0 5.657 1.172 6.828S6.229 22 10 22h4c3.771 0 5.657 0 6.828-1.172S22 17.771 22 14v-2.202c0-2.632 0-3.949-.77-4.804a3 3 0 0 0-.224-.225C20.151 6 18.834 6 16.202 6h-.374c-1.153 0-1.73 0-2.268-.153a4 4 0 0 1-.848-.352C12.224 5.224 11.816 4.815 11 4l-.55-.55c-.274-.274-.41-.41-.554-.53a4 4 0 0 0-2.18-.903C7.53 2 7.336 2 6.95 2c-.883 0-1.324 0-1.692.07A4 4 0 0 0 2.07 5.257M12.25 10a.75.75 0 0 1 .75-.75h5a.75.75 0 0 1 0 1.5h-5a.75.75 0 0 1-.75-.75"
        clipRule="evenodd"
      />
    </svg>
  );
}
