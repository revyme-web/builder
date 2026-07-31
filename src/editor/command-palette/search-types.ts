// search-types.ts — Shared types for the cmd+K command palette's
// searchable items, results, and execution actions.
//
// Ported from `builder/src/builder/context/search/search-types.ts`
// with Revyme-specific tweaks:
//   - Category list trimmed to what Revyme actually has today
//     (no `integrations`, no `documentation` until those are wired)
//   - Action variants match Revyme surfaces (left-panel ids, tool
//     modes, library file paths)
//
// The `score` + `matchedTerms` shape on `SearchResult` mirrors what
// the in-house fuzzy matcher in `search-utils.ts` produces so callers
// can render highlighted match positions later (not used in v1, but
// kept on the interface so we can add it without a breaking change).

import type { LeftPanelId } from '@/code/stores/left-panel-store';
import type { ToolMode } from '@/code/stores/tool-store';

export type SearchCategory =
  | 'project'    // virtual: Browse plugins / Browse components / New Project … (curated initial)
  | 'plugins'    // installed plugins (Tier 1 + Tier 2 + Tier 3) — pinned to initial via `featured`
  | 'commands'   // app-level actions: undo, copy, preview, publish, …
  | 'draw'       // canvas drawing tools: frame, text, shapes, layouts
  | 'tabs'       // left-panel switches: insert, library, …
  | 'library'    // local project items: components, sketches, vectors, icon sets, templates
  | 'pages';     // pages in the project

export interface CategoryConfig {
  label: string;
  /** Display weight — higher categories appear first in default
   *  (empty-query) results and rank higher in fuzzy results. */
  weight: number;
  /** Per-category cap when showing default (empty-query) results.
   *  Only used in the legacy non-featured path; the curated empty
   *  view filters by the `featured` flag instead. */
  defaultLimit: number;
}

export const CATEGORY_CONFIG: Record<SearchCategory, CategoryConfig> = {
  // `project` is the only group pinned to the empty-query view (via
  // its rows' `featured: true`). Everything else lives inline — plugins
  // sit alongside library / commands / pages when the user types, no
  // special elevation. Weights are basically uniform now; only project
  // gets a small bump so its rows render first at equal score.
  project:  { label: 'Project',     weight: 1.2, defaultLimit: 10 },
  commands: { label: 'Commands',    weight: 1.0, defaultLimit: 8 },
  draw:     { label: 'Tools',       weight: 1.0, defaultLimit: 10 },
  tabs:     { label: 'Panels',      weight: 1.0, defaultLimit: 9 },
  library:  { label: 'Library',     weight: 1.0, defaultLimit: 10 },
  plugins:  { label: 'Plugins',     weight: 1.0, defaultLimit: 10 },
  pages:    { label: 'Pages',       weight: 1.0, defaultLimit: 5 },
};

// ─── Action variants ────────────────────────────────────────────────────────
// Each searchable item declares a `SearchAction` — the search executor
// pattern-matches on `type` and runs the right side effect. New action
// types go here AND in `useSearchActions.ts` together.

export type SearchAction =
  | { type: 'execute-command'; commandId: string }
  | { type: 'set-tool-mode'; mode: ToolMode }
  | { type: 'open-left-panel'; panelId: LeftPanelId }
  | { type: 'switch-active-file'; filePath: string }
  /**
   * Insert a master-backed instance (component, icon set,
   * vector) onto the canvas at the selection-aware position the paste
   * rules pick. `filePath` is the master file; `elementType` is the
   * internal name (the JSX tag the renderer expects).
   */
  | { type: 'insert-library-item'; filePath: string; elementType: string }
  | { type: 'launch-plugin'; pluginTier: 'project' | 'installed' | 'cloud'; id: string }
  | { type: 'set-palette-filter'; filter: 'all' | 'plugins' }
  | { type: 'open-url'; url: string; newTab?: boolean };

// ─── Item shape ─────────────────────────────────────────────────────────────

export interface SearchableItem {
  id: string;
  name: string;
  category: SearchCategory;
  /** Optional sub-grouping label shown under the row name. */
  subcategory?: string;
  /** Extra terms the fuzzy matcher should consider. The matcher
   *  weights `name` highest, then `keywords`, then `subcategory`. */
  keywords: string[];
  /** Lucide / custom icon component, or null for the default category glyph. */
  icon?: React.ComponentType<{ size?: number; className?: string }> | null;
  /** Display-only string like "⌘K" or "⇧R". Pure visual hint, not parsed. */
  shortcut?: string;
  /** Action executed when the row is activated (Enter or click). */
  action: SearchAction;
  /** Optional one-line description for richer rows (plugins, library items). */
  description?: string;
  /** Optional predicate — item is hidden when this returns false. Lets
   *  us register conditional commands (e.g. "Create 404 page" only when
   *  no 404 exists yet). */
  condition?: () => boolean;
  /** When true, the item shows up in the curated empty-query view.
   *  Without this flag, the item only appears once the user types
   *  something the matcher can score. Used to keep the cmd+K palette's
   *  initial state focused on high-signal entry points (Browse
   *  marketplace, top installed plugins, New Project) instead of
   *  dumping every command/tool/file. */
  featured?: boolean;
}

export interface SearchResult extends SearchableItem {
  /** Higher = better match. Used for sort + the per-category default cap. */
  score: number;
  /** Strings inside `name`/`keywords` that matched. Useful for inline
   *  highlight rendering. Empty when the query is blank. */
  matchedTerms: string[];
}

/** Display order. Categories appear top-to-bottom in this order.
 *  Project leads (Browse Plugins / New Project / etc.); installed
 *  plugins drop below commands/tools/library — they're a normal
 *  category, not a hero section. */
export const CATEGORY_ORDER: SearchCategory[] = [
  'project',
  'commands',
  'draw',
  'tabs',
  'library',
  'plugins',
  'pages',
];
