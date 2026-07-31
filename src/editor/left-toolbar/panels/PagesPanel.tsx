// PagesPanel.tsx — Standalone wrapper for the Pages (file explorer) view.
//
// Split from the old `PagesLayersPanel` once Pages and Layers became
// separate left-toolbar tabs. The Layers tree moved to its own panel
// (`LayersOnlyPanel`) so each tab focuses on one concept and a long
// page list no longer fights a deep layers tree for vertical space.

import FileExplorer from '@/editor/FileExplorer';
import { trace } from '@/shared/debug-trace';

export default function PagesPanel() {
  trace.fn('PagesPanel.render');
  return (
    <div className="flex flex-col h-full bg-[var(--bg-surface)] overflow-y-auto scrollbar-hide">
      <FileExplorer />
    </div>
  );
}
