import { useEffect } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { Toaster } from 'sonner';
import Canvas from './canvas/Canvas';
import PropertiesPanel from './editor/PropertiesPanel';
import CommentsListPanel from './editor/CommentsListPanel';
import { commentModeActiveAtom } from './code/stores/comment-store';
import DebugToolbar from './editor/ui/DebugToolbar';
import BottomToolbar from './editor/BottomToolbar';
import IconSetChat from './editor/IconSetChat';
import PageChat from './editor/PageChat';
import { componentEditorFileAtom } from '@/code/stores/component-editor-store';
import { activeFilePathAtom, isIconSetFilePath } from './code/project/active-file-store';
import { isComponentFileAtom } from './code/stores/store';
import KeyframeSheet from './editor/tools/AnimationTool/css/KeyframeSheet';
import PreviewOverlay from './editor/header/PreviewOverlay';
import { LeftMenu, LeftPanel, leftPanelAtom } from './editor/left-toolbar';
import LeftHeader from './editor/header/LeftHeader';
import RightHeader from './editor/header/RightHeader';
import { commitActiveTextEdit } from './canvas/text-edit-committer';
import TranslationsOverlay from './editor/left-toolbar/panels/locale/TranslationsOverlay';
import CmsOverlay, { cmsOverlayOpenAtom } from './editor/left-toolbar/panels/cms/CmsOverlay';
import CmsEditorOverlay from './editor/left-toolbar/panels/cms/CmsEditorOverlay';
import { cmsEditorOpenAtom } from '@/code/stores/cms-editor-store';
import { translationsOverlayOpenAtom } from '@/editor/left-toolbar/panels/LocalePanel';
import { settingsOverlayOpenAtom } from '@/code/stores/website-settings-store';
import { showRulersAtom } from '@/code/stores/user-preferences-store';
import CodeEditorPopup from './editor/CodeEditorPopup';
import ComponentEditorOverlay from './editor/component-editor/ComponentEditorOverlay';
import SettingsOverlay from './editor/overlays/SettingsOverlay';
import PageVariablesModal from './editor/ui/PageVariablesModal';
import LinkedComponentModal from './cloud/components/LinkedComponentModal';
import PluginEditor from './editor/plugin-editor/PluginEditor';
import { pluginEditorFileAtom } from './editor/plugin-editor/plugin-editor-store';
import PluginRuntimeWindow from './plugins/PluginRuntimeWindow';
import PluginVideoPickerHost from './plugins/PluginVideoPickerHost';
import { UploadInstructionsModal } from './plugins/UploadInstructionsModal';
import { CommandPalette } from './editor/command-palette/CommandPalette';
import { OnboardingTutorial } from './editor/onboarding';
import { linkedComponentModalUrlAtom } from './cloud/components/linked-component-modal-store';
import { usePrefetchCdnMetadataForActiveFile } from './cloud/components/cdn-metadata-hook';
import { useSetAtom } from 'jotai';
import { initCloudPlugin } from './cloud/cloud-plugin';
import { CLOUD_ENABLED } from './shared/cloud-flag';
import { previewModeAtom } from './code/stores/editor-store';
import { CollaborationProvider } from './canvas/collab/CollaborationProvider';
import CollaborationLayer from './canvas/collab/CollaborationLayer';
import { useIsViewer, useViewerReason, setOfflineMode } from './code/stores/viewer-mode-store';
// Sketch draw animations intentionally do NOT auto-play on the canvas —
// it's an editing surface, and auto-playback on every preview exit /
// page open is distracting noise. The animation runs in PREVIEW (and at
// export time) because the generated source contains a real `useEffect`
// that calls `playSketchDraw` from `@revyme/runtime`; the canvas just
// shows the static committed `d` for each stroke.

// Register cloud plugin sections (Plans, Domain, Analytics, Submit) —
// cloud mode only. Standalone/OSS builds get just the core Website
// settings section; the SettingsOverlay renders whatever is registered.
if (CLOUD_ENABLED) initCloudPlugin();

export default function App() {
  // Lifted to atom so MenuTabs (View → Toggle preview) and the Ctrl+P
  // keyboard shortcut can both flip it without prop-drilling. The
  // right-header Preview button still drives the same atom via the
  // `onTogglePreview` prop below.
  const [previewMode, setPreviewMode] = useAtom(previewModeAtom);
  const componentEditorOpen = useAtomValue(componentEditorFileAtom) !== null;
  // Plugin editor takes over the canvas chrome the same way
  // ComponentEditor does — when open we hide the BottomToolbar (and
  // any other floating canvas-only UI) so the overlay can reach
  // edge-to-edge without competing chrome.
  const pluginEditorOpen = useAtomValue(pluginEditorFileAtom) !== null;
  // The CMS panel is a full data-management surface — the canvas creator
  // tools don't apply there, so the BottomToolbar hides while it's open.
  const cmsPanelOpen = useAtomValue(leftPanelAtom) === 'cms';
  const [cmsOverlayOpen, setCmsOverlayOpen] = useAtom(cmsOverlayOpenAtom);
  const [cmsEditorOpen, setCmsEditorOpen] = useAtom(cmsEditorOpenAtom);
  const translationsOverlayOpen = useAtomValue(translationsOverlayOpenAtom);
  // The BottomToolbar hides only while a CMS collection OVERLAY actually
  // covers the canvas — not merely when the CMS panel (the collection list)
  // is the active left panel, which still leaves the canvas visible.
  const cmsOverlayShowing = cmsOverlayOpen || cmsEditorOpen;
  // Leaving the CMS panel (clicking another left-menu icon) closes any open
  // CMS collection overlay — it would otherwise linger over an unrelated panel.
  useEffect(() => {
    if (!cmsPanelOpen) {
      setCmsOverlayOpen(false);
      setCmsEditorOpen(false);
    }
  }, [cmsPanelOpen, setCmsOverlayOpen, setCmsEditorOpen]);
  // Same rule for the Localization overlay: it may only exist while the
  // globe (locale) panel is the active left panel — clicking any other
  // left-menu icon dismisses it (the overlay atom's write-through selects
  // the locale panel on open, so the two stay in lockstep).
  const localePanelOpen = useAtomValue(leftPanelAtom) === 'locale';
  const setTranslationsOverlayOpen = useSetAtom(translationsOverlayOpenAtom);
  useEffect(() => {
    if (!localePanelOpen && translationsOverlayOpen) setTranslationsOverlayOpen(false);
  }, [localePanelOpen, translationsOverlayOpen, setTranslationsOverlayOpen]);
  // Viewers can't change anything — the AI page/design chat bubbles
  // would just produce mutations the queue no-ops, so hide them.
  const isViewer = useIsViewer();

  // Ctrl/Cmd+P → toggle preview. Ignored when typing in inputs /
  // textareas / contenteditable so the shortcut doesn't fight with
  // browser print or text input. preventDefault on the dispatched
  // event suppresses the browser print dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== 'p') return;
      const target = e.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) return;
      e.preventDefault();
      setPreviewMode((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPreviewMode]);
  // Icon-set masters route the AI chat differently — icon sets
  // keep their own streaming chat.
  const activeFilePath = useAtomValue(activeFilePathAtom);
  const isIconSet = isIconSetFilePath(activeFilePath);
  // Component master files re-skin the editor accent from blue (--accent)
  // to purple (--accent-secondary). The override goes on `<html>` (NOT a
  // child div) so it reaches portaled UI too: dropdown menus, the
  // variable modal, the preset picker, ToolPopups, etc. all render via
  // `createPortal(document.body)` and would otherwise miss an override
  // scoped to the editor root. The canvas iframe is a separate document
  // so its own --accent stays blue regardless — the canvas Renderer's
  // color rules depend on that.
  const isComponentFile = useAtomValue(isComponentFileAtom);
  useEffect(() => {
    const root = document.documentElement;
    if (isComponentFile) {
      root.style.setProperty('--accent', 'var(--accent-secondary)');
      // The FOREGROUND has to move with the fill. Overriding only --accent
      // left every accent-filled control (Publish, Variables, the active
      // tool) purple while its LABEL kept --accent-fg, which is the
      // near-black chosen for gold — black text on purple, and unreadable
      // once the two accents stopped being the same hue family.
      root.style.setProperty('--accent-fg', 'var(--accent-secondary-fg)');
      root.style.setProperty('--accent-strong', 'var(--accent-secondary)');
      root.style.setProperty('--accent-strong-fg', 'var(--accent-secondary-fg)');
      // `--border-focus` is the colour for focused inputs / dropdowns —
      // separate token from --accent in globals.css. Without overriding
      // it, focused ToolInputs keep the brand accent even when everything
      // else turns purple.
      root.style.setProperty('--border-focus', 'var(--accent-secondary)');
    } else {
      root.style.removeProperty('--accent');
      root.style.removeProperty('--accent-fg');
      root.style.removeProperty('--accent-strong');
      root.style.removeProperty('--accent-strong-fg');
      root.style.removeProperty('--border-focus');
    }
    return () => {
      root.style.removeProperty('--accent');
      root.style.removeProperty('--accent-fg');
      root.style.removeProperty('--accent-strong');
      root.style.removeProperty('--accent-strong-fg');
      root.style.removeProperty('--border-focus');
    };
  }, [isComponentFile]);

  // The left rail, left panel and right inspector normally FLOAT: inset from
  // the window edges, rounded, with the canvas running behind them. The
  // full-screen overlays (CMS, translations, settings, preview) cover the
  // whole viewport, and against that a floating panel leaves a gap and a
  // rounded corner sitting over a square edge — it reads as a bug.
  //
  // So the chrome docks for the duration: `panels-docked` zeroes --float-gap
  // and --float-radius on <html>, and the transition in globals.css slides
  // everything flush. Closing the overlay reverses it. The class goes on
  // <html> rather than a child because the headers and panels are `fixed`
  // siblings scattered across the tree, not children of one container.
  //
  // Rulers dock it too, and for a different reason than the overlays. They are
  // edge-anchored measurement chrome: opaque, and pinned to canvas coordinates,
  // so they can neither float nor bleed behind the cards the way the canvas
  // does. Every junction between a ruler and a floating card — the corner box,
  // the bar ends, the exposed bottom corner — needs its own patch, and the strip
  // of bare canvas above the top bar can't be fixed at all without pinning the
  // ruler to the window edge, which contradicts the floating layout.
  //
  // Turning rulers on IS a switch into precision mode, and edge-to-edge chrome
  // is what precision mode wants. So they dock, and the whole class of seam
  // problems stops existing. Rulers are opt-in and default OFF, so the floating
  // layout is what most sessions actually see.
  const settingsOverlayOpen = useAtomValue(settingsOverlayOpenAtom);
  const showRulers = useAtomValue(showRulersAtom);
  const panelsDocked =
    previewMode || settingsOverlayOpen || cmsOverlayShowing || translationsOverlayOpen || showRulers;
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('panels-docked', panelsDocked);
    return () => root.classList.remove('panels-docked');
  }, [panelsDocked]);

  return (
    <CollaborationProvider>
    <div style={{ display: 'flex', height: '100vh', flexDirection: 'column' }}>
      {/* Debug toolbar — floating at top center, above everything */}
      <DebugToolbar />
      {/* Live-collab broadcast loops + remote cursor overlay. Renders
          inside the provider so its hooks have context; the overlay
          itself is `position: fixed` and floats above the canvas. */}
      <CollaborationLayer />
      {/* View-only banner — shown when the current user is a viewer by
          ROLE. Owners and editors never see it. */}
      <ViewOnlyBanner />
      {/* Network watcher — flips the editor into the offline read-only
          state when the connection drops, and the matching toast. */}
      <OfflineWatcher />
      <OfflineToast />

      {/* Headers — fixed at top corners, canvas visible between them */}
      <LeftHeader />
      <RightHeader previewMode={previewMode} onTogglePreview={async () => {
        // Entering the live preview while a text-edit session is active: commit it
        // FIRST. Text-edit style changes only land in the code when the session
        // EXITS, so without this the preview would read stale code and miss the
        // just-made edits (color/font/…). No-op when nothing is being edited.
        if (!previewMode) await commitActiveTextEdit();
        setPreviewMode(!previewMode);
      }} />

      {/* Left toolbar: fixed icon menu + always-open panel. NOT inert
          for viewers — they need to switch panels (Pages, Layers,
          Library, …) and navigate between the website's pages to view
          them. Write actions inside the panels (add page, insert,
          CMS edit, …) bottom out at the mutation-queue gate, and the
          prominent ones are individually disabled in viewer mode. */}
      <LeftMenu />
      <LeftPanel />

      {/* Main — FULL-BLEED. The left rail and right inspector float above the
          canvas (see .float-panel-* in globals.css), so the canvas spans the
          whole width and runs behind them rather than being boxed between. */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative' }}>
        <Canvas />
        {/* Right panel: PropertiesPanel by default, swap for the
            project-wide comments list while comment mode is active.
            Both panels are 260 px wide so the canvas viewport doesn't
            reflow on toggle. Viewer read-only handling lives inside
            RightSidebar (fieldset-disable on the Properties panel; the
            comments list stays interactive). */}
        {!previewMode && <RightSidebar />}
        {/* AI chat — the bottom-sheet AIChatSheet. The page-agent loop drives
            BOTH pages and design-component masters (it sends the variant-layer
            tools when the active file is a component); icon-set masters keep
            their own streaming chat. */}
        {!previewMode && !componentEditorOpen && !pluginEditorOpen && !isViewer && isIconSet && <IconSetChat />}
        {!previewMode && !componentEditorOpen && !pluginEditorOpen && !isViewer && !isIconSet && <PageChat />}
        {!previewMode && !componentEditorOpen && !pluginEditorOpen && !cmsOverlayShowing && !translationsOverlayOpen && <BottomToolbar />}
        {/* Sketch brush controls live in the right PropertiesPanel
            (SketchTool) so they sit in the same place as every other
            element's properties — not in a floating toolbar. */}
        {!previewMode && <KeyframeSheet />}
        {/* Sketch draw animations only play in preview / export — the
            canvas is for editing, not auto-playback (see comment at
            top of file). */}
      </div>

      {/* Preview overlay — fullscreen iframe running the in-house React
          preview-sandbox (vite on :5175). Replaced the old `ServerPreview`
          (Next.js dev server in live-renderer/preview-project) — see
          `src/editor/header/PreviewOverlay.tsx` for the postMessage
          protocol that ships ProjectFS into the iframe. */}
      <PreviewOverlay open={previewMode} onClose={() => setPreviewMode(false)} />

      {/* Global overlays — portaled, always rendered */}
      <TranslationsOverlay />
      <CmsOverlay />
      <CmsEditorOverlay />
      <ComponentEditorOverlay />
      <CodeEditorPopup />
      <SettingsOverlay />
      <PageVariablesModal />
      <LinkedComponentModalMount />
      {/* Plugin runtime — global free-floating window. Independent
          of the ToolPopup singleton, so it stays open regardless of
          which left-panel section / tool popup is active. Closes
          only via its own × button or programmatic atom clear. */}
      <PluginRuntimeWindow hidden={previewMode} />
      {/* Bridges the `assets.pickVideo` plugin RPC to the native video picker
          (same Pixabay/Upload/URL modal as the Fill tool). Renders nothing until
          a plugin requests a pick. */}
      <PluginVideoPickerHost />
      {/* Upload Instructions modal — walks plugin authors through the
          `@revyme/plugin-tools pack` CLI + dashboard upload flow.
          Opened from a Tier 1 dev plugin's right-click menu. */}
      <UploadInstructionsModal />
      {/* cmd+K command palette — bottom-toolbar dropdown for searching
          marketplace plugins (and later commands/blocks/templates).
          Portal-mounted so it escapes any overflow/transform ancestors. */}
      <CommandPalette />
      {/* First-run product tour — shown once per browser (localStorage
          gate). Portals to body at z-[99999], cuts a spotlight hole around
          each chrome target tagged with `data-tutorial`. Hidden for
          viewers: the creator tools it walks through aren't in their
          stripped toolbar, so the steps would have no anchor. */}
      {!isViewer && <OnboardingTutorial />}
      {/* Plugin editor overlay — Monaco split with live iframe preview
          for Tier 2 (in-browser-authored) plugins. Reads
          `pluginEditorFileAtom`; null = closed. */}
      <PluginEditorMount />

      {/* Toast container — same dark style as the old builder.
          `position="bottom-center"` + `offset` lifts toasts above the
          48px bottom toolbar so they don't hide behind it. Calls to
          `toast(...)` from anywhere in the app render here via portal. */}
      <Toaster
        position="bottom-center"
        offset={64}
        toastOptions={{
          style: {
            background: '#1a1a1a',
            border: '1px solid rgba(255,255,255,0.1)',
            color: '#fff',
            fontSize: '13px',
          },
        }}
      />
    </div>
    </CollaborationProvider>
  );
}

// PluginEditor mount — atom-driven Monaco overlay for Tier 2 plugins.
// `pluginEditorFileAtom` set to a `plugins/{Name}.tsx` path opens the
// editor; setting null closes it. Library "Plugins" section's
// "+ New plugin" + "Edit" actions write to this atom.
function PluginEditorMount() {
  const filePath = useAtomValue(pluginEditorFileAtom);
  const setFilePath = useSetAtom(pluginEditorFileAtom);
  if (!filePath) return null;
  return <PluginEditor filePath={filePath} onClose={() => setFilePath(null)} />;
}

// LinkedComponentModal mount — read URL atom, pass through. Atom-driven so
// any place in the app can open the modal by writing the CDN URL into
// `linkedComponentModalUrlAtom` (today: canvas double-click handler).
function LinkedComponentModalMount() {
  const state = useAtomValue(linkedComponentModalUrlAtom);
  const setState = useSetAtom(linkedComponentModalUrlAtom);
  // Warm the metadata cache for every CDN-linked instance on the active page
  // so the modal's closed-source verdict is INSTANT on double-click (no
  // "Unlink" flash before the closed-source message).
  usePrefetchCdnMetadataForActiveFile();
  return (
    <LinkedComponentModal
      isOpen={state !== null}
      onClose={() => setState(null)}
      cdnUrl={state?.url ?? null}
      instanceNodeId={state?.nodeId ?? null}
    />
  );
}

// Right sidebar — switches between the default PropertiesPanel and the
// project-wide CommentsListPanel based on `commentModeActiveAtom`. Kept
// in a separate component so the atom subscription doesn't re-render the
// entire <App />, just the panel slot.
//
// Viewer read-only handling: the Properties panel is wrapped in a
// `<fieldset disabled>` — natively disables every form control inside
// (real disabled styling, like a `<input disabled>`), auto-applies to
// anything React renders later, and crucially does NOT block wheel
// scrolling (unlike `inert`, which suppresses scroll events). The
// comments list is left interactive — viewers can read/reply to
// comments, that's the one thing they CAN do.
function RightSidebar() {
  const commentMode = useAtomValue(commentModeActiveAtom);
  const isViewer = useIsViewer();
  if (commentMode) return <CommentsListPanel />;
  return (
    <fieldset
      disabled={isViewer}
      // `display: contents` + reset the fieldset's default chrome so it
      // adds zero layout — the disabled propagation is DOM-based and
      // unaffected by display. `min-inline-size: 0` defeats fieldset's
      // built-in min-content width.
      style={{ display: 'contents', border: 'none', margin: 0, padding: 0, minInlineSize: 0 }}
    >
      <PropertiesPanel />
    </fieldset>
  );
}

// ─── View-only mode bits ────────────────────────────────────────────────────

/** Read-only pill shown just above the bottom toolbar when the current
 *  user is a viewer BY ROLE. Bottom-center so it sits with the other
 *  canvas chrome instead of stealing the top edge. Non-interactive.
 *  Offline read-only mode gets the `<OfflineToast />` instead — this
 *  banner keys off the reason so the two never show at once. */
function ViewOnlyBanner() {
  const reason = useViewerReason();
  if (reason !== 'viewer') return null;
  return (
    <div
      style={{
        position: 'fixed',
        // BottomToolbar is `bottom: 16px` and ~44px tall — sit 8px above
        // it (16 + 44 + 8 = 68) so the two read as a stacked cluster.
        bottom: 68,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9998,
        padding: '4px 12px',
        background: 'rgba(0, 0, 0, 0.6)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        borderRadius: 999,
        color: 'rgba(255, 255, 255, 0.85)',
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: 0.2,
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      View only — you don't have edit access to this website.
    </div>
  );
}

/** Watches the browser's network status and flips the editor into the
 *  offline read-only state. The `offline` event fires the instant the
 *  network interface drops (`navigator.onLine` → false); a short
 *  debounce rides out 1-second blips so a flaky connection doesn't
 *  strobe the whole editor. Recovery (`online`) unlocks immediately.
 *  Renders nothing — it's a pure side-effect mount. */
function OfflineWatcher() {
  useEffect(() => {
    let pending: number | null = null;
    const goOffline = () => {
      if (pending !== null) return;
      pending = window.setTimeout(() => {
        pending = null;
        setOfflineMode(true);
      }, 2000);
    };
    const goOnline = () => {
      if (pending !== null) {
        window.clearTimeout(pending);
        pending = null;
      }
      setOfflineMode(false);
    };
    // Catch the case where the editor loads while already offline.
    if (!navigator.onLine) goOffline();
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      if (pending !== null) window.clearTimeout(pending);
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);
  return null;
}

/** Persistent toast shown while the user is offline. Unlike the timed
 *  `toast(...)` API this is declarative — it stays for the whole
 *  offline window and disappears the instant the network returns.
 *  Sits where the `ViewOnlyBanner` does (the two are mutually exclusive
 *  via the viewer reason). */
function OfflineToast() {
  const reason = useViewerReason();
  if (reason !== 'offline') return null;
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 68,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9998,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 14px',
        background: 'var(--bg-tertiary)',
        border: '1px solid var(--border-light)',
        borderRadius: 10,
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
        color: 'var(--text-primary)',
        fontSize: 12,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        userSelect: 'none',
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#f87171"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="1" y1="1" x2="23" y2="23" />
        <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
        <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
        <path d="M10.71 5.05A16 16 0 0 1 22.58 9" />
        <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
        <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
        <line x1="12" y1="20" x2="12.01" y2="20" />
      </svg>
      <span>Reconnect to the internet to continue editing.</span>
    </div>
  );
}


