// CommentsListPanel.tsx — Right-sidebar comment list.
//
// Mounted in `App.tsx` IN PLACE of `<PropertiesPanel />` while
// `commentModeActiveAtom` is true. Same 260-px width + bg-surface + left
// border so the layout doesn't shift when the user toggles comment mode.
//
// Lists EVERY comment in the project (across all files). A small filter
// dropdown next to the "Comments (N)" header lets the user scope the
// list: "All pages" (default — current file's comments sort first) or
// any specific file/component/icon-set that has at least one comment.
// Pixel-matched to `builder/.../rightToolbar/CommentsList.tsx` plus the
// extra filter chip the user requested.
//
// Clicking a row → `switchActiveFile` + `panToCanvasPoint` + `selectComment`.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  allCommentsAtom,
  commentOps,
  type Comment,
} from '@/code/stores/comment-store';
import {
  activeFilePathAtom,
  switchActiveFile,
  getFileDisplayName,
  isComponentFilePath,
} from '@/code/project/active-file-store';
import { selectedIdsAtom, updatingFromCanvasAtom } from '@/code/stores/store';
import { syncQueueCode, flushNow } from '@/code/mutation/mutation-queue';
import { panToCanvasPoint } from '@/canvas/transform';
import { ComponentClusterIcon } from '@/shared/icons';
import { trace } from '@/shared/debug-trace';
import { useCollaboratorColors, resolveCollaboratorAvatar } from '@/code/stores/collaborator-colors-store';
import { userAtom } from '@/backend/user-store';

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatTimestamp(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

interface LocationInfo {
  label: string;
  isComponent: boolean;
}

/** Resolve a `filePath` into a human-readable label + an "is this a
 *  component master file" flag (drives the accent-secondary badge color
 *  + the cluster icon). The home page (`getFileDisplayName === '/'`)
 *  reads as "Home" — a bare slash works for breadcrumb chrome but is
 *  awkward as a list-row badge / filter-dropdown entry. */
function getLocationLabel(filePath: string): LocationInfo {
  const isComponent = isComponentFilePath(filePath);
  let label = getFileDisplayName(filePath);
  if (label === '/') label = 'Home';
  else if (label.startsWith('/')) label = label.slice(1);
  return { label, isComponent };
}

// ─── Filter dropdown ───────────────────────────────────────────────────────
// Sentinel value for the "no filter — show everything" choice. Anything
// else is a literal `filePath` from the comments file (see the options
// list built below). Using a sentinel string instead of `null` keeps the
// type narrowed to `string` everywhere downstream.

const FILTER_ALL = '__all__';

interface FilterOption {
  value: string;            // FILTER_ALL or a filePath
  label: string;            // "All pages" or `getLocationLabel().label`
  isComponent?: boolean;    // tints the dropdown row + active chip
  count?: number;           // shown in the dropdown rows for context
}

interface FilterDropdownProps {
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
}

const FilterDropdown: React.FC<FilterDropdownProps> = ({ value, options, onChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click — same pattern the bottom-toolbar dropdowns
  // use. Plain mousedown listener so the close fires before any inner
  // onClick (which would re-open / no-op).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const current = options.find((o) => o.value === value) ?? options[0];

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1 h-6 px-2 rounded text-[10px] font-medium transition-colors cursor-pointer ${
          open
            ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
            : 'bg-[var(--grid-line)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
        }`}
        style={{ border: 'none', maxWidth: 130 }}
        title="Filter comments"
      >
        <span className="truncate">{current.label}</span>
        <svg width={9} height={9} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        // Dropdown panel — anchored to the chip, opens DOWN. Caps at
        // ~280 px so a project with dozens of pages still scrolls
        // gracefully instead of running off the bottom of the panel.
        <div
          className="absolute right-0 top-full mt-1 min-w-[180px] max-h-[280px] overflow-y-auto bg-[var(--dropdown-bg,var(--bg-surface))] border border-[var(--border-light)] rounded-md shadow-lg p-1"
          style={{ zIndex: 5500 }}
        >
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                key={opt.value}
                onClick={() => { onChange(opt.value); setOpen(false); }}
                className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-sm text-[11px] text-left transition-colors cursor-pointer ${
                  active
                    ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                    : 'bg-transparent text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                }`}
                style={{ border: 'none' }}
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  {opt.isComponent && (
                    <ComponentClusterIcon width={10} height={10} className="shrink-0 opacity-80" />
                  )}
                  <span className="truncate">{opt.label}</span>
                </span>
                {opt.count !== undefined && (
                  <span className={`text-[9px] shrink-0 ${active ? 'text-white/70' : 'text-[var(--text-tertiary)]'}`}>
                    {opt.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ─── Component ─────────────────────────────────────────────────────────────

export default function CommentsListPanel() {
  const comments = useAtomValue(allCommentsAtom);
  const activeFile = useAtomValue(activeFilePathAtom);
  // Per-website collaborator colors — the initial-avatar fallback tints
  // with the author's chosen color instead of a flat grey.
  const collaboratorColors = useCollaboratorColors();
  const currentUser = useAtomValue(userAtom);
  const setActiveFile = useSetAtom(activeFilePathAtom);
  const setSelectedIds = useSetAtom(selectedIdsAtom);
  const setUpdatingFromCanvas = useSetAtom(updatingFromCanvasAtom);

  // Filter state — local (no atom). Defaults to `FILTER_ALL` so the
  // user sees everything on first open; current-page sorting still
  // bubbles their active-file's comments to the top of that view.
  const [filter, setFilter] = useState<string>(FILTER_ALL);

  // Build the dropdown options + the displayed list in one pass — they
  // both depend on the same per-file grouping. Memoized on
  // `comments`/`activeFile` so we don't re-walk on every render.
  const { filterOptions, displayed } = useMemo(() => {
    // Group comments by `filePath` so each file becomes one dropdown
    // row with a count badge. Map preserves insertion order.
    const byPath = new Map<string, Comment[]>();
    for (const c of comments) {
      const list = byPath.get(c.filePath) ?? [];
      list.push(c);
      byPath.set(c.filePath, list);
    }

    // "All pages" sentinel + one row per file. Active file (if it has
    // any comments) is pinned right after "All pages" — easier to find
    // than scrolling alphabetically.
    const opts: FilterOption[] = [
      { value: FILTER_ALL, label: 'All pages', count: comments.length },
    ];
    if (byPath.has(activeFile)) {
      const loc = getLocationLabel(activeFile);
      opts.push({
        value: activeFile,
        label: `${loc.label} (current)`,
        isComponent: loc.isComponent,
        count: byPath.get(activeFile)!.length,
      });
    }
    // Other files, sorted by their display label so the dropdown list
    // is browseable (alphabetical roughly approximates "left-panel
    // sidebar order" for most projects).
    const otherEntries = [...byPath.entries()]
      .filter(([fp]) => fp !== activeFile)
      .map(([fp, list]) => {
        const loc = getLocationLabel(fp);
        return { fp, label: loc.label, isComponent: loc.isComponent, count: list.length };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
    for (const o of otherEntries) {
      opts.push({ value: o.fp, label: o.label, isComponent: o.isComponent, count: o.count });
    }

    // Apply the filter. `FILTER_ALL` keeps every comment but sorts the
    // active file's comments first so the user's current context is at
    // the top of the list (matches Figma's behavior). Sub-sort is
    // newest-first by latest message timestamp.
    let list: Comment[];
    if (filter === FILTER_ALL) {
      const score = (c: Comment) => {
        const ts = c.messages?.[c.messages.length - 1]?.createdAt ?? c.createdAt;
        // Active-file rank: 0 (top), others: 1 (below). Within each
        // bucket we sort by `ts` desc.
        return { rank: c.filePath === activeFile ? 0 : 1, ts };
      };
      list = [...comments].sort((a, b) => {
        const sa = score(a);
        const sb = score(b);
        if (sa.rank !== sb.rank) return sa.rank - sb.rank;
        return sb.ts - sa.ts;
      });
    } else {
      list = comments
        .filter((c) => c.filePath === filter)
        .sort((a, b) => {
          const ta = a.messages?.[a.messages.length - 1]?.createdAt ?? a.createdAt;
          const tb = b.messages?.[b.messages.length - 1]?.createdAt ?? b.createdAt;
          return tb - ta;
        });
    }

    return { filterOptions: opts, displayed: list };
  }, [comments, activeFile, filter]);

  const handleClick = useCallback((c: Comment) => {
    trace.action('comments-list:row-click', { id: c.id, filePath: c.filePath });
    if (activeFile !== c.filePath) {
      switchActiveFile(
        activeFile,
        c.filePath,
        { setActiveFile, setSelectedIds, setUpdatingFromCanvas },
        { syncQueueCode, flushNow },
      );
    }
    // Defer pan + select so the canvas remounts the new file before
    // the camera math runs (panning a stale file lands wrong).
    window.setTimeout(() => {
      panToCanvasPoint(c.x, c.y, 400);
      commentOps.selectComment(c.id);
    }, 100);
  }, [activeFile, setActiveFile, setSelectedIds, setUpdatingFromCanvas]);

  // ─── Empty state ──────────────────────────────────────────────────────
  // Project has zero comments → render the empty placeholder; no need
  // for the filter chip since there's nothing to filter.
  if (comments.length === 0) {
    return (
      <aside
        data-comment-panel
        className="w-[260px] shrink-0 bg-[var(--bg-surface)] border-l border-[var(--border-light)] flex flex-col relative z-5000"
        style={{ marginTop: 52, paddingLeft: '1.5px' }}
      >
        <div className="px-4 py-3 border-b border-[var(--border-light)]">
          <h3 className="text-xs font-semibold text-[var(--text-primary)]">Comments (0)</h3>
        </div>
        <div className="flex flex-col items-center justify-center flex-1 px-4 text-center">
          <span className="text-xs text-[var(--text-secondary)]">No comments yet</span>
          <span className="text-[10px] text-[var(--text-tertiary)] mt-1">
            Click anywhere on the canvas to add one
          </span>
        </div>
      </aside>
    );
  }

  return (
    <aside
      data-comment-panel
      className="w-[260px] shrink-0 bg-[var(--bg-surface)] border-l border-[var(--border-light)] flex flex-col relative z-5000"
      style={{ marginTop: 52, paddingLeft: '1.5px' }}
    >
      {/* Header — title + filter chip on the right. The chip wraps to a
          new line if needed (very narrow project names) but at 260 px
          it almost always sits inline. */}
      <div className="px-4 py-3 border-b border-[var(--border-light)] flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-[var(--text-primary)] shrink-0">
          Comments ({displayed.length})
        </h3>
        <FilterDropdown value={filter} options={filterOptions} onChange={setFilter} />
      </div>

      {/* Empty filter result (e.g. user picked a file then the comment
          there got deleted). Renders before the rows so the list area
          isn't a confused blank. */}
      {displayed.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center px-4 text-center">
          <span className="text-xs text-[var(--text-secondary)]">No comments here</span>
          <button
            onClick={() => setFilter(FILTER_ALL)}
            className="text-[10px] mt-2 text-[var(--accent-text)] hover:underline cursor-pointer bg-transparent"
            style={{ border: 'none' }}
          >
            Show all pages
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto scrollbar-hide">
          {displayed.map((c, idx) => {
            const messageCount = c.messages?.length ?? 0;
            const lastMessageAt = c.messages?.[c.messages.length - 1]?.createdAt ?? c.createdAt;
            const loc = getLocationLabel(c.filePath);
            // Resolve the avatar from live data so a profile picture
            // added later retroactively shows on old comments.
            const avatarUrl = c.authorId
              ? resolveCollaboratorAvatar(collaboratorColors, c.authorId, c.authorAvatar, currentUser)
              : c.authorAvatar ?? null;
            return (
              <React.Fragment key={c.id}>
                <button
                  onClick={() => handleClick(c)}
                  className="w-full px-4 py-3 text-left bg-transparent hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                  style={{ border: 'none' }}
                >
                  {/* Author + timestamp */}
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden"
                        style={{
                          backgroundColor: avatarUrl
                            ? 'transparent'
                            : (c.authorId ? collaboratorColors.get(c.authorId)?.color : undefined)
                              ?? 'var(--grid-line)',
                        }}
                      >
                        {avatarUrl ? (
                          <img src={avatarUrl} alt={c.authorName ?? ''} className="w-full h-full object-cover" />
                        ) : (
                          <span className="text-[9px] font-semibold text-white">
                            {(c.authorName ?? '?').charAt(0).toUpperCase()}
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] font-semibold text-[var(--text-primary)] font-sans">
                        {c.authorName ?? 'Unknown'}
                      </span>
                    </div>
                    <span className="text-[9px] text-[var(--text-tertiary)] opacity-60 font-sans">
                      {formatTimestamp(lastMessageAt)}
                    </span>
                  </div>

                  {/* Location badge */}
                  <div className="flex items-start gap-2 mb-1">
                    <span
                      className={`text-[9px] px-1.5 py-0.5 rounded font-sans flex-shrink-0 flex items-center gap-1 ${
                        loc.isComponent
                          ? 'bg-[var(--accent-secondary)] text-[var(--accent-secondary-fg)]'
                          : 'bg-[var(--grid-line)] text-[var(--text-secondary)]'
                      }`}
                    >
                      {loc.isComponent && <ComponentClusterIcon width={10} height={10} />}
                      {loc.label}
                    </span>
                  </div>

                  {/* Comment text preview */}
                  <div className="text-[10px] text-[var(--text-tertiary)] opacity-70 font-sans line-clamp-2">
                    {c.text || 'Empty comment'}
                  </div>

                  {messageCount > 1 && (
                    <div className="text-[9px] text-[var(--text-tertiary)] opacity-60 font-sans mt-1">
                      {messageCount - 1} {messageCount - 1 === 1 ? 'reply' : 'replies'}
                    </div>
                  )}
                </button>
                {idx < displayed.length - 1 && (
                  <div className="border-t border-[var(--border-light)]" />
                )}
              </React.Fragment>
            );
          })}
        </div>
      )}
    </aside>
  );
}
