// ComponentBreadcrumb.tsx — DynamicToolbar matching old builder design.
// Full-width bar at the top of the canvas when editing a component file.
// Shows: [Page button] > [Component1] > [Component2] breadcrumb navigation.
// Visible whenever activeFile is a component file — not just when entered via double-click.

import React, { useState } from 'react';
import { nextFrames } from '@/shared/dom-utils';
import { createPortal } from 'react-dom';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { activeFilePathAtom, componentBreadcrumbAtom, getFileDisplayName, isMasterFilePath, isComponentLikeFilePath, isTemplateFilePath, getRouteGroup, getHomePageFilePath, getSlugPageParentFile, syncUrlToPage } from '@/code/project/active-file-store';
import { selectedIdsAtom } from '@/code/stores/store';
import { overlayEditingIdAtom, overlayCallsAtom } from '@/code/stores/overlay-store';
import { suppressSelectionOverlayAtom } from '@/code/stores/editor-store';
import { collectionDataAtom } from '@/code/stores/cms-store';
import { previewSlugByFileAtom, slugPageReferrerByFileAtom } from '@/code/stores/cms-page-store';
import { parseCmsPageMeta, cmsItemDisplayLabel, prettyCollectionName } from '@/code/project/cms-page-ops';
import { openCmsEditorAtom } from '@/code/stores/cms-editor-store';
import { leftPanelAtom } from '@/code/stores/left-panel-store';
import { flushNow, syncQueueCode } from '@/code/mutation/mutation-queue';
import { projectFS } from '@/code/project/project-fs';
import { zoomToFit, zoomToFitCanvasBounds, cameraStash, transformManager } from '@/canvas/transform';
import { getContentRoot } from '@/canvas/node-ops';
import { computeFileEntryBounds } from '@/canvas/component-navigation';
import { PageDocumentIcon, ComponentClusterIcon, TemplateIcon, CmsIcon, CmsItemIcon } from '@/shared/icons';
import Breadcrumb, { type BreadcrumbSegment } from '@/design-system/Breadcrumb';
import VariableModal from '@/editor/ui/VariableModal';
import { trace } from '@/shared/debug-trace';

export default function ComponentBreadcrumb() {
  const breadcrumb = useAtomValue(componentBreadcrumbAtom);
  const [activeFile, setActiveFile] = useAtom(activeFilePathAtom);
  const setBreadcrumb = useSetAtom(componentBreadcrumbAtom);
  const setSelectedIds = useSetAtom(selectedIdsAtom);
  const setSuppressSelectionOverlay = useSetAtom(suppressSelectionOverlayAtom);
  // For the slug-page base: when the breadcrumb's root page is a CMS `[slug]`
  // detail page, the base shows [Collection] › [Item] (the previewed record)
  // instead of a single page segment — additive, so entering a component from
  // a slug page keeps the CMS context navigable. Same data the slug
  // breadcrumb uses.
  const collectionData = useAtomValue(collectionDataAtom);
  const previewSlugMap = useAtomValue(previewSlugByFileAtom);
  const referrerMap = useAtomValue(slugPageReferrerByFileAtom);
  const openCmsEditor = useSetAtom(openCmsEditorAtom);
  const setLeftPanel = useSetAtom(leftPanelAtom);
  const [variablesOpen, setVariablesOpen] = useState(false);
  // Overlay-edit mode: this top bar (the only top chrome on a component master,
  // which has no per-viewport headers) becomes the standard "Editing Overlay"
  // + Exit affordance, REPLACING the breadcrumb so it isn't hidden behind it.
  const [overlayEditingId, setOverlayEditingId] = useAtom(overlayEditingIdAtom);
  const overlayCalls = useAtomValue(overlayCallsAtom);
  const exitOverlayEdit = () => {
    const oid = overlayEditingId;
    setOverlayEditingId(null);
    const call = overlayCalls.find(c => c.overlayId === oid);
    if (call?.config.triggerId) setSelectedIds([call.config.triggerId]);
    trace.action('breadcrumb:overlay-edit-exit', { overlayId: oid });
  };

  // Show the breadcrumb for both regular components AND icon-set masters
  // — they share the same "user is editing a master, breadcrumb back to a
  // page" UX. Icon-set files get the in-canvas "+" placeholder card via
  // AddVectorUI; nothing extra needs to live in the breadcrumb.
  // Templates (LayoutClient.tsx) are component-like masters too — show the
  // breadcrumb so the user can exit back to the page that opened the template.
  if (!isMasterFilePath(activeFile) && !isTemplateFilePath(activeFile)) return null;

  const hasBreadcrumb = breadcrumb.length > 0;

  const switchWithZoom = (targetFile: string, switchFn: () => void) => {
    // Pre-zoom: snap the camera to the target file's bounds BEFORE
    // changing activeFile, so the iframe re-renders with the new
    // content already at the correct zoom. Same approach as
    // `enterComponentFile` — eliminates the "wrong-zoom flash" the
    // old opacity-on-wrapper hack couldn't fully hide (React
    // reconciles the wrapper's `style` on every render, wiping any
    // imperative opacity write). When bounds can't be computed
    // synchronously (file missing metadata, etc.), fall back to the
    // post-switch zoom-to-fit on the iframe-once-rendered.
    //
    // Either path also suppresses the SelectionBorder overlay until
    // after the iframe has pushed fresh rect-cache entries. Without
    // this the overlay's RAF poll reads stale rects from the
    // previous file for ~1 frame and visibly flashes huge before
    // snapping back. Two rAFs is enough — first frame for the
    // iframe to commit the patched DOM, second for the bridge's
    // batched rect push to land in the cache.
    setSuppressSelectionOverlay(true);
    const releaseOverlay = () => {
      nextFrames(2, () => {
        setSuppressSelectionOverlay(false);
      });
    };

    // Restore the user's previous camera if we stashed one when they
    // entered the master. This is what makes "back to page" feel
    // continuous: the user lands at the EXACT pan/zoom they were at
    // before the master edit, not at a generic page-fit. Falls
    // through to the synchronous `computeFileEntryBounds` pre-zoom
    // when no stash entry exists (fresh project, file deleted /
    // recreated, etc.).
    const stashed = cameraStash.get(targetFile);
    if (stashed) {
      transformManager.setTransform(stashed);
      switchFn();
      releaseOverlay();
      trace.action('breadcrumb:restore-stashed-camera', { targetFile, ...stashed });
      return;
    }

    const preBounds = computeFileEntryBounds(targetFile);
    if (preBounds) {
      zoomToFitCanvasBounds(preBounds, true);
      switchFn();
      releaseOverlay();
      trace.action('breadcrumb:pre-zoom', { targetFile, ...preBounds });
      return;
    }
    // Fallback path — opacity dip on the iframe element directly
    // (NOT the wrapper, which React reconciles every render). One
    // setTimeout to give the iframe a moment to commit the new
    // content before zoom-to-fit reads its rects.
    const iframe = document.querySelector('[data-canvas-iframe]') as HTMLElement | null;
    if (iframe) iframe.style.opacity = '0';
    switchFn();
    setTimeout(() => {
      const el = getContentRoot();
      if (el) zoomToFit(el, true);
      if (iframe) iframe.style.opacity = '1';
      releaseOverlay();
    }, 100);
  };

  const handleNavigateToPage = () => {
    // Fallback when the breadcrumb is empty: the canvas-editable Home — the
    // CLIENT body (`app/page.client.tsx`), not the server wrapper — resolved
    // via getHomePageFilePath so a route-grouped home (`app/(Body)/
    // page.client.tsx`) is found instead of a non-existent bare path that
    // would land on a blank editor.
    const targetFile = hasBreadcrumb ? breadcrumb[0] : getHomePageFilePath();
    trace.action('breadcrumb:exit-to-page', { from: activeFile, to: targetFile });
    const freshCode = projectFS.readFile(activeFile);
    if (freshCode) syncQueueCode(freshCode);
    flushNow();
    switchWithZoom(targetFile, () => {
      setActiveFile(targetFile);
      setBreadcrumb([]);
      setSelectedIds([]);
      // Keep the `?page=` query in sync. The `switchActiveFile` helper
      // does this for every other navigation flow (Library jump, dbl-
      // click instance, enterComponentFile); the breadcrumb path takes
      // the manual `setActiveFile` route to thread its pre-zoom
      // ordering and was missing the URL update. Without this the URL
      // stays on `?page=component:Xyz` after the user exits to the
      // page, so a reload drops them back into the master.
      syncUrlToPage(targetFile);
    });
  };

  const handleNavigateToComponent = (index: number) => {
    if (!hasBreadcrumb) return;
    const targetFile = breadcrumb[index + 1];
    if (!targetFile || targetFile === activeFile) return;
    trace.action('breadcrumb:navigate-component', { from: activeFile, to: targetFile, level: index });
    const freshCode = projectFS.readFile(activeFile);
    if (freshCode) syncQueueCode(freshCode);
    flushNow();
    switchWithZoom(targetFile, () => {
      setActiveFile(targetFile);
      setBreadcrumb(breadcrumb.slice(0, index + 1));
      setSelectedIds([]);
      // Same URL-sync gap as `handleNavigateToPage` — jumping to an
      // intermediate breadcrumb segment also needs to write the new
      // file's slug into the URL so reload lands on it.
      syncUrlToPage(targetFile);
    });
  };

  // Navigate to the ORIGIN page that preceded the slug page (the leading
  // segment when breadcrumb[0] is a `[slug]` detail page). Exits the whole
  // component + slug context: switches to the origin and clears the breadcrumb.
  const handleNavigateToOrigin = (originFile: string) => {
    if (!originFile || originFile === activeFile) return;
    trace.action('breadcrumb:navigate-origin', { from: activeFile, to: originFile });
    const freshCode = projectFS.readFile(activeFile);
    if (freshCode) syncQueueCode(freshCode);
    flushNow();
    switchWithZoom(originFile, () => {
      setActiveFile(originFile);
      setBreadcrumb([]);
      setSelectedIds([]);
      syncUrlToPage(originFile);
      // Back to a PAGE → return the left panel to the Pages tab (the collection
      // segment may have left it on the CMS panel).
      setLeftPanel('pages-layers');
    });
  };

  // The Home page's route slug resolves to '/' (empty slug). Show the
  // word "Home" for it — and for the empty-breadcrumb fallback —
  // instead of a bare slash. Non-home pages keep their slug (e.g. /about).
  const rawPageName = hasBreadcrumb ? getFileDisplayName(breadcrumb[0]) : '/';
  const pageName = rawPageName === '/' ? 'Home' : rawPageName;

  // Keep file paths around so we can recolor icon-set segments.
  // Purple (`#a78bfa` / `--accent-secondary`) is reserved for real
  // components — icon sets (`icons/`)
  // share the master-file plumbing but render in the blue
  // `--accent` everywhere else in the UI.
  const componentFiles = [
    ...(hasBreadcrumb ? breadcrumb.slice(1) : []),
    activeFile,
  ];

  // Base segment(s). When the root page (breadcrumb[0]) is a CMS `[slug]`
  // detail page, the base is TWO segments — [Collection] › [Item] — mirroring
  // the SlugPageBreadcrumb so the CMS context stays visible + navigable after
  // entering a component from a slug page (standard additive breadcrumb).
  // The Item segment navigates BACK to the slug page (= handleNavigateToPage).
  const slugBaseSegments: BreadcrumbSegment[] | null = (() => {
    if (!hasBreadcrumb) return null;
    const baseCode = projectFS.readFile(breadcrumb[0]);
    const cmsMeta = baseCode ? parseCmsPageMeta(baseCode) : null;
    if (cmsMeta?.kind !== 'detail') return null;
    const items = collectionData.get(cmsMeta.collection) ?? [];
    const slug = previewSlugMap.get(breadcrumb[0]) ?? items[0]?._slug ?? null;
    const item = items.find((i) => i._slug === slug) ?? items[0] ?? null;
    const openCmsCollection = () => {
      openCmsEditor({ collection: cmsMeta.collection, itemId: items[0]?._id ?? null });
      trace.action('breadcrumb:open-cms', { collection: cmsMeta.collection });
    };
    // Leading ORIGIN segment — the page that preceded the slug page (recorded
    // referrer, else the slug page's parent route), so the chain reads
    // [Origin] › [Collection] › [Item] › [Component…] and stays navigable back.
    const originFile = referrerMap.get(breadcrumb[0]) ?? getSlugPageParentFile(breadcrumb[0]);
    const originValid = !!originFile && originFile !== breadcrumb[0] && projectFS.exists(originFile);
    const originSeg: BreadcrumbSegment[] = originValid
      ? [{
          label: (() => { const r = getFileDisplayName(originFile!); return r === '/' ? 'Home' : r; })(),
          icon: <PageDocumentIcon size={14} className="text-[var(--text-secondary)]" />,
          color: 'var(--text-secondary)',
          onClick: () => handleNavigateToOrigin(originFile!),
        }]
      : [];
    return [
      ...originSeg,
      {
        label: prettyCollectionName(cmsMeta.collection),
        icon: <CmsIcon width={14} height={14} />,
        color: 'var(--text-secondary)',
        // Collection segment → open the CMS editor overlay (collection + first item).
        onClick: openCmsCollection,
      },
      {
        label: cmsItemDisplayLabel(item, slug),
        icon: <CmsItemIcon size={14} />,
        color: 'var(--text-secondary)',
        onClick: handleNavigateToPage,
      },
    ];
  })();

  const segments: BreadcrumbSegment[] = [
    ...(slugBaseSegments ?? [{
      label: pageName,
      icon: <PageDocumentIcon size={14} className="text-[var(--text-secondary)]" />,
      color: 'var(--text-secondary)',
      onClick: handleNavigateToPage,
    }]),
    ...componentFiles.map((filePath, index) => ({
      // A template segment shows the route-group/template name (e.g. "Main"),
      // not the bare "LayoutClient" file name. Components keep their @name.
      label: isTemplateFilePath(filePath)
        ? (() => { const g = getRouteGroup(filePath); return g ? g.charAt(0).toUpperCase() + g.slice(1) : 'Template'; })()
        : getFileDisplayName(filePath),
      // A template segment gets the template glyph (rect + rows, same as the
      // Library panel + FileExplorer); real components keep the cluster icon.
      icon: isTemplateFilePath(filePath) ? <TemplateIcon size={14} /> : <ComponentClusterIcon size={14} />,
      // Templates are component-like → secondary accent, same as real components.
      color: isComponentLikeFilePath(filePath) ? 'var(--accent-secondary)' : 'var(--accent)',
      onClick: index < componentFiles.length - 1 ? () => handleNavigateToComponent(index) : undefined,
    })),
  ];

  // The in-canvas "+" placeholder card (AddVectorUI.tsx) is the single
  // "add a new vector" affordance on icon-set masters, mirroring the reference's
  // variant-row "+" card. The redundant toolbar button that used to live
  // here was removed because two affordances for the same action made
  // the master toolbar feel busy.

  // z-[9000] sits ABOVE every canvas-overlay layer (CanvasRulers
  // chrome at 4900–4910, RulerGuides at 4895, position-indicator
  // pills at 4902, drag-preview lines at 4905, AddVariantUI at 2001)
  // so the breadcrumb cleanly covers any of them that visually overlap
  // the top 52 px chrome strip — and stays below the side headers
  // (z-9999) which need to remain on top of everything in the editor.
  return createPortal(
    <div
      className="float-bar-top fixed h-[52px] px-4 flex items-center left-[308px] right-[260px] shadow-[var(--shadow-sm)] border-b border-[var(--border-default)] bg-[var(--bg-surface)] z-[9000] top-0"
      data-dynamic-toolbar="true"
    >
      {overlayEditingId ? (
        /* OVERLAY EDIT — keep the SAME bar (background unchanged); just swap the
           breadcrumb for an accent-secondary "Editing Overlay" pill on the left and
           an "Exit" pill on the right. Both reuse the breadcrumb/Variables pill design. */
        <>
          <div
            className="px-3 h-7 flex items-center gap-1.5 text-sm font-medium text-[var(--accent-secondary-fg)] rounded-md whitespace-nowrap select-none"
            style={{ backgroundColor: 'var(--accent-secondary)' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
            Editing Overlay
          </div>
          <div className="flex-1" />
          <button
            onClick={exitOverlayEdit}
            className="px-3 h-7 flex items-center text-sm font-medium text-[var(--accent-secondary-fg)] rounded-md transition-all hover:brightness-110 whitespace-nowrap"
            style={{ backgroundColor: 'var(--accent-secondary)' }}
          >
            Exit
          </button>
        </>
      ) : (
        <>
          <Breadcrumb segments={segments} />

          {/* Spacer pushes the Variables button to the right edge of the bar. */}
          <div className="flex-1" />

          {/* Variables button — only on real component masters (not icon-set
              masters, which have no variable system). Opens the
              VariableModal in `manage` mode: a read-only browser over the
              component's props/variables. */}
          {isComponentLikeFilePath(activeFile) && (
            <button
              onClick={() => {
                trace.action('breadcrumb:open-variables', { file: activeFile });
                setVariablesOpen(true);
              }}
              className="px-3 h-7 flex items-center text-sm font-medium text-[var(--accent-secondary-fg)] rounded-md transition-all hover:brightness-110 whitespace-nowrap"
              style={{ backgroundColor: 'var(--accent-secondary)' }}
            >
              Variables
            </button>
          )}
        </>
      )}

      <VariableModal
        isOpen={variablesOpen}
        onClose={() => setVariablesOpen(false)}
        manage
      />
    </div>,
    document.body
  );
}
