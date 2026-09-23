// agent/ChangesCard.tsx — what the turn changed, how to reach it, how to undo it.
//
// The old card listed raw file paths ("app/page.client.tsx"), which names the
// document format rather than the user's website. This names the SURFACE the
// person recognises — Home, Header, the Blog collection, the Colors — and how
// much of it moved, IN ITS OWN UNIT: layers for a page, styles for the design
// tokens, items and fields for a collection. "How much" in a unit the user can
// check is the only summary worth printing.
//
// Every row is a LINK, and each kind of thing opens where that kind of thing
// lives: a page on the canvas with the touched layer selected, a component
// INSIDE the component, a code component in its editor, styles in the Styles
// panel, a collection in the CMS. "3 Layers" tells you something changed; it
// does not tell you whether you like it.

import { useCallback, useMemo, useRef, useState } from 'react';
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
import { openCmsEditorAtom } from '@/code/stores/cms-editor-store';
import { componentEditorFileAtom } from '@/code/stores/component-editor-store';
import { leftPanelAtom } from '@/code/stores/left-panel-store';
import { getCollectionSchema } from '@/code/project/cms-ops';
import { projectFS } from '@/code/project/project-fs';
import { isCodeComponentSource } from '@/code/oracle/checks/shared';
import { TOKENS_PATH, type ChangePart } from '@/code/project/change-parts';
import DropdownMenu from '@/design-system/DropdownMenu';
import { trace } from '@/shared/debug-trace';

export interface ChangedFile {
  path: string;
  addedIds?: string[];
  removedIds?: string[];
  changedIds?: string[];
  parts?: ChangePart[];
}

/**
 * 250ms, matching the floor `switchActiveFile` documents for its own late
 * bump. Shorter was measured to land before the new surface has parsed, and a
 * camera move against a stale file aims at the wrong place.
 */
const SWITCH_SETTLE_MS = 250;

// ─── Icons ───────────────────────────────────────────────────────────────────

const ICON = { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

function PageIcon() {
  return <svg {...ICON}><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;
}
function ComponentIcon() {
  return <svg {...ICON}><path d="M12 2l4 4-4 4-4-4zM12 14l4 4-4 4-4-4zM2 12l4-4 4 4-4 4zM14 12l4-4 4 4-4 4z" /></svg>;
}
function CodeIcon() {
  return <svg {...ICON}><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>;
}
function StyleIcon() {
  return <svg {...ICON}><path d="M12 2.7l5.7 5.6a8 8 0 1 1-11.4 0z" /></svg>;
}
function CollectionIcon() {
  return (
    <svg {...ICON}>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
      <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
    </svg>
  );
}
function GlobeIcon() {
  return <svg {...ICON}><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" /></svg>;
}
function FileIcon() {
  return <svg {...ICON}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>;
}

// ─── What a turn's changes become ────────────────────────────────────────────

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

/** One row of the card: a thing the user recognises, in the unit it is made of. */
export type CardRow =
  | { kind: 'page' | 'component' | 'file'; key: string; file: ChangedFile }
  | { kind: 'code-component'; key: string; path: string }
  | { kind: 'styles'; key: string; group: string; count: number; names: string[] }
  | { kind: 'collection'; key: string; slug: string; items: number; fields: number }
  | { kind: 'translations'; key: string; locale: string; count: number };

/** Editor bookkeeping — where each page's camera sits, the chat transcripts,
 *  folder layouts. It changes on nearly every run, it is not the website, and
 *  listing it ("_meta/page-camera.json") told the user nothing they could look
 *  at or care about. Still part of the turn's snapshot, so undo restores it;
 *  it is only not ANNOUNCED. */
function isEditorBookkeeping(path: string): boolean {
  return path.startsWith('_meta/') || path.startsWith('_revyme/');
}

const COLLECTION_FILE = /^cms\/([^/]+?)(?:\.schema)?\.json$/;
const MESSAGES_FILE = /^messages\/([^/]+)\.json$/;

const sum = (parts: ChangePart[] | undefined, unit: ChangePart['unit']) =>
  (parts ?? []).filter((p) => p.unit === unit).reduce((n, p) => n + p.count, 0);

/**
 * The rows a turn's changes become.
 *
 *  • editor bookkeeping is dropped;
 *  • a CMS collection is ONE row, counting its items and its fields — it is two
 *    files on disk, and a run that builds one touches both;
 *  • the design tokens are a row PER KIND of style that changed (Colors,
 *    Typography…), not one row called "globals.css";
 *  • a code component is its own kind: it has no layers to count, and it opens
 *    in its editor rather than on the canvas.
 *
 * `isCodeComponent` is injected because only the file's SOURCE says which kind
 * of component it is, and this function stays pure. Order of first appearance
 * is kept. May be empty: a run that only moved the camera has no card.
 */
export function rowsForCard(
  files: readonly ChangedFile[],
  opts: { isCodeComponent?: (path: string) => boolean } = {},
): CardRow[] {
  const rows: CardRow[] = [];
  const collections = new Map<string, Extract<CardRow, { kind: 'collection' }>>();
  const pages = new Map<string, Extract<CardRow, { kind: 'page' | 'component' | 'file' }>>();
  for (const file of files) {
    const { path } = file;
    if (isEditorBookkeeping(path)) continue;

    const slug = COLLECTION_FILE.exec(path)?.[1];
    if (slug) {
      let row = collections.get(slug);
      if (!row) {
        row = { kind: 'collection', key: `cms:${slug}`, slug, items: 0, fields: 0 };
        collections.set(slug, row);
        rows.push(row);
      }
      row.items += sum(file.parts, 'item');
      row.fields += sum(file.parts, 'field');
      continue;
    }

    if (path === TOKENS_PATH) {
      const styles = (file.parts ?? []).filter((p) => p.unit === 'style');
      // The file changed but no token did (a comment, a rule we do not model):
      // still worth one row, just without a count.
      if (styles.length === 0) rows.push({ kind: 'styles', key: 'styles:other', group: 'other', count: 0, names: [] });
      for (const p of styles) rows.push({ kind: 'styles', key: `styles:${p.group ?? 'other'}`, group: p.group ?? 'other', count: p.count, names: p.names });
      continue;
    }

    const locale = MESSAGES_FILE.exec(path)?.[1];
    if (locale) {
      rows.push({ kind: 'translations', key: `messages:${locale}`, locale, count: sum(file.parts, 'string') });
      continue;
    }

    if (path.startsWith('components/')) {
      rows.push(opts.isCodeComponent?.(path)
        ? { kind: 'code-component', key: path, path }
        : { kind: 'component', key: path, file });
      continue;
    }
    if (path.startsWith('app/')) {
      // A page is a PAIR on disk — the server wrapper (`page.tsx`) and the
      // client body (`page.client.tsx`). A run that creates a page writes both,
      // and listing both printed every new page twice under the same name
      // (user report 2026-09-21: "/articles" · "/articles"). One row, keyed by
      // the half you can open, counting the layers of both.
      const canonical = openablePath(path);
      const existing = pages.get(canonical);
      if (existing) {
        existing.file = {
          ...existing.file,
          addedIds: [...(existing.file.addedIds ?? []), ...(file.addedIds ?? [])],
          removedIds: [...(existing.file.removedIds ?? []), ...(file.removedIds ?? [])],
          changedIds: [...(existing.file.changedIds ?? []), ...(file.changedIds ?? [])],
        };
        continue;
      }
      const row: Extract<CardRow, { kind: 'page' | 'component' | 'file' }> = { kind: 'page', key: canonical, file: { ...file, path: canonical } };
      pages.set(canonical, row);
      rows.push(row);
      continue;
    }
    rows.push({ kind: 'file', key: path, file });
  }
  return rows;
}

const STYLE_GROUP_LABEL: Record<string, string> = {
  color: 'Colors', typography: 'Typography', spacing: 'Spacing', margin: 'Margins', radius: 'Radius',
  shadow: 'Shadows', border: 'Borders', image: 'Images', video: 'Videos', other: 'Styles',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a row is called and how much of it changed — text only, so it is
 *  testable without rendering. `detail` is empty when there is nothing honest
 *  to count (a file that failed to parse reports no ids; saying "0 Layers"
 *  would read as "nothing happened"). */
export function describeRow(row: CardRow, names: { file: (path: string) => string; collection: (slug: string) => string }): { label: string; detail: string; title?: string } {
  switch (row.kind) {
    case 'collection': {
      const bits = [row.items > 0 ? plural(row.items, 'Item') : '', row.fields > 0 ? plural(row.fields, 'Field') : ''].filter(Boolean);
      return { label: names.collection(row.slug), detail: bits.join(' · ') || 'Collection' };
    }
    case 'styles':
      return {
        // ONE style is named ("color-brand"); several are named by their kind.
        label: row.count === 1 && row.names[0] ? row.names[0] : (STYLE_GROUP_LABEL[row.group] ?? STYLE_GROUP_LABEL.other),
        detail: row.count > 0 ? plural(row.count, 'Style') : '',
        title: row.names.length > 0 ? row.names.join(', ') + (row.count > row.names.length ? ', …' : '') : undefined,
      };
    case 'translations':
      return { label: `Translations · ${row.locale}`, detail: row.count > 0 ? plural(row.count, 'String') : '' };
    case 'code-component':
      return { label: names.file(row.path), detail: 'Code' };
    default: {
      const n = layerCount(row.file);
      return { label: names.file(row.file.path), detail: n > 0 ? plural(n, 'Layer') : '' };
    }
  }
}

function RowIcon({ kind }: { kind: CardRow['kind'] }) {
  if (kind === 'page') return <PageIcon />;
  if (kind === 'component') return <ComponentIcon />;
  if (kind === 'code-component') return <CodeIcon />;
  if (kind === 'styles') return <StyleIcon />;
  if (kind === 'collection') return <CollectionIcon />;
  if (kind === 'translations') return <GlobeIcon />;
  return <FileIcon />;
}

export default function ChangesCard({ files, canRevert }: { files: ChangedFile[]; canRevert?: boolean }) {
  const [activeFile, setActiveFile] = useAtom(activeFilePathAtom);
  const setSelectedIds = useSetAtom(selectedIdsAtom);
  const setUpdatingFromCanvas = useSetAtom(updatingFromCanvasAtom);
  const openCms = useSetAtom(openCmsEditorAtom);
  const openCodeEditor = useSetAtom(componentEditorFileAtom);
  const setLeftPanel = useSetAtom(leftPanelAtom);
  const [hovered, setHovered] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  // Read once per render rather than subscribing: history is a module, not an
  // atom, and the card only needs to know whether the arrows are live at the
  // moment it draws.
  const history = getHistoryState();

  const revealFile = useCallback((f: ChangedFile) => {
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

  const rows = useMemo(() => rowsForCard(files, {
    isCodeComponent: (path) => {
      try { return isCodeComponentSource(projectFS.readFile(path) ?? ''); } catch { return false; }
    },
  }), [files]);

  /** Where a row takes you — `null` when there is nowhere to go (a file that
   *  was deleted, a collection the run removed). */
  const actionFor = useCallback((row: CardRow): (() => void) | null => {
    switch (row.kind) {
      case 'collection':
        return getCollectionSchema(row.slug) ? () => openCms({ collection: row.slug }) : null;
      case 'styles':
        return () => setLeftPanel('presets');
      case 'translations':
        return () => setLeftPanel('locale');
      case 'code-component':
        return projectFS.exists(row.path) ? () => openCodeEditor(row.path) : null;
      default:
        // A page or component opens even with nothing to select (a parse
        // failure reports no ids): getting you THERE is still the point.
        return projectFS.exists(openablePath(row.file.path)) ? () => revealFile(row.file) : null;
    }
  }, [openCms, setLeftPanel, openCodeEditor, revealFile]);

  if (rows.length === 0) return null;

  // A FILLED card (`.agent-card`, globals.css), laid out like the app's own
  // context menu: the card has PADDING, and everything inside is inset from it
  // — each row is its own cut-corner shape whose hover fill stops short of the
  // card's edge, and the one rule under the header is inset too. Full-bleed
  // rows and edge-to-edge hairlines made the card read as a table jammed into a
  // box; nothing in this editor's menus touches the edge of its container.
  return (
    <div className="agent-card cut-corners cut-border border p-1.5">
      <div className="flex h-8 items-center justify-between pl-2 pr-0.5">
        <span className="text-[12px] font-semibold text-[var(--text-primary)]">Changes</span>
        {/* Undo/redo appear only on the newest turn. History is a stack, so
            these on an older card would revert the most RECENT turn while
            appearing to revert the one they sit under. */}
        {canRevert && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={!history.canUndo}
              onClick={() => { const ok = undo(); trace.action('agent-changes:undo', { ok }); }}
              className="h-6 cut-corners bg-[var(--grid-line)] px-2 text-[11px] text-[var(--text-secondary)] transition-colors enabled:hover:text-[var(--text-primary)] focus:outline-none focus-visible:text-[var(--text-primary)] disabled:opacity-40"
            >
              Undo
            </button>
            <button
              ref={moreRef}
              type="button"
              title="More"
              aria-label="More"
              onClick={() => setMenuOpen((v) => !v)}
              className="flex h-6 w-7 items-center justify-center cut-corners bg-[var(--grid-line)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus:outline-none focus-visible:text-[var(--text-primary)]"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
            </button>
            <DropdownMenu
              isOpen={menuOpen}
              onClose={() => setMenuOpen(false)}
              anchorRef={moreRef}
              position="bottom-right"
              hoverStyle="subtle"
              items={[{
                id: 'redo', label: 'Redo', disabled: !history.canRedo,
                onClick: () => { const ok = redo(); trace.action('agent-changes:redo', { ok }); },
              }]}
            />
          </div>
        )}
      </div>
      <div className="mx-2 my-1 h-px bg-[var(--border-default)]/30" />
      <div className="flex flex-col gap-0.5">
        {rows.map((row) => {
          const { label, detail, title } = describeRow(row, {
            file: getFriendlyFileName,
            collection: (slug) => getCollectionSchema(slug)?.name ?? slug,
          });
          const action = actionFor(row);
          return (
            <button
              key={row.key}
              type="button"
              title={title}
              disabled={!action}
              onClick={() => { trace.action('agent-changes:open', { kind: row.kind, key: row.key }); action?.(); }}
              onMouseEnter={() => setHovered(row.key)}
              onMouseLeave={() => setHovered((h) => (h === row.key ? null : h))}
              className="group flex h-7 w-full items-center gap-2 cut-corners px-2 text-left transition-colors enabled:hover:bg-[var(--grid-line)] focus:outline-none focus-visible:bg-[var(--grid-line)] disabled:cursor-default"
            >
              <span className="shrink-0 text-[var(--text-tertiary)]"><RowIcon kind={row.kind} /></span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-secondary)] group-enabled:group-hover:text-[var(--text-primary)]">{label}</span>
              {/* The count answers "how much"; on hover the row answers "and
                  you can go look". Same slot, so nothing reflows. */}
              <span className="shrink-0 text-[11px] text-[var(--text-tertiary)]">
                {action && hovered === row.key ? <span className="text-[var(--text-secondary)]">View</span> : detail}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
