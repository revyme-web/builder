// sources/project.ts — Curated high-signal entries for the empty-query view.
//
// These carry `featured: true`, which is what `getDefaultResults` filters
// on. Once the MRU list has entries it takes precedence, so these act as
// the fallback a brand-new project sees rather than a permanent header.

import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import type { SearchableItem } from '../search-types';
import type { SearchSource } from './types';

export const projectSource: SearchSource = () => {
  const items: SearchableItem[] = [
    {
      id: 'project:browse-plugins',
      name: 'Browse Plugins',
      category: 'project',
      keywords: ['browse', 'all', 'plugins', 'marketplace', 'install'],
      action: { type: 'set-palette-filter', filter: 'plugins' },
      featured: true,
    },
    {
      id: 'project:new-project',
      name: 'New Project',
      category: 'project',
      keywords: ['new', 'project', 'create', 'start'],
      shortcut: '⌃⌥N',
      action: { type: 'execute-command', commandId: 'new-project' },
      featured: true,
    },
  ];

  if (CLOUD_ENABLED) {
    items.push({
      id: 'project:create-remix-link',
      name: 'Create Remix Link',
      category: 'project',
      keywords: ['remix', 'link', 'share', 'template', 'publish', 'fork'],
      action: { type: 'execute-command', commandId: 'create-remix-link' },
      featured: true,
    });
  }

  return items;
};
