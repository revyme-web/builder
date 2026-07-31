// plugins/cloud-plugin-actions.ts — user-facing actions on cloud
// plugins from the LibraryPanel right-click menu.
//
// Currently just `importCloudPluginLocally`: downloads the open-source
// TSX from a cloud plugin's `sourceUrl` and writes it to
// `plugins/<Slug>.tsx`, after which the row promotes to a regular
// Tier 2 plugin. Effectively a fork — the user owns the local copy
// and the cloud version's future updates don't follow.

import { toast } from 'sonner';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { uninstallCloudPlugin, type InstalledCloudPlugin } from './cloud-plugins';
import { getDefaultStore } from 'jotai';
import { trace } from '@/shared/debug-trace';

const store = getDefaultStore();

/**
 * Find a unique file path under `plugins/` for a plugin name. If
 * `plugins/MyPlugin.tsx` exists, returns `plugins/MyPlugin-2.tsx`,
 * then `-3`, etc. Matches how the rest of the editor handles name
 * collisions (vectors use the same pattern).
 */
function uniquePluginPath(baseName: string): string {
  const sanitized = baseName.replace(/[^A-Za-z0-9_-]/g, '');
  const safe = sanitized || 'Plugin';
  let candidate = `plugins/${safe}.tsx`;
  let i = 2;
  while (projectFS.readFile(candidate) != null) {
    candidate = `plugins/${safe}-${i}.tsx`;
    i++;
  }
  return candidate;
}

/**
 * Import an open-visibility cloud plugin as a local Tier 2 file. The
 * cloud pointer is removed once the local copy is written — the
 * LibraryPanel row promotes from cloud (closed icon, no Edit option)
 * to project (puzzle icon, Edit available).
 *
 * Fails loudly via toast if the source URL is missing or fetch fails.
 * Closed-visibility plugins shouldn't get here (the menu item is
 * hidden) — defensive check anyway.
 */
export async function importCloudPluginLocally(plugin: InstalledCloudPlugin): Promise<void> {
  if (plugin.visibility !== 'open' || !plugin.sourceUrl) {
    toast.error('This plugin is closed-source — source is not available');
    return;
  }
  if (plugin.sourceKind === 'multi') {
    toast.error('This plugin has multi-file source — use "Download source" to grab the zip');
    return;
  }
  try {
    // Route through the backend's source proxy so we get consistent
    // auth/visibility checks (and avoid leaking the raw R2 URL into
    // the user's network panel). The proxy returns 403 for closed
    // plugins even if we somehow got here with a sourceUrl set.
    const res = await fetch(`/api/plugins/source/${encodeURIComponent(plugin.id)}`);
    if (!res.ok) {
      toast.error(`Couldn't fetch source: HTTP ${res.status}`);
      return;
    }
    const source = await res.text();
    if (!source || source.length < 10) {
      toast.error('Source file looks empty or invalid');
      return;
    }
    const path = uniquePluginPath(plugin.name);
    projectFS.writeFile(path, source);
    // Remove the cloud pointer — the plugin now lives locally and the
    // user can edit it. Same as forking: cloud updates don't follow.
    uninstallCloudPlugin(plugin.id);
    store.set(projectVersionAtom, (v) => v + 1);
    trace.action('cloud-plugin:import-locally', { id: plugin.id, path });
    toast.success(`Imported ${plugin.name} to ${path}`);
  } catch (err) {
    trace.error('cloud-plugin:import-failed', { id: plugin.id, error: String(err) });
    toast.error(`Import failed: ${(err as Error).message}`);
  }
}

/**
 * Open the source-archive download for a multi-file cloud plugin.
 * Goes through the auth-gated backend proxy (`/api/plugins/source/:id`)
 * which streams the zip back with the right Content-Disposition so the
 * browser saves it instead of navigating. Closed plugins return 403;
 * single-file plugins shouldn't reach this code (the menu hides it).
 */
export function downloadCloudPluginArchive(plugin: InstalledCloudPlugin): void {
  if (plugin.visibility !== 'open' || !plugin.sourceUrl) {
    toast.error('This plugin is closed-source — source is not available');
    return;
  }
  if (plugin.sourceKind !== 'multi') {
    toast.error('This plugin has single-file source — use "Import locally" instead');
    return;
  }
  // Open the backend's source proxy. The endpoint sets
  // Content-Disposition: attachment so the browser saves it as a zip
  // rather than navigating to it. New tab keeps the user's editor
  // session clean in case the download stalls.
  const url = `/api/plugins/source/${encodeURIComponent(plugin.id)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
  trace.action('cloud-plugin:download-archive', { id: plugin.id });
}
