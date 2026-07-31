// editor/plugin-editor/plugin-sdk-runtime.ts — SDK as an ES-module string.
//
// Mirror of `@revyme/plugin-sdk`'s public API as plain JavaScript,
// inlined into Tier 2 plugin iframes via a `blob:` URL registered in
// the import map under `@revyme/plugin-sdk`. Plugin authors write:
//
//   import { createPlugin } from '@revyme/plugin-sdk';
//
// — same import path Tier 1 plugins use after `npm install`, so the
// SAME source compiles on both authoring tiers without rewrites.
//
// Why a hand-maintained ES-module copy: Revyme's vite.config sets
// `base: '/builder/'` in cloud mode and intercepts `?raw` queries, so
// pulling the .ts source via `?raw` doesn't work. Inlining sidesteps
// Vite entirely. Maintenance: keep this file's exports in shape-sync
// with `revyme-open/plugin-sdk/src/{protocol,sdk-client,create-plugin}.ts`.
// `plugin-sdk-runtime.test.ts` enforces parity for the canvas namespace
// + protocol shape; broader checks are covered by the typed SDK
// (the .ts version exists for static-typing checks).
//
// IMPLEMENTATION NOTE: every namespace method is a thin wrapper that
// calls `transport.send(<method-string>, <params>)`. The runtime is
// long but uniform — each method follows the same shape. We mirror
// sdk-client.ts EXACTLY so the param shape on the wire is identical
// regardless of which tier authored the plugin.

export const SDK_RUNTIME_SOURCE = `
// ─── protocol ────────────────────────────────────────────────────────────
const PROTOCOL_VERSION = 1;
// Handshake identifier PINNED by the published @revyme/plugin-sdk —
// existing plugins compare against this exact string. Rename only
// together with the next SDK major.
const HOST_NAME = 'revyme-canvas-poc';

let idCounter = 0;
function nextId() {
  idCounter += 1;
  return 'r' + Date.now().toString(36) + '-' + idCounter;
}

// ─── SDK proxy factory — mirrors sdk-client.ts ───────────────────────────
function makeRevymeSdk(transport) {
  // Helper: subscriptions with type-narrowing guard on payload.
  const sub = (event, guard, handler) => transport.subscribe(event, (p) => guard(p) && handler(p));
  const isArr = Array.isArray;
  const isStr = (v) => typeof v === 'string';
  const isObj = (v) => v && typeof v === 'object';
  const isBool = (v) => typeof v === 'boolean';

  const canvas = {
    getSelection: () => transport.send('canvas.getSelection'),
    setSelection: (ids) => transport.send('canvas.setSelection', { ids }),
    getNode: (id) => transport.send('canvas.getNode', { id }),
    getRect: (id) => transport.send('canvas.getRect', { id }),
    getParent: (id) => transport.send('canvas.getParent', { id }),
    getChildren: (id) => transport.send('canvas.getChildren', { id }),
    getNodesWithType: (tag) => transport.send('canvas.getNodesWithType', { tag }),
    getNodesWithAttribute: (attr, value) => transport.send('canvas.getNodesWithAttribute', { attr, value }),
    setAttributes: (id, attrs) => transport.send('canvas.setAttributes', { id, attrs }),
    addNode: (parentId, spec) => transport.send('canvas.addNode', { parentId, spec }),
    removeNode: (id) => transport.send('canvas.removeNode', { id }),
    cloneNode: (id) => transport.send('canvas.cloneNode', { id }),
    setParent: (id, parentId, insertIndex) => transport.send('canvas.setParent', { id, parentId, insertIndex }),
    zoomIntoView: (idOrIds) => transport.send('canvas.zoomIntoView', { idOrIds }),
    startLayoutDrag: (spec, x, y) => transport.send('canvas.startLayoutDrag', { spec, x, y }),
    updateLayoutDrag: (x, y) => transport.send('canvas.updateLayoutDrag', { x, y }),
    endLayoutDrag: (x, y) => transport.send('canvas.endLayoutDrag', { x, y }),
    cancelLayoutDrag: () => transport.send('canvas.cancelLayoutDrag'),
  };

  const subscribe = {
    selection: (handler) => sub('selection', isArr, handler),
    activePage: (handler) => sub('activePage', isStr, handler),
    canvasRoot: (handler) => transport.subscribe('canvasRoot', () => handler()),
    colorStyles: (handler) => sub('colorStyles', isArr, handler),
    textStyles: (handler) => sub('textStyles', isArr, handler),
    codeFiles: (handler) => sub('codeFiles', isArr, handler),
    openCodeFile: (handler) => transport.subscribe('openCodeFile', (p) => handler(isStr(p) ? p : null)),
    text: (nodeId, handler) => sub('text:' + nodeId, isStr, handler),
    customCode: (handler) => sub('customCode', isObj, handler),
    isAllowedTo: (methods, handler) => sub('isAllowedTo:' + methods.join(','), isBool, handler),
  };

  const ui = {
    show: (opts) => transport.send('ui.show', opts || {}),
    hide: () => transport.send('ui.hide'),
    resize: (opts) => transport.send('ui.resize', opts),
    notify: (message, level) => transport.send('ui.notify', { message, level }),
    showContextMenu: (items, pos) => transport.send('ui.showContextMenu', { items, pos }),
    setMenu: (items) => transport.send('ui.setMenu', { items }),
    setBackgroundMessage: (message) => transport.send('ui.setBackgroundMessage', { message }),
    setCloseWarning: (message) => transport.send('ui.setCloseWarning', { message }),
    closePlugin: () => transport.send('ui.closePlugin'),
  };

  const user = { getCurrentUser: () => transport.send('user.getCurrentUser') };
  const project = {
    getProjectInfo: () => transport.send('project.getProjectInfo'),
    getPublishInfo: () => transport.send('project.getPublishInfo'),
  };

  const pages = {
    list: () => transport.send('pages.list'),
    switch: (path) => transport.send('pages.switch', { path }),
    getActive: () => transport.send('pages.getActive'),
    create: (opts) => transport.send('pages.create', opts),
  };

  const components = {
    list: () => transport.send('components.list'),
    get: (path) => transport.send('components.get', { path }),
    addInstance: (args) => transport.send('components.addInstance', args),
    addDetachedComponentLayers: (args) => transport.send('components.addDetachedComponentLayers', args),
    createDesign: (name) => transport.send('components.createDesign', { name }),
    createCode: (name) => transport.send('components.createCode', { name }),
  };

  const sketches = {
    list: () => transport.send('sketches.list'),
    addVariant: (setPath, opts) => transport.send('sketches.addVariant', { setPath, opts }),
  };

  const vectors = {
    list: () => transport.send('vectors.list'),
    addVariant: (setPath, opts) => transport.send('vectors.addVariant', { setPath, opts }),
  };

  const animations = {
    listKeyframes: () => transport.send('animations.listKeyframes'),
    listGsap: () => transport.send('animations.listGsap'),
  };

  const variables = {
    list: () => transport.send('variables.list'),
    get: (name) => transport.send('variables.get', { name }),
    set: (name, value) => transport.send('variables.set', { name, value }),
  };

  const presets = {
    listColorTokens: () => transport.send('presets.listColorTokens'),
    listTextTokens: () => transport.send('presets.listTextTokens'),
    addColorToken: (name, value, opts) => transport.send('presets.addColorToken', { name, value, opts }),
    addTextToken: (name, attrs, opts) => transport.send('presets.addTextToken', { name, attrs, opts }),
    createFolder: (category, name) => transport.send('presets.createFolder', { category, name }),
    moveToFolder: (category, tokenName, folderId) =>
      transport.send('presets.moveToFolder', { category, tokenName, folderId }),
  };

  const styles = {
    createColorStyle: (attrs) => transport.send('styles.createColorStyle', attrs),
    getColorStyle: (id) => transport.send('styles.getColorStyle', { id }),
    getColorStyles: () => transport.send('styles.getColorStyles'),
    createTextStyle: (attrs) => transport.send('styles.createTextStyle', attrs),
    getTextStyle: (id) => transport.send('styles.getTextStyle', { id }),
    getTextStyles: () => transport.send('styles.getTextStyles'),
  };

  const fonts = {
    getFont: (family, opts) => transport.send('fonts.getFont', { family, opts }),
    getFonts: () => transport.send('fonts.getFonts'),
  };

  const assets = {
    addImage: (asset) => transport.send('assets.addImage', { asset }),
    setImage: (asset) => transport.send('assets.setImage', { asset }),
    uploadImage: (file) => transport.send('assets.uploadImage', { file }),
    uploadImages: (files) => transport.send('assets.uploadImages', { files }),
    fetchImage: (url) => transport.send('assets.fetchImage', { url }),
    uploadFile: (file) => transport.send('assets.uploadFile', { file }),
    uploadFiles: (files) => transport.send('assets.uploadFiles', { files }),
    addSvg: (svgString, opts) => transport.send('assets.addSvg', { svgString, opts }),
    pickVideo: () => transport.send('assets.pickVideo'),
  };

  const text = {
    getText: (nodeId) => transport.send('text.getText', { nodeId }),
    setText: (nodeId, t) => transport.send('text.setText', { nodeId, text: t }),
    addText: (t, opts) => transport.send('text.addText', { text: t, opts }),
  };

  const customCode = {
    setCustomCode: (opts) => transport.send('customCode.setCustomCode', opts),
    getCustomCode: () => transport.send('customCode.getCustomCode'),
  };

  const cms = {
    getCollections: () => transport.send('cms.getCollections'),
    getActiveCollection: () => transport.send('cms.getActiveCollection'),
    getActiveManagedCollection: () => transport.send('cms.getActiveManagedCollection'),
    getManagedCollections: () => transport.send('cms.getManagedCollections'),
    createCollection: (name) => transport.send('cms.createCollection', { name }),
    createManagedCollection: (name) => transport.send('cms.createManagedCollection', { name }),
    getFields: (collectionId) => transport.send('cms.getFields', { collectionId }),
    addFields: (collectionId, fields) => transport.send('cms.addFields', { collectionId, fields }),
    removeFields: (collectionId, fieldIds) => transport.send('cms.removeFields', { collectionId, fieldIds }),
    setFieldOrder: (collectionId, fieldIds) => transport.send('cms.setFieldOrder', { collectionId, fieldIds }),
    getItems: (collectionId) => transport.send('cms.getItems', { collectionId }),
    addItems: (collectionId, items) => transport.send('cms.addItems', { collectionId, items }),
    removeItems: (collectionId, itemIds) => transport.send('cms.removeItems', { collectionId, itemIds }),
    setItemOrder: (collectionId, itemIds) => transport.send('cms.setItemOrder', { collectionId, itemIds }),
  };

  const localization = {
    getLocales: () => transport.send('localization.getLocales'),
    getActiveLocale: () => transport.send('localization.getActiveLocale'),
    getDefaultLocale: () => transport.send('localization.getDefaultLocale'),
    getLocalizationGroups: () => transport.send('localization.getLocalizationGroups'),
    setLocalizationData: (updates) => transport.send('localization.setLocalizationData', { updates }),
  };

  const codeFiles = {
    list: () => transport.send('codeFiles.list'),
    get: (id) => transport.send('codeFiles.get', { id }),
    create: (opts) => transport.send('codeFiles.create', opts),
    setContent: (id, content) => transport.send('codeFiles.setContent', { id, content }),
    rename: (id, newName) => transport.send('codeFiles.rename', { id, newName }),
    remove: (id) => transport.send('codeFiles.remove', { id }),
    lint: (id) => transport.send('codeFiles.lint', { id }),
    typecheck: (id) => transport.send('codeFiles.typecheck', { id }),
    getVersions: (id) => transport.send('codeFiles.getVersions', { id }),
    navigateTo: (id) => transport.send('codeFiles.navigateTo', { id }),
  };

  const redirects = {
    list: () => transport.send('redirects.list'),
    add: (rs) => transport.send('redirects.add', { redirects: rs }),
    remove: (redirectIds) => transport.send('redirects.remove', { redirectIds }),
    setOrder: (redirectIds) => transport.send('redirects.setOrder', { redirectIds }),
  };

  const permissions = {
    isAllowedTo: (...methods) => transport.send('permissions.isAllowedTo', { methods }),
    useIsAllowedTo: () => {
      throw new Error(
        'permissions.useIsAllowedTo is a React hook — the runtime injects a real implementation. ' +
        'If you see this error, the SDK runtime build is broken.',
      );
    },
    subscribe: (methods, handler) => sub('isAllowedTo:' + methods.join(','), isBool, handler),
  };

  const pluginData = {
    get: (key) => transport.send('pluginData.get', { key }),
    set: (key, value) => transport.send('pluginData.set', { key, value }),
    delete: (key) => transport.send('pluginData.delete', { key }),
    keys: () => transport.send('pluginData.keys'),
  };

  const secrets = {
    request: (key, opts) => transport.send('secrets.request', { key, opts }),
    use: (key) => transport.send('secrets.use', { key }),
    list: () => transport.send('secrets.list'),
    revoke: (key) => transport.send('secrets.revoke', { key }),
  };

  // \`fetch\` reconstructs a Response from the host's serialized
  // \`{ status, headers, body }\` payload so plugin code can use
  // \`res.text()\` / \`res.json()\` exactly like standard fetch.
  const fetchNs = async (url, init) => {
    const s = await transport.send('fetch', { url, init });
    return new Response(s.body, { status: s.status, headers: s.headers });
  };

  const mode = {
    current: () => transport.send('mode.current'),
  };

  return {
    canvas, subscribe, ui,
    user, project,
    pages, components, sketches, vectors, animations, variables, presets,
    styles, fonts, assets, text,
    customCode, cms, localization, codeFiles, redirects,
    permissions, pluginData, secrets, fetch: fetchNs, mode,
  };
}

// ─── createPlugin (create-plugin.ts equivalent) ─────────────────────────
const SDK_VERSION = '1.0.0';

async function createPlugin(init) {
  init = init || {};
  const timeoutMs = (typeof init.handshakeTimeoutMs === 'number') ? init.handshakeTimeoutMs : 5000;

  if (typeof window === 'undefined' || !window.parent || window.parent === window) {
    throw new Error('createPlugin: must run inside an iframe whose parent is the editor host.');
  }

  const parent = window.parent;
  const post = (msg) => parent.postMessage(msg, '*');

  const pending = new Map();
  const subscribers = new Map();
  const subIdByHandler = new Map();

  // 1. Handshake — must complete before we return the SDK.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onHandshake);
      reject(new Error('createPlugin: handshake timed out after ' + timeoutMs + 'ms'));
    }, timeoutMs);

    function onHandshake(e) {
      if (e.source !== parent) return;
      const data = e.data;
      if (!data || typeof data !== 'object') return;
      if (data.type !== 'handshake-ack') return;
      if (data.protocolVersion !== PROTOCOL_VERSION) {
        clearTimeout(timer);
        window.removeEventListener('message', onHandshake);
        reject(new Error('createPlugin: protocol version mismatch — host=' + data.protocolVersion + ' sdk=' + PROTOCOL_VERSION));
        return;
      }
      clearTimeout(timer);
      window.removeEventListener('message', onHandshake);
      resolve();
    }

    window.addEventListener('message', onHandshake);
    post({
      type: 'handshake',
      protocolVersion: PROTOCOL_VERSION,
      pluginId: init.pluginId,
      sdkVersion: SDK_VERSION,
    });
  });

  // 2. Steady-state message pump.
  function onMessage(e) {
    if (e.source !== parent) return;
    const data = e.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'rpc-response') {
      const slot = pending.get(data.id);
      if (!slot) return;
      pending.delete(data.id);
      if (data.ok) slot.resolve(data.result);
      else slot.reject(new Error(data.error || 'plugin RPC failed'));
      return;
    }

    if (data.type === 'event') {
      const set = subscribers.get(data.event);
      if (!set) return;
      set.forEach((handler) => {
        try { handler(data.payload); }
        catch (err) { console.error('[plugin-sdk] event handler for "' + data.event + '" threw:', err); }
      });
    }
  }
  window.addEventListener('message', onMessage);

  // 3. Transport bridges sdk-client → postMessage.
  const transport = {
    send(method, params) {
      const id = nextId();
      const req = { type: 'rpc', id, method, params: params == null ? {} : params };
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        post(req);
      });
    },
    subscribe(event, handler) {
      let set = subscribers.get(event);
      if (!set) { set = new Set(); subscribers.set(event, set); }
      set.add(handler);
      const subId = nextId();
      subIdByHandler.set(handler, subId);
      post({ type: 'subscribe', id: subId, event });
      return () => {
        const live = subscribers.get(event);
        if (live) live.delete(handler);
        const id = subIdByHandler.get(handler);
        subIdByHandler.delete(handler);
        if (id) post({ type: 'unsubscribe', subscriptionId: id });
      };
    },
  };

  const revyme = makeRevymeSdk(transport);

  // ─── Auto-height reporting ────────────────────────────────────────
  // Cross-origin iframes (cloud plugins served from R2) can't be
  // measured from the host via \`contentDocument.scrollHeight\` — the
  // parent gets \`null\` for cross-origin contentDocument. So the plugin
  // side measures its own root and pushes the height to the host via
  // \`ui.resize\`. Local Tier 2 plugins ALSO go through this path —
  // explicit reporting is more reliable than the host trying to
  // observe a contentDocument that may detach + reattach during HMR.
  //
  // Throttled to one frame to coalesce bursts (typing in an input
  // changes layout dozens of times per second).
  let lastReportedHeight = 0;
  let heightReportPending = false;
  function reportHeight() {
    if (heightReportPending) return;
    heightReportPending = true;
    requestAnimationFrame(() => {
      heightReportPending = false;
      const h = document.documentElement.scrollHeight;
      if (h > 0 && Math.abs(h - lastReportedHeight) >= 2) {
        lastReportedHeight = h;
        post({
          type: 'rpc',
          id: nextId(),
          method: 'ui.resize',
          params: { height: h },
        });
      }
    });
  }
  // Observe the document root + body so any layout change inside the
  // plugin (tab switch, expansion, content load) triggers a re-report.
  try {
    const ro = new ResizeObserver(reportHeight);
    ro.observe(document.documentElement);
    if (document.body) ro.observe(document.body);
  } catch (e) {
    // ResizeObserver unsupported (very old browsers) — fall back to a
    // single report on next frame.
    setTimeout(reportHeight, 16);
  }
  // Also fire on next frame to catch the initial layout after React mount.
  setTimeout(reportHeight, 0);

  return {
    revyme,
    close() {
      window.removeEventListener('message', onMessage);
      post({ type: 'close' });
    },
  };
}

// ─── ES module exports ──────────────────────────────────────────────────
export { createPlugin, makeRevymeSdk, PROTOCOL_VERSION, HOST_NAME, SDK_VERSION };
`;
