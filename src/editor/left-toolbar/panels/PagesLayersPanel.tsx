// PagesLayersPanel.tsx — Layers and Pages as two tabs of ONE panel.
//
// They answer the same question ("where am I in this document?") and are never
// needed at once, so they were costing two rail icons for one job — and the
// Layers view already carried the page switcher at its top, which made the
// separate Pages icon half redundant. Layers is first and is the default: it
// is what you are in while building, where Pages is a visit.
//
// Library deliberately stays OUT: it is an insert surface (pick a thing and
// drop it on the canvas), not a way of navigating this document, and grouping
// it here read as arbitrary. It keeps its own rail icon.
//
// THE TAB IS THE PANEL ID. Rather than holding a local `activeTab` beside the
// `leftPanelAtom`, switching a tab writes the atom. That keeps one source of
// truth, so opening "Pages" from the command palette (or a shortcut, or
// restored panel state) lands on the right TAB instead of the right panel with
// the wrong tab showing — which is exactly the bug a second piece of state
// would have introduced.

import { useAtomValue, useSetAtom } from 'jotai';
import FileExplorer from '@/editor/FileExplorer';
import LayersPanel from '@/editor/LayersPanel';
import PanelErrorBoundary from '@/editor/ui/PanelErrorBoundary';
import ToolSegmentedControl from '@/editor/controls/ToolSegmentedControl';
import { leftPanelAtom, type LeftPanelId } from '@/code/stores/left-panel-store';
import { selectedNodeAtom } from '@/code/stores/store';
import { trace } from '@/shared/debug-trace';

/** Panel ids this panel owns, in tab order. */
const TABS = [
  { value: 'layers', label: 'Layers' },
  { value: 'pages-layers', label: 'Pages' },
];

export const PAGES_LAYERS_PANEL_IDS = new Set<LeftPanelId>(['layers', 'pages-layers']);

export default function PagesLayersPanel() {
  const activePanel = useAtomValue(leftPanelAtom);
  const setLeftPanel = useSetAtom(leftPanelAtom);
  const selectedId = useAtomValue(selectedNodeAtom);
  // An id outside the set can't reach this component, but default defensively
  // rather than render an empty body if one ever does.
  const tab = PAGES_LAYERS_PANEL_IDS.has(activePanel) ? activePanel : 'layers';
  trace.fn('PagesLayersPanel.render', { tab });

  const select = (next: string) => {
    setLeftPanel(next as LeftPanelId);
    trace.action('pages-layers:tab', { tab: next });
  };

  return (
    <div className="flex flex-col h-full overflow-hidden min-h-0">
      {/* `shrink-0` so the content below owns every remaining pixel — the
          switcher must never be squeezed by a long tree or asset list.
          `pt-[12px]` matches the rail's top padding so the switcher sits on
          the same line as the Vibe icon next to it. */}
      <div className="shrink-0 px-2 pt-[12px] pb-1">
        <ToolSegmentedControl value={tab} onChange={select} options={TABS} size="compact" />
      </div>

      {tab === 'layers' && (
        // A LayersPanel crash (e.g. the collection-list drag-out cycle stack
        // overflow, 2026-07-29) must never unmount the whole app — contain it
        // and re-arm when the selection changes.
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <PanelErrorBoundary name="layers-panel" resetKey={selectedId}>
            <LayersPanel />
          </PanelErrorBoundary>
        </div>
      )}

      {tab === 'pages-layers' && (
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide">
          <FileExplorer />
        </div>
      )}
    </div>
  );
}
