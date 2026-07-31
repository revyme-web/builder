// Stub for node-ops in sandbox context.
// Only provides getOrCreateCanvasStyleEl which Renderer needs.

export function getOrCreateCanvasStyleEl(): HTMLStyleElement | null {
  const root = document.querySelector('[data-content-root]');
  if (!root) return null;
  let el = root.querySelector('[data-canvas-styles]') as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.setAttribute('data-canvas-styles', 'true');
    root.prepend(el);
  }
  return el;
}

// Stubs for other exports Renderer might reference
export function getContentRoot(): HTMLElement | null {
  return document.querySelector('[data-content-root]');
}
export function refreshCanvasTokens(): void {}
export function getActiveFilePath(): string { return 'app/page.tsx'; }
export function getViewportPrefix(id: string): string { return (id === 'desktop' || id === 'default') ? '' : id + '-'; }
export function isPrimaryViewport(id: string): boolean { return id === 'desktop' || id === 'default'; }
export function setStyleContext() {}
export function setLocaleStyleCallback() {}
export function updateNodeStyles() {}
export function commitDragPosition() {}
export function getNodeId() { return null; }
export function patchElementStyles() {}
export function patchNodeStyles() {}
/** Inject / replace a CSS rule in the iframe's `<style data-canvas-styles>`.
 *  Mirrors `injectCanvasCSS` in `src/canvas/node-ops.ts` minus the bridge
 *  forward (the sandbox IS the iframe — no further hop). Used by the
 *  renderer's `applyStrokeAlignment` to apply Inside/Outside stroke
 *  alignment as a CSS rule keyed by the shape's `data-id`, without
 *  writing to the shape's inline style (which shape-edit-host would
 *  capture via innerHTML and bake into source). */
export function injectCanvasCSS(selector: string, cssBody: string): void {
  const styleEl = getOrCreateCanvasStyleEl();
  if (!styleEl) return;
  const selectorEsc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ruleRegex = new RegExp(`\\s*${selectorEsc}\\s*\\{[^}]*\\}`, 's');
  const newRule = `\n${selector} {\n${cssBody}\n}`;
  const cur = styleEl.textContent || '';
  styleEl.textContent = ruleRegex.test(cur) ? cur.replace(ruleRegex, newRule) : cur + newRule;
}

export function removeCanvasCSS(selector: string): void {
  const root = getContentRoot();
  if (!root) return;
  const styleEl = root.querySelector('[data-canvas-styles]') as HTMLStyleElement | null;
  if (!styleEl) return;
  const selectorEsc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ruleRegex = new RegExp(`\\s*${selectorEsc}\\s*\\{[^}]*\\}`, 's');
  styleEl.textContent = (styleEl.textContent || '').replace(ruleRegex, '');
}
export function clearCanvasStyles() {}
export function vpIdFromPrefix(p: string) { return p ? p.replace(/-$/, '') : 'desktop'; }
export function getViewportForElement() { return 'desktop'; }
export function getViewportFromEvent() { return 'desktop'; }
export function getViewportContainer() { return null; }
export function getViewportRoot() { return null; }
export function getParentEl() { return null; }
export function getSiblingEls() { return []; }
export function isElementOnScreen() { return true; }
export function getInteractingViewport() { return { vpId: 'desktop', vpWidth: 1440 }; }
export function redirectToComponentInstance(id: string) { return id; }
export function redirectToCollectionTemplate() { return null; }
export function redirectToFitTextWrapper() { return null; }
export function isComponentInstanceInCache() { return false; }
export type NodeMouseDownHandler = (nodeId: string, e: MouseEvent) => void;

// Bridge-aware stubs (added during iframe migration)
// These are no-ops in the sandbox — the sandbox IS the iframe, it doesn't query itself via bridge.
export function findNodeRect(_nodeId: string, _vpId: string): DOMRect | null { return null; }
export function findNodeSize(_nodeId: string, _vpId: string) { return { width: 0, height: 0 }; }
export function findNodeParentInnerSize(_nodeId: string, _vpId: string) { return { width: 0, height: 0 }; }
export function findNodeComputedStyle(_nodeId: string, _vpId: string, _prop: string): string { return ''; }
export function findNodeComputedStyles(_nodeId: string, _vpId: string, _props: string[]): Record<string, string> { return {}; }
export function findChildRects(_parentId: string, _vpId: string): Array<{ id: string; rect: DOMRect }> { return []; }
export function findVisibleChildRects(_parentId: string, _vpId: string): Array<{ id: string; rect: DOMRect }> { return []; }
export function getNodeIdsAtPoint(_x: number, _y: number): string[] { return []; }
export function getNodeHitsAtPoint(_x: number, _y: number): Array<{ id: string; vpPrefix: string }> { return []; }
export function patchNodeAttributes() {}
export function patchAllReplicaAttributes() {}
export function setNodeTextContent() {}
export function getSvgAttributesAsync() { return Promise.resolve({}); }
export function querySelectorIdsAsync() { return Promise.resolve([]); }
export function querySelectorIdsSync() { return []; }

export function patchCanvasRender() {}
export async function findNodeRectLiveMetaAsync(_nodeId: string, _vpId: string): Promise<{ rect: DOMRect | null; culled: boolean }> { return { rect: null, culled: false }; }
