// icon-style-utils.ts — Tiny shared helpers used by both the secondary
// panel cards (`index.tsx > GradientCard`) and the toolbar drag ghost
// (`canvas/ui/ToolbarGhost.tsx`).
//
// Kept here so the two render paths can't drift on which iconKey
// prefixes count as "full-width animated previews" vs "compact icons" —
// the ghost has to match the panel card exactly or the drag feels
// disconnected from what the user clicked.

/**
 * Is this iconKey backed by an animated preview component (full-width
 * tile) rather than a compact glyph (44px circle)? The prefixes
 * correspond to families of `*Icon` components in
 * `creative-preview-icons.tsx` and the noise / divider / pattern /
 * shader preview groups.
 */
export function isPreviewIcon(iconKey: string): boolean {
  return iconKey.startsWith('noise')
    || iconKey.startsWith('divider')
    || iconKey.startsWith('pattern')
    || iconKey.startsWith('shader')
    || iconKey.startsWith('creative')
    || iconKey.startsWith('effect');
}

/** Hex `#RGB` / `#RRGGBB` → `rgba(r, g, b, alpha)`. */
export function hexToRgba(hex: string, alpha: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (h.length !== 6) return `rgba(128, 128, 128, ${alpha})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
