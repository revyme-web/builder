// LeftMenu.tsx — 52px icon strip for the left toolbar.
// Matches old builder's leftMenu.tsx design exactly.

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { togglePanelAtom, leftPanelAtom, codeEditorOpenAtom, DEFAULT_LEFT_PANEL, type LeftPanelId } from '@/code/stores/left-panel-store';
import { aiChatDetachedAtom } from '@/code/stores/editor-store';
import { componentEditorFileAtom } from '@/code/stores/component-editor-store';
import { pluginEditorFileAtom } from '@/editor/plugin-editor/plugin-editor-store';
import { cmsEditorOpenAtom } from '@/code/stores/cms-editor-store';
import {
  InsertPlusIcon,
  PagesLayersIcon,
  LibraryStackIcon,
  GlobeInternationalIcon,
  ChatImageIcon,
  CmsIcon,
} from '@/shared/icons';
import CollaboratorsModal from '@/editor/collab/CollaboratorsModal';
import CollaboratorsSection from '@/editor/collab/CollaboratorsSection';
import { useIsViewer } from '@/code/stores/viewer-mode-store';
import { useIsClosedSource } from '@/code/stores/closed-source-store';

// ─── Code Icon ──────────────────────────────────────────────────────────────

function CodeIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" className={className}>
      <path fill="currentColor" d="M14.62 2.662a1.5 1.5 0 0 1 1.04 1.85l-4.431 15.787a1.5 1.5 0 0 1-2.889-.81L12.771 3.7a1.5 1.5 0 0 1 1.85-1.039ZM7.56 6.697a1.5 1.5 0 0 1 0 2.12L4.38 12l3.182 3.182a1.5 1.5 0 1 1-2.122 2.121L1.197 13.06a1.5 1.5 0 0 1 0-2.12l4.242-4.243a1.5 1.5 0 0 1 2.122 0Zm8.88 2.12a1.5 1.5 0 1 1 2.12-2.12l4.243 4.242a1.5 1.5 0 0 1 0 2.121l-4.242 4.243a1.5 1.5 0 1 1-2.122-2.121L19.621 12z" />
    </svg>
  );
}

// ─── Layers Icon (3 horizontal stacked sheets) ──────────────────────────────
//
// User-supplied glyph — three diamond layers stacked vertically, signalling
// the layer tree more conventionally than the offset-cards icon used
// before. `currentColor` lets the active/inactive theme split work the
// same way the other left-menu icons do.
function LayersIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" className={className}>
      <path fill="currentColor" d="m21.48 7.12l-9.02-5a.99.99 0 0 0-.97 0L2.52 7.08c-.32.18-.52.51-.52.87s.2.7.51.88l9.02 5.04c.15.08.32.13.49.13s.33-.04.49-.13l8.98-5c.32-.18.51-.51.51-.88s-.2-.7-.52-.87" />
      <path fill="currentColor" d="m12 15.86l-8.51-4.73l-.97 1.75l9 5c.15.08.32.13.49.13s.33-.04.49-.13l9-5l-.97-1.75l-8.51 4.73Z" />
      <path fill="currentColor" d="m12 19.86l-8.51-4.73l-.97 1.75l9 5c.15.08.32.13.49.13s.33-.04.49-.13l9-5l-.97-1.75l-8.51 4.73Z" />
    </svg>
  );
}

// ─── Hover-tooltip helpers ──────────────────────────────────────────────────
//
// Centralised state for the floating "section name" tooltip that pops to
// the right of an icon on hover. Click-to-suppress semantics: clicking an
// icon hides its tooltip until the user mouseenters a DIFFERENT icon
// (mouseenter on the same icon while suppressed stays silent). Without
// the suppression, the tooltip stayed visible after click and lingered
// over the panel that just opened.
type TooltipState = { label: string; top: number; left: number };

interface TooltipHandlers {
  /** mouseenter handler — pass the element ref so we can read its rect. */
  onEnter: (key: string, label: string, btn: HTMLElement) => void;
  /** mouseleave handler — clears the tooltip. */
  onLeave: () => void;
  /** call after the button's own click action runs, with the icon's key. */
  onClick: (key: string) => void;
  /** current suppression — read by Enter handler to skip showing. */
  suppressedKey: string | null;
}

// ─── Menu Button ────────────────────────────────────────────────────────────

interface MenuButtonProps {
  panelId: Exclude<LeftPanelId, null>;
  isActive: boolean;
  onToggle: (id: Exclude<LeftPanelId, null>) => void;
  title: string;
  tooltip: TooltipHandlers;
  children: React.ReactNode;
  /** Viewer mode — non-interactive + dimmed. Pages / Layers stay
   *  enabled so a viewer can still navigate; everything else passes
   *  `disabled` so it reads as available-with-edit-access. */
  disabled?: boolean;
  /** Optional `data-tutorial` id — lets the onboarding tour anchor a
   *  highlight to this icon button. */
  dataTutorial?: string;
}

const MenuButton = React.memo(function MenuButton({
  panelId, isActive, onToggle, title, tooltip, children, disabled, dataTutorial,
}: MenuButtonProps) {
  return (
    <button
      disabled={disabled}
      data-tutorial={dataTutorial}
      onClick={disabled ? undefined : (e) => {
        onToggle(panelId);
        tooltip.onClick(panelId);
        // Blur so the focus ring + lingering :hover state don't keep the
        // tooltip-anchor button "active" after the click closes the
        // tooltip.
        e.currentTarget.blur();
      }}
      onMouseEnter={disabled ? undefined : (e) => tooltip.onEnter(panelId, title, e.currentTarget)}
      onMouseLeave={disabled ? undefined : tooltip.onLeave}
      // Native browser tooltip removed — we draw our own. Without this,
      // the browser's grey title-bubble fights ours on slow systems.
      className={`w-8 h-8 rounded-md flex items-center justify-center transition-colors ${
        disabled
          ? 'text-[var(--text-secondary)] opacity-40 cursor-not-allowed'
          : isActive
            ? 'bg-[var(--btn-secondary-bg)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
      }`}
    >
      {children}
    </button>
  );
});

// ─── LeftMenu ───────────────────────────────────────────────────────────────

export default function LeftMenu() {
  const [activePanel, togglePanel] = useAtom(togglePanelAtom);
  const [codeOpen, setCodeOpen] = useAtom(codeEditorOpenAtom);
  // Viewer mode — only Pages + Layers stay interactive (navigation /
  // inspection). VIBE, Insert, Library, Presets, Media, Locale, CMS,
  // Code, Templates are all disabled (visible-but-dimmed, consistent
  // with the rest of view-only chrome).
  const isViewer = useIsViewer();
  const isClosedSource = useIsClosedSource();
  // The VIBE icon opens the docked AI chat. It hides entirely while the chat
  // is detached into the floating popup — there's nothing for it to toggle,
  // and the popup's X is what re-docks it.
  const detached = useAtomValue(aiChatDetachedAtom);
  // Code-component / plugin overlays — and the CMS editor overlay — take
  // over the workspace and host their own surface. The docked VIBE panel's
  // chat is gated off there, so it would render as an empty column. Hide
  // the VIBE icon while any overlay is open, and if VIBE is the active
  // panel fall back to Pages.
  const componentEditorOpen = useAtomValue(componentEditorFileAtom) !== null;
  const pluginEditorOpen = useAtomValue(pluginEditorFileAtom) !== null;
  const cmsEditorOpen = useAtomValue(cmsEditorOpenAtom);
  const inOverlay = componentEditorOpen || pluginEditorOpen || cmsEditorOpen;
  const setLeftPanel = useSetAtom(leftPanelAtom);
  useEffect(() => {
    if (inOverlay && activePanel === 'vibe') setLeftPanel(DEFAULT_LEFT_PANEL);
  }, [inOverlay, activePanel, setLeftPanel]);
  // Modal for "Share & collaborate" (invite/manage). Anchored to the
  // Collaborators icon at the bottom of the LeftMenu, mirroring where
  // the old builder put its CollaboratorsModal trigger. Replaces the
  // bottom Help icon — we don't need a runtime help button.
  const [collabModalOpen, setCollabModalOpen] = useState(false);

  // ─── Tooltip state — hover-to-show, click-to-suppress ─────────────────
  // `tooltip` is the currently visible label + its anchor coords. Null
  // means nothing's shown. `suppressedKey` is the icon ID that the user
  // just clicked — its tooltip stays hidden until the user mouseenters a
  // DIFFERENT icon (suppression clears at that point so the second hover
  // back onto the clicked icon shows the tooltip again).
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [suppressedKey, setSuppressedKey] = useState<string | null>(null);
  // Refs hold the latest values so the memoised handlers below stay
  // stable identity-wise (matters because `MenuButton` is `React.memo`'d
  // — a new handler object every render would defeat that memoisation).
  const suppressedRef = useRef<string | null>(null);
  suppressedRef.current = suppressedKey;

  const handleEnter = useCallback((key: string, label: string, btn: HTMLElement) => {
    // Re-entering the suppressed icon: keep tooltip hidden. Re-entering
    // anything else clears the suppression flag so subsequent hovers
    // (including a return to the previously-clicked icon) work as
    // expected.
    if (key === suppressedRef.current) {
      setTooltip(null);
      return;
    }
    if (suppressedRef.current !== null) setSuppressedKey(null);
    const rect = btn.getBoundingClientRect();
    setTooltip({
      label,
      top: rect.top + rect.height / 2,
      // Sits well clear of the icon strip — 20 px gap reads as a
      // floating chip in the gutter between LeftMenu and LeftPanel,
      // not a label hugging the button edge. LeftPanel starts at
      // x=52 so the tooltip lands in the visible margin between the
      // strip and the panel's left border.
      left: rect.right + 20,
    });
  }, []);
  const handleLeave = useCallback(() => setTooltip(null), []);
  const handleClick = useCallback((key: string) => {
    // Click hides the tooltip AND marks this icon's tooltip suppressed
    // until the next mouseenter on a different icon (see `handleEnter`).
    setTooltip(null);
    setSuppressedKey(key);
  }, []);
  const tooltipHandlers: TooltipHandlers = {
    onEnter: handleEnter,
    onLeave: handleLeave,
    onClick: handleClick,
    suppressedKey,
  };

  return (
    <div
      className="left-0 w-[52px] bg-[var(--bg-surface)] fixed z-[5000] flex flex-col justify-between items-center px-[10px] py-4"
      // willChange/isolation: own compositor layer — see LeftPanel (grey
      // checkerboard under the zoom-out re-raster burst).
      style={{ top: 52, height: 'calc(100vh - 52px)', willChange: 'transform', isolation: 'isolate' }}
    >
      {/* Right border */}
      <div className="absolute right-0 top-4 bottom-0 w-px bg-[var(--border-light)]" />

      {/* Top section */}
      <div className="flex items-center flex-col gap-2 relative z-10">
        {/* Vibe AI — brand accent. Opens the docked AI chat panel. Hidden while the
            chat is detached into its floating popup OR a code / plugin
            overlay is open; scales + slides in/out (and collapses its row
            height) on those transitions. `initial={false}` skips the
            animation on first app load. */}
        <AnimatePresence initial={false}>
          {!detached && !inOverlay && (
            <motion.div
              key="vibe-menu-item"
              initial={{ opacity: 0, scale: 0.6, x: -8, height: 0, marginBottom: -8 }}
              animate={{ opacity: 1, scale: 1, x: 0, height: 'auto', marginBottom: 0 }}
              exit={{ opacity: 0, scale: 0.6, x: -8, height: 0, marginBottom: -8 }}
              transition={{ type: 'spring', bounce: 0.2, duration: 0.28 }}
              className="flex flex-col items-center gap-2 overflow-hidden"
            >
              <button
                disabled={isViewer}
                onClick={isViewer ? undefined : (e) => { togglePanel('vibe'); handleClick('vibe'); e.currentTarget.blur(); }}
                onMouseEnter={isViewer ? undefined : (e) => handleEnter('vibe', 'Vibe AI', e.currentTarget)}
                onMouseLeave={isViewer ? undefined : handleLeave}
                className={`w-8 h-8 rounded-md flex items-center justify-center transition-colors text-[10px] font-bold tracking-wide ${
                  isViewer
                    ? 'bg-[var(--accent)] text-[var(--accent-fg)] opacity-40 cursor-not-allowed'
                    : activePanel === 'vibe'
                      ? 'bg-[var(--accent-hover)] text-[var(--accent-fg)]'
                      : 'bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-fg)]'
                }`}
              >
                VIBE
              </button>

              {/* Separator */}
              <div className="w-5 h-px bg-[var(--border-light)]" />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Insert — green */}
        <button
          data-left-menu-item="insert"
          data-tutorial="insert-button"
          disabled={isViewer}
          onClick={isViewer ? undefined : (e) => { togglePanel('insert'); handleClick('insert'); e.currentTarget.blur(); }}
          onMouseEnter={isViewer ? undefined : (e) => handleEnter('insert', 'Insert', e.currentTarget)}
          onMouseLeave={isViewer ? undefined : handleLeave}
          className={`w-8 h-8 rounded-md flex items-center justify-center transition-colors ${
            isViewer
              ? 'bg-[#0d9668] opacity-40 cursor-not-allowed'
              : activePanel === 'insert'
                ? 'bg-[#10B981]'
                : 'bg-[#0d9668] hover:bg-[#10B981]'
          }`}
        >
          <InsertPlusIcon className="w-[18px] h-[18px] text-white" />
        </button>

        {/* Layers — FIRST, directly under the insert button, and the panel the
            builder opens on. It is what you reach for on almost every edit;
            Pages is a navigation action you take once per session. Split out
            from the old combined Pages+Layers panel into its own tab. Enabled
            for viewers too: navigating the layer tree to inspect / comment is
            read-only. */}
        <MenuButton panelId="layers" isActive={activePanel === 'layers'} onToggle={togglePanel} title="Layers" tooltip={tooltipHandlers} dataTutorial="layers-button">
          <LayersIcon className="w-[18px] h-[18px]" />
        </MenuButton>

        {/* Pages */}
        <MenuButton panelId="pages-layers" isActive={activePanel === 'pages-layers'} onToggle={togglePanel} title="Pages" tooltip={tooltipHandlers} dataTutorial="pages-layers-button">
          <PagesLayersIcon className="w-[18px] h-[18px]" size={18} />
        </MenuButton>

        {/* Library — enabled for viewers. The panel itself gates which
            sections a viewer can click into (design components
            / vector sets / templates are navigable; code components are
            inert — see LibraryPanel). */}
        <MenuButton panelId="library" isActive={activePanel === 'library'} onToggle={togglePanel} title="Library" tooltip={tooltipHandlers} dataTutorial="library-button">
          <LibraryStackIcon className="w-[18px] h-[18px]" size={18} />
        </MenuButton>

        {/* Presets */}
        <MenuButton panelId="presets" isActive={activePanel === 'presets'} onToggle={togglePanel} title="Presets" tooltip={tooltipHandlers} disabled={isViewer} dataTutorial="presets-button">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" className="w-[18px] h-[18px]">
            <path fill="currentColor" d="M19 11.5s-2 2.17-2 3.5a2 2 0 0 0 2 2a2 2 0 0 0 2-2c0-1.33-2-3.5-2-3.5M5.21 10L10 5.21L14.79 10m1.77-1.06L7.62 0L6.21 1.41l2.38 2.38l-5.15 5.15c-.59.56-.59 1.53 0 2.12l5.5 5.5c.29.29.68.44 1.06.44s.77-.15 1.06-.44l5.5-5.5c.59-.59.59-1.56 0-2.12" />
          </svg>
        </MenuButton>

        {/* Media Gallery */}
        <MenuButton panelId="media" isActive={activePanel === 'media'} onToggle={togglePanel} title="Media Gallery" tooltip={tooltipHandlers} disabled={isViewer} dataTutorial="media-button">
          <ChatImageIcon className="w-[18px] h-[18px]" />
        </MenuButton>

        {/* Localization */}
        <MenuButton panelId="locale" isActive={activePanel === 'locale'} onToggle={togglePanel} title="Localization" tooltip={tooltipHandlers} disabled={isViewer} dataTutorial="locale-button">
          <GlobeInternationalIcon className="w-[18px] h-[18px]" size={18} />
        </MenuButton>

        {/* CMS */}
        <MenuButton panelId="cms" isActive={activePanel === 'cms'} onToggle={togglePanel} title="CMS" tooltip={tooltipHandlers} disabled={isViewer} dataTutorial="cms-button">
          <CmsIcon className="w-[18px] h-[18px]" />
        </MenuButton>

        {/* Code — opens floating popup instead of left panel. HIDDEN
            entirely on a closed-source template remix: the template author
            chose not to expose the source, so the affordance doesn't render
            (matching the marketplace "Closed source" option). */}
        {!isClosedSource && <button
          disabled={isViewer}
          onClick={isViewer ? undefined : (e) => { setCodeOpen(v => !v); handleClick('code'); e.currentTarget.blur(); }}
          onMouseEnter={isViewer ? undefined : (e) => handleEnter('code', 'Code', e.currentTarget)}
          onMouseLeave={isViewer ? undefined : handleLeave}
          className={`w-8 h-8 rounded-md flex items-center justify-center transition-colors ${
            isViewer
              ? 'text-[var(--text-secondary)] opacity-40 cursor-not-allowed'
              : codeOpen
                ? 'bg-[var(--btn-secondary-bg)] text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          }`}
        >
          <CodeIcon className="w-[18px] h-[18px]" />
        </button>}

      </div>

      {/* Bottom section — collaborators stack (port of the old builder
          design at `revyme-old/.../leftMenu.tsx#L96-209`):
            [ + ]            opens the invite modal
            [ remote… ]      one circle per remote user
            [ ME 🟢 ]        current user with pulsing connection dot
          Replaces the prior Help (?) icon — at the bottom of the
          strip we want the share affordance, not docs. */}
      <div className="relative z-10 flex flex-col items-center gap-3">
        <div className="w-5 h-px bg-[var(--border-light)]" />
        <CollaboratorsSection
          onAddClick={() => setCollabModalOpen(true)}
          onTooltipEnter={handleEnter}
          onTooltipLeave={handleLeave}
        />
      </div>

      {/* Modal — outside the icon strip so the backdrop / portal layer
          doesn't inherit the strip's `position: fixed` / z-index. */}
      <CollaboratorsModal isOpen={collabModalOpen} onClose={() => setCollabModalOpen(false)} />

      {/* Floating tooltip — portaled to body so it overlays the LeftPanel
          (which sits above z-[5000]) and respects screen-edge clamping
          regardless of where the LeftMenu container stacks. Renders only
          when `tooltip` is set; click-suppression is handled upstream in
          `handleClick` / `handleEnter`.
          Animation: very subtle fade + scale + slight rightward slide on
          enter / exit. Starts a few px to the LEFT of its final position
          with 95 % scale and 0 opacity, then settles into place over
          120 ms (linear-ish ease). Reads as "the tooltip floated out
          from the icon" without any showy motion. `transform: 'none'`
          gets overridden by framer-motion's `style` prop — we keep the
          `translateY(-50%)` by baking it into the `y: '-50%'` initial /
          animate values so motion preserves the vertical centring. */}
      {createPortal(
        <AnimatePresence>
          {tooltip && (
            <motion.div
              key="left-menu-tooltip"
              initial={{ opacity: 0, scale: 0.92, x: -4, y: '-50%' }}
              animate={{ opacity: 1, scale: 1, x: 0, y: '-50%' }}
              exit={{ opacity: 0, scale: 0.92, x: -4, y: '-50%' }}
              transition={{ duration: 0.12, ease: 'easeOut' }}
              className="fixed px-2 py-1 rounded-md bg-[var(--accent)] shadow-md text-[11px] font-medium text-[var(--accent-fg)] whitespace-nowrap pointer-events-none"
              style={{
                top: tooltip.top,
                left: tooltip.left,
                zIndex: 10000,
                // Anchor the scale to the LEFT edge so the tooltip
                // "grows out" from the icon side rather than from its
                // own centre — reads more naturally with the rightward
                // slide on enter.
                transformOrigin: 'left center',
              }}
            >
              {tooltip.label}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
