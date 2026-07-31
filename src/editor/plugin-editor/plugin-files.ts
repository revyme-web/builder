// editor/plugin-editor/plugin-files.ts — projectFS helpers for plugin source files.
//
// Plugins authored in-browser are stored as `plugins/{Name}.tsx` —
// a project primitive alongside `components/` and
// `icons/`. Each file is one self-contained plugin (no separate
// `manifest.json` for Tier 2; we derive the manifest from the
// filename + a minimal default permission set).
//
// Tier 1 plugins (sideloaded via dev URL) live entirely outside
// projectFS — they have their own `manifest.json` over HTTP. This
// module is only for the in-browser editor flow.

import { projectFS } from '@/code/project/project-fs';
import { modifyProjectFile } from '@/code/project/modify-file';
import type { PluginManifest } from '@revyme/plugin-sdk';
import { buildStarterTemplate } from './plugin-bundler';
import { parseComponentName, setComponentName } from '@/code/components/component-ops';
import { trace } from '@/shared/debug-trace';

const PLUGINS_DIR = 'plugins/';
const PLUGIN_EXT = '.tsx';

/** True if this projectFS path is a Tier 2 (in-browser-authored) plugin file. */
function isPluginFilePath(filePath: string): boolean {
  return filePath.startsWith(PLUGINS_DIR) && filePath.endsWith(PLUGIN_EXT);
}

/** Internal name (PascalCase, no extension) → file path. */
function pluginInternalNameToPath(internalName: string): string {
  return `${PLUGINS_DIR}${internalName}${PLUGIN_EXT}`;
}

/** File path → internal name. Inverse of `pluginInternalNameToPath`. */
export function pluginPathToInternalName(filePath: string): string {
  return filePath.replace(PLUGINS_DIR, '').replace(PLUGIN_EXT, '');
}

/** Every Tier 2 plugin file currently in projectFS. */
export function listPluginFiles(): string[] {
  return projectFS.listFiles().filter(isPluginFilePath).sort();
}

/**
 * Sanitize a user-supplied display name into a PascalCase file basename.
 * Mirrors the rule used by `component-ops.ts` so a plugin and a
 * component named the same end up with predictable file names.
 */
export function toPascalCase(input: string): string {
  return (
    input
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join('') || 'Plugin'
  );
}

/** Pick a unique internal name. Appends -2, -3, ... when the base collides. */
function makeUniquePluginName(base: string): string {
  const pascal = toPascalCase(base);
  if (!projectFS.exists(pluginInternalNameToPath(pascal))) return pascal;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${pascal}${i}`;
    if (!projectFS.exists(pluginInternalNameToPath(candidate))) return candidate;
  }
  return `${pascal}${Date.now().toString(36).slice(-4)}`;
}

/**
 * Create a new plugin file with the starter template. Returns the
 * file path so callers can switch to it in the editor immediately.
 */
export function createPluginFile(displayName: string): string {
  const internalName = makeUniquePluginName(displayName);
  const filePath = pluginInternalNameToPath(internalName);
  const pluginId = `local.${internalName.toLowerCase()}`;
  const code = buildStarterTemplate(pluginId, displayName);
  projectFS.writeFile(filePath, code);
  trace.action('plugin-files:create', { filePath, displayName, internalName });
  return filePath;
}

/** Read a plugin's source. Returns empty string when the file's missing. */
export function readPluginSource(filePath: string): string {
  return projectFS.readFile(filePath) ?? '';
}

/**
 * Write new source for a plugin. Routes through `modifyProjectFile` so
 * any pending mutation queue work flushes first — same convention the
 * rest of the editor uses for read→modify→write cycles.
 */
export function writePluginSource(filePath: string, source: string): void {
  modifyProjectFile(filePath, () => source);
  trace.action('plugin-files:write', { filePath, sizeBytes: source.length });
}

/** Delete a plugin file. */
export function deletePluginFile(filePath: string): void {
  if (!isPluginFilePath(filePath)) return;
  projectFS.deleteFile(filePath);
  trace.action('plugin-files:delete', { filePath });
}

/**
 * The display label for a plugin: the `@name` annotation if present, else the
 * filename. Mirrors `getFileDisplayName` for components — the file PATH stays
 * put (so folder placement, the open editor path, and the derived manifest id
 * are all stable); only the shown label changes.
 */
export function getPluginDisplayName(filePath: string): string {
  const code = projectFS.readFile(filePath);
  return (code && parseComponentName(code)) || pluginPathToInternalName(filePath);
}

/**
 * Rename a plugin by writing/updating its `@name` annotation. We deliberately
 * DON'T move the file — a rename only changes the display label (Library row +
 * runtime popup header), leaving the path, `local.<id>` manifest id, folder
 * membership, and any open-editor reference untouched.
 */
export function renamePluginFile(filePath: string, newName: string): void {
  if (!isPluginFilePath(filePath)) return;
  const trimmed = newName.trim();
  if (!trimmed) return;
  const code = readPluginSource(filePath);
  if (!code) return;
  const next = setComponentName(code, trimmed);
  if (next === code) return;
  writePluginSource(filePath, next);
  trace.action('plugin-files:rename', { filePath, newName: trimmed });
}

/**
 * Build a synthetic `PluginManifest` for a Tier 2 plugin. There's no
 * `manifest.json` on disk — this is the contract `PluginRuntimeWindow`
 * needs to attach a `PluginRouter`.
 *
 * PERMISSIONS — Tier 2 plugins are authored by the user IN THEIR OWN
 * PROJECT (the source lives in projectFS). Unlike Tier 1 sideloads
 * or marketplace installs, there's no "untrusted code from a third
 * party" vector — the user wrote the code or pasted it themselves.
 * So we grant every wired permission by default. When Tier 2 grows
 * a header-comment manifest (`// @plugin-permissions canvas:write,
 * presets:read, ...`) plugin authors can opt-down to a narrower set,
 * but the friction-free default is "all of them." Mirrors how
 * VSCode treats workspace-trust: code inside the project gets full
 * access; code from outside requires explicit grants.
 */
const TIER2_DEFAULT_PERMISSIONS = [
  'canvas:read', 'canvas:write',
  'pages:read', 'pages:write',
  'components:read', 'components:write',
  'sketches:read', 'sketches:write',
  'vectors:read', 'vectors:write',
  'animations:read', 'animations:write',
  'variables:read', 'variables:write',
  'presets:read', 'presets:write',
  'fonts:read',
  'assets:read', 'assets:write',
  'text:read', 'text:write',
  'cms:read', 'cms:write',
  'localization:read', 'localization:write',
  'codeFiles:read', 'codeFiles:write',
  'customCode:read', 'customCode:write',
  'secrets:read', 'secrets:write',
  'redirects:read', 'redirects:write',
  // Tier 2 plugins live INSIDE the project, authored by the user
  // themselves — same workspace-trust model as VSCode's "trusted
  // workspace". A network wildcard is appropriate here because the
  // user is fully aware of what their own plugin code does. Tier 1
  // (sideloaded / marketplace-installed) plugins must declare
  // narrower origins explicitly.
  'network:*',
];

/**
 * Cloud-plugin permissions. Marketplace plugins explicitly installed
 * by the user (via cmd+K) get the same broad permission set as Tier 2:
 * installing a plugin is the user's consent. Long-term we'll surface
 * a permission-prompt UI on install so plugin authors can declare
 * narrower scopes and users see what's being granted — until that
 * lands, "installed = trusted" mirrors how the rest of the editor
 * treats user actions (paste, drag-import).
 */
export const TIER3_DEFAULT_PERMISSIONS = TIER2_DEFAULT_PERMISSIONS;

export function deriveTier2Manifest(filePath: string): PluginManifest {
  const internalName = pluginPathToInternalName(filePath);
  // The manifest id stays PATH-derived (stable across renames); the display
  // name honors the `@name` annotation so the runtime popup header updates too.
  const code = projectFS.readFile(filePath) ?? '';
  return {
    id: `local.${internalName.toLowerCase()}`,
    name: parseComponentName(code) || internalName,
    version: '0.1.0',
    entry: filePath, // not loaded directly — bundler builds blob URL
    sdkVersion: '^1.0.0',
    mode: 'panel',
    permissions: TIER2_DEFAULT_PERMISSIONS,
  };
}
