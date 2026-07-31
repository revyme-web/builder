// plugins/permission-gate.ts — runtime permission enforcement.
//
// Pass 1 is internal-only: the gate exists but auto-grants every
// declared permission. The shape is here so call sites at the SDK
// router can write `assertCan(plugin, 'canvas:write')` from day one
// — when Pass 3 lands the install dialog + persistent grants store,
// only this file changes; routers untouched.
//
// Method-to-permission mapping lives in `methodPermissionMap` below.
// Adding a new SDK method: register its required permission here.
// Methods not in the map are allowed without a check (e.g. `ui.notify`
// — purely cosmetic, no project state touched).

import type { PluginManifest } from '@revyme/plugin-sdk';

export class PermissionDeniedError extends Error {
  constructor(public readonly required: string, public readonly method: string) {
    super(`Plugin lacks permission "${required}" required by "${method}"`);
    this.name = 'PermissionDeniedError';
  }
}

/**
 * Maps an RPC method (`namespace.method` form) to the permission it
 * requires. Methods not in the map require no permission.
 *
 * Year-1 mapping is intentionally coarse — `canvas:read` for any read
 * across the canvas/components/... namespaces, `canvas:write` for any
 * mutation. Pass 3 narrows this when the install dialog can show
 * granular permissions per-namespace.
 */
const methodPermissionMap: Record<string, string> = {
  // Canvas reads
  'canvas.getSelection': 'canvas:read',
  'canvas.getNode': 'canvas:read',
  'canvas.getRect': 'canvas:read',
  'canvas.getParent': 'canvas:read',
  'canvas.getChildren': 'canvas:read',
  'canvas.getNodesWithType': 'canvas:read',
  'canvas.getNodesWithAttribute': 'canvas:read',
  // Canvas writes
  'canvas.setSelection': 'canvas:write',
  'canvas.setAttributes': 'canvas:write',
  'canvas.addNode': 'canvas:write',
  'canvas.removeNode': 'canvas:write',
  'canvas.cloneNode': 'canvas:write',
  'canvas.setParent': 'canvas:write',
  'canvas.zoomIntoView': 'canvas:read',
  // Pages — read = list/getActive, write = switch/create
  'pages.list': 'pages:read',
  'pages.getActive': 'pages:read',
  'pages.switch': 'pages:write',
  'pages.create': 'pages:write',
  // Text — get = read, set/add = write
  'text.getText': 'canvas:read',
  'text.setText': 'canvas:write',
  'text.addText': 'canvas:write',
  // Components — list/get = read, mutators = write
  'components.list': 'components:read',
  'components.get': 'components:read',
  'components.addInstance': 'components:write',
  'components.addDetachedComponentLayers': 'components:write',
  'components.createDesign': 'components:write',
  'components.createCode': 'components:write',
  // Sketches / Vectors
  'sketches.list': 'sketches:read',
  'sketches.addVariant': 'sketches:write',
  'vectors.list': 'vectors:read',
  'vectors.addVariant': 'vectors:write',
  // Presets / Styles — share read perm; write maps to presets:write
  'presets.listColorTokens': 'presets:read',
  'presets.listTextTokens': 'presets:read',
  'presets.addColorToken': 'presets:write',
  'presets.addTextToken': 'presets:write',
  'styles.getColorStyles': 'presets:read',
  'styles.getTextStyles': 'presets:read',
  'styles.getColorStyle': 'presets:read',
  'styles.getTextStyle': 'presets:read',
  'styles.createColorStyle': 'presets:write',
  'styles.createTextStyle': 'presets:write',
  // Fonts / Assets — read-only at present
  'fonts.getFonts': 'fonts:read',
  'fonts.getFont': 'fonts:read',
  // Layout drag = arm the native canvas insert-drag from a plugin's tree spec.
  'canvas.startLayoutDrag': 'canvas:write',
  'canvas.updateLayoutDrag': 'canvas:write',
  'canvas.endLayoutDrag': 'canvas:write',
  'canvas.cancelLayoutDrag': 'canvas:write',
  'assets.addSvg': 'assets:write',
  'assets.addImage': 'assets:write',
  'assets.uploadImage': 'assets:write',
  // Opens the native video picker + fetches the chosen clip's bytes (via the
  // media proxy). A read/fetch, not a project mutation.
  'assets.pickVideo': 'assets:read',
  // Proxies an image URL → Blob (CORS-safe). A read/fetch, not a mutation.
  'assets.fetchImage': 'assets:read',
  // Variables / animations — listing is informational, no perm gate
  // (not security-sensitive; these all live in the user's own project)
  // codeFiles — read = list/get, write = create/setContent/remove/rename
  'codeFiles.list': 'codeFiles:read',
  'codeFiles.get': 'codeFiles:read',
  'codeFiles.create': 'codeFiles:write',
  'codeFiles.setContent': 'codeFiles:write',
  'codeFiles.remove': 'codeFiles:write',
  'codeFiles.rename': 'codeFiles:write',
  // customCode — site-wide head/body injection. Single permission.
  'customCode.getCustomCode': 'customCode:read',
  'customCode.setCustomCode': 'customCode:write',
  // Secrets — single permission for write (request/revoke), single for
  // read (use/list). Plugins typically declare both.
  'secrets.request': 'secrets:write',
  'secrets.revoke': 'secrets:write',
  'secrets.use': 'secrets:read',
  'secrets.list': 'secrets:read',
  // `fetch` itself isn't gated by a generic permission — it's gated
  // PER-CALL by the URL's origin (see network.ts isOriginAllowed). The
  // gate here would be redundant and would block plugins that have
  // SOME network access from calling fetch at all.

  // codeFiles.navigateTo — informational, no perm gate (it just opens the editor)
  // Subscriptions are not gated — plugin can subscribe to anything; the
  // payloads are derived from atoms the plugin already has read access
  // to via the corresponding read methods.

  // CMS
  'cms.getCollections': 'cms:read',
  'cms.getActiveCollection': 'cms:read',
  'cms.getActiveManagedCollection': 'cms:read',
  'cms.getManagedCollections': 'cms:read',
  'cms.createCollection': 'cms:write',
  'cms.createManagedCollection': 'cms:write',
  'cms.getFields': 'cms:read',
  'cms.addFields': 'cms:write',
  'cms.removeFields': 'cms:write',
  'cms.setFieldOrder': 'cms:write',
  'cms.getItems': 'cms:read',
  'cms.addItems': 'cms:write',
  'cms.removeItems': 'cms:write',
  'cms.setItemOrder': 'cms:write',

  // Localization
  'localization.getLocales': 'localization:read',
  'localization.getActiveLocale': 'localization:read',
  'localization.getDefaultLocale': 'localization:read',
  'localization.getLocalizationGroups': 'localization:read',
  'localization.setLocalizationData': 'localization:write',

  // Redirects
  'redirects.list': 'redirects:read',
  'redirects.add': 'redirects:write',
  'redirects.remove': 'redirects:write',
  'redirects.setOrder': 'redirects:write',
  // Plugin's own KV — always allowed (scoped per plugin), no perm
  // required. `pluginData:*` is implicit.
  // ui.* methods don't gate — they affect the plugin's own window only.
  // mode/user/project — informational, no permission required.
};

/**
 * Throws `PermissionDeniedError` if the plugin's manifest doesn't
 * declare a permission required by `method`. Pass 1 short-circuits
 * to "always allow" because we have no install-time grant flow yet —
 * see file header.
 */
export function assertCan(manifest: PluginManifest, method: string): void {
  const required = methodPermissionMap[method];
  if (!required) return; // no permission required for this method
  // Pass 1: auto-grant every declared permission. The check still
  // ensures the plugin's manifest at least *declares* the permission;
  // a plugin that never asked for `canvas:write` still gets denied,
  // which catches authoring bugs early.
  if (manifest.permissions.includes(required)) return;
  throw new PermissionDeniedError(required, method);
}

/**
 * Pass-1 helper used by the SDK router to map an unknown method to a
 * 'NOT_IMPLEMENTED' response. We stub every namespace this way until
 * its handlers land in subsequent passes — plugins get a clear error
 * rather than a silent timeout.
 */
export class NotImplementedError extends Error {
  constructor(public readonly method: string) {
    super(`Plugin SDK method "${method}" is not implemented in this host build`);
    this.name = 'NotImplementedError';
  }
}
