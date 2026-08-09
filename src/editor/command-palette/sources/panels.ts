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
  { id: 'layers',       name: 'Layers',         keywords: ['layers', 'tree', 'outline', 'hierarchy', 'nodes'], icon: PagesLayersIcon },
  { id: 'pages-layers', name: 'Pages',          keywords: ['pages', 'files', 'routes', 'site map'], icon: PagesLayersIcon },
  { id: 'library',      name: 'Library',        keywords: ['library', 'components', 'sketches', 'vectors', 'assets'], icon: LibraryStackIcon },
  { id: 'presets',      name: 'Presets',        keywords: ['presets', 'styles', 'tokens', 'design system'] },
  { id: 'media',        name: 'Media Gallery',  keywords: ['media', 'gallery', 'images', 'photos', 'video', 'upload'], icon: ChatImageIcon },
  { id: 'locale',       name: 'Localization',   keywords: ['locale', 'language', 'i18n', 'translation'], icon: GlobeInternationalIcon },
  { id: 'cms',          name: 'CMS / Blog',     keywords: ['cms', 'blog', 'content', 'collections', 'database'], icon: CmsIcon },
];

export const panelsSource: SearchSource = () =>
  TABS.map((tab) => ({
    id: `tab:${tab.id}`,
    name: tab.name,
    category: 'tabs' as const,
    keywords: [...tab.keywords, 'tab', 'panel', 'sidebar'],
    icon: tab.icon ?? null,
    action: { type: 'open-left-panel' as const, panelId: tab.id },
  }));
