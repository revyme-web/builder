// search-registry.ts — Source of truth for the cmd+K palette's
// searchable items.
//
// Five categories ship today (see search-types.ts):
//   1. commands — undo/redo, copy/paste, lock/hide, new project, …
//   2. draw     — tool-mode switches (Frame, Text, Rectangle, …)
//   3. tabs     — left-panel switches (Insert, Library, Presets, …)
//   4. library  — every local project file (components, sketches,
//                 vectors, icon sets, templates, plugins) — items
//                 update on every projectFS write because `getAll`
//                 reads the live atom state
//   5. plugins  — installed Tier 1/2/3 plugins
//   6. pages    — every page file (`app/**/page.tsx`)
//
// Builder reference: `builder/src/builder/context/search/search-registry.ts`.
// We diverge in two ways:
//   - Commands list is hand-curated against Revyme's actual shortcuts
//   - Library section pulls live from projectFS instead of preset stores

import { getDefaultStore } from 'jotai';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import {
  PagesLayersIcon,
  LibraryStackIcon,
  GlobeInternationalIcon,
  ChatImageIcon,
  CmsIcon,
  InsertPlusIcon,
  ComponentClusterIcon,
  ShapeSquareIcon,
  ShapeCircleIcon,
  ShapeTriangleIcon,
  ShapePathIcon,
  LayoutRowsIcon,
  LayoutColumnsIcon,
  LayoutGridIcon,
  TextToolbarIcon,
  CursorIcon,
} from '@/shared/icons';
import { projectFS } from '@/code/project/project-fs';
import {
  isComponentFilePath,
  isIconSetFilePath,
  listPageFiles,
  getFileDisplayName,
} from '@/code/project/active-file-store';
import { listTemplates } from '@/code/project/template-ops';
import { installedPluginsAtom } from '@/plugins/registry';
import { installedCloudPluginsAtom } from '@/plugins/cloud-plugins';
import { listPluginFiles, pluginPathToInternalName } from '@/editor/plugin-editor/plugin-files';
import type { SearchableItem } from './search-types';

const store = getDefaultStore();

// ─── Commands ───────────────────────────────────────────────────────────────
// Each id here MUST be handled in `useSearchActions.ts`'s
// `executeCommand()` switch. Adding a new command = add to both.

const COMMANDS: Array<{
  id: string;
  name: string;
  shortcut?: string;
  keywords: string[];
  icon?: SearchableItem['icon'];
}> = [
  // File / project
  { id: 'new-project',       name: 'New Project',         shortcut: '⌃⌥N', keywords: ['new', 'project', 'create', 'start'] },
  // Editing
  { id: 'undo',              name: 'Undo',                shortcut: '⌃Z',  keywords: ['undo', 'reverse', 'history', 'back'] },
  { id: 'redo',              name: 'Redo',                shortcut: '⌃⇧Z', keywords: ['redo', 'forward', 'history'] },
  { id: 'copy',              name: 'Copy',                shortcut: '⌃C',  keywords: ['copy', 'clipboard'] },
  { id: 'paste',             name: 'Paste',               shortcut: '⌃V',  keywords: ['paste', 'clipboard'] },
  { id: 'cut',               name: 'Cut',                 shortcut: '⌃X',  keywords: ['cut', 'clipboard'] },
  { id: 'duplicate',         name: 'Duplicate',           shortcut: '⌃D',  keywords: ['duplicate', 'copy'] },
  { id: 'delete',            name: 'Delete',              shortcut: '⌫',   keywords: ['delete', 'remove', 'trash'] },
  // Visibility / state toggles
  { id: 'toggle-lock',       name: 'Lock / Unlock',       shortcut: '⌃L',  keywords: ['lock', 'unlock', 'freeze'] },
  { id: 'toggle-visibility', name: 'Hide / Show',         shortcut: '⌃H',  keywords: ['hide', 'show', 'visibility'] },
  // Structure
  { id: 'wrap-in-frame',     name: 'Wrap in Frame',       shortcut: '⌥⇧A', keywords: ['wrap', 'frame', 'group', 'container'] },
  { id: 'wrap-in-layout',    name: 'Wrap in Layout',      shortcut: '⇧A',  keywords: ['wrap', 'layout', 'group', 'flex'] },
  { id: 'group-svgs',        name: 'Group SVGs',          shortcut: '⌃G',  keywords: ['group', 'svg', 'merge'] },
  { id: 'unfold-children',   name: 'Unfold Children',     shortcut: '⌃⌫',  keywords: ['unfold', 'unwrap', 'flatten', 'ungroup'] },
  // Zoom
  { id: 'zoom-in',           name: 'Zoom In',             shortcut: '⌃+',  keywords: ['zoom', 'in', 'magnify'] },
  { id: 'zoom-out',          name: 'Zoom Out',            shortcut: '⌃-',  keywords: ['zoom', 'out'] },
  { id: 'zoom-to-fit',       name: 'Zoom to Fit',         shortcut: '⇧1',  keywords: ['zoom', 'fit', 'fit all'] },
  { id: 'zoom-to-selection', name: 'Zoom to Selection',   shortcut: '⇧2',  keywords: ['zoom', 'selection', 'focus'] },
  { id: 'zoom-100',          name: 'Zoom to 100%',        shortcut: '⇧3',  keywords: ['zoom', '100', 'reset', 'actual size'] },
  // Selection
  { id: 'select-parent',     name: 'Select Parent',       shortcut: 'ESC', keywords: ['select', 'parent', 'up'] },
  { id: 'select-children',   name: 'Select Children',     shortcut: '↵',   keywords: ['select', 'children', 'down', 'into'] },
  { id: 'select-replica',    name: 'Select Replica',      shortcut: '⇧B',  keywords: ['select', 'replica', 'duplicate', 'instance'] },
];

function registerCommands(items: Map<string, SearchableItem>) {
  for (const cmd of COMMANDS) {
    items.set(`cmd:${cmd.id}`, {
      id: `cmd:${cmd.id}`,
      name: cmd.name,
      category: 'commands',
      keywords: cmd.keywords,
      shortcut: cmd.shortcut,
      icon: cmd.icon ?? null,
      action: { type: 'execute-command', commandId: cmd.id },
    });
  }
}

// ─── Draw tools (basic elements) ────────────────────────────────────────────

const DRAW_TOOLS: Array<{
  id: string;
  name: string;
  mode: import('@/code/stores/tool-store').ToolMode;
  shortcut?: string;
  keywords: string[];
  icon?: SearchableItem['icon'];
}> = [
  { id: 'select',         name: 'Select',     mode: 'select',         shortcut: 'V',  keywords: ['select', 'pointer', 'cursor', 'move'], icon: CursorIcon },
  { id: 'frame',          name: 'Frame',      mode: 'frame',          shortcut: 'F',  keywords: ['frame', 'container', 'box', 'div'], icon: ShapeSquareIcon },
  { id: 'text',           name: 'Text',       mode: 'text',           shortcut: 'T',  keywords: ['text', 'type', 'label', 'paragraph'], icon: TextToolbarIcon },
  { id: 'layout-rows',    name: 'Rows',       mode: 'layout-rows',    shortcut: '⇧R', keywords: ['rows', 'horizontal', 'layout', 'flex', 'stack'], icon: LayoutRowsIcon },
  { id: 'layout-cols',    name: 'Columns',    mode: 'layout-columns', shortcut: '⇧C', keywords: ['columns', 'vertical', 'layout', 'flex', 'stack'], icon: LayoutColumnsIcon },
  { id: 'layout-grid',    name: 'Grid',       mode: 'layout-grids',   shortcut: '⇧G', keywords: ['grid', 'css grid', 'layout'], icon: LayoutGridIcon },
  { id: 'shape-rect',     name: 'Rectangle',  mode: 'shape-rect',     shortcut: 'R',  keywords: ['rectangle', 'square', 'shape', 'box'], icon: ShapeSquareIcon },
  { id: 'shape-circle',   name: 'Circle',     mode: 'shape-ellipse',  shortcut: 'O',  keywords: ['circle', 'ellipse', 'oval', 'shape'], icon: ShapeCircleIcon },
  { id: 'shape-triangle', name: 'Triangle',   mode: 'shape-triangle', shortcut: '⇧T', keywords: ['triangle', 'polygon', 'shape'], icon: ShapeTriangleIcon },
  { id: 'shape-path',     name: 'Path',       mode: 'shape-path',     shortcut: 'P',  keywords: ['path', 'pen', 'vector', 'bezier'], icon: ShapePathIcon },
  { id: 'sketch',         name: 'Sketch',     mode: 'sketch',         shortcut: 'K',  keywords: ['sketch', 'draw', 'pencil', 'freehand'] },
];

function registerDrawTools(items: Map<string, SearchableItem>) {
  for (const tool of DRAW_TOOLS) {
    items.set(`draw:${tool.id}`, {
      id: `draw:${tool.id}`,
      name: tool.name,
      category: 'draw',
      keywords: [...tool.keywords, 'tool', 'draw', 'create'],
      shortcut: tool.shortcut,
      icon: tool.icon ?? null,
      action: { type: 'set-tool-mode', mode: tool.mode },
    });
  }
}

// ─── Tabs (left panel switches) ─────────────────────────────────────────────

const TABS: Array<{
  id: import('@/code/stores/left-panel-store').LeftPanelId;
  name: string;
  keywords: string[];
  icon?: SearchableItem['icon'];
}> = [
  { id: 'insert',       name: 'Insert',         keywords: ['insert', 'add', 'new', 'element', 'block'], icon: InsertPlusIcon },
  { id: 'pages-layers', name: 'Pages',          keywords: ['pages', 'files', 'routes', 'site map'], icon: PagesLayersIcon },
  { id: 'layers',       name: 'Layers',         keywords: ['layers', 'tree', 'outline', 'hierarchy', 'nodes'], icon: PagesLayersIcon },
  { id: 'library',      name: 'Library',        keywords: ['library', 'components', 'sketches', 'vectors', 'assets'], icon: LibraryStackIcon },
  { id: 'presets',      name: 'Presets',        keywords: ['presets', 'styles', 'tokens', 'design system'] },
  { id: 'media',        name: 'Media Gallery',  keywords: ['media', 'gallery', 'images', 'photos', 'video', 'upload'], icon: ChatImageIcon },
  { id: 'locale',       name: 'Localization',   keywords: ['locale', 'language', 'i18n', 'translation'], icon: GlobeInternationalIcon },
  { id: 'cms',          name: 'CMS / Blog',     keywords: ['cms', 'blog', 'content', 'collections', 'database'], icon: CmsIcon },
];

function registerTabs(items: Map<string, SearchableItem>) {
  for (const tab of TABS) {
    items.set(`tab:${tab.id}`, {
      id: `tab:${tab.id}`,
      name: tab.name,
      category: 'tabs',
      keywords: [...tab.keywords, 'tab', 'panel', 'sidebar'],
      icon: tab.icon ?? null,
      action: { type: 'open-left-panel', panelId: tab.id },
    });
  }
}

// ─── Local library (components / sketches / icon sets / templates / vectors) ─

function listAllVectorFiles(): string[] {
  // No dedicated helper today — match the path convention used by the
  // SDK's vectors namespace and the LibraryPanel: `vectors/<name>.tsx`.
  return projectFS.listFiles('vectors/').filter((f) => f.endsWith('.tsx'));
}

/** Internal name of a master file — same string `useComponentDrag`
 *  uses as the JSX tag for the dropped instance. Mirrors how Library
 *  panel rows derive their drag id. */
function fileToInternalName(filePath: string): string {
  // Strip the directory prefix + the `.tsx` suffix → `components/Hero.tsx`
  // → `Hero`. Matches what `pluginPathToInternalName` does for plugins
  // and what the LibraryPanel does inline for components/icons.
  return filePath
    .replace(/^(components|icons|vectors)\//, '')
    .replace(/\.tsx$/, '');
}

function registerLibrary(items: Map<string, SearchableItem>) {
  // Components — both design components and code components live under `components/`.
  const componentFiles = projectFS.listFiles('components/').filter((f) => f.endsWith('.tsx'));
  for (const file of componentFiles) {
    if (!isComponentFilePath(file)) continue;
    const name = getFileDisplayName(file);
    items.set(`lib:component:${file}`, {
      id: `lib:component:${file}`,
      name,
      category: 'library',
      subcategory: 'Component',
      keywords: [name.toLowerCase(), 'component', 'master', 'reusable'],
      icon: ComponentClusterIcon,
      // Insert an instance at the selection-aware location (same rules
      // as Ctrl+V). Switching to the master file is "Edit" not
      // "Insert", and the user's typical intent here is to add the
      // component to their current page.
      action: { type: 'insert-library-item', filePath: file, elementType: fileToInternalName(file) },
    });
  }

  // Icon sets — `icons/<name>.tsx`
  const iconFiles = projectFS.listFiles('icons/').filter((f) => f.endsWith('.tsx'));
  for (const file of iconFiles) {
    if (!isIconSetFilePath(file)) continue;
    const name = getFileDisplayName(file);
    items.set(`lib:icon-set:${file}`, {
      id: `lib:icon-set:${file}`,
      name,
      category: 'library',
      subcategory: 'Icon Set',
      keywords: [name.toLowerCase(), 'icon', 'icons', 'set', 'vector'],
      action: { type: 'insert-library-item', filePath: file, elementType: fileToInternalName(file) },
    });
  }

  // Vectors — `vectors/<name>.tsx`
  for (const file of listAllVectorFiles()) {
    const name = getFileDisplayName(file);
    items.set(`lib:vector:${file}`, {
      id: `lib:vector:${file}`,
      name,
      category: 'library',
      subcategory: 'Vector',
      keywords: [name.toLowerCase(), 'vector', 'svg', 'illustration'],
      action: { type: 'insert-library-item', filePath: file, elementType: fileToInternalName(file) },
    });
  }

  // Templates — these are layout files, not instantiable. Switching
  // active file is the right intent here.
  for (const t of listTemplates()) {
    items.set(`lib:template:${t.clientPath}`, {
      id: `lib:template:${t.clientPath}`,
      name: t.name,
      category: 'library',
      subcategory: 'Template',
      keywords: [t.name.toLowerCase(), 'template', 'layout', 'route group'],
      action: { type: 'switch-active-file', filePath: t.clientPath },
    });
  }
}

// ─── Pages ──────────────────────────────────────────────────────────────────

function registerPages(items: Map<string, SearchableItem>) {
  for (const file of listPageFiles()) {
    const name = getFileDisplayName(file);
    items.set(`page:${file}`, {
      id: `page:${file}`,
      name,
      category: 'pages',
      subcategory: file === 'app/page.tsx' ? 'Home' : 'Page',
      keywords: [name.toLowerCase(), 'page', 'route', 'url'],
      action: { type: 'switch-active-file', filePath: file },
    });
  }
}

// ─── Plugins ────────────────────────────────────────────────────────────────

function registerPlugins(items: Map<string, SearchableItem>) {
  // Tier 2 — project plugins authored in this Revyme instance.
  for (const filePath of listPluginFiles()) {
    const internal = pluginPathToInternalName(filePath);
    items.set(`plugin:project:${filePath}`, {
      id: `plugin:project:${filePath}`,
      name: internal,
      category: 'plugins',
      subcategory: 'Project',
      keywords: [internal.toLowerCase(), 'plugin', 'project', 'local', 'tier 2'],
      action: { type: 'launch-plugin', pluginTier: 'project', id: filePath },
    });
  }

  // Tier 1 — installed dev-URL plugins. Surface only when the user
  // types — keeping them out of the empty view leaves room for the
  // Project group to headline. (Earlier they were `featured: true`
  // mirroring the reference; the user preferred a tighter empty view.)
  const installed = store.get(installedPluginsAtom);
  for (const p of installed) {
    items.set(`plugin:installed:${p.manifest.id}`, {
      id: `plugin:installed:${p.manifest.id}`,
      name: p.manifest.name,
      category: 'plugins',
      subcategory: 'Dev URL',
      keywords: [p.manifest.name.toLowerCase(), 'plugin', 'dev', 'localhost', 'tier 1'],
      description: p.manifest.description,
      action: { type: 'launch-plugin', pluginTier: 'installed', id: p.manifest.id },
    });
  }

  // Tier 3 — installed cloud (marketplace) plugins. Same rationale —
  // typed search only.
  const cloud = store.get(installedCloudPluginsAtom);
  for (const p of cloud) {
    items.set(`plugin:cloud:${p.id}`, {
      id: `plugin:cloud:${p.id}`,
      name: p.name,
      category: 'plugins',
      subcategory: p.author ? `By ${p.author}` : 'Marketplace',
      keywords: [p.name.toLowerCase(), 'plugin', 'cloud', 'marketplace', 'tier 3', ...(p.author ? [p.author.toLowerCase()] : [])],
      action: { type: 'launch-plugin', pluginTier: 'cloud', id: p.id },
    });
  }
}

// ─── Project (curated empty-query entries) ──────────────────────────────────
// Virtual category that holds the "high-signal" actions that should
// always appear when the palette opens with no query — Browse the
// marketplaces, New project, etc. Each entry is `featured: true` so
// it surfaces in the curated empty view via search-utils' filter.

function registerProject(items: Map<string, SearchableItem>) {
  items.set('project:browse-plugins', {
    id: 'project:browse-plugins',
    name: 'Browse Plugins',
    category: 'project',
    keywords: ['browse', 'all', 'plugins', 'marketplace', 'install'],
    action: { type: 'set-palette-filter', filter: 'plugins' },
    featured: true,
  });
  items.set('project:new-project', {
    id: 'project:new-project',
    name: 'New Project',
    category: 'project',
    keywords: ['new', 'project', 'create', 'start'],
    shortcut: '⌃⌥N',
    action: { type: 'execute-command', commandId: 'new-project' },
    featured: true,
  });
  if (CLOUD_ENABLED) {
    items.set('project:create-remix-link', {
      id: 'project:create-remix-link',
      name: 'Create Remix Link',
      category: 'project',
      keywords: ['remix', 'link', 'share', 'template', 'publish', 'fork'],
      action: { type: 'execute-command', commandId: 'create-remix-link' },
      featured: true,
    });
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Build the full searchable item list. Called on every palette open —
 * the cost is trivial (<100 items, all in-memory) and rebuilding
 * guarantees we pick up live changes to projectFS, installed plugins,
 * etc. without needing invalidation wiring.
 */
export function getAllSearchableItems(): SearchableItem[] {
  const items = new Map<string, SearchableItem>();
  registerCommands(items);
  registerDrawTools(items);
  registerTabs(items);
  registerLibrary(items);
  registerPlugins(items);
  registerPages(items);
  registerProject(items);
  return Array.from(items.values());
}
