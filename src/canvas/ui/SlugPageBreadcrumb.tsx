// SlugPageBreadcrumb.tsx — top-of-canvas breadcrumb for CMS `[slug]` detail pages.
//
// Mirrors ComponentBreadcrumb (same fixed 52px top bar) but for a different
// context: a dynamic `[slug]` page bound to a CMS collection. Shows
//   [Collection] ›  [Current item ▾]
// where the item segment opens a SEARCHABLE dropdown of every record in the
// collection (standard) so the user can preview the template against any
// item. Picking an item writes `previewSlugByFileAtom` — the SAME mechanism the
// old in-Properties-panel "ITEM 1 / 4" navigator used (now removed; this bar
// replaces it). Visible only on detail pages (`@cmsPage kind: 'detail'`).

import { useState, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  cmsPageMetaAtom,
  activePreviewSlugAtom,
  previewSlugByFileAtom,
  slugPageReferrerByFileAtom,
} from '@/code/stores/cms-page-store';
import { collectionDataAtom } from '@/code/stores/cms-store';
import { selectedIdsAtom } from '@/code/stores/store';
import { activeFilePathAtom, getSlugPageParentFile, getFileDisplayName, syncUrlToPage } from '@/code/project/active-file-store';
import { cmsItemDisplayLabel as itemLabel, prettyCollectionName as prettyCollection } from '@/code/project/cms-page-ops';
import { openCmsEditorAtom } from '@/code/stores/cms-editor-store';
import { leftPanelAtom } from '@/code/stores/left-panel-store';
import { flushNow, syncQueueCode } from '@/code/mutation/mutation-queue';
import { projectFS } from '@/code/project/project-fs';
import { PageDocumentIcon, CmsIcon, CmsItemIcon } from '@/shared/icons';
import { stopHoverProbe } from './useSuppressCanvasHover';
import { trace } from '@/shared/debug-trace';

function Chevron() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-[var(--text-tertiary)]">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function CaretDown() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 ml-0.5 opacity-70">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export default function SlugPageBreadcrumb() {
  const meta = useAtomValue(cmsPageMetaAtom);
  const activeSlug = useAtomValue(activePreviewSlugAtom);
  const collectionData = useAtomValue(collectionDataAtom);
  const [filePath, setActiveFile] = useAtom(activeFilePathAtom);
  const setPreviewSlugMap = useSetAtom(previewSlugByFileAtom);
  const setSelectedIds = useSetAtom(selectedIdsAtom);
  const referrerMap = useAtomValue(slugPageReferrerByFileAtom);
  const openCmsEditor = useSetAtom(openCmsEditorAtom);
  const setLeftPanel = useSetAtom(leftPanelAtom);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const itemBtnRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number; width: number } | null>(null);

  // Position the dropdown under the item pill whenever it opens.
  useLayoutEffect(() => {
    if (!open) { setMenuPos(null); return; }
    const r = itemBtnRef.current?.getBoundingClientRect();
    if (r) setMenuPos({ left: r.left, top: r.bottom + 6, width: Math.max(r.width, 240) });
  }, [open]);

  // PATH gate FIRST: `cmsPageMetaAtom` derives from stableCodeAtom, which
  // updates a beat AFTER a page switch — gating on meta alone kept the
  // breadcrumb visible for ~0.2s on the new (non-slug) page before the new
  // code landed. The file PATH flips synchronously with the switch, and a
  // detail page always lives under a dynamic segment (`[slug]`), so the
  // path check hides the bar the same frame the user changes page.
  const isSlugPath = /\[[^/\]]+\]/.test(filePath ?? '');
  const isDetail = isSlugPath && meta?.kind === 'detail';
  const items = isDetail ? (collectionData.get(meta.collection) ?? []) : [];

  // Gate AFTER all hooks (hooks must run unconditionally).
  if (!isDetail || items.length === 0) return null;

  const currentIdx = Math.max(0, items.findIndex((i) => i._slug === activeSlug));
  const current = items[currentIdx];
  const currentLabel = itemLabel(current, activeSlug);

  const q = query.trim().toLowerCase();
  const filtered = q ? items.filter((it) => itemLabel(it).toLowerCase().includes(q)) : items;

  const pick = (slug: string) => {
    setPreviewSlugMap((prev) => {
      const next = new Map(prev);
      next.set(filePath, slug);
      return next;
    });
    setOpen(false);
    setQuery('');
    trace.action('slug-breadcrumb:pick-item', { slug, collection: meta.collection });
  };

  // Collection segment → open the CMS editor overlay on this collection, with
  // its first item expanded (mirrors the dbl-click-CMS-bound flow in
  // CanvasMouseController). `leftPanel: 'cms'` keeps the overlay mounted (App
  // auto-closes it when the left panel isn't 'cms').
  const openCmsCollection = () => {
    openCmsEditor({ collection: meta.collection, itemId: items[0]?._id ?? null });
    trace.action('slug-breadcrumb:open-cms', { collection: meta.collection });
  };

  // Origin segment — the page the user came FROM (recorded referrer), falling
  // back to the slug page's PARENT route (e.g. /blog for /blog/[slug]). Leads
  // the breadcrumb so there's a way back; the collection segment now opens the
  // CMS overlay instead of navigating.
  const originFile = referrerMap.get(filePath) ?? getSlugPageParentFile(filePath);
  const originValid = !!originFile && originFile !== filePath && projectFS.exists(originFile);
  const originRaw = originValid ? getFileDisplayName(originFile!) : '';
  const originLabel = originRaw === '/' ? 'Home' : originRaw;
  const goToOrigin = () => {
    if (!originValid || !originFile) return;
    const fresh = projectFS.readFile(filePath);
    if (fresh) syncQueueCode(fresh);
    flushNow();
    setActiveFile(originFile);
    setSelectedIds([]);
    syncUrlToPage(originFile);
    // Navigating back to a PAGE → return the left panel to the Pages tab (the
    // collection segment likely left it on the CMS panel).
    setLeftPanel('pages-layers');
    trace.action('slug-breadcrumb:back-to-origin', { from: filePath, to: originFile });
  };

  const pillBase =
    'flex items-center gap-1.5 px-2.5 py-1 bg-[var(--button-secondary-bg,rgba(255,255,255,0.06))] rounded-md text-sm font-medium transition-all whitespace-nowrap';

  return createPortal(
    <>
      {/* Fixed top bar — same chrome strip as ComponentBreadcrumb (between the
          left/right sidebars). z below the side headers (9999), above canvas
          overlays. */}
      <div
        className="float-bar-top fixed h-[52px] px-4 flex items-center left-[308px] right-[260px] shadow-[var(--shadow-sm)] border-b border-[var(--border-default)] bg-[var(--bg-canvas)] z-[9000] top-0"
        data-dynamic-toolbar="true"
      >
        <div className="flex items-center gap-2 min-w-0">
          {/* Origin segment — back to the page the user came from (or parent route). */}
          {originValid && (
            <>
              <button
                onClick={goToOrigin}
                className={`${pillBase} max-w-[200px] hover:brightness-125 cursor-pointer`}
                style={{ color: 'var(--text-secondary)' }}
                title={`Back to ${originLabel}`}
              >
                <span className="flex-shrink-0 flex items-center"><PageDocumentIcon size={14} className="text-[var(--text-secondary)]" /></span>
                <span className="truncate">{originLabel}</span>
              </button>
              <Chevron />
            </>
          )}

          {/* Collection segment → opens the CMS editor overlay (collection + first item). */}
          <button
            onClick={openCmsCollection}
            className={`${pillBase} max-w-[200px] hover:brightness-125 cursor-pointer`}
            style={{ color: 'var(--text-secondary)' }}
            title="Edit in CMS"
          >
            <span className="flex-shrink-0 flex items-center"><CmsIcon width={14} height={14} /></span>
            <span className="truncate">{prettyCollection(meta.collection)}</span>
          </button>

          <Chevron />

          {/* Item segment — opens the searchable item dropdown. */}
          <button
            ref={itemBtnRef}
            onClick={() => setOpen((o) => !o)}
            className={`${pillBase} max-w-[300px] hover:brightness-125 cursor-pointer`}
            style={{ color: 'var(--accent-text)' }}
          >
            <span className="flex-shrink-0 flex items-center"><CmsItemIcon size={14} /></span>
            <span className="truncate">{currentLabel}</span>
            <span className="text-[10px] font-semibold text-[var(--text-tertiary)] tabular-nums ml-0.5 flex-shrink-0">
              {currentIdx + 1}/{items.length}
            </span>
            <CaretDown />
          </button>
        </div>
      </div>

      {/* Dropdown — searchable list of every collection item. */}
      {open && menuPos && (
        <>
          {/* Backdrop → context-menu behavior: a click outside ONLY closes the
              dropdown; it must NOT leak (through the React portal tree) to the
              Canvas onMouseDown and select/deselect a node. Swallow the press,
              close on the completed click. Same pattern as DropdownMenu /
              AddViewportMenu. */}
          <div
            className="fixed inset-0 z-[9998]"
            {...stopHoverProbe}
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onMouseUp={(e) => { e.stopPropagation(); }}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(false); setQuery(''); }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(false); setQuery(''); }}
          />
          <div
            {...stopHoverProbe}
            onMouseDown={(e) => e.stopPropagation()}
            onMouseUp={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            className="fixed z-[9999] rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--dropdown-bg)] shadow-[var(--shadow-lg)] py-1.5 flex flex-col"
            style={{ left: menuPos.left, top: menuPos.top, width: menuPos.width, maxHeight: 420 }}
          >
            {/* Search */}
            <div className="px-2 pb-1.5">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Type to search..."
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); setQuery(''); }
                  if (e.key === 'Enter' && filtered[0]) pick(filtered[0]._slug);
                }}
                className="w-full h-8 px-3 text-xs bg-[var(--grid-line)] text-[var(--text-primary)] border border-[var(--border-light)] rounded-[var(--radius-lg)] hover:border-[var(--control-border)] focus:border-[var(--border-focus)] focus:outline-none transition-colors"
              />
            </div>

            {/* Item list */}
            <div className="scrollbar-hide overflow-y-auto" style={{ maxHeight: 360 }}>
              {filtered.length === 0 ? (
                <div className="px-3 py-2 text-xs text-[var(--text-tertiary)]">No items</div>
              ) : (
                filtered.map((it) => {
                  const isCurrent = it._slug === current?._slug;
                  return (
                    <button
                      key={it._slug}
                      onClick={() => pick(it._slug)}
                      className="group flex items-center gap-2 mx-1.5 px-2.5 py-1.5 rounded-[var(--radius-sm)] w-[calc(100%-12px)] text-left cursor-pointer text-xs text-[var(--text-primary)] hover:bg-[var(--accent)] hover:text-[var(--accent-fg)] transition-colors"
                    >
                      <span className="w-3.5 flex-shrink-0 flex items-center justify-center">
                        {isCurrent && (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                        )}
                      </span>
                      <span className="truncate flex-1">{itemLabel(it)}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}
    </>,
    document.body,
  );
}
