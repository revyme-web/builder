// sources/panels.ts — Left-panel switches (Insert, Layers, Library, CMS, …).
//
// Lowest-weight category in CATEGORY_CONFIG: "open the Layers panel" is
// almost never what someone means when they type a layer's name, so
// these sit below the content they'd otherwise crowd out.

import {
  PagesLayersIcon,
  LibraryStackIcon,
  GlobeInternationalIcon,
  ChatImageIcon,
  CmsIcon,
  InsertPlusIcon,
} from '@/shared/icons';
import type { LeftPanelId } from '@/code/stores/left-panel-store';
import type { SearchableItem } from '../search-types';
import type { SearchSource } from './types';

const TABS: Array<{
  id: LeftPanelId;
  name: string;
  keywords: string[];
  icon?: SearchableItem['icon'];
}> = [
  { id: 'insert',       name: 'Insert',         keywords: ['insert', 'add', 'new', 'element', 'block'], icon: InsertPlusIcon },
  // Same order as the LeftMenu — Layers first, then Pages. (Both show the
  // Pages glyph here: the toolbar's LayersIcon is local to LeftMenu.tsx and
  // isn't exported from @/shared/icons.)
  // One panel, two tabs — but keep BOTH entries: "pages" and "layers" are the
  // words people actually type, and either should land them on the panel.
  { id: 'pages-layers', name: 'Layers',         keywords: ['layers', 'tree', 'outline', 'hierarchy', 'nodes'], icon: PagesLayersIcon },
  { id: 'pages-layers', name: 'Pages',          keywords: ['pages', 'files', 'routes', 'site map'], icon: PagesLayersIcon },
  { id: 'library',      name: 'Library',        keywords: ['library', 'components', 'sketches', 'vectors', 'assets'], icon: LibraryStackIcon },
  { id: 'presets',      name: 'Presets',        keywords: ['presets', 'styles', 'tokens', 'design system'] },
  { id: 'media',        name: 'Media Gallery',  keywords: ['media', 'gallery', 'images', 'photos', 'video', 'upload'], icon: ChatImageIcon },
  { id: 'locale',       name: 'Localization',   keywords: ['locale', 'language', 'i18n', 'translation'], icon: GlobeInternationalIcon },
  { id: 'cms',          name: 'CMS / Blog',     keywords: ['cms', 'blog', 'content', 'collections', 'database'], icon: CmsIcon },
];

export const panelsSource: SearchSource = () =>
  TABS.map((tab) => ({
    // Keyed by NAME, not panel id: Layers and Pages are two entries pointing
    // at the same panel, and `tab:${tab.id}` alone would give them identical
    // result ids — duplicate React keys and a selection that jumps between
    // the two rows.
    id: `tab:${tab.id}:${tab.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name: tab.name,
    category: 'tabs' as const,
    keywords: [...tab.keywords, 'tab', 'panel', 'sidebar'],
    icon: tab.icon ?? null,
    action: { type: 'open-left-panel' as const, panelId: tab.id },
  }));
