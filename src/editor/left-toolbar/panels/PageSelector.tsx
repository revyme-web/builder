// PageSelector.tsx — Combobox that lists every page in the project and
// switches the active file when the user picks one.
//
// Lives at the top of the Layers panel so the user can flip between
// pages without leaving the layer tree. Type-to-filter narrows the list
// down by display name or file path; the currently-active file is
// preselected and shown in the trigger button. Closes on Escape, click
// outside, or selection. (Dropdown skeleton = the shared
// SearchableDropdown; this file owns only the page list + switch logic.)

import { useMemo, useCallback } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import {
  activeFilePathAtom,
  switchActiveFile,
  getFileDisplayName,
  componentBreadcrumbAtom,
} from '@/code/project/active-file-store';
import { selectedIdsAtom, updatingFromCanvasAtom } from '@/code/stores/store';
import { syncQueueCode, flushNow } from '@/code/mutation/mutation-queue';
import { useAtomValue } from 'jotai';
import { PageDocumentIcon } from '@/shared/icons';
import { trace } from '@/shared/debug-trace';
import SearchableDropdown from '../../ui/SearchableDropdown';

/** Full route-path label for a page — IDENTICAL to what the Pages panel
 *  (FileExplorer) shows, so the dropdown and the tree never disagree.
 *  Delegates to `getFileDisplayName`, which strips the URL-invisible route
 *  group `(Body)/` in the CORRECT order (before the `page.*` suffix, so a
 *  grouped home resolves to `/`), then maps the index `/` → "Home" the same
 *  way FileExplorer does (FileExplorer.tsx:173).
 *    `app/(Body)/page.client.tsx`             → "Home"
 *    `app/(Body)/advisors/page.client.tsx`    → "/advisors"
 *    `app/(Body)/blog/[slug]/page.client.tsx` → "/blog/[slug]"
 *
 *  (Previously this returned only the final segment — "advisors", "[slug]" —
 *  and stripped route groups AFTER the suffix, so a grouped home's bare
 *  `(Body)` had no trailing `/` to match and leaked through as the label.) */
function getPageRouteLabel(filePath: string): string {
  const name = getFileDisplayName(filePath);
  return name === '/' ? 'Home' : name;
}

export default function PageSelector() {
  const [activeFile, setActiveFile] = useAtom(activeFilePathAtom);
  const setSelectedIds = useSetAtom(selectedIdsAtom);
  const setUpdatingFromCanvas = useSetAtom(updatingFromCanvasAtom);
  const setBreadcrumb = useSetAtom(componentBreadcrumbAtom);
  const version = useAtomValue(projectVersionAtom);

  // Enumerate every page file in the project. Same `app/**/page.tsx`
  // probe FileExplorer's flat list uses; the version dep keeps the list
  // fresh when the user creates / renames / deletes a page elsewhere in
  // the editor.
  //
  // `label` is the full route path (`/blog/[slug]`, "Home" for the index)
  // — IDENTICAL to the Pages-panel tree — so the two never disagree. Long
  // nested paths ellipsis via the `truncate` class; the full `filePath`
  // stays available for search-by-folder.
  const pages = useMemo(() => {
    void version;
    return projectFS
      .listFiles('app/')
      // Only the canvas-editable client half — the server wrapper is
      // implicit and not user-facing.
      .filter((f) => f.endsWith('page.client.tsx'))
      .map((filePath) => ({
        filePath,
        label: getPageRouteLabel(filePath),
      }))
      .sort((a, b) => {
        // Home first, then alpha by label so the dropdown reads
        // top-down the same way the FileExplorer's tree does.
        if (a.label === 'Home') return -1;
        if (b.label === 'Home') return 1;
        return a.label.localeCompare(b.label);
      });
  }, [version]);

  const activeLabel = useMemo(() => {
    const match = pages.find((p) => p.filePath === activeFile);
    return match ? match.label : getPageRouteLabel(activeFile);
  }, [activeFile, pages]);

  const handleSwitch = useCallback(
    (target: string) => {
      if (target !== activeFile) {
        // Top-level page jump — NOT a drill-in, so reset the drill-in breadcrumb.
        // A stale breadcrumb (e.g. left over from "Edit Template" on the home
        // page) would otherwise make a directly-opened template resolve its
        // scroll Section anchors from that page (showing #hero, which only
        // exists on home, not on the template).
        setBreadcrumb([]);
        switchActiveFile(
          activeFile,
          target,
          { setActiveFile, setSelectedIds, setUpdatingFromCanvas },
          { syncQueueCode, flushNow },
        );
        trace.action('page-selector:switch', { from: activeFile, to: target });
      }
    },
    [activeFile, setActiveFile, setSelectedIds, setUpdatingFromCanvas],
  );

  return (
    <SearchableDropdown
      items={pages}
      getKey={(p) => p.filePath}
      getLabel={(p) => p.label}
      matches={(p, q) => p.label.toLowerCase().includes(q) || p.filePath.toLowerCase().includes(q)}
      activeKey={activeFile}
      triggerLabel={activeLabel}
      triggerIcon={<PageDocumentIcon size={14} />}
      itemIcon={<PageDocumentIcon size={12} />}
      placeholder="Search pages…"
      emptyText="No pages match."
      // Same brighter tier as `SearchBar` so the dropdown trigger and
      // the search input directly underneath read as a matched pair
      // (10/14 % white instead of the prior 5/8 %, which got lost on
      // the dark panel background). Input matches the SearchBar tier
      // (see SearchBar.tsx) — theme-mirrored black/white tint so the
      // input isn't invisible on a light panel.
      triggerClassName="w-full flex items-center gap-2 px-2 py-1.5 text-xs bg-black/[0.06] hover:bg-black/[0.09] dark:bg-white/[0.1] dark:hover:bg-white/[0.14] cut-corners text-[var(--text-primary)] outline-none transition-colors"
      inputClassName="w-full px-2 py-1.5 text-xs bg-black/[0.06] hover:bg-black/[0.09] focus:bg-black/[0.12] dark:bg-white/[0.1] dark:hover:bg-white/[0.14] dark:focus:bg-white/[0.18] cut-corners text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] outline-none transition-colors"
      listClassName="max-h-60 overflow-y-auto scrollbar-hide py-1"
      onSelect={(p) => handleSwitch(p.filePath)}
    />
  );
}
