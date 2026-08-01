// sources/app-actions.ts — Application-level actions mirroring the header
// menus (File / View / Help) and the logo menu.
//
// These are the rows that make an empty cmd+K useful: "Toggle preview",
// "New page", "Site Settings", "Documentation". Before this source the
// default view held three entries, so opening the palette without typing
// told the user almost nothing about what it could do.
//
// Every entry here dispatches through `execute-command`, and every id must
// have a branch in `useSearchActions.executeCommand()`. They deliberately
// call the SAME functions the menus call (`menuNewPage`, `startOnboarding`,
// the preview atom) rather than reimplementing them — the menu and the
// palette drifting apart is the failure mode worth designing against.
//
// Menu entries wired to `stub()` in menu-builders (Copy code, Export code,
// the Site Settings sub-items, plugin management) are intentionally ABSENT.
// A palette row that traces and does nothing is worse than no row: it reads
// as a broken feature rather than a missing one.

import { canExport } from '@/editor/header/export-project';
import type { SearchableItem } from '../search-types';
import type { SearchSource } from './types';

const ACTIONS: Array<{
  id: string;
  name: string;
  shortcut?: string;
  keywords: string[];
  description?: string;
  /** Shown in the empty-query view. Reserve for things a user would plausibly
   *  open the palette to reach, not everything that exists. */
  featured?: boolean;
  /** Hides the row when it returns false — evaluated on every search. */
  condition?: () => boolean;
}> = [
  // ─ View ─
  {
    id: 'toggle-preview',
    name: 'Toggle Preview',
    shortcut: '⌃P',
    keywords: ['preview', 'play', 'present', 'view', 'test', 'interact'],
    featured: true,
  },
  // ─ File ─
  {
    id: 'new-page',
    name: 'New Page',
    keywords: ['new', 'page', 'add page', 'create page', 'route'],
    featured: true,
  },
  {
    id: 'site-settings',
    name: 'Site Settings',
    keywords: ['site', 'settings', 'domain', 'seo', 'analytics', 'metadata', 'favicon'],
    featured: true,
  },
  {
    id: 'export-code',
    name: 'Export Code',
    keywords: ['export', 'code', 'download', 'zip', 'source', 'next.js', 'eject'],
    description: 'Download the project as a Next.js source zip',
    featured: true,
    // Same gate as the header's Export button: without a backend there is
    // nothing to build the zip, so the row disappears rather than offering
    // an action that can only fail.
    condition: canExport,
  },
  // ─ Help ─
  {
    id: 'open-docs',
    name: 'Documentation',
    keywords: ['docs', 'documentation', 'help', 'guide', 'manual', 'learn'],
    featured: true,
  },
  {
    id: 'open-shortcuts',
    name: 'Keyboard Shortcuts',
    keywords: ['keyboard', 'shortcuts', 'keys', 'hotkeys', 'bindings'],
    featured: true,
  },
  {
    id: 'launch-tutorial',
    name: 'Launch Tutorial',
    keywords: ['tutorial', 'onboarding', 'tour', 'walkthrough', 'getting started'],
  },
  // ─ Account ─
  {
    id: 'go-dashboard',
    name: 'Go to Dashboard',
    keywords: ['dashboard', 'home', 'projects', 'sites', 'account', 'exit'],
  },
];

export const appActionsSource: SearchSource = () =>
  ACTIONS.map((a): SearchableItem => ({
    id: `app:${a.id}`,
    name: a.name,
    category: 'project',
    keywords: a.keywords,
    shortcut: a.shortcut,
    description: a.description,
    featured: a.featured,
    condition: a.condition,
    action: { type: 'execute-command', commandId: a.id },
  }));
