// Stub for canvas-bridge in sandbox context.
// The sandbox IS the iframe — it doesn't query itself via the bridge.

const noopBridge = {
  getRect: () => null,
  getChildRects: () => [],
  getComputedValue: () => '',
  getComputedValues: () => ({}),
  getContainerRect: () => null,
  getElementIdsAtPoint: () => [],
  patchStyles: () => {},
  injectCSS: () => {},
  removeCSS: () => {},
  getCachedCorners: () => null,
  getCachedComputedStyle: () => '',
  getCachedComputedStyles: () => ({}),
  getIframeOffset: () => ({ x: 0, y: 0 }),
  getIframeDocument: () => null,
  loadFontInIframe: () => {},
};

export function getCanvasBridge() { return noopBridge; }
export function clearBridgeReadCaches() {}
export function setActiveBridge() {}
