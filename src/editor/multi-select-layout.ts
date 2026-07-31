// multi-select-layout.ts — pure helper for showing the Layout tool during
// multi-select. Own file so PropertiesPanel keeps a single default export
// (Fast Refresh disables HMR when a component file co-exports a value).

/**
 * Whether the Layout tool should show for an ENTIRE multi-selection, and in
 * which state:
 *
 *   'flex' | 'grid' — every node is already that kind of container; show the tool
 *                     populated so gap / align / padding / direction edits fan out
 *                     across the whole selection (user request 2026-07-24).
 *   'none'          — NO node has a layout, but every one of them COULD have one
 *                     (a frame that accepts children); show the tool in its ADD
 *                     state so one `+` gives the whole selection a layout. Without
 *                     this the tool vanished the moment you multi-selected plain
 *                     frames — the exact case where adding a layout to all of them
 *                     at once is most useful (user request 2026-07-25).
 *   null            — hidden: mixed kinds (some flex + some grid), a mix of
 *                     laid-out and plain, or something in the selection can't take
 *                     a layout at all (text, svg, image).
 */
export function resolveMultiSelectLayoutType(
  selectedIds: string[],
  displayOf: (id: string) => string,
  /** True when this node is a container that could HOLD a layout (frame-like). */
  canHoldLayout: (id: string) => boolean,
): 'flex' | 'grid' | 'none' | null {
  if (selectedIds.length === 0) return null;
  const typeOf = (id: string): 'flex' | 'grid' | 'other' => {
    const d = displayOf(id);
    if (d === 'flex' || d === 'inline-flex') return 'flex';
    if (d === 'grid' || d === 'inline-grid') return 'grid';
    return 'other';
  };
  const first = typeOf(selectedIds[0]);
  if (first === 'other') {
    // ADD state — only when NOTHING in the selection has a layout AND every one
    // of them can take one. A single laid-out node makes it a mixed selection
    // (handled by the `every` below returning false), and a single non-container
    // means "add layout to all" would silently skip it.
    return selectedIds.every((id) => typeOf(id) === 'other' && canHoldLayout(id)) ? 'none' : null;
  }
  return selectedIds.every((id) => typeOf(id) === first) ? first : null;
}
