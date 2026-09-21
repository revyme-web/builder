// variant-root.ts — "is this the component master's ROOT node?", as a LEAF
// module (no imports), because both `node-ops` and `ResizeManager` need it and
// they already depend on each other in one direction. Importing it from
// `ResizeManager` closed that loop; a cycle here breaks canvas boot in a way
// the unit tests cannot see (see project-fs's import-cycle incident).

export function isComponentVariantRootNode(
  node: { parentId?: string | null; isCanvasNode?: boolean; attrs?: Record<string, string> } | null | undefined,
): boolean {
  return !!node && !node.parentId && !node.isCanvasNode && !node.attrs?.['data-overlay'];
}
