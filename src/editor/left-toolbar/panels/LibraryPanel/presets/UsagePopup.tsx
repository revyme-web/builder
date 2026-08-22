// UsagePopup — floating list of all consumers (file + node) of a preset
// token, anchored to the row's "× usages" badge. UsageBadge is the
// click-to-open badge that owns the popup state.

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAtomValue, useSetAtom } from 'jotai';
import { activeFilePathAtom, componentBreadcrumbAtom, switchActiveFile, isMasterFilePath } from '@/code/project/active-file-store';
import { selectedIdsAtom, updatingFromCanvasAtom } from '@/code/stores/store';
import { type PresetUsage } from '@/code/stores/preset-store';
import { collapseLibraryBreadcrumb } from '@/canvas/component-navigation';
import { zoomToFitNodes } from '@/canvas/transform';
import { getContentRoot } from '@/canvas/node-ops';
import { flushNow, syncQueueCode } from '@/code/mutation/mutation-queue';
import { trace } from '@/shared/debug-trace';

// ─── Usage Popup ────────────────────────────────────────────────────────────
//
// Shown when the user clicks the count badge on a preset row. Lists every
// node in the project that references the preset via `var(--name)`. Clicking
// an entry switches the active file (if needed), selects the node, and
// zoom-to-fit's it. Mirrors the builder's `UsagePopup` UX — a fast way to
// audit "where is this token used?" and jump to fix or inspect each call site.

interface UsagePopupProps {
  usages: PresetUsage[];
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

export function UsagePopup({ usages, triggerRef, onClose }: UsagePopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const [position] = useState(() => {
    if (!triggerRef.current) return { top: 0, left: 0 };
    const rect = triggerRef.current.getBoundingClientRect();
    return { top: rect.top, left: rect.right + 8 };
  });

  const activeFilePath = useAtomValue(activeFilePathAtom);
  const setActiveFilePath = useSetAtom(activeFilePathAtom);
  const setSelectedIds = useSetAtom(selectedIdsAtom);
  const setUpdatingFromCanvas = useSetAtom(updatingFromCanvasAtom);
  const breadcrumb = useAtomValue(componentBreadcrumbAtom);
  const setBreadcrumb = useSetAtom(componentBreadcrumbAtom);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (popupRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose, triggerRef]);

  const handleViewNode = useCallback((usage: PresetUsage) => {
    trace.action('preset-usage:view-node', { filePath: usage.filePath, nodeId: usage.nodeId });
    if (usage.filePath !== activeFilePath) {
      // Keep the master breadcrumb correct. Jumping into a master from
      // the presets panel is a flat jump (like a Library click): its
      // page crumb is the page the user was on — or, if they were
      // already inside a master, that master's existing page crumb.
      // Without this the breadcrumb stays empty and "back to page"
      // lands on a blank editor. Navigating to a plain page clears it.
      setBreadcrumb(
        isMasterFilePath(usage.filePath)
          ? collapseLibraryBreadcrumb(breadcrumb, activeFilePath)
          : [],
      );
      switchActiveFile(activeFilePath, usage.filePath, {
        setActiveFile: setActiveFilePath,
        setSelectedIds,
        setUpdatingFromCanvas,
      }, { syncQueueCode, flushNow });
    }
    // Defer selection + zoom so the renderer can paint the new file's nodes
    // first — without the delay the bridge cache has no rect for the node yet
    // and the camera doesn't move.
    setTimeout(() => {
      setSelectedIds([usage.nodeId]);
      setTimeout(() => {
        const contentEl = getContentRoot();
        if (contentEl) zoomToFitNodes(contentEl, [usage.nodeId]);
      }, 80);
    }, usage.filePath !== activeFilePath ? 200 : 30);
    onClose();
  }, [activeFilePath, setActiveFilePath, setSelectedIds, setUpdatingFromCanvas, breadcrumb, setBreadcrumb, onClose]);

  const seen = new Set<string>();
  const list = usages.filter(u => {
    const key = `${u.filePath}::${u.nodeId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return createPortal(
    <div
      ref={popupRef}
      className="fixed z-[9999] min-w-[200px] max-w-[280px] bg-[var(--dropdown-bg,var(--bg-surface))] border border-[var(--border-light)] cut-corners cut-lg cut-border [--cut-border-color:var(--border-light)] shadow-[var(--shadow-lg)] p-1"
      style={{ top: position.top, left: position.left }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="max-h-[260px] overflow-y-auto scrollbar-hide">
        {list.length === 0 ? (
          <div className="px-3 py-2 text-[10px] text-[var(--text-disabled)]">No usages</div>
        ) : (
          list.map(u => (
            <div
              key={`${u.filePath}::${u.nodeId}`}
              onClick={() => handleViewNode(u)}
              className="group flex items-center gap-2 px-2 py-1.5 cut-corners cursor-pointer hover:bg-[var(--bg-hover)] transition-colors"
            >
              <div className="flex-1 min-w-0">
                <span className="block text-xs font-medium text-[var(--text-primary)] truncate">{u.nodeName}</span>
                <span className="block text-[10px] text-[var(--text-disabled)] truncate">{u.fileLabel}</span>
              </div>
              <span className="opacity-0 group-hover:opacity-100 px-1.5 py-0.5 rounded text-[10px] font-medium bg-white/10 text-[var(--text-secondary)] transition-opacity">View</span>
            </div>
          ))
        )}
      </div>
    </div>,
    document.body,
  );
}

/** ONE usage popup at a time: opening a badge closes whichever other
 *  badge's popup is showing (they used to CUMULATE — each badge owns
 *  local `open` state and the click's stopPropagation kept sibling
 *  popups' outside-close from firing). Module-level latch: the opening
 *  badge closes the previous one and registers its own closer. */
let _closeOpenUsagePopup: (() => void) | null = null;

/** Small clickable badge showing a usage count. Opens UsagePopup on click. */
export function UsageBadge({ count, usages }: { count: number; usages: PresetUsage[] }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => () => { if (_closeOpenUsagePopup === closeRef.current) _closeOpenUsagePopup = null; }, []);
  const closeRef = useRef<() => void>(() => {});
  closeRef.current = () => setOpen(false);
  if (count <= 0) return null;
  return (
    <>
      <button
        ref={triggerRef}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => {
            const next = !v;
            if (next) {
              if (_closeOpenUsagePopup && _closeOpenUsagePopup !== closeRef.current) _closeOpenUsagePopup();
              _closeOpenUsagePopup = closeRef.current;
            } else if (_closeOpenUsagePopup === closeRef.current) {
              _closeOpenUsagePopup = null;
            }
            return next;
          });
        }}
        className="w-4 h-4 flex items-center justify-center text-[9px] font-medium bg-[var(--bg-canvas,var(--grid-line))] text-[var(--text-secondary)] rounded cursor-pointer hover:bg-[var(--accent)]/30 hover:text-[var(--text-primary)] transition-colors"
        title={`Used by ${count} node${count === 1 ? '' : 's'} — click to view`}
      >
        {count}
      </button>
      {open && <UsagePopup usages={usages} triggerRef={triggerRef} onClose={() => setOpen(false)} />}
    </>
  );
}
