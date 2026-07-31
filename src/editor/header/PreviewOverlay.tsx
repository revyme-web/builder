// PreviewOverlay.tsx — Preview overlay that boots the in-house preview-sandbox
// (vite on :5175). Opens when the user hits the play button in the right
// header; ships the active project's ProjectFS contents over postMessage and
// re-pushes any file changes for instant hot reload.
//
// Layout: fixed inset, z-9997 — below LeftHeader/RightHeader (z-9999) and the
// LeftMenu/LeftPanel so the editor chrome stays visible while previewing.
// Centers the preview iframe inside a dark backdrop with a viewport-controls
// header (W/H/Full/presets/reload) and four grip handles for resizing.
//
// The preview is a SEPARATE iframe from the canvas sandbox: the canvas runs
// the editor's imperative DOM patcher, the preview runs a real React tree.
// Both read from the same ProjectFS but render via different paths.

import { useEffect, useRef, useState, useCallback } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { flushNow } from '@/code/mutation/mutation-queue';
import { activeFilePathAtom, filePathToSlug, isComponentFilePath, getVariantBasePage } from '@/code/project/active-file-store';
import { templateGroupFromLayoutFile, templatePreviewRoute } from '@/preview/template-preview';
import { migrateLegacyDarkBlock } from '@/code/project/preset-ops';
import { activePreviewSlugAtom } from '@/code/stores/cms-page-store';
import { selectedNodeAtom, codeAtom, getNodesSnapshot } from '@/code/stores/store';
import { interactingViewportIdAtom, interactingViewportWidthAtom } from '@/code/stores/viewport-store';
import { parseVariantConfig } from '@/code/variants/variant-config';
import { previewComponentFileOverrideAtom } from '@/code/stores/editor-store';
import { activeLocaleAtom } from '@/code/stores/locale-store';
import {
  DesktopViewportIcon,
  TabletViewportIcon,
  MobileViewportIcon,
  ReloadIcon,
} from '@/shared/icons';
import { trace } from '@/shared/debug-trace';
import { usePreviewThumbnail } from './usePreviewThumbnail';
import ToolInput from '@/editor/controls/ToolInput';
import Button from '@/design-system/Button';

/** URL the preview iframe loads. Historically this lived at
 *  `http://localhost:5175` (a separate Vite project). The runtime has since
 *  been moved into the editor's own dev server, so the iframe is now
 *  same-origin with the parent. The constant is kept for the iframe `src`
 *  attribute only — postMessage target origin is set to `'*'` (the iframe
 *  is self-hosted by us, so origin pinning adds no real security but DOES
 *  silently drop messages whenever the iframe ends up at a different port,
 *  which is exactly the bug we're fixing). */
const PREVIEW_ORIGIN =
  typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname}:5175`
    : 'http://localhost:5175';
/** Target-origin used in `iframe.contentWindow.postMessage(..., …)`.
 *  `'*'` works regardless of where the iframe ends up (5175, 3333, or any
 *  future port). The incoming filter is also relaxed below so messages from
 *  whichever origin actually serves the iframe are accepted. */
const POST_MESSAGE_TARGET = '*';

const PRESETS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 375, height: 812 },
};

// Header height — the preview surface sits below the 52px LeftHeader/
// RightHeader strip and spans the full window width (covers LeftMenu/
// LeftPanel) so users get the largest possible preview area.
const HEADER_H = 52;

// A/B variant manifest lookup — resolves a variant file path
// (`_revyme/variants/<testId>/<id>.tsx`) to its base page path by reading
// the sibling `test.json` manifest the variant-create flow writes. Returns
// null for non-variant paths OR when the manifest is missing / malformed.
// The base page path is what the iframe's route table actually knows about;
// without this resolution the preview would 404 on the variant's literal
// path (the deployed Worker serves variants by cookie hash, not URL).
function resolveVariantOverride(filePath: string):
  | { variantFilePath: string; basePagePath: string }
  | null {
  const basePagePath = getVariantBasePage(filePath);
  return basePagePath ? { variantFilePath: filePath, basePagePath } : null;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function PreviewOverlay({ open, onClose }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeReady, setIframeReady] = useState(false);
  // Bumped on EVERY `preview:ready` — an in-iframe navigation (the locale
  // switcher's location.assign to /fr) fully reloads the iframe, which posts
  // a fresh `preview:ready` while `iframeReady` is already true. Keying the
  // files-push on this tick re-sends the project to the reloaded instance —
  // without it the new document waits for files forever and renders BLANK.
  const [readyTick, setReadyTick] = useState(0);
  const projectVersion = useAtomValue(projectVersionAtom);
  const activeLocale = useAtomValue(activeLocaleAtom);
  // ─── Re-push on ANY file write ────────────────────────────────────────────
  // `projectVersionAtom` is bumped by `modifyProjectFile` and by history
  // restores — NOT by an ordinary mutation-queue flush, which is how almost
  // every canvas edit reaches projectFS (`onFlush` → `projectFS.writeFile`).
  // So with the preview OPEN, switching a container to Grid, editing a style,
  // dragging — none of it re-pushed: the iframe kept rendering the project as
  // it stood when the preview opened, while the published site (built from the
  // saved snapshot) was correct. Reported as "tablet renders wrong in preview
  // but right on the live site", 2026-07-26.
  //
  // `projectFS.subscribe` fires on every write/delete, which is the complete
  // signal. Coalesced into a tick so a burst of writes (one flush touching
  // several files) causes ONE re-push.
  const [fsTick, setFsTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    let queued = false;
    return projectFS.subscribe(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; setFsTick((t) => t + 1); });
    });
  }, [open]);
  const [previewOverride, setPreviewOverride] = useAtom(previewComponentFileOverrideAtom);
  const activeFilePathRaw = useAtomValue(activeFilePathAtom);
  // When a play-icon affordance set the override, preview that file
  // instead of whichever file the canvas is currently editing. Lets the
  // user keep their page open in the builder AND press Play on a
  // component instance to preview JUST that component standalone.
  const activeFilePath = previewOverride ?? activeFilePathRaw;
  // For dynamic CMS detail pages (`app/team/[slug]/page.tsx`), the editor
  // tracks which item is currently being previewed. Substituting that slug
  // into the path on initial nav lets the preview open on the same item the
  // user was designing against, rather than 404'ing on `[slug]`.
  const activePreviewSlug = useAtomValue(activePreviewSlugAtom);
  // Selection + interacting variant — used to seed the component preview's
  // `initialVariant` so the iframe opens in the same variant the user was
  // editing (e.g. clicking inside variant-2's hierarchy and pressing Play
  // boots the preview already in variant-2 instead of always defaulting to
  // the primary). Reads are cheap; the values are only consumed below on
  // open / reload / project-version bumps.
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const interactingVpId = useAtomValue(interactingViewportIdAtom);
  // Width of the viewport the user was last working in (the one containing the
  // selection). Used to seed the preview iframe size on open — the page-mode
  // analogue of the component-mode `initialVariant` seeding above: select inside
  // the Tablet viewport + press Play → preview boots at 768px so the page's
  // responsive (@media/@container) rules match the tile the user was editing.
  const interactingVpWidth = useAtomValue(interactingViewportWidthAtom);
  const code = useAtomValue(codeAtom);

  // ─── Viewport sizing state ─────────────────────────────────────────

  const [previewWidth, setPreviewWidth] = useState(PRESETS.desktop.width);
  const [previewHeight, setPreviewHeight] = useState(PRESETS.desktop.height);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [windowWidth, setWindowWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1440);
  const [windowHeight, setWindowHeight] = useState(typeof window !== 'undefined' ? window.innerHeight : 900);

  useEffect(() => {
    const handleResize = () => {
      setWindowWidth(window.innerWidth);
      setWindowHeight(window.innerHeight);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Seed the iframe size from the interacting viewport when the preview OPENS.
  // Page mode only — select inside the Tablet viewport, press Play, and the
  // preview launches at 768px (height = the matching device preset) so the
  // responsive layout matches what the canvas tile showed. Component mode keeps
  // its own sizing (the variant's width comes from the rendered component via
  // `initialVariant`). Fires on the false→true `open` transition so the user
  // can freely resize / switch presets afterwards without it snapping back.
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (open && !prevOpenRef.current && !isComponentFilePath(activeFilePath) && interactingVpWidth > 0) {
      const preset = interactingVpWidth <= PRESETS.mobile.width ? PRESETS.mobile
        : interactingVpWidth <= PRESETS.tablet.width ? PRESETS.tablet
        : PRESETS.desktop;
      setPreviewWidth(interactingVpWidth);
      setPreviewHeight(preset.height);
      setIsFullScreen(false);
      trace.action('preview-overlay:seed-viewport-size', { vpId: interactingVpId, width: interactingVpWidth });
    }
    prevOpenRef.current = open;
  }, [open, interactingVpWidth, interactingVpId, activeFilePath]);

  // The overlay's controls header occupies the SAME 52px row as the editor's
  // LeftHeader/RightHeader (visible in the middle gap between them). Iframe
  // starts at y=52, so fullscreen height = window height - 52.
  const currentWidth = isFullScreen ? windowWidth : previewWidth;
  const currentHeight = isFullScreen ? windowHeight - HEADER_H : previewHeight;

  // Visible iframe height — cap at the available vertical space so the
  // bottom grip handle is always reachable and the parent backdrop never
  // scrolls. The user's `previewHeight` is still preserved (and shown in the
  // H input); we just clamp what gets rendered. Scroll happens INSIDE the
  // iframe (the user's page), not on the parent backdrop.
  // 32px = top padding (16) + bottom padding (16) on the dark backdrop.
  const maxIframeHeight = Math.max(200, windowHeight - HEADER_H - 32);
  const renderedWidth = isFullScreen ? '100%' : Math.min(currentWidth, windowWidth - 64);
  const renderedHeight = isFullScreen ? '100%' : Math.min(currentHeight, maxIframeHeight);

  const activeViewport = currentWidth <= PRESETS.mobile.width ? 'mobile'
    : currentWidth <= PRESETS.tablet.width ? 'tablet' : 'desktop';

  // ─── Drag handlers (4-side grip resize) ────────────────────────────

  const dragStateRef = useRef<{
    axis: 'h' | 'v';
    fromTop: boolean;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  } | null>(null);
  const [isDragging, setIsDragging] = useState<'h' | 'v' | null>(null);

  const startHorizontal = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStateRef.current = { axis: 'h', fromTop: false, startX: e.clientX, startY: 0, startW: previewWidth, startH: 0 };
    setIsDragging('h');
    trace.action('preview-overlay:drag-h-start', { width: previewWidth });
  }, [previewWidth]);

  const startVertical = useCallback((e: React.MouseEvent, fromTop: boolean) => {
    e.preventDefault();
    dragStateRef.current = { axis: 'v', fromTop, startX: 0, startY: e.clientY, startW: 0, startH: previewHeight };
    setIsDragging('v');
  }, [previewHeight]);

  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: MouseEvent) => {
      const s = dragStateRef.current;
      if (!s) return;
      if (s.axis === 'h') {
        const dx = e.clientX - s.startX;
        const next = Math.max(320, Math.min(s.startW + dx * 2, windowWidth - 100));
        setPreviewWidth(Math.round(next));
      } else {
        const dy = e.clientY - s.startY;
        const delta = s.fromTop ? -dy : dy;
        const next = Math.max(200, Math.min(s.startH + delta * (s.fromTop ? 2 : 1), windowHeight - 100));
        setPreviewHeight(Math.round(next));
      }
    };
    const onUp = () => {
      setIsDragging(null);
      dragStateRef.current = null;
      trace.action('preview-overlay:drag-end', { width: previewWidth, height: previewHeight });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [isDragging, windowWidth, windowHeight, previewWidth, previewHeight]);

  const handleViewportSelect = useCallback((vp: keyof typeof PRESETS) => {
    const preset = PRESETS[vp];
    setPreviewWidth(preset.width);
    setPreviewHeight(preset.height);
    setIsFullScreen(false);
    trace.action('preview-overlay:viewport-select', { viewport: vp, width: preset.width });
  }, []);

  const handleReload = useCallback(() => {
    setIframeReady(false);
    setReloadKey((k) => k + 1);
    trace.action('preview-overlay:reload');
  }, []);

  // ─── postMessage protocol ──────────────────────────────────────────

  // Listen for the preview iframe's `preview:ready` handshake — only safe to
  // post project files after that arrives, otherwise the message lands
  // before the in-iframe listener is mounted.
  useEffect(() => {
    if (!open) return;
    setIframeReady(false);
    const handler = (e: MessageEvent) => {
      // No origin filter — the iframe may be served from PREVIEW_ORIGIN,
      // the parent's own origin, or any future port. We only act on a
      // narrow set of `preview:*` message types we send to ourselves; an
      // unrelated origin can't fake the protocol shape in a way that
      // changes editor behavior. Filtering by message type below.
      if (e.data?.type === 'preview:ready') {
        setIframeReady(true);
        setReadyTick((t) => t + 1);
        trace.action('preview-overlay:ready', { from: e.origin });
      }
    };
    window.addEventListener('message', handler);
    // Defensive fallback: if the iframe loads but `preview:ready` never
    // arrives within 3 s (e.g. Vite optimize-dep 504, syntax error in user
    // code, network hiccup), force-send the files anyway. main.tsx is
    // idempotent — receiving them twice is harmless.
    const timeout = setTimeout(() => {
      setIframeReady((prev) => {
        if (!prev) trace.error('preview-overlay:ready-timeout', { ms: 3000 });
        return true;
      });
    }, 3000);
    return () => {
      window.removeEventListener('message', handler);
      clearTimeout(timeout);
    };
  }, [open, reloadKey]);

  // Push the full ProjectFS contents on first ready, and again on EVERY file
  // write (`fsTick`, above) — not just when `projectVersionAtom` bumps, which
  // misses the mutation-queue flush that carries almost every canvas edit. The
  // in-iframe runtime handles route rebuild + re-render (it clears its
  // `compiledModuleCache` on each push, so re-pushed files really do recompile).
  useEffect(() => {
    if (!open || !iframeReady) return;
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;

    // Flush the mutation queue BEFORE snapshotting. Queued mutations apply to
    // the queue's own `currentCode` first and only reach `projectFS` when a
    // flush lands — and the drag path deliberately DEFERS that write to the end
    // of the gesture. Reading projectFS unflushed therefore ships a snapshot
    // that is one or more edits behind, and the preview renders a layout the
    // canvas has already moved past (reported as "the live site shows a flex row
    // where the canvas shows my grid", 2026-07-26). Publish
    // (`RightHeader.handlePublish`) and the remix-link builder
    // (`menu-builders.menuCreateRemixLink`) both flush first — this was the one
    // snapshot reader that didn't.
    flushNow();

    const files: Array<[string, string]> = [];
    let globalsCssContent = '';
    for (const path of projectFS.listFiles()) {
      let content = projectFS.readFile(path);
      if (content === null) continue;
      // Older projects store dark-mode tokens under `[data-theme="dark"]`,
      // which doesn't match the `<html class="dark">` that next-themes adds
      // (providers.tsx uses `attribute="class"`). Fold those entries into
      // `:root.dark` on the way to the preview so the theme toggle works
      // even before the user re-saves a preset (the canonical fix lives in
      // preset-ops.setDarkTokenValue, which writes :root.dark going forward).
      if (path === 'app/globals.css') {
        content = migrateLegacyDarkBlock(content);
        globalsCssContent = content;
      }
      files.push([path, content]);
    }
    // Pin the preview to the same theme the canvas always uses (light) so
    // user edits to `:root { --foo: … }` show up. The canvas Renderer
    // skips `:root.dark` by design — without this, next-themes' `enableSystem`
    // can flip the iframe to dark and the user's light-mode preset edits
    // never appear in the preview. Sent BEFORE files so the iframe's
    // theme is set on the first paint, not a flash of dark.
    iframe.contentWindow.postMessage({ type: 'preview:force-theme', theme: 'light' }, POST_MESSAGE_TARGET);
    // Pin the LOCALE too, same reasoning as the theme above. The generated
    // `providers.tsx` resolves an unprefixed route's locale from
    // `localStorage.getItem('locale')` — and the preview iframe runs on its OWN
    // ORIGIN, so it has its own localStorage. A locale picked in an earlier
    // preview session stuck, `<html lang>` became that locale, and every
    // `:lang(xx)` rule in the page fired — a legacy `:lang(fr) […] { display:
    // flex !important }` turned a 3-column grid into a row in the preview while
    // the published site (localStorage `en`) rendered it correctly
    // (user find 2026-07-26).
    iframe.contentWindow.postMessage({ type: 'preview:force-locale', locale: activeLocale }, POST_MESSAGE_TARGET);
    iframe.contentWindow.postMessage({ type: 'preview:project-files', files }, POST_MESSAGE_TARGET);

    // Dedicated tokens channel — extract `:root { … }` (and `:root.dark { … }`)
    // out of globals.css and forward as a high-priority style block. The
    // regular CSS file pipeline already injects globals.css, but only fires
    // once the iframe processes `preview:project-files`. Sending tokens
    // separately as their own injection guarantees `var(--shadow-elevated)`
    // (and any other preset token) resolves even on the first paint, and
    // gives us a single style element to debug if tokens look off.
    const rootBlocks: string[] = [];
    if (globalsCssContent) {
      const rootMatch = globalsCssContent.match(/:root\s*\{[\s\S]*?\}/);
      if (rootMatch) rootBlocks.push(rootMatch[0]);
      const darkMatch = globalsCssContent.match(/:root\.dark\s*\{[\s\S]*?\}/);
      if (darkMatch) rootBlocks.push(darkMatch[0]);
    }
    iframe.contentWindow.postMessage({
      type: 'preview:tokens',
      css: rootBlocks.join('\n'),
    }, POST_MESSAGE_TARGET);
    trace.action('preview-overlay:project-pushed', {
      fileCount: files.length,
      version: projectVersion,
      tokenBlocks: rootBlocks.length,
    });
  }, [open, iframeReady, projectVersion, reloadKey, readyTick, fsTick, activeLocale]);

  // Open the preview on the user's currently active page (e.g. /page-3),
  // not always /. Fires only when ready transitions to true (per open cycle
  // / per reload) — we don't want to teleport the user back to the active
  // file every time they edit something while preview is open.
  //
  // Dynamic routes (`/team/[slug]`): substitute `[slug]` (or any `[X]`
  // segment) with the slug currently previewed in the editor — that's the
  // CMS item the user was designing against. Without this the iframe lands
  // on the literal `/team/[slug]` URL which 404s, and the user sees the
  // home page or a 404 instead of the page they were editing.
  useEffect(() => {
    if (!open || !iframeReady) return;
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;

    // Component master open in the editor → render it standalone in the
    // sandbox (Storybook-style). The sandbox short-circuits routing while
    // `previewComponentFile` is set; sending `filePath: null` for non-component
    // files restores normal page routing on a subsequent toggle.
    if (isComponentFilePath(activeFilePath)) {
      // Seed `initialVariant` from the user's current selection. All variants
      // share the same node tree on the master canvas — the only signal
      // distinguishing them is which viewport (variant) the user last
      // interacted with, which the canvas tracks in `interactingViewportIdAtom`
      // (Canvas.tsx maps each variant to its own viewport with `id = variant
      // name`, except primary `default` which becomes `desktop` for backwards
      // compat). When nothing is selected, OR the selected node lives outside
      // any variant viewport (canvas-node fragment), fall back to the primary
      // variant so the preview boots in a sane default state.
      const variants = parseVariantConfig(code);
      const primaryVariant = variants.find(v => v.isPrimary)?.name ?? variants[0]?.name ?? 'default';
      const selectedNode = selectedNodeId ? getNodesSnapshot().get(selectedNodeId) : null;
      // `vpId === 'desktop'` is the canvas-side alias for the `default`
      // variant; map it back to the variant name the component file uses.
      const vpToVariant = (vpId: string) => (vpId === 'desktop' ? 'default' : vpId);
      const useFallback = !selectedNodeId || !selectedNode || selectedNode.isCanvasNode;
      const initialVariant = useFallback ? primaryVariant : vpToVariant(interactingVpId);
      iframe.contentWindow.postMessage({
        type: 'preview:component',
        filePath: activeFilePath,
        initialVariant,
      }, POST_MESSAGE_TARGET);
      trace.action('preview-overlay:component-mode', {
        activeFilePath,
        initialVariant,
        selectedNodeId,
        interactingVpId,
        usedFallback: useFallback,
      });
      return;
    }
    // Page mode — clear any component-isolation that may be active from a
    // previous toggle, then navigate by slug.
    iframe.contentWindow.postMessage({ type: 'preview:component', filePath: null }, POST_MESSAGE_TARGET);

    // A/B variant page: the file lives at `_revyme/variants/<testId>/<id>.tsx`,
    // OUTSIDE the `app/` tree the iframe's router scans, so naively navigating
    // by `filePathToSlug(activeFilePath)` would 404. Look up the variant's
    // manifest, learn its base page path, and tell the iframe to swap THIS
    // variant's compiled output into that route's pageFile slot — the layout
    // chain comes for free. `previewVariantOverride` is sent fresh on every
    // open / reload; sending an empty payload on non-variant pages clears any
    // stale override left from the previous preview session.
    const variantInfo = resolveVariantOverride(activeFilePath);
    if (variantInfo) {
      // Order: navigate first, then register the override. Both messages
      // process before React commits, but the iframe's popstate-driven
      // `setUrl` lives in state — only the override is in a module-scoped
      // map. Doing the override LAST means the render that observes the
      // new URL also observes the override; reversing the order would
      // commit one frame with the new URL against an empty override map,
      // briefly painting the baseline before the variant.
      const baseSlug = filePathToSlug(variantInfo.basePagePath);
      const url = '/' + (baseSlug === 'home' ? '' : baseSlug);
      iframe.contentWindow.postMessage({ type: 'preview:navigate', url }, POST_MESSAGE_TARGET);
      iframe.contentWindow.postMessage({
        type: 'preview:variant-page',
        variantFilePath: variantInfo.variantFilePath,
        basePagePath: variantInfo.basePagePath,
      }, POST_MESSAGE_TARGET);
      trace.action('preview-overlay:variant-nav', {
        url,
        variantFilePath: variantInfo.variantFilePath,
        basePagePath: variantInfo.basePagePath,
      });
      return;
    }
    iframe.contentWindow.postMessage({ type: 'preview:variant-page', variantFilePath: null, basePagePath: null }, POST_MESSAGE_TARGET);

    // Template (route-group LayoutClient) — it has no page route of its own, so
    // `filePathToSlug` would yield `/LayoutClient.tsx` and 404. Navigate to the
    // injected placeholder route instead, which renders the template's layout
    // around a page-content placeholder. See preview/template-preview.ts.
    const tplGroup = templateGroupFromLayoutFile(activeFilePath);
    if (tplGroup) {
      const url = templatePreviewRoute(tplGroup).url;
      iframe.contentWindow.postMessage({ type: 'preview:navigate', url }, POST_MESSAGE_TARGET);
      trace.action('preview-overlay:template-nav', { url, group: tplGroup, activeFilePath });
      return;
    }

    const slug = filePathToSlug(activeFilePath);
    if (!slug || slug === 'home') return;

    let urlPath = slug;
    if (urlPath.includes('[')) {
      // Replace EVERY `[name]` (or `[...name]`) segment with the active
      // preview slug. We don't try to match by segment name — the CMS
      // detail-page pattern is one dynamic segment per route, and the
      // editor exposes exactly one `activePreviewSlug` per active file.
      if (!activePreviewSlug) return;
      urlPath = urlPath.replace(/\[[^\]]+\]/g, activePreviewSlug);
    }

    const url = '/' + urlPath;
    iframe.contentWindow.postMessage({ type: 'preview:navigate', url }, POST_MESSAGE_TARGET);
    trace.action('preview-overlay:initial-nav', { url, activeFilePath, dynamic: slug.includes('[') });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, iframeReady, reloadKey]);

  // ESC closes the overlay. (Browser-level shortcut — clicks inside the
  // iframe don't bubble out, so the parent owns this.)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Clear the preview-file override whenever the overlay closes so the
  // next Play press (right-header button) uses the active canvas file
  // instead of the last-overridden component. Watching `open` keeps
  // the clear paired with every close path — parent's setPreviewMode,
  // Escape, the X button — without each having to remember.
  useEffect(() => {
    if (!open && previewOverride) setPreviewOverride(null);
  }, [open, previewOverride, setPreviewOverride]);

  // Dashboard thumbnail — when the preview opens on the HOME page (and the
  // project changed since the last capture), the iframe snapshots its own
  // rendered page and we upload it as the website's preview_image. Only the
  // home page may set it — `preview_image` is one thumbnail per site, so
  // previewing a sub-page or a component master must not overwrite it.
  // Deferred inside the iframe so it never slows the preview. Replaces the
  // puppeteer screenshot-service.
  const isHomePage =
    !isComponentFilePath(activeFilePath) && filePathToSlug(activeFilePath) === 'home';
  usePreviewThumbnail({
    open,
    iframeReady,
    isHomePage,
    projectVersion,
    iframeRef,
    postMessageTarget: POST_MESSAGE_TARGET,
  });

  if (!open) return null;

  // ─── Render ────────────────────────────────────────────────────────

  return (
    <div
      // z-[9997]: below LeftHeader/RightHeader (z-9999) so they stay clickable
      // (close, preview-toggle). The overlay covers the full window —
      // including over LeftMenu/LeftPanel — for the maximum preview surface.
      // The overlay's own controls header sits in the SAME 52px row as the
      // editor headers: LeftHeader covers the left corner, RightHeader the
      // right corner, and the controls (Full/W/H/presets/reload/×) show in
      // the middle gap between them.
      className="fixed inset-0 z-[9997] flex flex-col"
      data-preview-overlay=""
    >
      {/* Viewport-controls header — 52px to match LeftHeader/RightHeader.
          Layout: a single linear row of homogenous 32px controls. The X
          close was removed because LeftHeader already shows a "Back"
          affordance in preview mode (same gesture, single place to
          look). The hardcoded "{W} × {H}" readout was removed too — the
          W/H inputs already show those numbers, so the duplicate just
          added visual noise. */}
      <div
        className="h-[52px] bg-[var(--bg-surface)] border-b border-[var(--border-light)] flex items-center justify-center shrink-0"
        style={{ position: 'relative', zIndex: 1 }}
      >
        <div className="flex items-center gap-2">
          {/* Full screen toggle — design-system Button so it shares the
              EXACT chrome (background, hover, radius) as the LeftHeader
              Back button. variant="primary" when active so the toggled
              state is unambiguous. */}
          <Button
            variant={isFullScreen ? 'primary' : 'secondary'}
            size="sm"
            tabIndex={-1}
            onClick={() => setIsFullScreen(!isFullScreen)}
            title="Toggle fullscreen"
          >
            Full
          </Button>

          {/* Hairline separator — visual grouping for sizing inputs vs
              the rest of the toolbar, without competing with the row's
              own border-b. */}
          <div className="w-px h-5 bg-[var(--border-light)] mx-1" aria-hidden />

          {/* Width — ToolInput so the user gets the same chevron-drag /
              arrow-nudge / Enter-to-commit behavior as every other
              numeric control in the editor. Wrapped in a fixed-width
              column because ToolInput fills its parent. */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[var(--text-tertiary)] font-medium uppercase tracking-wide">W</span>
            <div className="w-[72px]">
              <ToolInput
                value={String(Math.round(isFullScreen ? currentWidth : previewWidth))}
                onChange={(v) => {
                  const n = parseInt(v, 10);
                  if (Number.isFinite(n) && n >= 320) {
                    setPreviewWidth(n);
                    setIsFullScreen(false);
                    trace.action('preview-overlay:width-commit', { width: n });
                  }
                }}
                step={10}
              />
            </div>
          </div>

          {/* Height — same pattern as width. */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[var(--text-tertiary)] font-medium uppercase tracking-wide">H</span>
            <div className="w-[72px]">
              <ToolInput
                value={String(Math.round(isFullScreen ? currentHeight : previewHeight))}
                onChange={(v) => {
                  const n = parseInt(v, 10);
                  if (Number.isFinite(n) && n >= 200) {
                    setPreviewHeight(n);
                    setIsFullScreen(false);
                    trace.action('preview-overlay:height-commit', { height: n });
                  }
                }}
                step={10}
              />
            </div>
          </div>

          <div className="w-px h-5 bg-[var(--border-light)] mx-1" aria-hidden />

          {/* Viewport presets — each preset is its own design-system
              Button (same chrome as Back / Full / reload). Active
              preset gets variant="primary" so it picks up the accent
              fill — no separate "selected" decoration, the variant
              swap does it. `!px-0 !w-[30px]` makes the icon-only
              footprint square to match h-[30px]. */}
          {([
            { id: 'desktop', Icon: DesktopViewportIcon, label: 'Desktop' },
            { id: 'tablet', Icon: TabletViewportIcon, label: 'Tablet' },
            { id: 'mobile', Icon: MobileViewportIcon, label: 'Mobile' },
          ] as const).map(({ id, Icon, label }) => {
            const active = activeViewport === id;
            return (
              <Button
                key={id}
                variant={active ? 'primary' : 'secondary'}
                size="sm"
                tabIndex={-1}
                onClick={() => handleViewportSelect(id)}
                title={label}
                aria-label={label}
                aria-pressed={active}
                className="!px-0 !w-[30px]"
                icon={<Icon className="w-[14px] h-[14px]" />}
              />
            );
          })}

          <div className="w-px h-5 bg-[var(--border-light)] mx-1" aria-hidden />

          {/* Reload — same design-system Button chrome as everything
              else. The reload glyph's path fills its viewBox edge-to-
              edge (unlike the device icons, which have ~10% inner
              padding inside their paths) — w-[14px] here is what makes
              it read as the same visual size as the device icons next
              to it. */}
          <Button
            variant="secondary"
            size="sm"
            tabIndex={-1}
            onClick={handleReload}
            title="Reload preview"
            aria-label="Reload preview"
            className="!px-0 !w-[30px]"
            icon={<ReloadIcon className="w-[14px] h-[14px]" />}
          />
        </div>
      </div>

      {/* Preview area — dark backdrop. Iframe is aligned to the top with
          breathing-room padding. `overflow-hidden` so the parent backdrop
          NEVER scrolls — scroll only happens inside the iframe (the user's
          page). The iframe rendered height is clamped to `maxIframeHeight`
          so the bottom grip handle is always visible. */}
      <div className="flex-1 bg-[var(--bg-canvas)] flex items-start justify-center relative overflow-hidden pt-4 pb-4">
        {/* Iframe wrapper — grip handles position relative to THIS wrapper
            (not the dark backdrop's center) so resize handles stay attached
            to the iframe regardless of where the wrapper ends up in the
            scrollable area. */}
        <div
          className="relative shrink-0"
          style={{
            width: renderedWidth,
            height: renderedHeight,
          }}
        >
          {/* Left grip */}
          {!isFullScreen && (
            <div
              className="absolute top-0 bottom-0 flex items-center justify-center z-10 group cursor-ew-resize"
              style={{ left: -15, width: 15 }}
              onMouseDown={startHorizontal}
            >
              <div className="w-1 h-16 bg-gray-300 group-hover:bg-[var(--accent)] transition-colors rounded-full opacity-60 group-hover:opacity-100" />
            </div>
          )}
          {/* Right grip */}
          {!isFullScreen && (
            <div
              className="absolute top-0 bottom-0 flex items-center justify-center z-10 group cursor-ew-resize"
              style={{ right: -15, width: 15 }}
              onMouseDown={startHorizontal}
            >
              <div className="w-1 h-16 bg-gray-300 group-hover:bg-[var(--accent)] transition-colors rounded-full opacity-60 group-hover:opacity-100" />
            </div>
          )}
          {/* Top grip */}
          {!isFullScreen && (
            <div
              className="absolute left-0 right-0 flex items-center justify-center z-10 group cursor-ns-resize"
              style={{ top: -15, height: 15 }}
              onMouseDown={(e) => startVertical(e, true)}
            >
              <div className="h-1 w-16 bg-gray-300 group-hover:bg-[var(--accent)] transition-colors rounded-full opacity-60 group-hover:opacity-100" />
            </div>
          )}
          {/* Bottom grip */}
          {!isFullScreen && (
            <div
              className="absolute left-0 right-0 flex items-center justify-center z-10 group cursor-ns-resize"
              style={{ bottom: -15, height: 15 }}
              onMouseDown={(e) => startVertical(e, false)}
            >
              <div className="h-1 w-16 bg-gray-300 group-hover:bg-[var(--accent)] transition-colors rounded-full opacity-60 group-hover:opacity-100" />
            </div>
          )}

          {/* Iframe container — transparent so the dark backdrop shows
              through while user code is still compiling/mounting (no white
              flash, no loader). The user's globals.css paints its own bg
              once the React tree mounts. */}
          <div className="w-full h-full overflow-hidden">
            <iframe
              key={reloadKey}
              ref={iframeRef}
              src={PREVIEW_ORIGIN + '/'}
              className="w-full h-full"
              style={{ border: 'none', display: 'block' }}
              // No `sandbox` attribute on purpose. The preview lives at
              // localhost:5175 — a different origin from the parent (3333) —
              // so origin isolation already prevents user code from touching
              // the parent's DOM, cookies, or window. Adding `sandbox`
              // recursively sandboxes every nested iframe (YouTube, Vimeo,
              // Calendly, Spline, …); those nested iframes inherit the
              // parent sandbox tokens and end up at
              // `chrome-error://chromewebdata/` because their loads are
              // blocked. Sandbox would also strip cookies the third-party
              // players need. The `allow="..."` attribute below is what
              // grants the embed-permission features (autoplay, fullscreen,
              // clipboard, etc.) to nested iframes — it's the right tool
              // for that job, not `sandbox`.
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen; web-share"
            />
          </div>
        </div>

        {/* Drag overlay — blocks iframe pointer events during resize so
            mouse events keep firing on the parent document. */}
        {isDragging && (
          <div className={`fixed inset-0 z-20 ${isDragging === 'h' ? 'cursor-ew-resize' : 'cursor-ns-resize'}`} />
        )}
      </div>
    </div>
  );
}
