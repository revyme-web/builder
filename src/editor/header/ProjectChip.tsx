// ProjectChip.tsx — Plain-text project name + active-page breadcrumb
// in the top-left header.
//
// Renders as `ProjectName / pagename` — project name bold-white with
// accent-hover affordance (click opens the rename modal), slash in
// disabled tone, page label in secondary. Only the leaf segment of
// the page path is shown; the full path lives in the title tooltip.
//
// Rename modal is `NameInputModal` — same shell components / icons /
// modal flows use, so the chrome reads as the rest of the app.
//
// IMPORTANT: project name ≠ `metadata.title`. SEO title lives in
// app/layout.tsx → Settings overlay. Project name is the user-facing
// identifier (chip, browser tab, dashboard tile) and lives in
// `projectNameAtom`. See `src/code/stores/project-store.ts`.

import { useState } from 'react';
import { useAtomValue } from 'jotai';
import { projectNameAtom, setProjectName } from '@/code/stores/project-store';
import { activeFilePathAtom, getFileDisplayName } from '@/code/project/active-file-store';
import NameInputModal from '@/editor/ui/NameInputModal';
import { trace } from '@/shared/debug-trace';
import { useIsViewer } from '@/code/stores/viewer-mode-store';
import { backend } from '@/backend';
import { getProjectId } from '@/backend/project-id';

export default function ProjectChip() {
  const name = useAtomValue(projectNameAtom);
  const activeFilePath = useAtomValue(activeFilePathAtom);
  const [renameOpen, setRenameOpen] = useState(false);
  // Viewers can't rename — render the project name as a plain,
  // non-interactive span instead of the rename-trigger button.
  const isViewer = useIsViewer();

  const displayName = name || 'Untitled';

  // `getFileDisplayName` returns the full slug path for nested
  // pages — e.g. `app/blog/post-1/page.tsx` → `/blog/post-1`. In
  // this header slot we only have room for the leaf, so we show the
  // last segment without a leading slash (the divider `/` between
  // project and page already serves as the path delimiter). The
  // full slug stays in the title tooltip for context.
  const rawLabel = activeFilePath ? getFileDisplayName(activeFilePath) : '';
  let pageLabel = '';
  if (rawLabel === '/') {
    pageLabel = 'Home';
  } else if (rawLabel.startsWith('/')) {
    const segments = rawLabel.split('/').filter(Boolean);
    pageLabel = segments.length > 0 ? segments[segments.length - 1] : rawLabel;
  } else {
    pageLabel = rawLabel;
  }

  // Tooltip shows the FULL slug so the user can still identify which
  // nested page they're on when the chip label has been truncated.
  const fullTitle = rawLabel && rawLabel !== pageLabel
    ? `${displayName} / ${rawLabel}`
    : pageLabel ? `${displayName} / ${pageLabel}` : displayName;

  trace.fn('ProjectChip.render', { name: displayName, pageLabel, renameOpen });

  // Layout: project name is `shrink-0` so it never collapses — it's
  // the more important identifier, the user always wants to see it
  // whole. The page label gets `flex-1 min-w-0 truncate`, so when
  // the slot is tight IT shrinks (with ellipsis), not the project
  // name. The "/" separator stays visible (`shrink-0`).
  //
  // The project-name span is a button with accent hover + cursor
  // pointer — clicking opens the rename modal. The page label stays
  // a plain span (read-only context, not a trigger).
  return (
    <>
      <div
        // `w-full` is load-bearing: `max-w-[50%]` on the project
        // button resolves against THIS div's content width. Without
        // a stretched width, the div sizes to its children's natural
        // content and `50%` ends up being "half of the short combined
        // text" — which truncates the project name even when the
        // slot has plenty of room. Stretching to fill the parent slot
        // makes the cap resolve against the real 256-px column.
        className="flex items-center gap-1.5 min-w-0 w-full leading-none overflow-hidden"
        title={fullTitle}
      >
        {isViewer ? (
          // View-only: same text styling as the rename button minus
          // the cursor/hover affordance — it's not a trigger.
          <span className="max-w-[50%] truncate shrink-0 text-xs font-bold text-[var(--text-primary)]">
            {displayName}
          </span>
        ) : (
        <button
          type="button"
          onClick={() => {
            trace.action('project-chip:open-rename');
            setRenameOpen(true);
          }}
          tabIndex={-1}
          // Project sizing rule the user wants:
          //   - Project content shorter than 50% → button is
          //     content-sized (no waste, no truncation).
          //   - Project content longer than 50%  → button caps at
          //     50% and truncates to ellipsis.
          //   - The page takes whatever space is left (content-
          //     width when short, truncates with ellipsis when it
          //     would otherwise extend past the slot).
          //
          // `max-w-[50%]` is a CAP, not a forced size — items with
          // `flex-basis: auto` and shorter content sit at content
          // width naturally; the cap only kicks in when content
          // would exceed 50%. `shrink-0` keeps the project anchored
          // at its (capped) width so a long page can't push it
          // past 50%. `truncate` ellipses the over-50% case.
          //
          // Hover: text turns accent (no background fill).
          className="max-w-[50%] truncate shrink-0 text-xs font-bold text-[var(--text-primary)] cursor-pointer bg-transparent border-none p-0 transition-colors hover:text-[var(--accent-text)]"
        >
          {displayName}
        </button>
        )}
        {pageLabel && (
          <>
            <span className="text-xs text-[var(--text-disabled)] shrink-0">/</span>
            {/* Page sizing: natural content width, default shrink-1.
                Project's high shrink factor means page shrinks last
                — it stays at content width as long as project still
                has room to give. When project hits its 50%-or-content
                floor, page starts absorbing the remaining overflow
                and truncates. */}
            <span className="text-xs text-[var(--text-secondary)] truncate min-w-0">
              {pageLabel}
            </span>
          </>
        )}
      </div>

      <NameInputModal
        isOpen={renameOpen}
        onClose={() => setRenameOpen(false)}
        onSubmit={(newName) => {
          trace.action('project-chip:rename-submit', { name: newName });
          setProjectName(newName);
          // Persist to the canonical `websites.name` so the dashboard tile
          // stays in sync. Skip empty (backend requires a non-empty name);
          // fire-and-forget — the local atom/localStorage already updated.
          const trimmed = newName.trim();
          if (trimmed) {
            void backend.renameWebsite(getProjectId(), trimmed).catch((err) =>
              trace.error('project-chip:rename-persist-failed', { error: String(err) }),
            );
          }
        }}
        title="Rename Project"
        placeholder="Project name"
        defaultValue={name}
        submitLabel="Save"
      />
    </>
  );
}
