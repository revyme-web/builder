// plugins/registry.ts — installed plugin list + jotai atoms.
//
// A plugin "install" in Pass 1 is just remembering the URL the user
// pasted, plus the manifest fetched from `${url}/manifest.json`.
// The list persists in localStorage so plugins survive reloads.
// Pass 4+ will store this server-side once the cloud version lands.
//
// One installed plugin = `{ url, manifest, installedAt }`. Identity is
// the manifest's `id` (reverse-DNS string). Re-installing the same id
// from a different URL replaces the entry — useful for dev where the
// localhost port might change between sessions.
//
// Loaded plugins (the iframes currently mounted in the DOM) are tracked
// separately in `loadedPluginsAtom` — install ≠ load. A plugin is
// loaded when its popup is open in the editor; closing the popup
// unmounts the iframe but keeps the install record.

import { atom, getDefaultStore } from 'jotai';
import type { PluginManifest } from '@revyme/plugin-sdk';
import { parseManifest } from './manifest';
import { trace } from '@/shared/debug-trace';

export interface InstalledPlugin {
  /** Base URL the iframe loads from. May be a localhost dev URL or a CDN URL. */
  url: string;
  manifest: PluginManifest;
  /** Epoch ms — used by the Library section to sort by recent. */
  installedAt: number;
}

const STORAGE_KEY = 'revyme:plugins:installed';

/**
 * Hydrate from localStorage on module load. Survives page reloads;
 * cleared on explicit uninstall. We tolerate corrupt entries — a
 * single bad record doesn't poison the whole list.
 */
function loadFromStorage(): InstalledPlugin[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out: InstalledPlugin[] = [];
    for (const v of arr) {
      try {
        if (!v || typeof v !== 'object') continue;
        if (typeof v.url !== 'string' || typeof v.installedAt !== 'number') continue;
        const manifest = parseManifest(v.manifest);
        out.push({ url: v.url, manifest, installedAt: v.installedAt });
      } catch {
        // Skip — see file header.
      }
    }
    return out;
  } catch {
    return [];
  }
}

function persist(plugins: InstalledPlugin[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(plugins));
  } catch (e) {
    trace.error('plugin-registry:persist-failed', { error: String(e) });
  }
}

/** Source of truth for installed plugins. */
export const installedPluginsAtom = atom<InstalledPlugin[]>(loadFromStorage());

/** Plugins currently mounted in the editor (at most one popup open at a time in Pass 1). */
const loadedPluginsAtom = atom<Set<string>>(new Set<string>());

/**
 * Currently-open plugin id — drives `PluginRuntimeWindow`. Null when no
 * plugin window is showing. Setting this to an installed plugin's id
 * mounts its iframe; setting to null unmounts.
 *
 * Used for Tier 1 (sideloaded via dev URL) plugins. Tier 2
 * (project-authored, lives in `plugins/*.tsx`) plugins use
 * `launchedProjectPluginAtom` below — separate atom because the
 * mount path differs: Tier 1 loads a remote URL, Tier 2 compiles
 * source to a blob URL. Both render through the same popup host.
 */
export const openPluginIdAtom = atom<string | null>(null);

/**
 * Currently-launched Tier 2 plugin (file path, e.g. `plugins/Foo.tsx`).
 * Set when the user clicks a project plugin row in Library; null
 * when the popup closes. `PluginRuntimeWindow` reads this, compiles the
 * file's source via `bundlePluginToBlobUrl`, and renders the blob
 * URL in the same iframe shell as installed plugins.
 *
 * Mutually exclusive with `openPluginIdAtom` — only one plugin
 * popup at a time. Setting either atom clears the other (the popup
 * host enforces this on mount).
 */
export const launchedProjectPluginAtom = atom<string | null>(null);

const store = getDefaultStore();

/**
 * Add a plugin from a base URL. Fetches `${url}/manifest.json`,
 * validates, and persists. Replaces any existing entry with the same id.
 */
export async function installPluginFromUrl(url: string): Promise<InstalledPlugin> {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('installPluginFromUrl: empty URL');
  const manifestUrl = `${trimmed}/manifest.json`;
  let raw: unknown;
  try {
    // Cache-bust: a dev plugin's manifest changes as the author iterates
    // (new permissions, size, etc.). Without this the browser HTTP cache
    // can serve a STALE manifest on re-add, so newly-declared permissions
    // never reach the gate (the "PERMISSION_DENIED after adding it" trap).
    const res = await fetch(`${manifestUrl}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${manifestUrl}`);
    }
    raw = await res.json();
  } catch (e) {
    throw new Error(`installPluginFromUrl: ${(e as Error).message}`);
  }
  const manifest = parseManifest(raw);
  const entry: InstalledPlugin = { url: trimmed, manifest, installedAt: Date.now() };
  const current = store.get(installedPluginsAtom);
  const next = current.filter((p) => p.manifest.id !== manifest.id);
  next.push(entry);
  store.set(installedPluginsAtom, next);
  persist(next);
  trace.action('plugin-registry:install', { id: manifest.id, url: trimmed });
  return entry;
}

/** Remove an installed plugin by id. Closes its window if currently open. */
export function uninstallPlugin(id: string): void {
  const current = store.get(installedPluginsAtom);
  const next = current.filter((p) => p.manifest.id !== id);
  if (next.length === current.length) return;
  store.set(installedPluginsAtom, next);
  persist(next);
  if (store.get(openPluginIdAtom) === id) {
    store.set(openPluginIdAtom, null);
  }
  trace.action('plugin-registry:uninstall', { id });
}

/** Resolve a plugin's full entry URL (base URL + manifest entry path). */
export function getPluginEntryUrl(plugin: InstalledPlugin): string {
  const entry = plugin.manifest.entry.replace(/^\/+/, '');
  return `${plugin.url}/${entry}`;
}

/** Find an installed plugin by id. Returns undefined if not installed. */
export function getInstalledPlugin(id: string): InstalledPlugin | undefined {
  return store.get(installedPluginsAtom).find((p) => p.manifest.id === id);
}
