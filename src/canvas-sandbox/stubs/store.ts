// Stub for store.ts in sandbox context.
// Prevents circular dependency issues from Jotai atoms.

export function getNodeFromCache() { return undefined; }
export function injectNodeIntoCache() {}
export function updateNodeInCache() {}
export function removeNodeFromCache() {}
export function moveNodeInCache() {}
export function isComponentInstanceInCache() { return false; }
export function getVariantOverriddenKeys() { return null; }
export function getCachedNodesMap() { return new Map(); }
export function getNodesSnapshot() { return new Map(); }
export function seedNodesForCode() { return new Map(); }
export function setPreferCacheSnapshot() {}
export const nodesAtom = { init: new Map() };
export const selectedNodeAtom = { init: null };
export const selectedIdsAtom = { init: [] };
export const codeAtom = { init: '' };
// `stable*` atoms mirror their non-stable counterparts but pause updates
// while the canvas is being interacted with (drag/resize). Real
// implementations live in `code/stores/store.ts`; the sandbox doesn't run
// that interaction loop, so the stubs just shadow the shape.
export const stableCodeAtom = { init: '' };
export const stableNodesAtom = { init: new Map() };
export const updatingFromCanvasAtom = { init: false };
export const isComponentFileAtom = { init: false };
export const isLayoutFileAtom = { init: false };
export const hoveredIdAtom = { init: null };
export const hoveredNodeIdAtom = { init: null };
export const hoveredViewportIdAtom = { init: 'desktop' };
export const canvasInteractingAtom = { init: false };
export const pendingFileSwitchAtom = { init: null };
export const mapItemIndexAtom = { init: null };
export const mapContextAtom = { init: null };
export const isMapTemplateSelectedAtom = { init: false };
export const isComponentSelectedAtom = { init: false };

export function getAllCachedNodes() { return []; }
