// ReplaceWithMenu.tsx — the "Replace with" flyout in the canvas context menu.
// Shown ONLY when the selected node is a design- or code-component instance
// (they're interchangeable). Lists every project component (design + code) with
// a live search box, and on click swaps the instance for the chosen component —
// keeping the instance's data-id + width/height, adding the new import and
// pruning the old one if it's now unused (handled by the mutation's syncImports).

import { useState, useMemo, useRef } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { hasComponentControls } from '@/code/components/controls-parser';
import { getFileDisplayName } from '@/code/project/active-file-store';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { selectedIdsAtom } from '@/code/stores/store';
import { forceCanvasRender } from '@/canvas/node-ops';
import { trace } from '@/shared/debug-trace';

// Same glyphs as the Library panel: purple diamond cluster = design component,
// </> chevrons = code component. Inherit currentColor so hover flips to white.
const DiamondIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M12.53 2.47a.75.75 0 0 0-1.06 0L8.32 5.62a.75.75 0 0 0 0 1.06l3.15 3.15a.75.75 0 0 0 1.06 0l3.15-3.15a.75.75 0 0 0 0-1.06zm5.85 6.3a.75.75 0 0 0-1.06 0l-3.15 3.15a.75.75 0 0 0 0 1.06l3.15 3.15a.75.75 0 0 0 1.06 0l3.15-3.15a.75.75 0 0 0 0-1.06zm-5.85 5.4a.75.75 0 0 0-1.06 0l-3.15 3.15a.75.75 0 0 0 0 1.06l3.15 3.15a.75.75 0 0 0 1.06 0l3.15-3.15a.75.75 0 0 0 0-1.06zM6.68 8.32a.75.75 0 0 0-1.06 0l-3.15 3.15a.75.75 0 0 0 0 1.06l3.15 3.15a.75.75 0 0 0 1.06 0l3.15-3.15a.75.75 0 0 0 0-1.06z" /></svg>
);
const CodeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24"><g fill="none"><path d="M0 0h24v24H0z" /><path fill="currentColor" d="M14.62 2.662a1.5 1.5 0 0 1 1.04 1.85l-4.431 15.787a1.5 1.5 0 0 1-2.889-.81L12.771 3.7a1.5 1.5 0 0 1 1.85-1.039ZM7.56 6.697a1.5 1.5 0 0 1 0 2.12L4.38 12l3.182 3.182a1.5 1.5 0 1 1-2.122 2.121L1.197 13.06a1.5 1.5 0 0 1 0-2.12l4.242-4.243a1.5 1.5 0 0 1 2.122 0Zm8.88 2.12a1.5 1.5 0 1 1 2.12-2.12l4.243 4.242a1.5 1.5 0 0 1 0 2.121l-4.242 4.243a1.5 1.5 0 1 1-2.122-2.121L19.621 12z" /></g></svg>
);

interface Entry { filePath: string; tag: string; label: string; isCode: boolean; }

export default function ReplaceWithMenu({ nodeId, currentFile, width, height, onDone }: {
  nodeId: string;
  /** The instance's current `componentFile` — excluded from the list (can't replace with itself). */
  currentFile: string | null;
  width?: string;
  height?: string;
  /** Close the whole context menu. */
  onDone: () => void;
}) {
  const version = useAtomValue(projectVersionAtom);
  const setSelectedIds = useSetAtom(selectedIdsAtom);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const entries = useMemo<Entry[]>(() => {
    const files = projectFS.listFiles('components/').filter(f => f.endsWith('.tsx'));
    const list: Entry[] = [];
    for (const filePath of files) {
      if (currentFile && filePath === currentFile) continue;
      const code = projectFS.readFile(filePath);
      if (!code) continue;
      const isCode = hasComponentControls(code);
      // Tag = file basename. syncImports resolves `<Basename>` → `components/
      // Basename.tsx` and emits `import Basename from '@/components/Basename'`
      // (a default import works under any name), so the tag MUST be the basename.
      const tag = filePath.replace('components/', '').replace(/\.tsx$/, '');
      list.push({ filePath, tag, label: getFileDisplayName(filePath), isCode });
    }
    // Design components first (alpha), then code components (alpha) — mirrors the
    // Library panel grouping.
    list.sort((a, b) => (a.isCode === b.isCode ? a.label.localeCompare(b.label) : a.isCode ? 1 : -1));
    return list;
    // version re-derives the list when components are added/renamed/edited.
  }, [version, currentFile]);

  const q = query.trim().toLowerCase();
  const filtered = q ? entries.filter(e => e.label.toLowerCase().includes(q)) : entries;

  const handleReplace = (e: Entry) => {
    trace.action('context-menu:replace-component', { nodeId, from: currentFile, to: e.filePath });
    queueMutation({ type: 'replaceComponentInstance', nodeId, newTag: e.tag, newDisplayName: e.label, width, height });
    flushNow();
    forceCanvasRender();
    setSelectedIds([nodeId]);
    onDone();
  };

  return (
    <div
      className="relative"
      onMouseEnter={() => { setOpen(true); requestAnimationFrame(() => inputRef.current?.focus()); }}
      onMouseLeave={() => setOpen(false)}
    >
      <button className="group flex items-center gap-3 mx-1.5 px-2 h-8 w-[calc(100%-12px)] rounded-[var(--radius-sm)] text-left text-[13px] text-[var(--text-primary)] hover:bg-[var(--accent)] hover:text-[var(--accent-fg)] transition-colors">
        <span className="flex-1">Replace with</span>
        <span className="text-[var(--text-tertiary)] group-hover:text-[var(--accent-fg)]">▸</span>
      </button>
      {open && (
        <>
          {/* Hover bridge so crossing the 2px gap doesn't close the flyout. */}
          <div className="absolute left-full top-0 w-1 h-full" aria-hidden="true" />
          <div className="absolute left-full top-0 ml-0.5 bg-[var(--dropdown-bg)] shadow-[var(--shadow-lg)] rounded-[var(--radius-md)] py-2 w-[244px] border border-[var(--border-light)]">
            {/* Search — same look as the left-header search. */}
            <div className="px-2 pb-1.5">
              <div className="flex items-center gap-2 px-2 h-7 rounded-[var(--radius-sm)] bg-[var(--control-bg)] border border-[var(--control-border)]">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-[var(--text-tertiary)] shrink-0"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onMouseDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onDone(); }}
                  placeholder="Search components…"
                  className="flex-1 bg-transparent text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
                />
              </div>
            </div>
            <div className="max-h-[300px] overflow-y-auto scrollbar-hide">
              {filtered.length === 0 && (
                <div className="px-3 py-2 text-[13px] text-[var(--text-tertiary)]">No components</div>
              )}
              {filtered.map(e => (
                <button
                  key={e.filePath}
                  onClick={() => handleReplace(e)}
                  onMouseDown={(ev) => ev.stopPropagation()}
                  className="group flex items-center gap-2 mx-1.5 px-2 h-8 w-[calc(100%-12px)] rounded-[var(--radius-sm)] text-left text-[13px] text-[var(--text-primary)] hover:bg-[var(--accent)] hover:text-[var(--accent-fg)] transition-colors"
                >
                  <span className="shrink-0 text-[var(--accent-secondary)] group-hover:text-[var(--accent-fg)]">
                    {e.isCode ? <CodeIcon /> : <DiamondIcon />}
                  </span>
                  <span className="flex-1 truncate">{e.label}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
