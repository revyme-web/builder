// plugins/cloud-plugins.ts — installed cloud-plugin registry.
//
// Cloud plugins (Tier 3) are NOT stored as source in the project. The
// project just holds a pointer per installed plugin in
// `plugins/installed.json`. The iframe runtime fetches the bundled
// HTML directly from `bundleUrl` on each launch — no local compilation.
//
// Tier 2 (local) plugins still live as `.tsx` source in `plugins/`.
// The two tiers coexist in the LibraryPanel: local entries discovered
// by scanning `plugins/*.tsx`, cloud entries read from this file.
//
// Storage is intentionally a visible JSON file (not a hidden atom) so
// it diffs cleanly in version control and a user can sanity-check
// what's installed by opening the file.

import { atom, getDefaultStore } from 'jotai';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { trace } from '@/shared/debug-trace';

/** Pointer record for a cloud plugin installed in this project. */
export interface InstalledCloudPlugin {
  /** Marketplace plugin id (revyme-cloud `creator_components.id`). */
  id: string;
  /** Display name shown in the LibraryPanel. */
  name: string;
  /** Slug for friendly URLs. May be null if backend doesn't have it yet. */
  slug: string | null;
  /** Iframe `src` URL — points at the bundled HTML on revyme-cloud's CDN. */
  bundleUrl: string;
  /** Source URL when visibility=open, null when closed. Format depends
   *  on `sourceKind`: `.tsx` for single-file (Revyme-built), `.zip` for
   *  multi-file (authored externally). */
  sourceUrl: string | null;
  /** Drives the LibraryPanel right-click menu:
   *    'single' → "Import locally" (auto-fork into plugins/<Name>.tsx)
   *    'multi'  → "Download source" (just opens the zip URL)
   *    null     → neither (closed-source) */
  sourceKind: 'single' | 'multi' | null;
  /** Semver-like version string. Used for "Update available" detection. */
  version: string;
  visibility: 'open' | 'closed';
  /** Optional thumbnail shown in LibraryPanel + marketplace cards. */
  iconUrl: string | null;
  /** Plugin author display name. */
  author: string | null;
  /** Epoch ms when this entry was added — sorts "most recent first". */
  installedAt: number;
}

/** ProjectFS path where the install list is persisted. Visible so users
 *  can see what they have installed in their project tree. */
const INSTALLED_PATH = 'plugins/installed.json';

interface InstalledFile {
  /** Schema version — bumped when the on-disk shape changes so older
   *  projects can be migrated forward without crashing the loader. */
  version: 1;
  cloud: InstalledCloudPlugin[];
}

const EMPTY_FILE: InstalledFile = { version: 1, cloud: [] };

/**
 * Load the install list from `plugins/installed.json`. Returns an empty
 * file when missing or malformed — single bad row doesn't poison the
 * list, same lenient strategy as `registry.ts` for installed Tier 1
 * plugins.
 */
function loadFromFs(): InstalledCloudPlugin[] {
  const raw = projectFS.readFile(INSTALLED_PATH);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as InstalledFile;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.cloud)) return [];
    return parsed.cloud
      .filter((p): p is InstalledCloudPlugin =>
        !!p && typeof p === 'object' &&
        typeof p.id === 'string' &&
        typeof p.name === 'string' &&
        typeof p.bundleUrl === 'string' &&
        (p.visibility === 'open' || p.visibility === 'closed'),
      )
      // Backfill `sourceKind` for entries written before the field
      // was added. Derives from the URL extension so existing installs
      // stay usable across the upgrade.
      .map((p) => ({
        ...p,
        sourceKind: (p as InstalledCloudPlugin).sourceKind ?? (
          p.sourceUrl
            ? (p.sourceUrl.toLowerCase().endsWith('.zip') ? 'multi' as const : 'single' as const)
            : null
        ),
      }));
  } catch (err) {
    trace.error('cloud-plugins:load-failed', { error: String(err) });
    return [];
  }
}

function persistToFs(plugins: InstalledCloudPlugin[]): void {
  const data: InstalledFile = { version: 1, cloud: plugins };
  projectFS.writeFile(INSTALLED_PATH, JSON.stringify(data, null, 2));
  trace.action('cloud-plugins:persist', { count: plugins.length });
}

/** Reactive list of installed cloud plugins for this project. */
export const installedCloudPluginsAtom = atom<InstalledCloudPlugin[]>(loadFromFs());

/**
 * Currently-launched cloud plugin id (cloud `creator_components.id`).
 * Mutually exclusive with `openPluginIdAtom` and
 * `launchedProjectPluginAtom` — PluginRuntimeWindow clears any
 * already-open window before setting a new launched plugin.
 */
export const launchedCloudPluginAtom = atom<string | null>(null);

const store = getDefaultStore();

/**
 * Install (or update) a cloud plugin entry in this project. If the
 * plugin id is already installed, the existing row is replaced — this
 * is how "Update to latest" works: same id, fresh metadata. Returns
 * the persisted row.
 */
export function installCloudPlugin(plugin: Omit<InstalledCloudPlugin, 'installedAt'>): InstalledCloudPlugin {
  const entry: InstalledCloudPlugin = { ...plugin, installedAt: Date.now() };
  const current = store.get(installedCloudPluginsAtom);
  const next = current.filter((p) => p.id !== plugin.id);
  next.push(entry);
  store.set(installedCloudPluginsAtom, next);
  persistToFs(next);
  // Bump project version so LibraryPanel re-renders without a manual refresh.
  store.set(projectVersionAtom, (v) => v + 1);
  trace.action('cloud-plugins:install', { id: plugin.id, name: plugin.name });
  return entry;
}

/** Remove a cloud plugin pointer from this project. Closes the launched
 *  window if it was this plugin. */
export function uninstallCloudPlugin(id: string): void {
  const current = store.get(installedCloudPluginsAtom);
  const next = current.filter((p) => p.id !== id);
  if (next.length === current.length) return;
  store.set(installedCloudPluginsAtom, next);
  persistToFs(next);
  store.set(projectVersionAtom, (v) => v + 1);
  if (store.get(launchedCloudPluginAtom) === id) {
    store.set(launchedCloudPluginAtom, null);
  }
  trace.action('cloud-plugins:uninstall', { id });
}
