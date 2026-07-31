// file-path-kind.ts — Pure file-path KIND predicates (leaf module, no
// imports). Extracted from active-file-store.ts so canvas/node-ops (and
// other low-level modules) can classify paths without importing the
// stateful store — active-file-store re-exports these for its callers.

/** Check if a file path is a component file (pure function — use in imperative code) */
export function isComponentFilePath(path: string): boolean {
  return path.startsWith('components/');
}

/** The CANVAS-EDITABLE half of a template (route-group layout). Only the
 *  `LayoutClient.tsx` is edited on the canvas — the server `layout.tsx` shell is
 *  never the active canvas file, so this is narrower than `isLayoutFile`. A
 *  template behaves like a design-component MASTER for the variable system,
 *  accent theming, and breadcrumb — see `isComponentLikeFilePath`. */
export function isTemplateFilePath(path: string): boolean {
  return path.endsWith('/LayoutClient.tsx') || path === 'LayoutClient.tsx';
}

/** "Treat this file like a design-component master." True for real components
 *  AND templates (LayoutClient). This is the gate for the COMPONENT-style
 *  variable system (function-param vars + @propMeta, NOT page @pageVariables),
 *  the accent-secondary (purple) re-skin, selection/hover theming, and the
 *  master breadcrumb. A template IS a component (with its variables surfaced in
 *  the Template tool instead of an instance props tool). Genuinely
 *  `components/`-only logic (registry scans, breadcrumb path-segment colour for
 *  real components) keeps using `isComponentFilePath`. */
export function isComponentLikeFilePath(path: string): boolean {
  return isComponentFilePath(path) || isTemplateFilePath(path);
}

/** Check if a file path is an icon-set master file. Icon sets live in
 *  `icons/` and behave like components for navigation purposes (own
 *  master canvas, breadcrumb back to page, etc.). */
export function isIconSetFilePath(path: string): boolean {
  return path.startsWith('icons/') && path.endsWith('.tsx');
}

/** A layout file — the route group's server shell or its client wrapper.
 *  Lives here (the LEAF path-predicate module) so canvas/node-ops can gate
 *  behaviour on "editing a template" without importing active-file-store
 *  (which would cycle). Moved from active-file-store 2026-07-27. */
export function isLayoutFile(path: string): boolean {
  return path.endsWith('/layout.tsx') || path.endsWith('/layout.jsx') || path === 'layout.tsx'
    || path.endsWith('/LayoutClient.tsx') || path === 'LayoutClient.tsx';
}
