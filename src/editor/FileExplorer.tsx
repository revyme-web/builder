// FileExplorer.tsx — Project file tree in the left sidebar.
// Shows app/ pages organized in a tree: route groups, layouts, pages.
// Supports drag-and-drop to move pages between groups and nest as subdirectories.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  activeFilePathAtom, getFileDisplayName, createPageFile, deletePageFile,
  movePageFile, createRouteGroup, getRouteGroup, getPageSlug,
  switchActiveFile, createNotFoundPageFile, NOT_FOUND_PATH, notFoundExists,
  componentBreadcrumbAtom, filePathToAbPagePath,
} from '../code/project/active-file-store';
import { createTemplate, validateTemplateName } from '../code/project/template-ops';
import { createCmsIndexPageFile, createCmsDetailPageFile, findCmsPageFile } from '../code/project/cms-page-ops';
import { collectionSchemasAtom } from '../code/stores/cms-store';
import { projectFS, projectVersionAtom, stableProjectVersionAtom } from '../code/project/project-fs';
import { selectedIdsAtom, updatingFromCanvasAtom } from '../code/stores/store';
import { flushNow, syncQueueCode } from '../code/mutation/mutation-queue';
import { sealPendingHistory, pushHistoryFileOp } from '../code/mutation/history';
import { fitAllOnNextRender } from '@/canvas/transform';
import { PageHomeIcon, PageDocumentIcon, NotFoundIcon } from '../shared/icons';
import DropdownMenu, { type DropdownMenuEntry } from '@/design-system/DropdownMenu';
import SectionLabel from '@/design-system/SectionLabel';
import SearchBar from '@/design-system/SearchBar';
import ToolDivider from '@/editor/controls/ToolDivider';
import AddButton from '@/design-system/AddButton';
import SidebarRow from '@/design-system/SidebarRow';
import {
  resolveFolderTreeDrop,
  folderTreeIndicatorAtom,
  folderTreeDraggedAtom,
  type FolderTreeDropIndicator,
} from '@/design-system/FolderTree';
import Modal from '@/design-system/Modal';
import NameInputModal from '@/editor/ui/NameInputModal';
import { settingsOverlayOpenAtom, settingsSectionAtom, selectedSeoPageAtom } from '@/code/stores/website-settings-store';
import { trace } from '../shared/debug-trace';
import { useIsViewer } from '@/code/stores/viewer-mode-store';

// Pages panel reuses the Library panel's pointer-drag hit-test
// helpers (resolveFolderTreeDrop / folderTreeIndicatorAtom). Same
// 3px threshold, same elementsFromPoint hit-test, same before/inside/
// after Y bands. We use a dedicated `pages-tree` namespace so a drag
// inside the Library can't accidentally trigger Pages drop logic and
// vice versa.
const PAGES_DRAG_NS = 'pages-tree';
const PAGES_DRAG_THRESHOLD_PX = 3;
// Drop indicator color — accent blue, not the purple --accent-secondary
// the Library panel uses. Library is component-/asset-themed
// (components share the purple accent); Pages reads as page navigation
// which is blue throughout the rest of the editor.
const PAGES_DRAG_INDICATOR = 'var(--accent, #cec997)';

// ─── Icons ──────────────────────────────────────────────────────────────────

function FolderIcon({ className }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function LayoutIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'currentColor' }}>
      <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="3" y1="15" x2="21" y2="15" />
    </svg>
  );
}

/** Template = a route group with its own LayoutClient.tsx. Distinguished
 *  from plain organisational route groups (which use FolderIcon). The
 *  three-row layout glyph echoes the right-panel Template section icon
 *  so the connection is obvious. */
function TemplateIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="3" y1="15" x2="21" y2="15" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="10" height="10" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease' }}
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PageTreeEntry {
  id: string;
  filePath: string;
  displayPath: string;
  label: string;
  type: 'page' | 'group' | 'layout' | 'variant';
  group: string | null;
  depth: number;
  isHome: boolean;
  /** True when this group entry is a Template (a route group whose folder
   *  has a `LayoutClient.tsx`). Plain organisational route groups don't
   *  have one and stay false. Drives icon + label rendering. */
  isTemplate?: boolean;
  /** A/B test variant rows — rendered as nested children under their
   *  parent page with a letter badge (A/B/C/D…). Variant 'a' is the
   *  baseline (the page itself); 'b' onward are real files under
   *  `_revyme/variants/<testId>/<variantId>.tsx`. */
  isVariant?: boolean;
  variantTestId?: string;
  variantId?: string;
  /** Letter shown in the row badge. A for baseline, B/C/D… for variants. */
  variantLetter?: string;
  /** Override the default depth-based paddingLeft. Used by A/B variant
   *  rows so their letter badge column lines up exactly with the
   *  parent's icon column (parent's chevron + gap), independent of the
   *  default 24px depth-step. */
  customPaddingLeft?: number;
  children: PageTreeEntry[];
}

// ─── Tree Builder ───────────────────────────────────────────────────────────

export function buildPageTree(version: number): PageTreeEntry[] {
  trace.fn('FileExplorer.buildPageTree', { version });

  const allFiles = projectFS.listFiles('app/');
  // Pages are PAIRS: `<dir>/page.tsx` (server wrapper, owns metadata)
  // + `<dir>/page.client.tsx` (canvas-editable body). The tree builds
  // off the .client.tsx half so each route shows exactly one row.
  // The wrapper is implicit alongside each entry.
  const pageFiles = allFiles.filter(f => f.endsWith('page.client.tsx'));

  // Group pages by route group
  const groupedPages = new Map<string | null, string[]>();
  for (const fp of pageFiles) {
    const group = getRouteGroup(fp);
    if (!groupedPages.has(group)) groupedPages.set(group, []);
    groupedPages.get(group)!.push(fp);
  }

  // Collect all known groups (including empty ones that have a layout)
  const groupNames = new Set<string>();
  for (const file of allFiles) {
    const g = getRouteGroup(file);
    if (g) groupNames.add(g);
  }

  // ─── Page-path nesting helper ─────────────────────────────────────────────
  // Pages in the same route group nest by path: `/about/team` becomes a
  // child of `/about` when both exist as pages. Lookup walks one folder
  // up at a time until it finds an existing page-file or runs out of
  // segments. Visual label of a nested entry shows ONLY the last segment
  // (`/team` instead of `/about/team`) so the indentation does the work.
  function nestPagesByPath(pageList: string[], homePath: string, baseDepth: number): PageTreeEntry[] {
    const entryMap = new Map<string, PageTreeEntry>();
    for (const fp of pageList) {
      const isHome = fp === homePath;
      const slug = getPageSlug(fp);
      entryMap.set(fp, {
        id: `page:${fp}`,
        filePath: fp,
        displayPath: fp,
        // Home gets the human-readable "Home" label (matches the reference + makes
        // the bare `/` render less cryptic). Everything else uses its slug.
        label: isHome ? 'Home' : slug,
        type: 'page',
        group: getRouteGroup(fp),
        depth: baseDepth,
        isHome,
        children: [],
      });
    }

    /** Find the deepest ancestor page-file present in `entryMap`.
     *  The home page (`app/page.tsx` or `app/(group)/page.tsx`) is
     *  intentionally NOT considered a parent — it's a sibling of every
     *  other top-level route. Otherwise `/about` and friends would all
     *  nest under Home, which doesn't match how routes actually relate
     *  (Next.js uses `/about` independently of `/`). */
    const findParent = (fp: string): string | null => {
      let dir = fp.replace(/\/page\.client\.tsx$/, '');
      while (dir.includes('/')) {
        dir = dir.substring(0, dir.lastIndexOf('/'));
        const candidate = `${dir}/page.client.tsx`;
        if (candidate === fp) continue;
        if (candidate === homePath) continue; // Home is a sibling, not a parent
        if (entryMap.has(candidate)) return candidate;
      }
      return null;
    };

    const topLevel: PageTreeEntry[] = [];
    for (const [fp, entry] of entryMap) {
      const parentFp = findParent(fp);
      if (parentFp) {
        const parent = entryMap.get(parentFp)!;
        parent.children.push(entry);
        // Nested entries show only the last URL segment so the
        // indentation conveys hierarchy without the path being
        // duplicated on every line. Dynamic segments like `[slug]`
        // pass through as-is.
        const lastSeg = fp.replace(/\/page\.client\.tsx$/, '').split('/').pop() ?? '';
        entry.label = `/${lastSeg}`;
      } else {
        topLevel.push(entry);
      }
    }

    /** Walk the nested tree assigning depths and sorting children. */
    const stamp = (entries: PageTreeEntry[], depth: number) => {
      const sortFn = (a: PageTreeEntry, b: PageTreeEntry) => {
        if (a.isHome) return -1;
        if (b.isHome) return 1;
        return a.label.localeCompare(b.label);
      };
      entries.sort(sortFn);
      for (const e of entries) {
        e.depth = depth;
        e.children.sort(sortFn);
        stamp(e.children, depth + 1);
      }
    };
    stamp(topLevel, baseDepth);
    return topLevel;
  }

  const tree: PageTreeEntry[] = [];

  // FLAT page tree — Templates are an ATTRIBUTE of a page, not a parent.
  // The user picks a template via the right-panel Template picker; in the
  // file tree they just see Home, /about, /contact regardless of which
  // template each page is assigned to. This matches the reference's mental
  // model: "Templates live in the Library, pages live here, the link
  // between them is metadata."
  //
  // Path-based nesting still applies — `/about/team` nests under `/about`
  // when both exist — and we treat ANY home page (bare OR templated) as
  // the canonical root, so `/about` doesn't accidentally become a child
  // of the templated home.
  //
  // Plain organisational route groups (no LayoutClient.tsx) DO still
  // render as folders. They're not templates, they're filesystem
  // organisation, and the user explicitly created them via "New Route
  // Group" so showing them as folders matches that intent.

  /** A home page can live at `app/page.client.tsx` OR `app/(template)/page.client.tsx`.
   *  We only have one Home in the tree — find whichever exists. */
  const findHomePath = (): string | null => {
    if (projectFS.exists('app/page.client.tsx')) return 'app/page.client.tsx';
    for (const file of pageFiles) {
      if (file.match(/^app\/\([^)]+\)\/page\.client\.tsx$/)) return file;
    }
    return null;
  };
  const homePath = findHomePath() ?? 'app/page.client.tsx';

  // Templated pages (in a route group with LayoutClient) — these surface
  // FLAT in the panel. Plain-route-group pages stay nested under their
  // group folder.
  const templatedPages: string[] = [];
  const plainGroupPages = new Map<string, string[]>();
  const sortedGroups = [...groupNames].sort();
  for (const groupName of sortedGroups) {
    const groupDir = `app/(${groupName})`;
    const isTemplate =
      projectFS.exists(`${groupDir}/LayoutClient.tsx`) || projectFS.exists(`${groupDir}/layout.tsx`);
    const pages = groupedPages.get(groupName) ?? [];
    if (isTemplate) {
      templatedPages.push(...pages);
    } else {
      plainGroupPages.set(groupName, pages);
    }
  }

  // 1) Plain organisational route groups still render as folders.
  for (const [groupName, pages] of plainGroupPages) {
    const groupDir = `app/(${groupName})`;
    const groupHome = `${groupDir}/page.client.tsx`;
    const nested = nestPagesByPath(pages, groupHome, 1);
    tree.push({
      id: `group:${groupName}`,
      filePath: groupDir,
      displayPath: groupDir,
      label: `(${groupName})`,
      type: 'group',
      group: groupName,
      depth: 0,
      isHome: false,
      isTemplate: false,
      children: nested,
    });
  }

  // 2) All other pages — bare AND templated — flat at root level.
  const flatPages = [...(groupedPages.get(null) ?? []), ...templatedPages];
  const flat = nestPagesByPath(flatPages, homePath, 0);
  tree.push(...flat);

  // Sort: home first, then everything alphabetical. Plain groups stay in
  // their natural alphabetical slot among the pages.
  tree.sort((a, b) => {
    if (a.isHome) return -1;
    if (b.isHome) return 1;
    return a.label.localeCompare(b.label);
  });

  // Inject A/B test variant rows as children of their parent page.
  // Walks `_revyme/variants/<testId>/test.json` manifests written at
  // test-creation time and matches each one to its parent page entry by
  // `pagePath`. Each matching page gains:
  //   - Variant A row (the page itself; clicking it just re-selects the page)
  //   - Variant B, C, D… rows pointing at `_revyme/variants/<testId>/<id>.tsx`
  // The recursive injector handles nested page entries (templated pages
  // sit under their group's children, so we walk the tree).
  injectAbVariants(tree);

  trace.action('FileExplorer.buildPageTree:result', { entryCount: tree.length, groups: sortedGroups });
  return tree;
}

/** Manifest written at `_revyme/variants/<testId>/test.json` whenever a
 *  test is created. Decoupled from the backend so the tree builder can
 *  reconstruct the page→variants relationship without an HTTP call. */
interface AbVariantManifest {
  testId: string;
  pagePath: string;
  variants: Array<{ id: string; name: string; weight: number }>;
}

function loadAbVariantManifests(): AbVariantManifest[] {
  const out: AbVariantManifest[] = [];
  const files = projectFS.listFiles('_revyme/variants/');
  for (const file of files) {
    if (!file.endsWith('/test.json')) continue;
    const json = projectFS.readFile(file);
    if (!json) continue;
    try {
      const parsed = JSON.parse(json) as AbVariantManifest;
      if (parsed.testId && parsed.pagePath && Array.isArray(parsed.variants)) {
        out.push(parsed);
      }
    } catch {
      // Malformed manifest — skip; the test is still in the backend DB but
      // we won't render its variants until the file is fixed.
    }
  }
  return out;
}

/** Walk the tree and mutate each page entry whose filePath matches a
 *  manifest's pagePath — append variant rows as children. Recurses into
 *  groups so templated pages inside `(template)/` get their variants too. */
function injectAbVariants(tree: PageTreeEntry[]): void {
  const manifests = loadAbVariantManifests();
  if (manifests.length === 0) return;

  const byPage = new Map<string, AbVariantManifest[]>();
  for (const m of manifests) {
    const list = byPage.get(m.pagePath) ?? [];
    list.push(m);
    byPage.set(m.pagePath, list);
  }

  function walk(entries: PageTreeEntry[]) {
    for (const entry of entries) {
      if (entry.type === 'group') {
        walk(entry.children);
        continue;
      }
      if (entry.type !== 'page') continue;
      const tests = byPage.get(entry.filePath);
      if (!tests || tests.length === 0) continue;

      // Build the variant children. Each test contributes its full
      // variant set (A = baseline at the page itself; B onward = real
      // files). Indent step is 20 px (matches the TreeRow formula
      // `depth * 20 + 12`), so variant children' chevron column lands
      // directly under the parent page's icon — no manual
      // customPaddingLeft needed.
      const variantChildren: PageTreeEntry[] = [];
      for (const test of tests) {
        for (const v of test.variants) {
          const letter = v.id.toUpperCase();
          const isBaseline = v.id === 'a';
          variantChildren.push({
            id: `${entry.id}:${test.testId}:${v.id}`,
            // Baseline 'a' uses the parent page's file; B+ use the variant file.
            filePath: isBaseline
              ? entry.filePath
              : `_revyme/variants/${test.testId}/${v.id}.tsx`,
            displayPath: v.name,
            label: v.name,
            type: 'variant',
            group: entry.group,
            depth: entry.depth + 1,
            isHome: false,
            isVariant: true,
            variantTestId: test.testId,
            variantId: v.id,
            variantLetter: letter,
            children: [],
          });
        }
      }
      // Order: variants FIRST, then sub-routes. The TreeRow render
      // inserts a hairline divider at the variant/non-variant
      // boundary so the user sees the visual grouping (the reference ships
      // the same separator pattern).
      entry.children = [...variantChildren, ...entry.children];
    }
  }

  walk(tree);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Flatten a tree into a list of entries (for drag-drop target lookup) */
function flattenTree(tree: PageTreeEntry[], collapsed: Set<string>): PageTreeEntry[] {
  const result: PageTreeEntry[] = [];
  for (const entry of tree) {
    result.push(entry);
    // Recurse into anything that has children: groups, sub-route pages,
    // pages with A/B variant children. The drag system looks up rows
    // by id in this flattened list — without recursing into pages we
    // miss every nested entry and the drop bails with
    // "src-not-found-or-not-page".
    if (!collapsed.has(entry.id) && entry.children.length > 0) {
      result.push(...flattenTree(entry.children, collapsed));
    }
  }
  return result;
}

/** Extract the slug segment from a page file path */
export function extractSlug(filePath: string): string {
  // app/about/page.tsx → about
  // app/(marketing)/about/page.tsx → about
  const parts = filePath.replace(/^app\//, '').split('/');
  // Remove page.tsx
  parts.pop();
  // Remove route group if present
  const filtered = parts.filter(p => !p.startsWith('('));
  return filtered.join('/') || '';
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function FileExplorer() {
  // Viewer mode — the Pages "+" (new page / 404 page) is a write
  // action and gets disabled.
  const isViewer = useIsViewer();
  const [activeFile, setActiveFile] = useAtom(activeFilePathAtom);
  const setSelectedIds = useSetAtom(selectedIdsAtom);
  const setUpdatingFromCanvas = useSetAtom(updatingFromCanvasAtom);
  const setBreadcrumb = useSetAtom(componentBreadcrumbAtom);
  const setVersion = useSetAtom(projectVersionAtom);
  // Read STABLE — file tree doesn't need to refresh on every per-reparent
  // file write during drag. The sync effect in Canvas.tsx catches it up on
  // drag end so renames/adds reflect in the tree before the next interaction.
  const version = useAtomValue(stableProjectVersionAtom);
  // The stable mirror is a lagging debounce — fine for prop parsers, terrible
  // for STRUCTURAL ops the user just performed here (a created page's rename
  // row appeared ~2s late while the create burst kept resetting the mirror
  // timer). Own ops bump this local counter so the tree rebuilds INSTANTLY;
  // external changes still ride the stable version.
  const [structuralBump, setStructuralBump] = useState(0);
  const bumpTreeNow = useCallback(() => setStructuralBump(b => b + 1), []);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Page search: filters the tree to entries whose label, displayPath,
  // or filePath includes the query (case-insensitive). Group / template
  // rows are kept whenever ANY of their descendant pages match so the
  // user still sees the route-group container leading down to a deep
  // match. Empty query passes the tree through untouched.
  const [pageSearchQuery, setPageSearchQuery] = useState('');
  const pageSearchActive = pageSearchQuery.trim().length > 0;
  // Drag state lives in module-level atoms (shared with the Library
  // panel's drag system) so two drags can't run simultaneously across
  // the editor. resolveFolderTreeDrop() writes the indicator; rows
  // read it via these atoms to render the drop-position visuals.
  const dragIndicator = useAtomValue(folderTreeIndicatorAtom);
  const setDragIndicator = useSetAtom(folderTreeIndicatorAtom);
  const draggedId = useAtomValue(folderTreeDraggedAtom);
  const setDraggedId = useSetAtom(folderTreeDraggedAtom);
  const [showAddMenu, setShowAddMenu] = useState(false);
  // Route-group / Template name prompts — NameInputModal replaces the
  // browser window.prompt these flows used before.
  const [routeGroupModalOpen, setRouteGroupModalOpen] = useState(false);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  // entry.id of the row currently in inline-rename mode (page or
  // variant). Cleared on commit or Esc by the SidebarRow input.
  const [renamingEntryId, setRenamingEntryId] = useState<string | null>(null);
  // Plan-cap upsell modal. Set when a PATCH/POST comes back 402 with
  // the backend's Upgrade-to-Studio message; the modal relays it and
  // points the user at Settings → Plans.
  const [upgradeMessage, setUpgradeMessage] = useState<string | null>(null);
  const setSettingsOpen = useSetAtom(settingsOverlayOpenAtom);
  const setSettingsSection = useSetAtom(settingsSectionAtom);
  const setSelectedSeoPage = useSetAtom(selectedSeoPageAtom);
  // Pending variant-delete confirmation. Stored as the entry + message
  // so the ConfirmDeleteModal can render the right copy (variant vs.
  // whole-test cascade) and run the same delete logic on confirm.
  const [variantDelete, setVariantDelete] = useState<{
    entry: PageTreeEntry;
    title: string;
    message: string;
  } | null>(null);
  // Pending page-delete confirmation — same shape as variantDelete
  // but holds the file path so the confirm handler can call
  // `deletePageFile` directly. Replaces the prior `window.confirm`
  // prompt that the user flagged as out-of-design.
  const [pageDelete, setPageDelete] = useState<{
    filePath: string;
    displayName: string;
  } | null>(null);
  // Shift-click multi-select. The set holds extra page file paths the
  // user has chosen to bulk-act on; rendered with an accent outline so
  // each picked row reads as part of one selection. Plain (non-shift)
  // click on any row clears this — it falls back to the normal
  // "single active file" behaviour. Bulk delete via the Delete /
  // Backspace key opens `bulkPagesDelete` below.
  const [multiSelectedPages, setMultiSelectedPages] = useState<Set<string>>(new Set());
  // Pending bulk-delete confirmation — list of file paths queued for
  // deletion when the user pressed Delete with a multi-select active.
  // The modal renders the count + a sample of names; confirm fires the
  // same `performPageDelete` per path the single-page flow already uses.
  const [bulkPagesDelete, setBulkPagesDelete] = useState<{
    filePaths: string[];
    displayNames: string[];
  } | null>(null);
  // Pending "Make as Control" confirmation. Promotes a variant's tree
  // to the baseline page and ends the test — the reference's natural way to
  // adopt a winner without a separate Promote-Winner workflow.
  const [makeControlTarget, setMakeControlTarget] = useState<PageTreeEntry | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);

  /** Runs the actual variant-delete on confirm. Cascade-deletes the
   *  whole test when removing this variant would drop the test below
   *  the 2-variant minimum the backend enforces. Mirrors the local
   *  manifest sweep so the deploy bundle doesn't ship orphan files. */
  const performVariantDelete = useCallback(async (variantEntry: PageTreeEntry) => {
    const testId = variantEntry.variantTestId;
    const variantId = variantEntry.variantId;
    if (!testId || !variantId) return;
    const manifest = loadAbVariantManifests().find(m => m.testId === testId);
    if (!manifest) return;
    const remaining = manifest.variants.filter(v => v.id !== variantId);
    const deleteWholeTest = remaining.length < 2;

    try {
      if (deleteWholeTest) {
        const r = await fetch(`/api/ab-tests/${testId}`, { method: 'DELETE' });
        if (!r.ok) {
          const j = await r.json().catch(() => null);
          alert(j?.error?.message ?? 'Could not delete test');
          return;
        }
        const manifestPath = `_revyme/variants/${testId}/test.json`;
        if (projectFS.exists(manifestPath)) projectFS.deleteFile(manifestPath);
        for (const v of manifest.variants) {
          if (v.id === 'a') continue;
          const variantPath = `_revyme/variants/${testId}/${v.id}.tsx`;
          if (projectFS.exists(variantPath)) projectFS.deleteFile(variantPath);
        }
        trace.action('FileExplorer.abTest.testDeleted', { testId, cause: 'last-variant-removed' });
      } else {
        const r = await fetch(`/api/ab-tests/${testId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ variants: remaining }),
        });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j?.test) {
          alert(j?.error?.message ?? 'Could not delete variant');
          return;
        }
        const manifestPath = `_revyme/variants/${testId}/test.json`;
        projectFS.writeFile(manifestPath, JSON.stringify({
          testId,
          pagePath: manifest.pagePath,
          variants: j.test.variants,
        }, null, 2));
        if (variantId !== 'a') {
          const variantPath = `_revyme/variants/${testId}/${variantId}.tsx`;
          if (projectFS.exists(variantPath)) projectFS.deleteFile(variantPath);
        }
        trace.action('FileExplorer.abTest.variantDeleted', { testId, variantId });
      }
      // Bounce off the deleted variant file so the canvas doesn't
      // hang on a now-missing path.
      if (activeFile === variantEntry.filePath
          && variantEntry.filePath.startsWith('_revyme/variants/')) {
        setActiveFile(manifest.pagePath);
      }
      setVersion(v => v + 1); bumpTreeNow();
      window.dispatchEvent(new Event('ab-tests-changed'));
    } catch (e) {
      trace.error('FileExplorer.abTest.deleteVariant', e);
      alert('Could not delete variant. Try again.');
    }
  }, [activeFile, setActiveFile, setVersion]);

  /** Promote a variant to the baseline. Reads the variant's `.tsx`,
   *  writes it as the parent page's source, then nukes the whole test
   *  (DB row + manifest + every variant file) — the reference's "Make as
   *  Control" semantic. The page now serves what the variant served;
   *  the test stops splitting traffic; conversion data already in
   *  analytics stays put. */
  const performMakeAsControl = useCallback(async (variantEntry: PageTreeEntry) => {
    const testId = variantEntry.variantTestId;
    const variantId = variantEntry.variantId;
    if (!testId || !variantId || variantId === 'a') return;
    const manifest = loadAbVariantManifests().find(m => m.testId === testId);
    if (!manifest) return;

    const variantPath = `_revyme/variants/${testId}/${variantId}.tsx`;
    const variantCode = projectFS.readFile(variantPath);
    if (variantCode === null) {
      alert('Could not read variant content.');
      return;
    }

    try {
      // 1. Overwrite the baseline page file with the variant's tree.
      //    This is the actual "promote" — from here on, every visitor
      //    sees what variant B served.
      projectFS.writeFile(manifest.pagePath, variantCode);

      // 2. Tear down the test on the backend. Variants no longer have
      //    a purpose; the experiment is over.
      const r = await fetch(`/api/ab-tests/${testId}`, { method: 'DELETE' });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        alert(j?.error?.message ?? 'Could not end the test after promoting.');
        return;
      }

      // 3. Sweep variant files + manifest so the deploy bundle doesn't
      //    ship orphan trees and the FileExplorer doesn't keep
      //    rendering ghost variant rows.
      const manifestPath = `_revyme/variants/${testId}/test.json`;
      if (projectFS.exists(manifestPath)) projectFS.deleteFile(manifestPath);
      for (const v of manifest.variants) {
        if (v.id === 'a') continue;
        const path = `_revyme/variants/${testId}/${v.id}.tsx`;
        if (projectFS.exists(path)) projectFS.deleteFile(path);
      }

      // 4. If the user was sitting on the variant file, hop back to
      //    the baseline page so the canvas doesn't hang on a deleted
      //    file path.
      if (activeFile === variantEntry.filePath
          && variantEntry.filePath.startsWith('_revyme/variants/')) {
        setActiveFile(manifest.pagePath);
      }

      trace.action('FileExplorer.abTest.makeAsControl', { testId, variantId });
      setVersion(v => v + 1); bumpTreeNow();
      window.dispatchEvent(new Event('ab-tests-changed'));
    } catch (e) {
      trace.error('FileExplorer.abTest.makeAsControl', e);
      alert('Could not promote variant. Try again.');
    }
  }, [activeFile, setActiveFile, setVersion]);

  trace.fn('FileExplorer.render', { activeFile, version });

  // Build tree from ProjectFS
  const tree = useMemo(() => buildPageTree(version), [version, structuralBump]);
  const flat = useMemo(() => flattenTree(tree, collapsed), [tree, collapsed]);

  // Search-filtered tree. Walks the hierarchy recursively, keeping each
  // entry either when it matches OR when any descendant matches (so a
  // matching nested page surfaces with its group containers as
  // breadcrumbs). When search is empty we pass `tree` through — zero
  // cost. Filtered groups also get their children replaced with the
  // already-filtered subset so collapsing/expanding doesn't reveal
  // non-matching siblings.
  const displayTree = useMemo(() => {
    if (!pageSearchActive) return tree;
    const q = pageSearchQuery.trim().toLowerCase();
    const filter = (entries: PageTreeEntry[]): PageTreeEntry[] => {
      const out: PageTreeEntry[] = [];
      for (const e of entries) {
        const haystack = `${e.label} ${e.displayPath} ${e.filePath}`.toLowerCase();
        const selfMatches = haystack.includes(q);
        const filteredChildren = filter(e.children);
        if (selfMatches || filteredChildren.length > 0) {
          out.push({ ...e, children: filteredChildren });
        }
      }
      return out;
    };
    return filter(tree);
  }, [tree, pageSearchActive, pageSearchQuery]);

  // All page files for delete check — one per route (the canvas-
  // editable .client.tsx half of each page pair).
  const pageFiles = useMemo(() => {
    return projectFS.listFiles('app/').filter(f => f.endsWith('page.client.tsx'));
  }, [version]);

  // ─── File switching ─────────────────────────────────────────────────────

  const switchFile = useCallback((filePath: string) => {
    // Plain (non-shift) click drops any extra multi-select picks — the
    // user is back to single-page navigation. Shift-click goes through
    // `togglePageInMultiSelect` instead and never reaches here.
    setMultiSelectedPages(prev => (prev.size === 0 ? prev : new Set()));
    // Top-level file open — NOT a drill-in. Reset the drill-in breadcrumb so a
    // directly-opened template/component doesn't inherit a stale page context
    // (e.g. scroll Section anchors resolving from a previously-edited page).
    setBreadcrumb([]);
    switchActiveFile(activeFile, filePath,
      { setActiveFile, setSelectedIds, setUpdatingFromCanvas },
      { syncQueueCode, flushNow },
    );
  }, [activeFile, setActiveFile, setSelectedIds, setUpdatingFromCanvas, setBreadcrumb]);

  // Shift-click toggles a page into / out of the bulk-select set. The
  // active file always counts as "selected" too (it's the natural
  // anchor), so the set holds the EXTRAS. Toggling an already-picked
  // page off doesn't reset anything — the user can fine-tune their
  // selection by shift-clicking the same row twice. Variants and group
  // rows are out of scope (variants are part of an A/B test, groups
  // aren't deletable files).
  const togglePageInMultiSelect = useCallback((filePath: string) => {
    setMultiSelectedPages(prev => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      trace.action('FileExplorer.multiSelect.toggle', {
        filePath, total: next.size,
      });
      return next;
    });
  }, []);

  // Open the bulk-delete confirmation for the current multi-select.
  // Shared between the Delete/Backspace shortcut and the per-row
  // ⋯ menu's "Delete N pages" entry — both paths land in the same
  // modal so the confirm copy + the actual delete loop only live in
  // one place. Filters Home out as a safety net (it can't be deleted
  // anyway, but the modal preview shouldn't list it).
  const requestBulkDelete = useCallback(() => {
    if (multiSelectedPages.size === 0) return;
    const paths = [...multiSelectedPages].filter(p => p !== 'app/page.client.tsx');
    if (paths.length === 0) return;
    setBulkPagesDelete({
      filePaths: paths,
      displayNames: paths.map(p => getFileDisplayName(p)),
    });
    trace.action('FileExplorer.bulkDelete:request', { count: paths.length });
  }, [multiSelectedPages]);

  // ─── Collapse toggle ───────────────────────────────────────────────────

  const toggleCollapse = useCallback((entryId: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      trace.action('FileExplorer.toggleCollapse', { entryId, collapsed: next.has(entryId) });
      return next;
    });
  }, []);

  // ─── Add menu ──────────────────────────────────────────────────────────

  const addPage = useCallback((groupDir?: string) => {
    flushNow();
    const filePath = createPageFile(undefined, groupDir);
    setVersion(v => v + 1); bumpTreeNow();
    setSelectedIds([]);
    setActiveFile(filePath);
    setShowAddMenu(false);
    // Recenter the camera on the new page once it renders — otherwise it
    // inherits the previous page's pan/zoom and a fresh page can sit far
    // off-screen. Instant (no tween), fires after the new content's
    // render-complete so it frames the new viewport, not the old one.
    fitAllOnNextRender();
    // Drop the new row straight into rename mode so the user can give
    // it a real name instead of stumbling onto "/page-3" first.
    // Matches the reference's flow for creating a new page.
    setRenamingEntryId(`page:${filePath}`);
    bumpTreeNow();
    trace.action('FileExplorer.addPage', { filePath, groupDir });
  }, [setActiveFile, setSelectedIds, setVersion]);

  // ─── CMS Page menu ────────────────────────────────────────────────────────
  // DropdownMenu now supports native cascading submenus, so the "New CMS
  // Page" item just declares its `submenuItems` recursively — no state
  // machine needed. Hovering opens each level; clicking a leaf creates
  // the page.
  const collectionSchemas = useAtomValue(collectionSchemasAtom);

  const addNotFoundPage = useCallback(() => {
    flushNow();
    const filePath = createNotFoundPageFile();
    setVersion(v => v + 1); bumpTreeNow();
    setSelectedIds([]);
    setActiveFile(filePath);
    setShowAddMenu(false);
    fitAllOnNextRender(); // recenter on the new page once it renders
    trace.action('FileExplorer.addNotFoundPage', { filePath });
  }, [setActiveFile, setSelectedIds, setVersion]);

  const addCmsPage = useCallback((slug: string, mode: 'index' | 'detail') => {
    flushNow();
    const filePath = mode === 'index'
      ? createCmsIndexPageFile(slug)
      : createCmsDetailPageFile(slug);
    setVersion(v => v + 1); bumpTreeNow();
    setSelectedIds([]);
    setActiveFile(filePath);
    setShowAddMenu(false);
    fitAllOnNextRender(); // recenter on the new page once it renders
    trace.action('FileExplorer.addCmsPage', { filePath, slug, mode });
  }, [setActiveFile, setSelectedIds, setVersion]);

  const addRouteGroup = useCallback(() => {
    setRouteGroupModalOpen(true);
  }, []);

  // Runs after the user submits the route-group name in the modal.
  const performAddRouteGroup = useCallback((name: string) => {
    // Clean the name: remove parens, spaces
    const clean = name.replace(/[()]/g, '').trim().toLowerCase().replace(/\s+/g, '-');
    if (!clean) return;

    flushNow();
    createRouteGroup(clean, true);
    setVersion(v => v + 1); bumpTreeNow();
    setShowAddMenu(false);
    trace.action('FileExplorer.addRouteGroup', { name: clean });
  }, [setVersion]);

  /** Create a new Template — same mechanism as a route group with a layout,
   *  but the picker UI + Pages-panel icon treat it as the first-class
   *  Template entity. Wraps `createTemplate` from template-ops so name
   *  validation + conflict detection live in one place. */
  const addTemplate = useCallback(() => {
    setTemplateModalOpen(true);
  }, []);

  // Runs after the user submits the template name in the modal.
  const performAddTemplate = useCallback((name: string) => {
    const clean = name.replace(/[()]/g, '').trim().toLowerCase().replace(/\s+/g, '-');
    if (!clean) return;

    flushNow();
    // One history entry for the creation (template ops bypass the queue —
    // without this the create was absent from the undo timeline).
    sealPendingHistory();
    const result = createTemplate(clean);
    if (!result) {
      alert(`Could not create template "${clean}" — name may be invalid or already in use.`);
      return;
    }
    setVersion(v => v + 1); bumpTreeNow();
    setShowAddMenu(false);
    pushHistoryFileOp(activeFile);
    trace.action('FileExplorer.addTemplate', { name: clean });
  }, [setVersion, activeFile]);

  // Outside click + Escape handled by DropdownMenu component

  // ─── Delete ────────────────────────────────────────────────────────────

  // Open the design-system confirm modal — the actual delete runs
  // from `performPageDelete` after the user clicks Delete in the
  // modal. Splitting them lets the modal manage the cancel path
  // (Escape / click-outside / Cancel) without re-running the
  // last-page / home-page guards.
  const deletePage = useCallback((filePath: string) => {
    if (pageFiles.length <= 1) return; // Can't delete last page
    if (filePath === 'app/page.client.tsx') return; // Can't delete home page

    const displayName = getFileDisplayName(filePath);
    setPageDelete({ filePath, displayName });
    trace.action('FileExplorer.deletePage:request', { filePath });
  }, [pageFiles]);

  // Runs the actual delete after the user confirms via the modal.
  // `deletePageFile` handles BOTH halves of the page pair (server
  // wrapper + client body) so callers don't have to think about it.
  const performPageDelete = useCallback((filePath: string) => {
    trace.action('FileExplorer.deletePage:confirm', { filePath });
    deletePageFile(filePath);
    setVersion(v => v + 1); bumpTreeNow();

    if (filePath === activeFile) {
      const fallback = pageFiles.find(f => f !== filePath) ?? 'app/page.client.tsx';
      setActiveFile(fallback);
      setSelectedIds([]);
    }
  }, [pageFiles, activeFile, setActiveFile, setSelectedIds, setVersion]);

  // ─── Duplicate ─────────────────────────────────────────────────────────

  const duplicatePage = useCallback((filePath: string) => {
    flushNow();
    // Read the canvas body — the wrapper is a 5-line shim we'll
    // regenerate, so no need to read it here.
    const clientCode = projectFS.readFile(filePath);
    if (!clientCode) return;

    // Derive new path: app/about/page.client.tsx → app/about-copy/page.client.tsx
    const group = getRouteGroup(filePath);
    // `getPageSlug` returns the URL-style form ("/about"), but we're
    // building a filesystem path here — strip the leading slash so
    // `${baseDir}/${newSlug}/...` doesn't collapse to
    // `app//about-copy/...`. Without this, every duplicate added
    // an extra slash to the displayed name (visible as `///page-X-
    // copy-copy` after two duplicates).
    const slug = getPageSlug(filePath).replace(/^\//, '');
    const baseDir = group ? `app/(${group})` : 'app';
    let newSlug = slug ? `${slug}-copy` : 'page-copy';

    // Ensure unique path — probe the client half (the .tsx wrapper is
    // a sibling that always exists alongside it).
    let newPath = `${baseDir}/${newSlug}/page.client.tsx`;
    let counter = 1;
    while (projectFS.exists(newPath)) {
      newSlug = slug ? `${slug}-copy-${counter}` : `page-copy-${counter}`;
      newPath = `${baseDir}/${newSlug}/page.client.tsx`;
      counter++;
    }

    // Write both halves of the new page pair — client gets the
    // copied body, server is a fresh wrapper that renders it.
    projectFS.writeFile(newPath, clientCode);
    const newServerPath = newPath.replace(/page\.client\.tsx$/, 'page.tsx');
    projectFS.writeFile(newServerPath, `import PageClient from './page.client';

export const metadata = {};

export default function Page() {
  return <PageClient />;
}
`);
    setVersion(v => v + 1); bumpTreeNow();
    switchActiveFile(activeFile, newPath,
      { setActiveFile, setSelectedIds, setUpdatingFromCanvas },
      { syncQueueCode, flushNow },
    );
    trace.action('FileExplorer.duplicatePage', { from: filePath, to: newPath });
  }, [activeFile, setActiveFile, setSelectedIds, setUpdatingFromCanvas, setVersion]);

  // ─── Drag-and-drop (pointer-based, ported from the Library panel
  //     FolderTree). HTML5 drag-drop was glitchy: jumpy hit-tests,
  //     couldn't drop on the panel's empty space (to move to root),
  //     and the dragImage flicker. The pointer system uses a 3px
  //     threshold + document-level listeners + elementsFromPoint hit-
  //     test (resolveFolderTreeDrop), which matches the reference's feel. ──
  //
  //     Constraints preserved:
  //       - Home (app/page.tsx) can't be dragged or made a child
  //       - Variant rows can't be dragged or dropped onto
  //       - A page can't be nested under itself or its own descendants

  /** True when `targetId` is `draggedId` or one of its descendants in
   *  the current tree — refuses to drop a page into its own subtree. */
  const wouldNestInsideSelf = useCallback((draggedRowId: string, targetRowId: string): boolean => {
    if (draggedRowId === targetRowId) return true;
    const draggedEntry = flat.find(e => e.id === draggedRowId);
    if (!draggedEntry || draggedEntry.type !== 'page') return false;
    const draggedDir = draggedEntry.filePath.replace(/\/page\.client\.tsx$/, '') + '/';
    const targetEntry = flat.find(e => e.id === targetRowId);
    if (!targetEntry || targetEntry.type !== 'page') return false;
    return targetEntry.filePath.startsWith(draggedDir);
  }, [flat]);

  /** Move a page AND every nested child page along with it. The base
   *  movePageFile handles ONE page pair (server + client) at a time;
   *  a page with sub-routes needs the whole directory subtree
   *  relocated or its children get orphaned at the old path.
   *
   *  Iteration: page-pair halves are dispatched to movePageFile
   *  (which handles both atomically), so we only invoke once per
   *  route via the .client.tsx half — the server wrapper rides along.
   *  Non-page files in the subtree get a plain projectFS.moveFile. */
  const movePageSubtree = useCallback((srcPath: string, destPath: string) => {
    const srcDir = srcPath.replace(/\/page\.client\.tsx$/, '').replace(/\/page\.tsx$/, '') + '/';
    const destDir = destPath.replace(/\/page\.client\.tsx$/, '').replace(/\/page\.tsx$/, '') + '/';
    // Snapshot the file list — moveFile mutates projectFS underneath
    // us, so iterating live would skip rows.
    const filesUnderSrc = projectFS.listFiles()
      .filter(p => p === srcPath || p.startsWith(srcDir));
    let movedActive: string | null = null;
    for (const oldFp of filesUnderSrc) {
      const newFp = oldFp === srcPath
        ? destPath
        : destDir + oldFp.slice(srcDir.length);
      if (oldFp === newFp) continue;
      // Skip the server wrapper — movePageFile picks it up when we
      // process the .client.tsx half of the same pair.
      if (oldFp.endsWith('/page.tsx') && !oldFp.endsWith('/page.client.tsx')) continue;
      if (oldFp.endsWith('/page.client.tsx')) {
        movePageFile(oldFp, newFp);
      } else {
        // Non-page file (layout, css, etc.) — plain move.
        if (projectFS.exists(oldFp)) projectFS.moveFile(oldFp, newFp);
      }
      if (activeFile === oldFp) movedActive = newFp;
    }
    if (movedActive) setActiveFile(movedActive);
  }, [activeFile, setActiveFile]);

  /** Start a pointer drag on `entry`. Mirrors FolderTree's startDrag
   *  step-for-step: arm threshold, document-level listeners, indicator
   *  via resolveFolderTreeDrop, commit on mouseup. Variant rows and
   *  the Home page short-circuit since they can't be moved. */
  const startPageDrag = useCallback((e: React.MouseEvent, entry: PageTreeEntry) => {
    trace.action('FileExplorer.dragStart', { id: entry.id, type: entry.type, isHome: entry.isHome });
    if (e.button !== 0) return;
    if (entry.type === 'variant') return;
    if (entry.type === 'page' && entry.isHome) return;

    const startX = e.clientX;
    const startY = e.clientY;
    let thresholdMet = false;
    let currentIndicator: FolderTreeDropIndicator | null = null;
    let currentDragged: string | null = null;

    const onMouseMove = (ev: MouseEvent) => {
      if (!thresholdMet) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (Math.abs(dx) < PAGES_DRAG_THRESHOLD_PX && Math.abs(dy) < PAGES_DRAG_THRESHOLD_PX) return;
        thresholdMet = true;
        currentDragged = entry.id;
        setDraggedId(entry.id);
        document.body.style.cursor = 'grabbing';
        trace.action('FileExplorer.dragThresholdMet', { id: entry.id });
      }
      if (!currentDragged) return;

      const next = resolveFolderTreeDrop(ev.clientX, ev.clientY, currentDragged, PAGES_DRAG_NS);
      // Block self-nesting + descendants (cycle protection).
      if (next && wouldNestInsideSelf(currentDragged, next.rowId)) {
        currentIndicator = null;
        setDragIndicator(null);
        return;
      }
      currentIndicator = next;
      setDragIndicator(next);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      const ind = currentIndicator;
      const dragged = currentDragged;
      setDraggedId(null);
      setDragIndicator(null);
      trace.action('FileExplorer.dragMouseUp', {
        thresholdMet, dragged, indicator: ind,
      });
      if (!ind || !dragged || ind.rowId === dragged) {
        trace.action('FileExplorer.dragCancel', { reason: !ind ? 'no-indicator' : !dragged ? 'no-dragged' : 'same-row' });
        return;
      }

      // Resolve dragged page + target entry.
      const srcEntry = flat.find(en => en.id === dragged);
      if (!srcEntry || srcEntry.type !== 'page') {
        trace.action('FileExplorer.dragBail', { reason: 'src-not-found-or-not-page', dragged, srcType: srcEntry?.type });
        return;
      }
      const targetEntry = flat.find(en => en.id === ind.rowId);
      if (!targetEntry) {
        trace.action('FileExplorer.dragBail', { reason: 'target-not-found', target: ind.rowId });
        return;
      }

      // Use just the LEAF directory name when relocating. extractSlug
      // returns the full nested path ("ergergerg/wdwdwdwd/page-3");
      // we only want the last segment so the page becomes a sibling
      // of the target, not a deeply-nested clone of its old location.
      const slugFull = extractSlug(srcEntry.filePath);
      if (!slugFull) {
        trace.action('FileExplorer.dragBail', { reason: 'no-slug', srcPath: srcEntry.filePath });
        return;
      }
      const slugSegments = slugFull.split('/');
      const leafSlug = slugSegments[slugSegments.length - 1]!;

      // Compute the new file path based on the drop position.
      let newPath: string;
      if (ind.position === 'inside') {
        if (targetEntry.type === 'group') {
          newPath = `app/(${targetEntry.group})/${leafSlug}/page.client.tsx`;
        } else if (targetEntry.type === 'page') {
          const targetDir = targetEntry.filePath.replace(/\/page\.client\.tsx$/, '');
          newPath = `${targetDir}/${leafSlug}/page.client.tsx`;
        } else {
          trace.action('FileExplorer.dragBail', { reason: 'inside-target-not-page-or-group', targetType: targetEntry.type });
          return;
        }
      } else {
        // before / after — drop into the target's parent directory.
        if (targetEntry.type === 'page') {
          const targetDir = targetEntry.filePath.replace(/\/page\.client\.tsx$/, '');
          const lastSlash = targetDir.lastIndexOf('/');
          const parentDir = lastSlash >= 0 ? targetDir.slice(0, lastSlash) : 'app';
          newPath = `${parentDir}/${leafSlug}/page.client.tsx`;
        } else if (targetEntry.type === 'group') {
          newPath = `app/${leafSlug}/page.client.tsx`;
        } else {
          trace.action('FileExplorer.dragBail', { reason: 'sibling-target-not-page-or-group', targetType: targetEntry.type });
          return;
        }
      }

      const oldPath = srcEntry.filePath;
      trace.action('FileExplorer.dragResolved', { oldPath, newPath, position: ind.position });
      if (oldPath === newPath) {
        trace.action('FileExplorer.dragBail', { reason: 'same-path', oldPath });
        return;
      }
      if (projectFS.exists(newPath)) {
        trace.action('FileExplorer.dragBail', { reason: 'conflict', from: oldPath, to: newPath });
        return;
      }

      trace.action('FileExplorer.drop', {
        from: oldPath, to: newPath, position: ind.position, target: ind.rowId,
      });
      flushNow();
      movePageSubtree(oldPath, newPath);
      setVersion(v => v + 1); bumpTreeNow();
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [flat, setVersion, setDraggedId, setDragIndicator, wouldNestInsideSelf, movePageSubtree]);

  // Cleanup the cursor override if FileExplorer unmounts mid-drag.
  useEffect(() => () => {
    document.body.style.cursor = '';
  }, []);

  // Delete / Backspace fires the bulk-delete confirmation when a
  // shift-click multi-select is active. Listener is document-level
  // (standard) so the keystroke works regardless of where the
  // focus lives — the panel rows themselves aren't focusable. We
  // gate against typing into inputs / textareas / contenteditable
  // surfaces so renaming a page or editing text doesn't trigger a
  // page wipe on every Backspace.
  useEffect(() => {
    if (multiSelectedPages.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }
      e.preventDefault();
      requestBulkDelete();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [multiSelectedPages, requestBulkDelete]);

  // ─── Render ────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col shrink-0">
      {/* Search row sits at the VERY TOP of the panel — above the "Pages"
          SectionLabel so the filter affordance is the first thing the
          user sees on this tab. No top divider; just the search input
          with a divider beneath it separating the controls from the
          "Pages" label + page tree below. */}
      <div className="px-3 pt-3 shrink-0">
        <SearchBar
          value={pageSearchQuery}
          onChange={setPageSearchQuery}
          placeholder="Search pages…"
        />
      </div>
      <ToolDivider />

      {/* Header */}
      <SectionLabel size="md" right={
        <div>
          <AddButton
            ref={addBtnRef}
            disabled={isViewer}
            onClick={isViewer ? undefined : () => setShowAddMenu(prev => !prev)}
            title={isViewer ? 'View only' : 'Add new page or route group'}
            className={isViewer ? 'opacity-40 !cursor-not-allowed hover:!bg-transparent' : ''}
          />
          <DropdownMenu
            isOpen={showAddMenu}
            onClose={() => setShowAddMenu(false)}
            anchorRef={addBtnRef}
            position="bottom-left"
            items={(() => {
              const items: DropdownMenuEntry[] = [
                { id: 'new-page', label: 'New Page', icon: <PageDocumentIcon size={14} />, onClick: () => addPage() },
              ];
              // 404 page — only one allowed per project. Hide the
              // entry once `app/not-found.tsx` exists so the user can't
              // create a duplicate (Next.js wouldn't pick up two).
              if (!notFoundExists()) {
                items.push({
                  id: 'new-404',
                  label: '404 Page',
                  icon: <PageDocumentIcon size={14} />,
                  onClick: () => addNotFoundPage(),
                });
              }
              // Only surface "New CMS Page" when at least one collection
              // exists — otherwise the entry leads to an empty submenu.
              if (collectionSchemas.size > 0) {
                // For each collection, check whether the Index / Detail page
                // file already exists in ProjectFS so we can grey out the
                // matching menu entry. When BOTH exist, the collection's
                // parent item is itself disabled — the user has already
                // generated everything we offer for it. Disabled parents
                // don't open their submenu on hover (DropdownMenu's onMouseEnter
                // skips disabled items) so the cascade just stops.
                items.push({
                  id: 'new-cms-page',
                  label: 'New CMS Page',
                  icon: <PageDocumentIcon size={14} />,
                  // Parent items don't fire onClick — they open their
                  // submenu on hover. The placeholder noop satisfies the
                  // type system.
                  onClick: () => {},
                  submenuItems: Array.from(collectionSchemas).map(([slug, schema]) => {
                    // findCmsPageFile resolves wherever the page ended up — a
                    // Template moves pages into a route group (`app/(Body)/…`),
                    // a detail can co-locate under an index folder or a bumped
                    // (`blog-2`) folder. The old bare `app/<slug>/…` probe
                    // missed all of those and kept offering "Detail Page" for
                    // a collection that already had one (user report 2026-07-28).
                    const indexExists = !!findCmsPageFile(slug, 'index');
                    const detailExists = !!findCmsPageFile(slug, 'detail');
                    const bothExist = indexExists && detailExists;
                    return {
                      id: `cms-collection-${slug}`,
                      label: schema.name ?? slug,
                      onClick: () => {},
                      // Disable the whole collection branch when both
                      // pages already exist — there's literally nothing
                      // to add for it.
                      disabled: bothExist,
                      submenuItems: [
                        {
                          id: `cms-${slug}-index`,
                          label: 'Index',
                          icon: <PageDocumentIcon size={14} />,
                          disabled: indexExists,
                          onClick: () => addCmsPage(slug, 'index'),
                        },
                        {
                          id: `cms-${slug}-detail`,
                          label: 'Detail Page',
                          icon: <PageDocumentIcon size={14} />,
                          disabled: detailExists,
                          onClick: () => addCmsPage(slug, 'detail'),
                        },
                      ],
                    };
                  }),
                });
              }
              // "New Template" + "New Route Group" entries removed —
              // Templates are managed exclusively from the Library
              // panel's Templates section now, and explicit Route Group
              // creation is reserved for Template assignment (which
              // happens automatically when applying a Template to a
              // page). Surfacing them here led to half-configured
              // groups that didn't connect to the Template system.
              return items;
            })()}
          />
        </div>
      }>Pages</SectionLabel>

      {/* Tree */}
      <div className="px-2 pb-1">
        {pageSearchActive && displayTree.length === 0 ? (
          <div className="px-2 py-3 text-xs text-[var(--text-disabled)] text-center">
            No pages match “{pageSearchQuery}”
          </div>
        ) : displayTree.map(entry => (
          <TreeRow
            key={entry.id}
            entry={entry}
            activeFile={activeFile}
            multiSelectedPages={multiSelectedPages}
            onToggleMultiSelect={togglePageInMultiSelect}
            onBulkDelete={requestBulkDelete}
            dragIndicator={dragIndicator}
            draggedId={draggedId}
            collapsed={collapsed}
            onSwitch={switchFile}
            onToggleCollapse={toggleCollapse}
            onDelete={deletePage}
            onDuplicate={duplicatePage}
            onStartDrag={startPageDrag}
            onAddPageToGroup={(groupDir) => { addPage(`app/(${groupDir})`); }}
            onCreateAbTest={async (filePath) => {
              // "New A/B test…" / "Add variant" are both inline — no modal.
              // Naming follows the reference: 'a'=Control, 'b'=Variant, 'c'=Variant 1,
              // 'd'=Variant 2, … (the user can rename in Settings later).
              // a–z: matches the Studio backend cap (26 variants per test).
              // Pro is server-gated at 2; the backend rejects past-cap PATCHes
              // with an Upgrade-to-Studio message that the alert below relays.
              const letters = ['a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s','t','u','v','w','x','y','z'];
              const variantLabel = (id: string): string => {
                if (id === 'a') return 'Control';
                if (id === 'b') return 'Variant';
                return `Variant ${id.charCodeAt(0) - 'b'.charCodeAt(0)}`;
              };

              const existing = loadAbVariantManifests().find(m => m.pagePath === filePath);

              if (!existing) {
                // ── CREATE NEW TEST (Control + Variant) ──
                // Strips `.client.tsx` (not just `.tsx`) so the path has no
                // dot — the backend's PAGE_PATH_RX rejects dots, which is why
                // creation broke once pages became `page.client.tsx`.
                const apiPagePath = filePathToAbPagePath(filePath);
                const variants = ['a', 'b'].map(id => ({
                  id, name: variantLabel(id), weight: 0,
                }));
                try {
                  const websiteId = (await import('@/backend/project-id')).getProjectId();
                  const r = await fetch('/api/ab-tests', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      websiteId, pagePath: apiPagePath, name: 'A/B test',
                      variants, goals: [],
                    }),
                  });
                  const j = await r.json().catch(() => null);
                  if (!r.ok || !j?.test) {
                    // 402 = plan-cap or plan-required (Free/Lite trying
                    // to create a test). Route to the upgrade modal so
                    // the user has a clear path forward.
                    const msg = j?.error?.message ?? 'Could not create test';
                    if (r.status === 402) setUpgradeMessage(msg);
                    else alert(msg);
                    return;
                  }
                  const test = j.test;
                  const manifestPath = `_revyme/variants/${test.id}/test.json`;
                  projectFS.writeFile(manifestPath, JSON.stringify({
                    testId: test.id, pagePath: filePath, variants: test.variants,
                  }, null, 2));
                  const source = projectFS.readFile(filePath);
                  if (source) {
                    for (const v of test.variants) {
                      if (v.id === 'a') continue;
                      const variantPath = `_revyme/variants/${test.id}/${v.id}.tsx`;
                      if (!projectFS.exists(variantPath)) {
                        projectFS.writeFile(variantPath, source);
                      }
                    }
                  }
                  trace.action('FileExplorer.abTest.created', {
                    testId: test.id, pagePath: filePath, variantCount: test.variants.length,
                  });
                  setVersion(v => v + 1); bumpTreeNow();
                  window.dispatchEvent(new Event('ab-tests-changed'));
                } catch (e) {
                  trace.error('FileExplorer.abTest.create', e);
                  alert('Could not create test. Try again.');
                }
                return;
              }

              // ── ADD VARIANT to the existing test ──
              const used = new Set(existing.variants.map(v => v.id));
              const nextIdx = letters.findIndex(l => !used.has(l));
              if (nextIdx === -1) {
                alert('This test already has the maximum of 26 variants.');
                return;
              }
              const nextId = letters[nextIdx]!;
              const nextVariants = [
                ...existing.variants,
                { id: nextId, name: variantLabel(nextId), weight: 0 },
              ];
              try {
                const r = await fetch(`/api/ab-tests/${existing.testId}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ variants: nextVariants }),
                });
                const j = await r.json().catch(() => null);
                if (!r.ok || !j?.test) {
                  // Plan-cap hits return 402 (paymentRequired) — relay
                  // the backend's Upgrade-to-Studio copy through the
                  // upgrade modal instead of a browser alert. Anything
                  // else stays an alert (no obvious upsell action).
                  const msg = j?.error?.message ?? 'Could not add variant';
                  if (r.status === 402) setUpgradeMessage(msg);
                  else alert(msg);
                  return;
                }
                const manifestPath = `_revyme/variants/${existing.testId}/test.json`;
                projectFS.writeFile(manifestPath, JSON.stringify({
                  testId: existing.testId, pagePath: existing.pagePath,
                  variants: j.test.variants,
                }, null, 2));
                const source = projectFS.readFile(filePath);
                if (source) {
                  const variantPath = `_revyme/variants/${existing.testId}/${nextId}.tsx`;
                  if (!projectFS.exists(variantPath)) {
                    projectFS.writeFile(variantPath, source);
                  }
                }
                trace.action('FileExplorer.abTest.variantAdded', {
                  testId: existing.testId, variantId: nextId,
                });
                setVersion(v => v + 1); bumpTreeNow();
                window.dispatchEvent(new Event('ab-tests-changed'));
              } catch (e) {
                trace.error('FileExplorer.abTest.addVariant', e);
                alert('Could not add variant. Try again.');
              }
            }}
            renamingEntryId={renamingEntryId}
            onStartRename={(entry) => setRenamingEntryId(entry.id)}
            onCommitRename={async (entry, newValue) => {
              setRenamingEntryId(null);
              const trimmed = newValue.trim();
              if (!trimmed || trimmed === entry.label) return;

              // ── Variant rename ──
              if (entry.type === 'variant') {
                const testId = entry.variantTestId;
                const variantId = entry.variantId;
                if (!testId || !variantId) return;
                const manifest = loadAbVariantManifests().find(m => m.testId === testId);
                if (!manifest) return;
                const nextVariants = manifest.variants.map(v =>
                  v.id === variantId ? { ...v, name: trimmed } : v,
                );
                const manifestPath = `_revyme/variants/${testId}/test.json`;

                // ── Optimistic: write the manifest LOCALLY first and
                // bump the project version so the tree re-renders with
                // the new label on the next frame. The PATCH below runs
                // in the background to persist to the backend — if it
                // fails we roll the manifest back. This is the same
                // pattern PageAbTestDetail's TestCard uses for state
                // changes and weight edits.
                projectFS.writeFile(manifestPath, JSON.stringify({
                  testId,
                  pagePath: manifest.pagePath,
                  variants: nextVariants,
                }, null, 2));
                setVersion(v => v + 1); bumpTreeNow();
                window.dispatchEvent(new Event('ab-tests-changed'));
                trace.action('FileExplorer.abTest.variantRenamed', { testId, variantId, name: trimmed });

                try {
                  const r = await fetch(`/api/ab-tests/${testId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ variants: nextVariants }),
                  });
                  const j = await r.json().catch(() => null);
                  if (!r.ok || !j?.test) {
                    // Roll back the optimistic write.
                    projectFS.writeFile(manifestPath, JSON.stringify({
                      testId,
                      pagePath: manifest.pagePath,
                      variants: manifest.variants,
                    }, null, 2));
                    setVersion(v => v + 1); bumpTreeNow();
                    alert(j?.error?.message ?? 'Could not rename variant');
                    return;
                  }
                  // Reconcile with whatever the server actually wrote —
                  // covers any normalization the backend might do
                  // (trimming, deduping). Quiet write, no event.
                  projectFS.writeFile(manifestPath, JSON.stringify({
                    testId,
                    pagePath: manifest.pagePath,
                    variants: j.test.variants,
                  }, null, 2));
                } catch (e) {
                  trace.error('FileExplorer.abTest.renameVariant', e);
                  // Network error — roll back.
                  projectFS.writeFile(manifestPath, JSON.stringify({
                    testId,
                    pagePath: manifest.pagePath,
                    variants: manifest.variants,
                  }, null, 2));
                  setVersion(v => v + 1); bumpTreeNow();
                  alert('Could not rename variant. Try again.');
                }
                return;
              }

              // ── Page rename — sluggify the input, move both halves
              // of the page pair (server wrapper + client body). The
              // match regex now anchors on .client.tsx because that's
              // the canonical entry.filePath; movePageSubtree handles
              // the corresponding page.tsx wrapper automatically.
              if (entry.type === 'page') {
                const oldPath = entry.filePath;
                const m = oldPath.match(/^(app(?:\/\([^)]+\))?)\/([^/]+)\/page\.client\.tsx$/);
                if (!m) return;  // home page (app/page.client.tsx) doesn't have a slug to rename
                const prefix = m[1];
                const slug = trimmed.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
                if (!slug) return;
                const newPath = `${prefix}/${slug}/page.client.tsx`;
                if (newPath === oldPath) return;
                trace.action('FileExplorer.renamePage', { from: oldPath, to: newPath });
                flushNow();
                movePageFile(oldPath, newPath);
                setVersion(v => v + 1); bumpTreeNow();
                if (activeFile === oldPath) setActiveFile(newPath);
              }
            }}
            onDeleteVariant={(variantEntry) => {
              // Menu click — open the design-system confirm modal
              // instead of the old window.confirm. The modal's "Delete"
              // button calls the real delete logic below.
              const testId = variantEntry.variantTestId;
              const variantId = variantEntry.variantId;
              if (!testId || !variantId) return;
              const manifest = loadAbVariantManifests().find(m => m.testId === testId);
              if (!manifest) return;
              const remaining = manifest.variants.filter(v => v.id !== variantId);
              const deleteWholeTest = remaining.length < 2;
              setVariantDelete({
                entry: variantEntry,
                title: deleteWholeTest ? 'Delete A/B test' : 'Delete variant',
                message: deleteWholeTest
                  ? `Deleting "${variantEntry.label}" will remove the entire A/B test on this page — a test needs at least 2 variants. This can't be undone.`
                  : `Delete variant "${variantEntry.label}"? This can't be undone.`,
              });
            }}
            onMakeAsControl={(variantEntry) => {
              // Menu click — open the design-system confirm modal.
              // The real promote logic lives in `performMakeAsControl`
              // and runs when the user clicks Confirm.
              setMakeControlTarget(variantEntry);
            }}
            onOpenPageSettings={(filePath) => {
              // Jump straight into the Pages SEO tab pre-selected to
              // THIS page. The SettingsOverlay's URL-sync effect then
              // writes `?settings=pages:<slug>` so the deep link
              // round-trips on refresh.
              trace.action('FileExplorer.pageSettings:open', { filePath });
              setSelectedSeoPage(filePath);
              setSettingsSection('pages');
              setSettingsOpen(true);
            }}
          />
        ))}

        {/* 404 page row — inline at the end of Pages with a badge.
         *  Hidden when the file doesn't exist; the user creates it via
         *  the "+" dropdown's "404 Page" entry. Click switches to it
         *  like any page; Delete via the row menu fully removes the
         *  file (Next.js falls back to its built-in error page until
         *  the user re-creates it). */}
        {notFoundExists() && (
          <SidebarRow
            // Icon size + paddingLeft must MATCH TreeRow's depth-0 row
            // (`size={12}` and `depth * 24 + 12 = 12` px) so the 404
            // row's icon column lines up with Home / every other
            // top-level page. Drift either value and the icon nudges
            // left or right vs the rest of the list.
            icon={<NotFoundIcon size={12} style={{ color: 'currentColor' }} />}
            label="Not Found"
            iconColor="var(--text-secondary)"
            isActive={activeFile === NOT_FOUND_PATH}
            onClick={() => switchFile(NOT_FOUND_PATH)}
            style={{ paddingLeft: 12, cursor: 'pointer' }}
            right={
              <span
                className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-white/10 text-[var(--text-secondary)] tabular-nums"
                title="Project-wide 404 page (app/not-found.tsx)"
              >
                404
              </span>
            }
            menuItems={[
              {
                id: 'delete-404',
                label: 'Delete',
                // Same in-app confirm path as regular page delete —
                // routes through `pageDelete` state so the user sees
                // the design-system modal instead of the browser
                // `confirm()` prompt. `performPageDelete` already
                // handles the active-file fallback case (line 715
                // above), so the inline activeFile reset that used
                // to live here isn't needed.
                onClick: () => {
                  trace.action('FileExplorer.deleteNotFoundPage:request');
                  setPageDelete({
                    filePath: NOT_FOUND_PATH,
                    displayName: 'Not Found',
                  });
                },
              },
            ]}
          />
        )}
      </div>

      {/* Plan-cap upsell — shown when an A/B test mutation comes back
          402 (paymentRequired) carrying the backend's Upgrade-to-Studio
          message. Replaces the browser alert that used to fire here. */}
      <UpgradePlanModal
        message={upgradeMessage}
        onCancel={() => setUpgradeMessage(null)}
        onUpgrade={() => {
          setUpgradeMessage(null);
          setSettingsSection('plans');
          setSettingsOpen(true);
        }}
      />

      {/* Variant delete confirm — design-system modal with a red
          Delete button. Replaces the browser window.confirm prompt. */}
      <ConfirmDeleteModal
        title={variantDelete?.title ?? ''}
        message={variantDelete?.message ?? ''}
        isOpen={!!variantDelete}
        onCancel={() => setVariantDelete(null)}
        onConfirm={() => {
          if (!variantDelete) return;
          const entry = variantDelete.entry;
          setVariantDelete(null);
          void performVariantDelete(entry);
        }}
      />

      {/* Make-as-Control confirm — same modal shell. The "Replace"
          framing matches what's actually happening: the page's content
          is being overwritten with this variant's, and the test ends. */}
      <ConfirmDeleteModal
        title="Make as Control"
        message={
          makeControlTarget
            ? `"${makeControlTarget.label}" will replace the Control page. The A/B test ends and the other variants are removed. Conversion data already in your analytics stays put.`
            : ''
        }
        isOpen={!!makeControlTarget}
        confirmText="Replace Control"
        onCancel={() => setMakeControlTarget(null)}
        onConfirm={() => {
          if (!makeControlTarget) return;
          const entry = makeControlTarget;
          setMakeControlTarget(null);
          void performMakeAsControl(entry);
        }}
      />

      {/* Page delete confirm — same modal shell as variant delete.
          Title quotes the page slug so the user can verify what's
          about to be removed; message warns that the action is
          irreversible (mirrors the variant-delete copy tone). */}
      <ConfirmDeleteModal
        title={pageDelete ? `Delete "${pageDelete.displayName}"?` : ''}
        message="This page and its content will be permanently removed. This cannot be undone."
        isOpen={!!pageDelete}
        onCancel={() => setPageDelete(null)}
        onConfirm={() => {
          if (!pageDelete) return;
          const filePath = pageDelete.filePath;
          setPageDelete(null);
          performPageDelete(filePath);
        }}
      />

      {/* Bulk page delete confirm — fired when the user pressed
          Delete / Backspace with a multi-select active. Lists the
          first few page names + a "+N more" tail so the user can
          double-check the scope before nuking. Confirm iterates the
          same `performPageDelete` per path. */}
      <ConfirmDeleteModal
        title={
          bulkPagesDelete
            ? `Delete ${bulkPagesDelete.filePaths.length} pages?`
            : ''
        }
        message={
          bulkPagesDelete
            ? (() => {
                const names = bulkPagesDelete.displayNames;
                const preview = names.slice(0, 4).join(', ');
                const extra = names.length > 4 ? ` + ${names.length - 4} more` : '';
                return `${preview}${extra}. This cannot be undone.`;
              })()
            : ''
        }
        isOpen={!!bulkPagesDelete}
        onCancel={() => setBulkPagesDelete(null)}
        onConfirm={() => {
          if (!bulkPagesDelete) return;
          const paths = bulkPagesDelete.filePaths;
          setBulkPagesDelete(null);
          setMultiSelectedPages(new Set());
          for (const p of paths) performPageDelete(p);
          trace.action('FileExplorer.bulkDelete:confirm', { count: paths.length });
        }}
      />

      {/* Route group / Template name prompts — NameInputModal replaces the
          browser window.prompt these flows used before. The clean-up +
          create logic runs in the perform* callbacks on submit. */}
      <NameInputModal
        isOpen={routeGroupModalOpen}
        onClose={() => setRouteGroupModalOpen(false)}
        onSubmit={performAddRouteGroup}
        title="New Route Group"
        placeholder='Route group name (e.g. "marketing")'
        submitLabel="Create Route Group"
      />
      <NameInputModal
        isOpen={templateModalOpen}
        onClose={() => setTemplateModalOpen(false)}
        onSubmit={performAddTemplate}
        title="New Template"
        placeholder='Template name (e.g. "marketing")'
        submitLabel="Create Template"
        // Validate the SLUGIFIED name — this call site lower-cases and
        // hyphenates before creating, so validating the raw input would refuse
        // "My Template" that `performAddTemplate` would happily accept.
        validate={(n) => validateTemplateName(n.replace(/[()]/g, '').trim().toLowerCase().replace(/\s+/g, '-'))}
        // Templates share the component-system accent — purple fill, white
        // label — everywhere else in the app; the modal has to match.
        accent="secondary"
      />
    </div>
  );
}

// ─── Confirm-delete modal — design-system modal shell + red Delete
// button. Used by the variant delete flow; can be reused by any other
// destructive action that needs an in-app confirm instead of the
// browser's native window.confirm prompt.

function ConfirmDeleteModal({
  title, message, isOpen, onCancel, onConfirm, confirmText = 'Delete',
}: {
  title: string;
  message: string;
  isOpen: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  /** Label for the destructive button. Defaults to "Delete" because
   *  that's what most callers do; "Replace Control" reuses the same
   *  red-button shell for Make-as-Control. */
  confirmText?: string;
}) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={title}
      width={256}
    >
      <div className="px-3 py-3 flex flex-col gap-3">
        <p className="text-xs text-[var(--text-primary)] leading-relaxed">
          {message}
        </p>
        <button
          type="button"
          onClick={onConfirm}
          className="w-full h-8 text-xs font-medium text-white bg-red-500 hover:bg-red-500/90 rounded-[var(--radius-lg)] cursor-pointer"
        >
          {confirmText}
        </button>
      </div>
    </Modal>
  );
}

// ─── Upgrade-plan modal — relays a 402 error into the design-system
// modal shell + a primary Upgrade button that lands on Settings →
// Plans. Used for variant-cap / goal-cap / concurrent-test rejections.

function UpgradePlanModal({
  message, onCancel, onUpgrade,
}: {
  message: string | null;
  onCancel: () => void;
  onUpgrade: () => void;
}) {
  // 256px (w-64) matches the Name Component modal so the upgrade
  // surface reads as part of the same modal family.
  return (
    <Modal
      isOpen={!!message}
      onClose={onCancel}
      title="Upgrade plan"
      width={256}
    >
      <div className="px-3 py-3 flex flex-col gap-3">
        {/* `whitespace-pre-line` so embedded \n\n in the backend
            message becomes a real paragraph break in the rendered
            modal (the upgrade-cap copy uses one for "Upgrade to
            Studio…" to drop onto its own line). */}
        <p className="text-xs text-[var(--text-primary)] leading-relaxed whitespace-pre-line">
          {message ?? ''}
        </p>
        <button
          type="button"
          onClick={onUpgrade}
          className="w-full h-8 text-xs font-medium text-[var(--accent-fg)] bg-[var(--accent)] hover:opacity-90 rounded-[var(--radius-lg)] cursor-pointer"
        >
          Upgrade
        </button>
      </div>
    </Modal>
  );
}

// ─── Tree Row ───────────────────────────────────────────────────────────────

interface TreeRowProps {
  entry: PageTreeEntry;
  activeFile: string;
  /** Active drop indicator from FolderTree's atom (rowId + position).
   *  Null when no drag is in progress. */
  dragIndicator: FolderTreeDropIndicator | null;
  /** id of the entry currently being dragged, null when idle. Drives
   *  the opacity-down visual on the source row. */
  draggedId: string | null;
  collapsed: Set<string>;
  onSwitch: (filePath: string) => void;
  onToggleCollapse: (entryId: string) => void;
  onDelete: (filePath: string) => void;
  onDuplicate: (filePath: string) => void;
  /** Pointer mousedown handler that arms the drag. The handler ignores
   *  variant rows + the Home page itself. */
  onStartDrag: (e: React.MouseEvent, entry: PageTreeEntry) => void;
  onAddPageToGroup?: (groupDir: string) => void;
  /** A/B test create — triggered from the page row's ellipsis menu.
   *  When undefined (e.g. cloud disabled), the menu item doesn't render. */
  onCreateAbTest?: (filePath: string) => void;
  /** A/B variant delete — confirms, removes the variant. If this drops
   *  the test below 2 variants, deletes the whole test as well. */
  onDeleteVariant?: (entry: PageTreeEntry) => void;
  /** Promote this variant to the baseline. Overwrites the parent
   *  page's file with the variant's content, then ends the test
   *  (standard "Make as Control"). Only enabled for non-baseline
   *  variants — Control (variantId === 'a') IS the baseline. */
  onMakeAsControl?: (entry: PageTreeEntry) => void;
  /** Open Settings → Pages with this page pre-selected. Wires the
   *  "Settings" entry on each page row's ⋯ menu so the user can jump
   *  straight to the per-page SEO form. */
  onOpenPageSettings?: (filePath: string) => void;
  /** When set, this is the entry whose row should render the inline
   *  rename input instead of a static label. SidebarRow handles
   *  focus, Enter / Escape / blur → onCommit. */
  renamingEntryId?: string | null;
  /** "Rename" menu-item click — flips the row into edit mode by
   *  setting renamingEntryId. */
  onStartRename?: (entry: PageTreeEntry) => void;
  /** Inline rename committed — fires when the user hits Enter or
   *  blurs the input. Routes to a variant PATCH or a page-file move
   *  based on the entry type. */
  onCommitRename?: (entry: PageTreeEntry, newValue: string) => void;
  /** Set of page file paths that are part of a shift-click multi-
   *  selection. Rendered with an accent outline so each pick reads as
   *  part of one selection. Variants / groups are never in this set. */
  multiSelectedPages?: Set<string>;
  /** Shift-click handler — toggles a page in/out of `multiSelectedPages`.
   *  Wiring lives in TreeRow's click handler; the parent supplies the
   *  setter so the whole panel can share one set. */
  onToggleMultiSelect?: (filePath: string) => void;
  /** Open the bulk-delete confirmation for the current multi-select set.
   *  When this is wired AND `multiSelectedPages` is non-empty, the row's
   *  ⋯ menu collapses to a single "Delete N pages" entry — Duplicate /
   *  Edit / Rename / Settings / A/B all become meaningless when several
   *  pages are about to be removed at once. */
  onBulkDelete?: () => void;
}

const TreeRow = React.memo(function TreeRow({
  entry, activeFile, dragIndicator, draggedId, collapsed,
  onSwitch, onToggleCollapse, onDelete, onDuplicate, onStartDrag, onAddPageToGroup, onCreateAbTest, onDeleteVariant, onMakeAsControl, onOpenPageSettings, renamingEntryId, onStartRename, onCommitRename, multiSelectedPages, onToggleMultiSelect, onBulkDelete,
}: TreeRowProps) {
  // Viewer mode: no per-row ⋯ menu. Every entry in it (Duplicate, Edit,
  // Rename, Settings, New A/B test, Delete) is a write action, so the
  // whole menu is suppressed — `menuItems=undefined` makes SidebarRow
  // skip the ellipsis button AND the right-click context menu.
  const isViewer = useIsViewer();
  const isActive = entry.filePath === activeFile;
  const isDragged = draggedId === entry.id;
  const isCollapsed = collapsed.has(entry.id);
  const isDropTarget = dragIndicator?.rowId === entry.id;
  const dropPos = isDropTarget ? dragIndicator!.position : null;
  const isDraggable = entry.type === 'page' && !entry.isHome;
  const canDelete = entry.type === 'page' && !entry.isHome;

  // Indent step picked so a CHILD's chevron column lands directly
  // under the PARENT's icon column (standard). Parent row at
  // depth 0 starts at `pl-3 (12 px)`; chevron column ~14 px + gap ~6 px
  // puts the parent's icon at ~32 px. A 20 px step lands depth-1's
  // chevron at `20 + 12 = 32 px` — same x as the parent's icon —
  // and the child's icon a slot further at ~52 px (right under the
  // parent's first text glyph).
  //
  // Previous values: 24 px crept barely past the parent's icon
  // (children looked "barely shifted"); 40 px shoved children too far
  // (chevrons landed past the parent's text, which the user reported
  // as "one slot too far"). 20 px hits the sweet spot the user
  // confirmed against the reference.
  const paddingLeft = entry.customPaddingLeft ?? entry.depth * 20 + 12;

  // Drop indicator styles
  const dropIndicatorStyle: React.CSSProperties = {};
  if (isDropTarget && !isDragged && dropPos === 'inside') {
    dropIndicatorStyle.outline = `1px solid ${PAGES_DRAG_INDICATOR}`;
    dropIndicatorStyle.outlineOffset = -1;
    dropIndicatorStyle.borderRadius = 6;
  }

  // Bundle the parent page + its Control variant (variant 'a') into a
  // single visual block when both are active. Variant 'a' shares the
  // parent's filePath, so clicking either highlights both rows; we
  // strip the meeting border-radius so they read as one contiguous
  // selection — matches the Layers panel's parent + selected-child
  // continuous highlight.
  const isBundleParent = entry.type === 'page'
    && isActive
    && entry.children.some(c => c.type === 'variant' && c.variantId === 'a');
  const isBundleChild = entry.type === 'variant'
    && entry.variantId === 'a'
    && isActive;
  if (isBundleParent) {
    dropIndicatorStyle.borderBottomLeftRadius = 0;
    dropIndicatorStyle.borderBottomRightRadius = 0;
  }
  if (isBundleChild) {
    dropIndicatorStyle.borderTopLeftRadius = 0;
    dropIndicatorStyle.borderTopRightRadius = 0;
  }

  const renderIcon = () => {
    // Groups never reach this — they render only the chevron in the icon
    // slot. Pages-with-children also short-circuit to the chevron. So the
    // only callers here are leaf pages and (legacy) `layout`-type entries.
    if (entry.type === 'variant') {
      // A/B variant rows show a colored letter badge (A/B/C/D…) instead
      // of a page/folder icon. Letter color is fixed by id so the same
      // variant always shows in the same color across renders.
      const palette = ['#3b82f6', '#a855f7', '#10b981', '#f97316', '#ef4444', '#06b6d4', '#eab308', '#ec4899', '#84cc16', '#6366f1'];
      const idx = (entry.variantLetter ?? 'A').charCodeAt(0) - 'A'.charCodeAt(0);
      const bg = palette[Math.max(0, idx % palette.length)];
      return (
        <span
          className="inline-flex items-center justify-center rounded-full text-[8px] font-bold text-white"
          style={{ width: 14, height: 14, background: bg, lineHeight: 1 }}
          title={`Variant ${entry.variantLetter}`}
        >
          {entry.variantLetter}
        </span>
      );
    }
    if (entry.type === 'layout') return <LayoutIcon />;
    if (entry.isHome) return <PageHomeIcon size={12} style={{ color: 'currentColor' }} />;
    return <PageDocumentIcon size={12} style={{ color: 'currentColor' }} />;
  };

  const handleClick = (e: React.MouseEvent) => {
    // Shift-click on a deletable page → bulk-select toggle. Variants,
    // groups, and the Home page (which can't be deleted) all fall
    // through to the normal switch path even when shift is held — they
    // can't participate in a bulk delete so a multi-pick is meaningless.
    const isShiftMultiPick = e.shiftKey
      && entry.type === 'page'
      && !entry.isHome
      && onToggleMultiSelect;
    if (isShiftMultiPick) {
      e.preventDefault();
      e.stopPropagation();
      onToggleMultiSelect!(entry.filePath);
      return;
    }
    if (entry.type === 'group') {
      onToggleCollapse(entry.id);
    } else {
      // Page click always navigates to the file. Page-with-children
      // (a route that has sub-routes) toggles its own collapse via the
      // dedicated chevron click handler (see the chevron `onMouseDown`
      // below) — that lets the user fold/unfold without losing the
      // ability to jump to the parent page itself.
      onSwitch(entry.filePath);
    }
  };

  // True when this row's file is part of an active shift-select. Drives
  // an accent outline on the row so the user sees the bulk pick — the
  // active-row's existing highlight stays underneath when activeFile is
  // also in the set.
  const isMultiPicked = entry.type === 'page'
    && !!multiSelectedPages?.has(entry.filePath);
  if (isMultiPicked) {
    dropIndicatorStyle.outline = `1.5px solid ${PAGES_DRAG_INDICATOR}`;
    dropIndicatorStyle.outlineOffset = -1;
    dropIndicatorStyle.borderRadius = 6;
  }

  /** Stops propagation so the chevron toggle doesn't also navigate. */
  const handleChevronClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleCollapse(entry.id);
  };
  const hasNestedChildren = (entry.type === 'page' || entry.type === 'group') && entry.children.length > 0;
  // Pages that have ANY A/B variant children keep the page icon AND
  // get an expand chevron to the left (via SidebarRow's prefix slot).
  // The "any" (not "every") relaxation matters when a page has BOTH
  // a sub-route page AND variants — the reference surfaces the icon in that
  // mixed case too, since the row is still a real page. Sub-route-only
  // parents (no variants) stay chevron-only to match the existing
  // pattern.
  const hasAnyVariantChildren = entry.type === 'page'
    && hasNestedChildren
    && entry.children.some(c => c.type === 'variant');
  const chevronPrefix = (
    // 14px wide + justify-center so the chevron sits inside the same
    // visual slot as a row icon. Matches the Layers panel's chevron
    // spacing (chevron-to-icon gap reads the same as icon-to-label
    // gap). Vertical alignment with variant badges below is handled
    // separately via `customPaddingLeft` on the variant entries.
    <span
      className="shrink-0 opacity-60 cursor-pointer hover:opacity-100 flex items-center justify-center"
      style={{ width: 14, height: 14 }}
      onClick={handleChevronClick}
    >
      <ChevronIcon open={!isCollapsed} />
    </span>
  );

  // Data attributes consumed by resolveFolderTreeDrop() to identify
  // the row under the cursor + classify its drop semantics. `folder`
  // is the FolderTree-side name for "this row accepts an inside drop"
  // — for Pages that's true for any non-variant entry (variants can't
  // hold children of their own).
  const rowDataAttrs: Record<string, string | number> = {
    [`data-${PAGES_DRAG_NS}-row`]: entry.id,
    [`data-${PAGES_DRAG_NS}-depth`]: entry.depth,
    [`data-${PAGES_DRAG_NS}-folder`]: entry.type === 'variant' ? 'false' : 'true',
  };

  return (
    <>
      {/* Row wrapper: position:relative so the before/after indicators
          can absolute-position INSIDE the row (no layout shift on
          adjacent rows). Pointer onMouseDown arms the drag (FolderTree
          pattern). */}
      <div
        {...rowDataAttrs}
        style={{ position: 'relative' }}
        onMouseDown={isDraggable ? (e) => onStartDrag(e, entry) : undefined}
      >
      <SidebarRow
        onClick={handleClick}
        prefixSlot={
          // Chevron sits in its own slot — same row gap as the icon, so
          // chevron + icon + label all line up cleanly. Renders for any
          // expandable row: groups (templates / organisational folders),
          // and pages that have ANY nested children (sub-routes or A/B
          // variants). LEAF pages get an EMPTY placeholder of the same
          // width so their page icon lines up vertically with the icon
          // column of chevron-bearing siblings — without it, a nested
          // leaf row (e.g. `/wdwdwdwd` under `/ergererg`) drew its
          // icon directly under the parent's icon column, not "one slot
          // further right" like the user expected. The placeholder is
          // 14 px to match `chevronPrefix`'s width above.
          entry.type === 'group'
            ? <span className="shrink-0 opacity-60" style={{ width: 10 }}>
                <ChevronIcon open={!isCollapsed} />
              </span>
            : (entry.type === 'page' && hasNestedChildren)
              ? chevronPrefix
              : <span className="shrink-0" style={{ width: 14 }} aria-hidden="true" />
        }
        icon={renderIcon()}
        label={entry.label}
        isActive={isActive && entry.type !== 'group'}
        iconColor="inherit"
        // When this row is the one being renamed, swap the static label
        // for the SidebarRow inline input — same UX as the Layers panel.
        inlineEdit={renamingEntryId === entry.id && onCommitRename
          ? { initialValue: entry.label, onCommit: (v) => onCommitRename(entry, v) }
          : undefined}
        menuItems={isViewer ? undefined : (
          // Bulk-select mode: every other menu item (Duplicate, Edit,
          // Rename, Settings, A/B) is per-row and would be ambiguous
          // when N rows are selected. Collapse to a single Delete
          // entry that runs the bulk flow — same modal as the
          // Delete/Backspace shortcut, just reached via the menu.
          // Variants and the Home page can't participate in bulk
          // delete, so for them the menu stays untouched.
          multiSelectedPages && multiSelectedPages.size > 0
            && entry.type === 'page'
            && onBulkDelete
        ) ? [
          { id: 'delete', label: `Delete ${multiSelectedPages.size} page${multiSelectedPages.size === 1 ? '' : 's'}`, onClick: onBulkDelete } as DropdownMenuEntry,
        ] : (entry.type === 'page' || entry.type === 'layout') ? [
          ...(entry.type === 'page' ? [{ id: 'duplicate', label: 'Duplicate', onClick: () => onDuplicate(entry.filePath) } as DropdownMenuEntry] : []),
          { id: 'edit', label: 'Edit', onClick: () => onSwitch(entry.filePath) },
          ...(entry.type === 'page' && onStartRename && !entry.isHome ? [
            { id: 'rename', label: 'Rename', onClick: () => onStartRename(entry) } as DropdownMenuEntry,
          ] : []),
          ...(entry.type === 'page' && onOpenPageSettings ? [
            { type: 'separator' } as DropdownMenuEntry,
            // "Settings" → opens the SettingsOverlay on the Pages SEO
            // tab pre-selected to THIS page. URL-encoded so a refresh
            // lands the user back on the same row.
            { id: 'settings', label: 'Settings', onClick: () => onOpenPageSettings(entry.filePath) } as DropdownMenuEntry,
          ] : []),
          ...(entry.type === 'page' && onCreateAbTest ? [
            { type: 'separator' } as DropdownMenuEntry,
            // Label flips when the page already has a test — clicking
            // "Add variant" extends the existing test rather than
            // creating a duplicate test on the same page (which would
            // double up Baseline/Variant B rows in the tree).
            {
              id: 'ab-test',
              label: entry.children.some(c => c.type === 'variant')
                ? 'Add variant'
                : 'New A/B test',
              onClick: () => onCreateAbTest(entry.filePath),
            } as DropdownMenuEntry,
          ] : []),
          ...(canDelete ? [{ id: 'delete', label: 'Delete', onClick: () => onDelete(entry.filePath) } as DropdownMenuEntry] : []),
        ] : entry.type === 'variant' && (onStartRename || onDeleteVariant || onMakeAsControl) ? [
          // Variant row menu — Control (variantId === 'a') is the
          // baseline page itself, no Rename / Make-as-Control for it.
          // Other variants get Rename (inline input) + Make as Control
          // (the reference's promote-winner equivalent) + Delete (with auto-
          // cascade-delete-test when dropping below 2 variants).
          ...(onStartRename && entry.variantId !== 'a' ? [
            { id: 'rename', label: 'Rename', onClick: () => onStartRename(entry) } as DropdownMenuEntry,
          ] : []),
          ...(onMakeAsControl && entry.variantId !== 'a' ? [
            { id: 'make-control', label: 'Make as Control', onClick: () => onMakeAsControl(entry) } as DropdownMenuEntry,
          ] : []),
          ...(onDeleteVariant ? [
            ...((onStartRename || onMakeAsControl) && entry.variantId !== 'a' ? [{ type: 'separator' } as DropdownMenuEntry] : []),
            { id: 'delete', label: 'Delete', onClick: () => onDeleteVariant(entry) } as DropdownMenuEntry,
          ] : []),
        ] : undefined}
        right={entry.type === 'group' && onAddPageToGroup ? (
          <button
            onClick={(e) => { e.stopPropagation(); onAddPageToGroup!(entry.group!); }}
            title="Add page to group"
            className="shrink-0 opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0.5 rounded transition-opacity border-none bg-transparent cursor-pointer"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        ) : undefined}
        style={{
          paddingLeft,
          opacity: isDragged ? 0.4 : 1,
          cursor: 'pointer',
          ...dropIndicatorStyle,
        }}
      />

      {/* Drop indicators — absolute-positioned INSIDE the row wrapper
          so adjacent rows don't shift when they appear. 2px line plus
          a small open circle at its left edge, half-on / half-off the
          row edge — matches FolderTree's exact visual treatment. */}
      {isDropTarget && dropPos === 'before' && !isDragged && (
        <>
          <div style={{
            position: 'absolute', top: 0, right: 8, left: 8,
            height: 2, background: PAGES_DRAG_INDICATOR, zIndex: 50,
          }} />
          <div style={{
            position: 'absolute', top: -3, left: 8,
            width: 8, height: 8, borderRadius: '50%',
            background: 'var(--bg-base, #000)',
            border: `2px solid ${PAGES_DRAG_INDICATOR}`,
            transform: 'translateX(-50%)', zIndex: 50,
          }} />
        </>
      )}
      {isDropTarget && dropPos === 'after' && !isDragged && (
        <>
          <div style={{
            position: 'absolute', bottom: 0, right: 8, left: 8,
            height: 2, background: PAGES_DRAG_INDICATOR, zIndex: 50,
          }} />
          <div style={{
            position: 'absolute', bottom: -3, left: 8,
            width: 8, height: 8, borderRadius: '50%',
            background: 'var(--bg-base, #000)',
            border: `2px solid ${PAGES_DRAG_INDICATOR}`,
            transform: 'translateX(-50%)', zIndex: 50,
          }} />
        </>
      )}
      </div>

      {/* Children — rendered for groups (existing behaviour), for pages
          that have nested-by-path descendants (e.g. /about → /about/team),
          AND for pages that have A/B test variant children (injected by
          buildPageTree). Same `isCollapsed` toggle for fold/unfold.

          When the page has BOTH variants and sub-routes we drop a thin
          hairline divider at the variant/non-variant boundary so the
          two groups read as distinct — matches the reference's pattern. */}
      {(entry.type === 'group' || (entry.type === 'page' && entry.children.length > 0))
        && !isCollapsed
        && entry.children.map((child, i, arr) => {
          const isFirstNonVariant = child.type !== 'variant'
            && i > 0
            && arr[i - 1]!.type === 'variant';
          return (
            <React.Fragment key={child.id}>
              {isFirstNonVariant && (
                <div
                  data-variant-divider
                  className="h-px bg-[var(--border-light)] my-1"
                  style={{
                    marginLeft: (child.customPaddingLeft ?? child.depth * 20 + 12),
                    marginRight: 8,
                  }}
                />
              )}
              <TreeRow
                entry={child}
                activeFile={activeFile}
                dragIndicator={dragIndicator}
                draggedId={draggedId}
                collapsed={collapsed}
                onSwitch={onSwitch}
                onToggleCollapse={onToggleCollapse}
                onDelete={onDelete}
                onDuplicate={onDuplicate}
                onStartDrag={onStartDrag}
                onCreateAbTest={onCreateAbTest}
                onDeleteVariant={onDeleteVariant}
                onMakeAsControl={onMakeAsControl}
                onOpenPageSettings={onOpenPageSettings}
                renamingEntryId={renamingEntryId}
                onStartRename={onStartRename}
                onCommitRename={onCommitRename}
              />
            </React.Fragment>
          );
        })}
    </>
  );
});

