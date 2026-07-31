// Stub for cms-ops in sandbox context.
//
// CMS schemas and item data live in the parent app's projectFS. The iframe
// sandbox doesn't have that, so we mirror what the renderer needs through
// the render command and stash it here. The Renderer's `getCollectionData`
// import resolves to this file in the sandbox build via the alias in
// `src/canvas-sandbox/vite.config.ts`.
//
// Anything not already pushed by the parent returns empty so a partially-
// initialized iframe still renders without crashing.

let _data: Record<string, any[]> = {};
let _schemas: Record<string, any> = {};

/** Replace the entire schema + data tables. Called from bridge-sandbox.ts
 *  on every `render()` from the parent so collection content stays current
 *  as the user edits items in the CMS panel. */
export function setSandboxCmsCollections(payload: {
  data: Record<string, any[]>;
  schemas: Record<string, any>;
}): void {
  _data = payload.data || {};
  _schemas = payload.schemas || {};
}

export function getCollectionData(slug: string): any[] {
  return _data[slug] ?? [];
}

export function getCollectionSchema(slug: string): any {
  return _schemas[slug] ?? null;
}
