// menu-builders.tsx — Shared definitions for the editor's File / Edit /
// Insert / View command surfaces.
//
// Originally these lived inline in `MenuTabs.tsx` as a top-of-header
// menubar (File / Edit / Insert / View chips). The header was
// refactored so that menubar collapses into the Revyme logo dropdown
// (LogoButton in LeftHeader.tsx) as right-opening submenus, freeing
// the 256 px slot for the project-name chip. The menu DEFINITIONS
// stay here — they're plain `DropdownMenuEntry[]` builders the logo
// dropdown consumes verbatim. The `createAndOpenProject` action also
// lives here (was previously exported from MenuTabs.tsx; the keyboard
// shortcut + command palette import it).
//
// Anything UI-shaped (menubar chip rendering, hover-to-switch, etc.)
// is gone — the logo dropdown's existing submenu machinery handles
// presentation now.

import { getDefaultStore } from 'jotai';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import type { DropdownMenuEntry } from '@/design-system/DropdownMenu';
import { trace } from '@/shared/debug-trace';
import { flushNow } from '@/code/mutation/mutation-queue';
import { undo, redo } from '@/code/mutation/history';
import { copyNodes } from '@/code/features/paste-engine';
import { executePaste } from '@/code/features/paste-engine/execute-from-ui';
import { deleteNode, duplicateSelection } from '@/canvas/commands';
import { getContentRoot } from '@/canvas/node-ops';
import { zoomIn, zoomOut, zoomTo100, zoomToFit } from '@/canvas/transform';
import { selectedIdsAtom, selectedNodeAtom, nodesAtom } from '@/code/stores/store';
import { toolModeAtom } from '@/code/stores/tool-store';
import { activeFilePathAtom, createPageFile } from '@/code/project/active-file-store';
import { projectVersionAtom, projectFS } from '@/code/project/project-fs';
import { shareAsTemplate, createWebsite } from '@/backend/revyme-backend';
import { backend } from '@/backend/index';
import { getProjectId } from '@/backend/project-id';
import { toast } from 'sonner';
import type { AutoPanSpeed } from '@/code/stores/user-preferences-store';
import { previewModeAtom, shortcutsModalOpenAtom, exportDropdownOpenAtom } from '@/code/stores/editor-store';
import { paletteOpenAtom } from '@/code/stores/palette-store';
import { startOnboarding } from '@/editor/onboarding';
import { BUILDER_THEMES } from '@/shared/builder-themes';

type TabId = 'file' | 'edit' | 'insert' | 'view';

export interface TabSpec {
  id: TabId;
  label: string;
  items: DropdownMenuEntry[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const stub = (action: string) => () => trace.action(`menu:${action}`);

/** Create a brand-new project and switch to it.
 *
 *  The current `ProjectBackend` interface (`src/backend/types.ts`) only
 *  exposes load/save/upload — there's no `createWebsite` allocation
 *  call. So "create" reduces to: pick a fresh id, navigate to its
 *  builder route, and let `ProjectLoader` seed the empty starter on
 *  first mount (it sees `fileCount === 0` and calls
 *  `createEmptyProject()` automatically).
 *
 *  In local mode the new id becomes a fresh localStorage entry on the
 *  first autosave. In cloud mode the same flow lands a fresh project
 *  on the backend via `saveProject(id, …)` — the backend doesn't need
 *  a separate "create" step in this codebase.
 */
export function createAndOpenProject(): void {
  trace.action('menu:file-new-project:start');
  // Flush in-flight code mutations for the CURRENT project so anything
  // unsaved still lands in localStorage / cloud BEFORE the new tab
  // opens. The current tab keeps editing the existing project, so
  // missing this flush wouldn't lose data — but flushing here keeps
  // the "open new tab" gesture identical to the prior in-place swap
  // for users who muscle-memory expect everything to be persisted.
  flushNow();

  // Open the tab SYNCHRONOUSLY, inside the user gesture — an async
  // `window.open` after the create round-trip is popup-blocked by every
  // browser. The blank tab is pointed at the builder once the id exists.
  //
  // We intentionally do NOT pass `noopener` here: with `noopener`,
  // `window.open` ALWAYS returns `null` (security feature — the parent
  // can't reach back into the child), and we need the Window handle to
  // navigate it after the backend round-trip. Without `noopener` we get
  // a real Window-or-null return, so the popup-blocker fallback only
  // fires when the popup actually got blocked.
  const tab = window.open('', '_blank');
  if (!tab) {
    // Truly blocked (no Window object). Browser will normally show its
    // popup-blocker indicator; surface a console hint too so dev users
    // can debug headless setups where the indicator isn't visible.
    trace.action('menu:file-new-project:popup-blocked');
    console.warn('[Revyme] New project popup was blocked. Allow popups for this site to open new projects in a new tab.');
    return;
  }

  if (!CLOUD_ENABLED) {
    // Local mode: no backend rows, no ACL — a fresh client-side id IS the
    // create. The new tab boots `ProjectLoader`, finds nothing under the id,
    // and seeds `createEmptyProject()`; the first autosave lands it in
    // localStorage.
    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `proj-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    trace.action('menu:file-new-project:navigate', { id, mode: 'local' });
    tab.location.href = `/builder/${id}`;
    return;
  }

  // Cloud mode: the website row MUST exist before the builder opens —
  // `ProjectLoader` resolves the caller's role from the backend, and an
  // unknown id has no membership → the builder boots in VIEW-ONLY mode
  // with every save rejected ("you don't have edit access", 2026-08-11).
  //
  // Target workspace = the CURRENT website's workspace, so a new project
  // started while working in a team stays in that team — IF the caller may
  // create websites there (owner/admin/editor member; the backend enforces
  // it and falls back to the personal workspace otherwise). A site with no
  // workspace resolves to `null` → personal explicitly, NOT the dashboard's
  // cookie-remembered workspace, which may be unrelated to what's on screen.
  void (async () => {
    try {
      const currentWorkspaceId = await backend.getWebsiteWorkspaceId(getProjectId());
      const id = await createWebsite(undefined, currentWorkspaceId ?? null);
      trace.action('menu:file-new-project:navigate', { id, mode: 'cloud', requestedWorkspaceId: currentWorkspaceId });
      tab.location.href = `/builder/${id}`;
    } catch (err) {
      trace.error('menu:file-new-project:create-failed', { error: String(err) });
      tab.close();
      console.warn('[Revyme] Could not create a new project:', err);
    }
  })();
}

// ─── Selection / clipboard / nav helpers ───────────────────────────────────
// Each one mirrors the equivalent keyboard-shortcut handler in
// `src/canvas/shortcuts.ts` — same atoms, same module-level functions, same
// trace calls. Both surfaces (menu + Ctrl-shortcut) call the same underlying
// helpers (`copyNodes`, `executePaste`, `deleteNode`, …); we only re-resolve
// the in-flight selection / nodes / contentEl from the default store at
// click-time so the menu doesn't go stale across the router lifecycle.

function readSelection(): { ids: string[]; primary: string | null } {
  const store = getDefaultStore();
  return { ids: store.get(selectedIdsAtom), primary: store.get(selectedNodeAtom) };
}

/** Best-effort no-op fallback for `handleNodeMouseDown` from the menu side.
 *  The menu can't reach Canvas's real `handleNodeMouseDown` (it's a closure
 *  over canvas state), so paste/duplicate from the menu rely on the
 *  Renderer's normal mousedown wiring once the new node mounts. The only
 *  side effect lost vs the keyboard-shortcut path is the immediate-select
 *  click handling on a synthesized element, which the executePaste flow
 *  handles via `setSelectedIds` anyway. */
const menuNoMouseDown: () => void = () => { /* see comment */ };

/** Exported so the cmd+K palette runs the identical path as File ▸ New page —
 *  the flush-then-bump-then-switch order matters and must not be duplicated. */
export function menuNewPage(): void {
  flushNow();
  const filePath = createPageFile();
  const store = getDefaultStore();
  store.set(projectVersionAtom, (v) => v + 1);
  store.set(selectedIdsAtom, []);
  store.set(activeFilePathAtom, filePath);
  trace.action('menu:file-new', { filePath });
}

/**
 * "Create remix link" entry — uploads the current projectFS snapshot
 * as a template share (backend creates an idempotent draft
 * `creator_components` row so the royalty FK works immediately) and
 * copies the user-facing `<host>/r/<hash>` URL to clipboard. Same
 * URL works two ways: DM to a friend for direct remix, or paste in
 * the dashboard's Templates → Submit form for marketplace publish.
 */
async function menuCreateRemixLink(): Promise<void> {
  trace.action('menu:file-create-remix-link:start');
  flushNow();
  const files: Record<string, string> = {};
  projectFS.getSnapshot().forEach((v, k) => { files[k] = v; });
  if (Object.keys(files).length === 0) {
    toast.error('Project is empty');
    return;
  }
  try {
    // Pass the current website id so the backend preserves the remix
    // lineage (`parent_template_id` + `original_creator_user_id`) on
    // the new draft row.
    const { getProjectId } = await import('@/backend/project-id');
    const result = await shareAsTemplate({
      name: 'Untitled',
      files,
      source_website_id: getProjectId(),
    });
    await navigator.clipboard.writeText(result.share_url).catch(() => {});
    toast.success('Remix link copied');
    trace.action('menu:file-create-remix-link:done', { hash: result.hash });
  } catch (err) {
    trace.error('menu:file-create-remix-link:failed', { error: String(err) });
    toast.error((err as Error).message || 'Could not create remix link');
  }
}

function menuUndo(): void { trace.action('menu:edit-undo'); undo(); }
function menuRedo(): void { trace.action('menu:edit-redo'); redo(); }

function menuCopy(): void {
  const { ids } = readSelection();
  if (ids.length === 0) return;
  copyNodes(ids, getDefaultStore().get(nodesAtom));
  trace.action('menu:edit-copy', { count: ids.length });
}

function menuCut(): void {
  const { ids } = readSelection();
  if (ids.length === 0) return;
  const store = getDefaultStore();
  copyNodes(ids, store.get(nodesAtom));
  const contentEl = getContentRoot();
  if (contentEl) {
    deleteNode(ids, contentEl);
    store.set(selectedIdsAtom, []);
  }
  trace.action('menu:edit-cut', { count: ids.length });
}

function menuPaste(setMouseDown?: () => void): void {
  void setMouseDown;
  const store = getDefaultStore();
  const { primary } = readSelection();
  executePaste(
    store.get(nodesAtom),
    getContentRoot(),
    primary,
    (id) => store.set(selectedIdsAtom, id ? [id] : []),
    menuNoMouseDown as any,
  );
  trace.action('menu:edit-paste');
}

function menuDuplicate(): void {
  const { primary } = readSelection();
  if (!primary) return;
  // Same restore-clipboard dance as the Ctrl+D keyboard shortcut so a
  // menu-driven duplicate doesn't clobber whatever the user just copied —
  // shared via duplicateSelection() in canvas/commands.ts.
  const store = getDefaultStore();
  duplicateSelection({
    nodes: store.get(nodesAtom),
    primaryId: primary,
    contentEl: getContentRoot(),
    setSelectedIds: (ids) => store.set(selectedIdsAtom, ids),
    handleNodeMouseDown: menuNoMouseDown as any,
  });
  trace.action('menu:edit-duplicate', { nodeId: primary });
}

function menuDelete(): void {
  const { ids } = readSelection();
  if (ids.length === 0) return;
  const contentEl = getContentRoot();
  if (!contentEl) return;
  deleteNode(ids, contentEl);
  getDefaultStore().set(selectedIdsAtom, []);
  trace.action('menu:edit-delete', { count: ids.length });
}

function menuSetTool(mode: string): void {
  getDefaultStore().set(toolModeAtom, mode as any);
  trace.action('menu:set-tool', { mode });
}

function menuZoomFit(): void {
  const el = getContentRoot();
  if (el) zoomToFit(el);
  trace.action('menu:view-zoom-fit');
}

// ─── Submenu definitions (kept-as-submenu items only) ───────────────────────

// Site Settings keeps a submenu — multi-page domain / SEO / analytics
// surfaces, each likely to grow.
const siteSettingsSubmenu: DropdownMenuEntry[] = [
  { id: 'site-domain', label: 'Domain', onClick: stub('site-domain') },
  { id: 'site-seo', label: 'SEO', onClick: stub('site-seo') },
  { id: 'site-analytics', label: 'Analytics', onClick: stub('site-analytics') },
];

// Plugins keeps a submenu — browse vs manage are clearly distinct entry points.
const pluginsSubmenu: DropdownMenuEntry[] = [
  { id: 'plugins-browse', label: 'Browse plugins…', onClick: stub('plugins-browse') },
  { id: 'plugins-manage', label: 'Manage installed', onClick: stub('plugins-manage') },
];

/** Builder accent themes — recolours the EDITOR chrome (not the user's site).
 *  Takes the live value + setter (same shape as buildPreferencesSubmenu) so
 *  the checkmark tracks the selection; reading a module-level value here would
 *  freeze it at whatever was active when LeftHeader last re-memoized. */
export function buildThemeSubmenu(current: string, set: (id: string) => void): DropdownMenuEntry[] {
  // Preview the accent for the mode the chrome is ACTUALLY in — each palette
  // ships a separate light/dark accent, so showing the light one while the
  // editor is dark would advertise a colour the user will never see.
  const dark = typeof document !== 'undefined'
    && document.documentElement.classList.contains('dark');
  return BUILDER_THEMES.map((t) => ({
    id: `builder-theme-${t.id}`,
    label: t.label,
    trailingIcon: (
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className="h-3.5 w-3.5 rounded-[4px] border border-black/25 dark:border-white/25"
          style={{ backgroundColor: (dark ? t.dark : t.light).accent }}
        />
        {/* Fixed-width cell so the swatches stay on one column whether or not
            the row is the selected one. */}
        <span className="w-3 flex items-center justify-center">
          {current === t.id ? <CheckGlyph /> : null}
        </span>
      </span>
    ),
    onClick: () => {
      set(t.id);
      trace.action('menu:builder-theme', { id: t.id });
    },
  }));
}

// Tiny check glyph used to mark the active state on toggle/select
// preference rows. Renders in DropdownMenuItem's `trailingIcon` slot
// so it sits at the END of the row (right side), past the label —
// the leading `icon` slot would line them up on the left and the
// boolean rows would look like normal items with stray icons.
const CheckGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export interface PrefsState {
  directSelectionEnabled: boolean;
  autoPanSpeed: AutoPanSpeed;
  autoFocusLayers: boolean;
  showRulers: boolean;
  useSmoothZoom: boolean;
  showPixelGrid: boolean;
}

export interface PrefsSetters {
  setDirectSelectionEnabled: (v: boolean) => void;
  setAutoPanSpeed: (v: AutoPanSpeed) => void;
  setAutoFocusLayers: (v: boolean) => void;
  setShowRulers: (v: boolean) => void;
  setUseSmoothZoom: (v: boolean) => void;
  setShowPixelGrid: (v: boolean) => void;
}

/** Build the Preferences submenu from live atom values + setters.
 *  Each toggle row shows a check glyph when its pref is on; clicking
 *  flips the atom (which is `atomWithStorage`-backed, so the new value
 *  persists across reloads). The Auto pan speed entries form a radio
 *  group — the active level is checked, the other two aren't, and
 *  clicking one switches without toggling. */
export function buildPreferencesSubmenu(prefs: PrefsState, set: PrefsSetters): DropdownMenuEntry[] {
  const toggle = (
    id: string, label: string, value: boolean, setter: (v: boolean) => void,
  ): DropdownMenuEntry => ({
    id, label,
    trailingIcon: value ? <CheckGlyph /> : null,
    onClick: () => { setter(!value); trace.action(`menu:pref:${id}`, { next: !value }); },
  });
  const radio = (
    id: string, label: string, level: AutoPanSpeed,
  ): DropdownMenuEntry => ({
    id, label,
    trailingIcon: prefs.autoPanSpeed === level ? <CheckGlyph /> : null,
    onClick: () => { set.setAutoPanSpeed(level); trace.action(`menu:pref:auto-pan-speed`, { level }); },
  });
  return [
    toggle('pref-direct-selection', 'Direct selection', prefs.directSelectionEnabled, set.setDirectSelectionEnabled),
    toggle('pref-auto-focus-layers', 'Auto focus layers', prefs.autoFocusLayers, set.setAutoFocusLayers),
    toggle('pref-show-rulers', 'Show rulers', prefs.showRulers, set.setShowRulers),
    toggle('pref-smooth-zoom', 'Use smooth zoom', prefs.useSmoothZoom, set.setUseSmoothZoom),
    toggle('pref-pixel-grid', 'Show pixel grid', prefs.showPixelGrid, set.setShowPixelGrid),
    { type: 'separator' },
    // Auto-pan speed — three rows, one radio group. Header row at the
    // top is non-interactive (disabled) so it reads as a label rather
    // than a clickable command.
    { id: 'pref-auto-pan-speed', label: 'Auto pan speed', disabled: true, onClick: () => {} },
    radio('pref-auto-pan-speed-low',  '   Low',  'low'),
    radio('pref-auto-pan-speed-mid',  '   Mid',  'mid'),
    radio('pref-auto-pan-speed-high', '   High', 'high'),
  ];
}

// ─── Top-level tab specs ────────────────────────────────────────────────────
//
// Items are FLAT inside each top dropdown (no parent groupings like "Edit ▶"
// or "Tool ▶"); related groups are separated with `{ type: 'separator' }`.
// Only deeper menus (Site Settings, Plugins, Preferences) stay as submenus
// because each holds multiple destinations or is conceptually distinct from
// a "command".

export function buildTabs(preferencesSubmenu: DropdownMenuEntry[]): TabSpec[] {
  return [
  {
    id: 'file',
    label: 'File',
    items: [
      // Project-level (real handlers — wired up to the backend).
      // No Save item — autosave handles persistence (`autosave.ts`
      // debounces flushes 2 s after each mutation in cloud mode);
      // a manual Save would be a no-op for the user.
      // No shortcut on New page — it's a rare action, the keyboard
      // shortcut would steal Ctrl+N from the browser.
      // New project's `Ctrl+Alt+N` is registered in
      // `src/canvas/shortcuts.ts` (search for `menuNewProject`).
      { id: 'file-new-project', label: 'New project', shortcut: 'Ctrl+Alt+N', onClick: () => createAndOpenProject() },
      { id: 'file-new', label: 'New page', onClick: () => menuNewPage() },
      { id: 'file-export', label: 'Export…', onClick: stub('file-export') },
      { type: 'separator' },
      // Create Remix Link — uploads the current project as a
      // shareable template. Same URL works two ways: friends with the
      // link can remix instantly, and pasting it into the dashboard's
      // Templates → Submit form publishes it to the marketplace. The
      // RemixLinkModal renders the URL with a copy button on success.
      ...(CLOUD_ENABLED ? [{ id: 'file-create-remix-link', label: 'Create remix link…', onClick: () => menuCreateRemixLink() }] : []),
      { type: 'separator' },
      // Code ops (formerly Code ▶)
      // Opens the right-header Export dropdown (format picker + Export
      // project) rather than exporting straight away — the user should
      // choose Source vs Tailwind, and there is no reason to have a second
      // picker in this menu. "Copy code" used to sit above this; it was a
      // `stub()` that only traced, and its meaning was never clear
      // (copy which code — the page? the project?), so it is gone.
      {
        id: 'code-export',
        label: 'Export code…',
        onClick: () => {
          trace.action('menu:code-export');
          getDefaultStore().set(exportDropdownOpenAtom, true);
        },
      },
      { type: 'separator' },
      // Project-scoped configuration — kept as submenus.
      { id: 'site-settings', label: 'Site Settings', submenuItems: siteSettingsSubmenu, onClick: () => {} },
      { id: 'plugins', label: 'Plugins', submenuItems: pluginsSubmenu, onClick: () => {} },
      // "Go to Dashboard" + "Your Account" live in the LeftHeader's
      // Revyme-logo dropdown — they're account-level actions that
      // don't really belong with project-file actions like New/Export.
    ],
  },
  {
    id: 'edit',
    label: 'Edit',
    items: [
      // History — wired to `code/mutation/history` (same module the
      // Ctrl+Z/Y/Shift+Z keyboard shortcuts call).
      { id: 'edit-undo', label: 'Undo', shortcut: 'Ctrl+Z', onClick: menuUndo },
      { id: 'edit-redo', label: 'Redo', shortcut: 'Ctrl+Shift+Z', onClick: menuRedo },
      { type: 'separator' },
      // Clipboard — same `copyNodes` + `executePaste` + `deleteNode`
      // helpers `src/canvas/shortcuts.ts` calls for Ctrl+C/X/V.
      { id: 'edit-cut', label: 'Cut', shortcut: 'Ctrl+X', onClick: menuCut },
      { id: 'edit-copy', label: 'Copy', shortcut: 'Ctrl+C', onClick: menuCopy },
      { id: 'edit-paste', label: 'Paste', shortcut: 'Ctrl+V', onClick: () => menuPaste() },
      { type: 'separator' },
      // Selection lifecycle
      { id: 'edit-duplicate', label: 'Duplicate', shortcut: 'Ctrl+D', onClick: menuDuplicate },
      { id: 'edit-delete', label: 'Delete', shortcut: 'Del', onClick: menuDelete },
      { type: 'separator' },
      // Tools — flip `toolModeAtom`. Comment tool not implemented yet,
      // kept as a stub. Select / Hand match the V / H keyboard shortcuts.
      { id: 'tool-select', label: 'Select', shortcut: 'V', onClick: () => menuSetTool('select') },
      { id: 'tool-hand', label: 'Hand', shortcut: 'H', onClick: () => menuSetTool('hand') },
      { id: 'tool-comment', label: 'Comment', shortcut: 'C', onClick: stub('tool-comment') },
      { type: 'separator' },
      // Editor configuration
      { id: 'preferences', label: 'Preferences', submenuItems: preferencesSubmenu, onClick: () => {} },
      // The row advertises Ctrl+K, so it must open the same palette that
      // shortcut does — it was a `stub()` that only traced.
      {
        id: 'quick-actions',
        label: 'Quick Actions',
        shortcut: 'Ctrl+K',
        onClick: () => {
          trace.action('menu:quick-actions');
          getDefaultStore().set(paletteOpenAtom, true);
        },
      },
    ],
  },
  {
    id: 'insert',
    label: 'Insert',
    // Mirrors the bottom toolbar exactly: Frame, Text, Layout (rows /
    // columns / grids), the four shape primitives, then Sketch. Each
    // item just sets `toolModeAtom` — the same atom the bottom-toolbar
    // buttons + the F / T / Shift+R / R / O / Shift+T / P / K shortcuts
    // already drive. Items + shortcuts are kept in lockstep with
    // `BottomToolbar.tsx` and `src/canvas/shortcuts.ts` so the menu is
    // just a third surface onto the same actions, never a stale list.
    items: [
      { id: 'insert-frame', label: 'Frame', shortcut: 'F', onClick: () => menuSetTool('frame') },
      { id: 'insert-text', label: 'Text', shortcut: 'T', onClick: () => menuSetTool('text') },
      { type: 'separator' },
      { id: 'insert-layout-rows', label: 'Rows', shortcut: 'Shift+R', onClick: () => menuSetTool('layout-rows') },
      { id: 'insert-layout-columns', label: 'Columns', shortcut: 'Shift+C', onClick: () => menuSetTool('layout-columns') },
      { id: 'insert-layout-grids', label: 'Grids', shortcut: 'Shift+G', onClick: () => menuSetTool('layout-grids') },
      { type: 'separator' },
      { id: 'insert-shape-rect', label: 'Square', shortcut: 'R', onClick: () => menuSetTool('shape-rect') },
      { id: 'insert-shape-ellipse', label: 'Circle', shortcut: 'O', onClick: () => menuSetTool('shape-ellipse') },
      { id: 'insert-shape-triangle', label: 'Triangle', shortcut: 'Shift+T', onClick: () => menuSetTool('shape-triangle') },
      { id: 'insert-shape-path', label: 'Path', shortcut: 'P', onClick: () => menuSetTool('shape-path') },
      { type: 'separator' },
      { id: 'insert-sketch', label: 'Sketch', shortcut: 'K', onClick: () => menuSetTool('sketch') },
    ],
  },
  {
    id: 'view',
    label: 'View',
    items: [
      // Zoom — direct calls into `canvas/transform`, same module the
      // Ctrl+= / Ctrl+- / Shift+1 / Shift+3 keyboard shortcuts use.
      { id: 'view-zoom-in', label: 'Zoom in', shortcut: 'Ctrl++', onClick: () => { trace.action('menu:view-zoom-in'); zoomIn(); } },
      { id: 'view-zoom-out', label: 'Zoom out', shortcut: 'Ctrl+-', onClick: () => { trace.action('menu:view-zoom-out'); zoomOut(); } },
      { id: 'view-zoom-reset', label: 'Zoom to 100%', shortcut: 'Ctrl+0', onClick: () => { trace.action('menu:view-zoom-reset'); zoomTo100(); } },
      { id: 'view-fit', label: 'Zoom to fit', shortcut: 'Shift+1', onClick: menuZoomFit },
      { type: 'separator' },
      // Mode toggle — `previewModeAtom` is also driven by the right-header
      // Preview button and the Ctrl+P shortcut (App.tsx). Reading the
      // store directly inside `onClick` keeps the menu items array a
      // plain const — no need to subscribe the whole MenuTabs component
      // to preview state just to render this row.
      {
        id: 'view-preview',
        label: 'Toggle preview',
        shortcut: 'Ctrl+P',
        onClick: () => {
          const store = getDefaultStore();
          const next = !store.get(previewModeAtom);
          trace.action('menu:view-toggle-preview', { next });
          store.set(previewModeAtom, next);
        },
      },
      { type: 'separator' },
      // Help (formerly Help ▶)
      // Docs live on the marketing site — Next.js dispatcher at :3001 in
      // dev, revyme.com in production. Same import.meta cast as
      // revyme-backend.ts (raw `import.meta.env` trips this tsconfig).
      {
        id: 'help-docs',
        label: 'Documentation',
        onClick: () => {
          const isDev = !!(import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV;
          const docsUrl = isDev ? 'http://localhost:3001/docs' : 'https://revyme.com/docs';
          trace.action('menu:help-docs', { docsUrl });
          window.open(docsUrl, '_blank', 'noopener');
        },
      },
      // Opens the registry-driven shortcuts overview (KeyboardShortcutsModal,
      // mounted in LeftHeader) — rows come straight from keyboard.getAll().
      {
        id: 'help-shortcuts',
        label: 'Keyboard shortcuts',
        onClick: () => {
          trace.action('menu:help-shortcuts');
          getDefaultStore().set(shortcutsModalOpenAtom, true);
        },
      },
      { type: 'separator' },
      // Launch tutorial — re-runs the first-run onboarding tour on demand.
      // `startOnboarding()` dispatches the window event the mounted
      // OnboardingTutorial listens for; it just re-shows the tour as a
      // one-off and does NOT clear the localStorage completion flag.
      { id: 'help-tutorial', label: 'Launch tutorial', onClick: () => { trace.action('menu:view-launch-tutorial'); startOnboarding(); } },
    ],
  },
  ];
}
