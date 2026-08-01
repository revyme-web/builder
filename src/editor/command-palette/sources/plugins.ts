// sources/plugins.ts — Installed plugins across all three tiers.
//
//   Tier 1 — dev-URL plugins running on localhost
//   Tier 2 — project plugins authored inside this Revyme instance
//   Tier 3 — cloud/marketplace plugins the user has installed
//
// Only INSTALLED plugins live here. The marketplace catalogue is a
// network call and stays behind the "Plugins" tab, so typing in "All"
// never fires marketplace requests.

import { getDefaultStore } from 'jotai';
import { installedPluginsAtom } from '@/plugins/registry';
import { installedCloudPluginsAtom } from '@/plugins/cloud-plugins';
import { listPluginFiles, pluginPathToInternalName } from '@/editor/plugin-editor/plugin-files';
import type { SearchableItem } from '../search-types';
import type { SearchSource } from './types';

const store = getDefaultStore();

export const pluginsSource: SearchSource = () => {
  const items: SearchableItem[] = [];

  // Tier 2 — project plugins.
  for (const filePath of listPluginFiles()) {
    const internal = pluginPathToInternalName(filePath);
    items.push({
      id: `plugin:project:${filePath}`,
      name: internal,
      category: 'plugins',
      subcategory: 'Project',
      keywords: [internal.toLowerCase(), 'plugin', 'project', 'local', 'tier 2'],
      action: { type: 'launch-plugin', pluginTier: 'project', id: filePath },
    });
  }

  // Tier 1 — dev-URL plugins.
  for (const p of store.get(installedPluginsAtom)) {
    items.push({
      id: `plugin:installed:${p.manifest.id}`,
      name: p.manifest.name,
      category: 'plugins',
      subcategory: 'Dev URL',
      keywords: [p.manifest.name.toLowerCase(), 'plugin', 'dev', 'localhost', 'tier 1'],
      description: p.manifest.description,
      action: { type: 'launch-plugin', pluginTier: 'installed', id: p.manifest.id },
    });
  }

  // Tier 3 — installed cloud plugins.
  for (const p of store.get(installedCloudPluginsAtom)) {
    items.push({
      id: `plugin:cloud:${p.id}`,
      name: p.name,
      category: 'plugins',
      subcategory: p.author ? `By ${p.author}` : 'Marketplace',
      keywords: [
        p.name.toLowerCase(),
        'plugin', 'cloud', 'marketplace', 'tier 3',
        ...(p.author ? [p.author.toLowerCase()] : []),
      ],
      action: { type: 'launch-plugin', pluginTier: 'cloud', id: p.id },
    });
  }

  return items;
};
