// LeftPanel.tsx — Panel container that renders the active panel.
// Fixed 256px for all panels. Code editor moved to floating CodeEditorPopup.

import React from 'react';
import { useAtomValue } from 'jotai';
import { leftPanelAtom } from '@/code/stores/left-panel-store';
import { workspaceOverlayOpenAtom } from '@/code/stores/workspace-overlay-store';
import PagesLayersPanel from './panels/PagesLayersPanel';
import InsertPanel from './panels/insert';
import LibraryPanel from './panels/LibraryPanel';
import MediaGalleryPanel from './panels/MediaGalleryPanel';
import LocalePanel from './panels/LocalePanel';
import CmsPanel from './panels/CmsPanel';
import { trace } from '@/shared/debug-trace';

// Wrapper to pass mode='presets' to LibraryPanel
function PresetsPanel() {
  return <LibraryPanel mode="presets" />;
}
function LibraryOnlyPanel() {
  return <LibraryPanel mode="library" />;
}

const PANEL_MAP: Record<string, React.ComponentType> = {
  'insert': InsertPanel,
  // Layers and Pages are ONE panel with a segmented control (Layers first).
  // Both ids map to it: 'pages-layers' is the canonical one, and 'layers' is
  // kept so existing shortcuts, saved panel state and deep links from before
  // the merge still open something instead of rendering nothing.
  'pages-layers': PagesLayersPanel,
  'layers': PagesLayersPanel,
  'library': LibraryOnlyPanel,
  'presets': PresetsPanel,
  'media': MediaGalleryPanel,
  'locale': LocalePanel,
  'cms': CmsPanel,
  // NOTE: 'vibe' has no entry on purpose — the docked AI chat is a
  // self-positioned overlay (`VibeDockShell`, rendered by PageChat /
  // IconSetChat) that sits in this same slot. When 'vibe' is active this
  // component renders nothing so the overlay has the space to itself.
};

const PANEL_WIDTH = 256;

export default function LeftPanel() {
  const activePanel = useAtomValue(leftPanelAtom);
  // The bottom-right cut is a window onto the CANVAS. While a takeover
  // overlay (CMS, localization, component/plugin editor) covers the
  // workspace, the notch would show a triangle of stale canvas through the
  // overlay's chrome — so the corner squares off for the duration.
  const overlayOpen = useAtomValue(workspaceOverlayOpenAtom);
  const PanelComponent = PANEL_MAP[activePanel];
  if (!PanelComponent) return null;

  trace.fn('LeftPanel.render', { activePanel });

  return (
    <div
      // `data-editor-panel` is what ToolbarDragStrategy.onMove uses to
      // recognize "cursor is still over a left panel, NOT over the canvas"
      // — this overlay sits at z-[5000] above the canvas containerRect,
      // so without the marker the strategy would happily commit drops on
      // mouseup over here.
      data-editor-panel="left-primary"
      data-tutorial="left-panel"
      className={`fixed z-[5000] flex flex-col overflow-hidden ${overlayOpen ? '' : 'cut-br cut-lg'}`}
      // willChange/isolation: own compositor layer — during a big zoom-out
      // the sandbox's re-materialise + re-raster burst saturates the shared
      // GPU process; without a persistent texture the panel's invalidated
      // tiles painted as grey checkerboard until the raster caught up.
      style={{ left: 52, top: 52, width: PANEL_WIDTH, height: 'calc(100vh - 52px)', willChange: 'transform', isolation: 'isolate' }}
    >
      <PanelComponent />
    </div>
  );
}
