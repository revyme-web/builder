// LayersOnlyPanel.tsx — Standalone wrapper for the Layers tree.
//
// Companion to `PagesPanel`. Splitting the old combined Pages+Layers
// panel into two tabs gives the layers tree the full panel height and
// removes the resizable divider — each tab now does one thing.

import { useAtomValue } from 'jotai';
import LayersPanel from '@/editor/LayersPanel';
import PanelErrorBoundary from '@/editor/ui/PanelErrorBoundary';
import { selectedNodeAtom } from '@/code/stores/store';
import { trace } from '@/shared/debug-trace';

export default function LayersOnlyPanel() {
  trace.fn('LayersOnlyPanel.render');
  // A LayersPanel crash (e.g. the collection-list drag-out cycle stack
  // overflow, 2026-07-29) must never unmount the whole app — contain it and
  // re-arm when the selection changes (same pattern as PropertiesPanel).
  const selectedId = useAtomValue(selectedNodeAtom);
  return (
    <div className="flex flex-col h-full bg-[var(--bg-surface)] overflow-hidden min-h-0">
      <PanelErrorBoundary name="layers-panel" resetKey={selectedId}>
        <LayersPanel />
      </PanelErrorBoundary>
    </div>
  );
}
