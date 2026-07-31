// LinkedComponentsList — the "Linked Components" section of the Library
// panel: components imported by CDN URL (assets.revyme.app/...). Listed
// grouped by their creator. LinkedCreatorFolder is the creator group
// container, LinkedComponentRow is a single linked-component row.

import React, { useState, useMemo, useEffect } from 'react';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import { useAtomValue, useSetAtom } from 'jotai';
import SidebarRow from '@/design-system/SidebarRow';
import { LibraryUsageBadge } from './LibraryUsageBadge';
import type { DropdownMenuEntry } from '@/design-system/DropdownMenu';
import { useCdnMetadataCache, useEnsureCdnMetadata, type CdnMetadataCacheEntry } from '@/cloud/components/cdn-metadata-hook';
import { scanLinkedComponentUrls } from '@/cloud/components/linked-components-scanner';
import { linkedComponentModalUrlAtom } from '@/cloud/components/linked-component-modal-store';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { selectedIdsAtom } from '@/code/stores/store';
import { useNodesComputed } from '@/code/stores/node-family';
import { useComponentDrag } from '../shared/useComponentDrag';
import { useIsViewer } from '@/code/stores/viewer-mode-store';
import { CreatorFolderIcon } from '../shared/icons';
import { DesignComponentIcon } from './ComponentRow';
import { IconSetIcon } from './IconSetRow';

// ─── Linked Components (CDN-imported, grouped by creator) ──────────────────
// Walks projectFS for `assets.revyme.app/components/...` URL imports,
// fetches metadata for each (component name + creator name/avatar via
// the public `/api/components/metadata?hash=` endpoint), and groups by
// creator id into collapsible sub-folders. Mirrors the reference's
// "Components → Project / <Creator A> / <Creator B>" layout.
//
// Click a row → opens the LinkedComponentModal (Unlink Instance / Unlink
// and Replace All). Same modal as a canvas double-click.
//
// Hides itself entirely when the project has no CDN imports.

export function LinkedComponentsList({ kind = 'component' }: { kind?: 'component' | 'vector' }) {
  // Cloud-only: linked components are CDN-hosted Revyme infrastructure.
  if (!CLOUD_ENABLED) return null;

  const projectVersion = useAtomValue(projectVersionAtom);
  const ensureMetadata = useEnsureCdnMetadata();
  const metadataCache = useCdnMetadataCache();
  const setLinkedModalUrl = useSetAtom(linkedComponentModalUrlAtom);
  // Same selection-driven highlight as the local rows above — collect
  // the `componentFile` of every selected node (which for CDN-linked
  // instances is the `https://…` URL) so each row can match its own
  // url against the set and render active. Re-derives reactively.
  const selectedIds = useAtomValue(selectedIdsAtom);
  const selectedComponentFiles = useNodesComputed((allNodes) => {
    const set = new Set<string>();
    for (const id of selectedIds) {
      const node = allNodes.get(id);
      if (node?.componentFile) set.add(node.componentFile);
    }
    return set;
  }, [selectedIds]);

  // Filter the project's CDN URLs by prefix so each section gets its
  // matching set. Without this, vector URLs would show under
  // Components — confusing and wrong
  // since the right-panel tooling (IconSetTool /
  // ComponentPropsTool) routes off the SAME prefix.
  const prefix = kind === 'vector' ? '/vectors/'
    : '/components/';
  const linkedUrls = useMemo(() => {
    return Array.from(scanLinkedComponentUrls(projectFS)).filter(u => u.includes(prefix));
  }, [projectVersion, prefix]);

  // Kick off metadata loads for any URLs we don't have cached yet. The
  // hook is no-op for already-cached URLs so this is safe to call on
  // every render.
  useEffect(() => {
    for (const url of linkedUrls) ensureMetadata(url);
  }, [linkedUrls, ensureMetadata]);

  // Group by creator. URLs whose metadata hasn't loaded yet bucket under
  // a "Loading…" creator until they resolve. URLs whose metadata 404'd
  // (orphan / lost source) bucket under "Unknown".
  type Group = { id: string; label: string; urls: string[] };
  const groups: Group[] = useMemo(() => {
    const byCreator = new Map<string, Group>();
    for (const url of linkedUrls) {
      const meta = metadataCache.get(url);
      let id: string;
      let label: string;
      if (!meta) {
        id = '__loading__';
        label = 'Loading…';
      } else if (meta === 'missing' || meta === 'error') {
        // 404 orphans AND resolved fetch failures both land under "Unknown"
        // (the 'error' entry retries on the next ensure after its backoff).
        id = '__unknown__';
        label = 'Unknown';
      } else if (meta.creator) {
        id = meta.creator.id;
        label = meta.creator.name ?? 'Anonymous';
      } else {
        id = '__anon__';
        label = 'Anonymous';
      }
      let group = byCreator.get(id);
      if (!group) {
        group = { id, label, urls: [] };
        byCreator.set(id, group);
      }
      group.urls.push(url);
    }
    return Array.from(byCreator.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [linkedUrls, metadataCache]);

  if (linkedUrls.length === 0) return null;

  // No outer padding wrapper — the parent ComponentsSection already
  // owns a `<div className="px-2 pb-2">` shared by local + linked rows
  // so they sit flush against each other (no inter-section gap).
  return (
    <>
      {groups.map(group => (
        <LinkedCreatorFolder
          key={group.id}
          kind={kind}
          label={group.label}
          urls={group.urls}
          metadataCache={metadataCache}
          selectedComponentFiles={selectedComponentFiles}
          onSelectUrl={(url) => setLinkedModalUrl({ url, nodeId: null })}
        />
      ))}
    </>
  );
}

export function LinkedCreatorFolder({
  label, urls, metadataCache, selectedComponentFiles, onSelectUrl, kind = 'component',
}: {
  label: string;
  urls: string[];
  metadataCache: Map<string, CdnMetadataCacheEntry>;
  /** URLs whose instances are currently selected on the canvas — each
   *  row checks `.has(url)` to decide active styling. */
  selectedComponentFiles: Set<string>;
  onSelectUrl: (url: string) => void;
  /** Which Library section hosts this folder — drives the accent + row
   *  glyph. Components keep SidebarRow's purple default (accent-secondary
   *  is the component colour); Vectors use blue `var(--accent)` + the
   *  triangle IconSetIcon, matching the section's local rows. */
  kind?: 'component' | 'vector';
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <SidebarRow
        icon={<CreatorFolderIcon />}
        label={label}
        iconColor={kind === 'vector' ? 'var(--accent)' : undefined}
        expandable={{ expanded: open }}
        onClick={() => setOpen(o => !o)}
      />
      {open && urls.map(url => {
        const meta = metadataCache.get(url);
        // Slug regex matches BOTH `/components/<Name>@<hash>` and
        // `/vectors/<Name>@<hash>` shapes. The previous version only
        // matched `/components/`, so dragging a linked vector landed
        // a `<Component>` tag (the fallback) on the canvas instead of
        // the actual `<ViLiTi>` (or whatever the vector slug is) —
        // import line points at the right URL but the JSX tag name
        // didn't, so the parser couldn't bind the import to the
        // element and rendered a blank wrapper.
        const slugRegex = /\/(?:components|vectors)\/([^@/]+)@/;
        const name = meta && meta !== 'missing' && meta !== 'error' ? meta.name : (url.match(slugRegex)?.[1] ?? 'Component');
        // Use the URL's slug as the JSX tag name on drop. Sanitize so
        // characters like `-` from the URL slug don't end up in the
        // tag (would break JSX). Falls back to "Component" if the slug
        // is somehow empty.
        const slugMatch = url.match(slugRegex);
        const tagName = (slugMatch?.[1] ?? 'Component').replace(/[^a-zA-Z0-9_]/g, '') || 'Component';
        return (
          <LinkedComponentRow
            key={url}
            kind={kind}
            url={url}
            tagName={tagName}
            label={name}
            isActive={selectedComponentFiles.has(url)}
            onSelectUrl={onSelectUrl}
          />
        );
      })}
    </>
  );
}

// One linked-component row inside a creator folder. Wraps SidebarRow in a
// wrapper that carries pixel-exact left padding (so the row icon lands
// under the creator name) AND the drag handler. `useComponentDrag` is
// the same hook local components use — passing the URL as `filePath`
// activates the CDN-link branch which threads `cdnUrl` through to
// ToolbarDragStrategy. On drop the strategy ensures the URL `import`
// line exists on the active page before inserting the JSX tag.
export function LinkedComponentRow({
  url, tagName, label, isActive, onSelectUrl, kind = 'component',
}: {
  url: string;
  tagName: string;
  label: string;
  /** True when an instance of this CDN component is currently selected
   *  on the canvas — same purple-active state as local rows. */
  isActive: boolean;
  onSelectUrl: (url: string) => void;
  /** Section flavour — vectors get the triangle IconSetIcon in blue
   *  `var(--accent)` (matching local IconSetRow); components keep the
   *  diamond glyph in SidebarRow's purple default. */
  kind?: 'component' | 'vector';
}) {
  const handleDrag = useComponentDrag(url, tagName);
  // CDN-linked components have no local master to navigate into, so for
  // viewers the row is inert — same as code components in the Library.
  const isViewer = useIsViewer();
  const menuItems: DropdownMenuEntry[] = [
    { id: 'edit', label: 'Edit', onClick: () => onSelectUrl(url) },
    { id: 'unlink', label: 'Unlink', onClick: () => onSelectUrl(url) },
  ];
  return (
    // 40 = folder-body indent (20) + leaf chevron-column offset (20) —
    // matching FolderTree's `depth*20 + 20` for a LEAF under a depth-0
    // folder, so linked rows align with Project-tree leaves instead of
    // sitting at their creator folder's level (same fix as the Plugins
    // section's cloud rows).
    <div style={{ paddingLeft: 40 }} onPointerDown={isViewer ? undefined : handleDrag}>
      <SidebarRow
        icon={kind === 'vector' ? <IconSetIcon /> : <DesignComponentIcon />}
        label={label}
        iconColor={kind === 'vector' ? 'var(--accent)' : undefined}
        isActive={isActive}
        menuItems={isViewer ? undefined : menuItems}
        onClick={isViewer ? undefined : () => onSelectUrl(url)}
        // Usage badge, same as local rows — the usage index keys CDN-linked
        // instances by their import URL, which is exactly this row's `url`.
        right={<LibraryUsageBadge filePath={url} />}
      />
    </div>
  );
}
