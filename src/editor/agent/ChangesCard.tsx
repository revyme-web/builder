// agent/ChangesCard.tsx — what the turn changed, how to reach it, how to undo it.
//
// The old card listed raw file paths ("app/page.client.tsx"), which names the
// document format rather than the user's website. This names the SURFACE the
// person recognises — Home, Header — and how much of it moved, which is the
// only summary they can check against the canvas.
//
// Every row is a LINK. "3 Layers" tells you something changed; it does not tell
// you whether you like it. Clicking opens that surface and selects what the
// agent touched, so reviewing the turn is one click per row instead of hunting
// the canvas for a diff you cannot see.

import { useCallback, useState } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import {
  getFriendlyFileName, switchActiveFile, activeFilePathAtom,
  getPageClientPath, isPageServerFile,
} from '@/code/project/active-file-store';
import { selectedIdsAtom, updatingFromCanvasAtom } from '@/code/stores/store';
import { syncQueueCode, flushNow } from '@/code/mutation/mutation-queue';
import { undo, redo, getHistoryState } from '@/code/mutation/history';
import { getContentRoot } from '@/canvas/node-ops';
import { zoomToFitSelection } from '@/canvas/transform';
import { trace } from '@/shared/debug-trace';

export interface ChangedFile {
  path: string;
  addedIds?: string[];
  removedIds?: string[];
  changedIds?: string[];
}

/**
 * 250ms, matching the floor `switchActiveFile` documents for its own late
 * bump. Shorter was measured to land before the new surface has parsed, and a
 * camera move against a stale file aims at the wrong place.
 */
const SWITCH_SETTLE_MS = 250;

function PageIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function ComponentIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l4 4-4 4-4-4zM12 14l4 4-4 4-4-4zM2 12l4-4 4 4-4 4zM14 12l4-4 4 4-4 4z" />
    </svg>
  );
}

/** How many layers this file gained, lost or had rewritten. */
export function layerCount(f: ChangedFile): number {
  return (f.addedIds?.length ?? 0) + (f.removedIds?.length ?? 0) + (f.changedIds?.length ?? 0);
}

/**
 * The node a row reveals.
 *
 * Prefer something ADDED — that is the new thing the user wants to look at —
 * then something changed. A REMOVED id is deliberately never returned: it no
 * longer exists, so selecting it would silently do nothing and the row would
 * feel broken.
 */
export function revealTarget(f: ChangedFile): string | null {
  return f.addedIds?.[0] ?? f.changedIds?.[0] ?? null;
}

/** Pages are a PAIR; only the client half is a surface you can open. */
function openablePath(path: string): string {
  return isPageServerFile(path) ? getPageClientPath(path) : path;
}

export default function ChangesCard({ files, canRevert }: { files: ChangedFile[]; canRevert?: boolean }) {
  const [activeFile, setActiveFile] = useAtom(activeFilePathAtom);
  const setSelectedIds = useSetAtom(selectedIdsAtom);
  const setUpdatingFromCanvas = useSetAtom(updatingFromCanvasAtom);
  const [hovered, setHovered] = useState<string | null>(null);
  // Read once per render rather than subscribing: history is a module, not an
  // atom, and the card only needs to know whether the arrows are live at the
  // moment it draws.
  const history = getHistoryState();

  const reveal = useCallback((f: ChangedFile) => {
    const path = openablePath(f.path);
    const nodeId = revealTarget(f);
    trace.action('agent-changes:reveal', { path, nodeId });

    const focus = () => {
      if (!nodeId) return;
      setSelectedIds([nodeId]);
      const root = getContentRoot();
      // `true` = no tween. The user clicked to look at something; animating
      // across the canvas delays the answer without adding information.
      if (root) zoomToFitSelection(root, [nodeId], true);
    };

    if (activeFile === path) { focus(); return; }

    switchActiveFile(
      activeFile, path,
      { setActiveFile, setSelectedIds, setUpdatingFromCanvas },
      { syncQueueCode, flushNow },
    );
    // Select optimistically AND again after the switch settles. The early call
    // survives the remount and keeps the overlay from flashing empty; the late
    // one is what actually sticks, because `switchActiveFile` clears the
    // selection as part of its own sequence.
    if (nodeId) setSelectedIds([nodeId]);
    window.setTimeout(focus, SWITCH_SETTLE_MS);
  }, [activeFile, setActiveFile, setSelectedIds, setUpdatingFromCanvas]);

  // A file whose parse failed on either side reports zero ids (see file-diff).
  // It still CHANGED, so it stays listed — but with no count, rather than a
  // confident "0 Layers" that reads as "nothing happened".
  if (files.length === 0) return null;

  return (
    <div className="cut-corners cut-border [--cut-border-color:var(--border-default)] border border-[var(--border-default)]">
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="text-[12px] font-semibold text-[var(--text-primary)]">Changes</span>
        {/* Undo/redo appear only on the newest turn. History is a stack, so
            these buttons on an older card would revert the most RECENT turn
            while appearing to revert the one they sit under. */}
        {canRevert && (
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              disabled={!history.canUndo}
              onClick={() => { const ok = undo(); trace.action('agent-changes:undo', { ok }); }}
              className="cut-corners px-2 py-0.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent"
            >
              Undo
            </button>
            <button
              type="button"
              disabled={!history.canRedo}
              onClick={() => { const ok = redo(); trace.action('agent-changes:redo', { ok }); }}
              className="cut-corners px-2 py-0.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent"
            >
              Redo
            </button>
          </div>
        )}
      </div>
      <div className="flex flex-col">
        {files.map((f) => {
          const n = layerCount(f);
          const isComponent = f.path.startsWith('components/');
          const canReveal = revealTarget(f) !== null;
          const showView = canReveal && hovered === f.path;
          return (
            <button
              key={f.path}
              type="button"
              disabled={!canReveal}
              onClick={() => reveal(f)}
              onMouseEnter={() => setHovered(f.path)}
              onMouseLeave={() => setHovered((h) => (h === f.path ? null : h))}
              className="flex w-full items-center gap-1.5 px-2 py-1 text-left transition-colors enabled:hover:bg-[var(--bg-hover)] disabled:cursor-default"
            >
              <span className="shrink-0 text-[var(--text-tertiary)]">
                {isComponent ? <ComponentIcon /> : <PageIcon />}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-primary)]">
                {getFriendlyFileName(f.path)}
              </span>
              {/* The count answers "how much"; on hover the row answers "and
                  you can go look". Same slot, so nothing reflows. */}
              {showView ? (
                <span className="shrink-0 text-[11px] text-[var(--text-secondary)]">View</span>
              ) : n > 0 ? (
                <span className="shrink-0 text-[11px] text-[var(--text-tertiary)]">
                  {n} {n === 1 ? 'Layer' : 'Layers'}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
