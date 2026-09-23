// branching/location.ts — where the user IS, carried across a branch switch.
//
// A branch is a copy of the site, so the page you are on, the master you are
// editing (and the breadcrumb above it), the overlay you have open, the CMS
// collection or item, the code component in its editor — all of it usually
// EXISTS on the other branch too. Switching should land on the same thing
// there, and only fall back to the branch's remembered / default page when
// the thing is genuinely gone (deleted on that branch, never created there).
// Before this the switch always landed on the branch's own remembered file
// and cleared everything else (owner, 2026-09-22: "it just makes its own
// history of where I am on the branch").
//
// Pure resolution over a `BranchReader`, so the rules are testable with plain
// maps; `captureEditorLocation` / `applyEditorLocation` are the two ends that
// touch the atoms.

import { getDefaultStore } from 'jotai';
import { projectFS } from '@/code/project/project-fs';
import { activeFilePathAtom, componentBreadcrumbAtom } from '@/code/project/active-file-store';
import { overlayEditingIdAtom } from '@/code/stores/overlay-store';
import { componentEditorFileAtom } from '@/code/stores/component-editor-store';
import {
  cmsEditorOpenAtom, cmsEditorCollectionAtom, cmsEditorExpandedItemAtom, cmsEditorFocusedFieldAtom,
  cmsOverlayOpenAtom, activeOverlayCollectionAtom,
} from '@/code/stores/cms-editor-store';
import { trace } from '@/shared/debug-trace';

export interface EditorLocation {
  /** The active file (page or master). */
  file: string;
  /** Ancestor files above the active master (component-editing trail). */
  breadcrumb: string[];
  /** Overlay being edited on the canvas (a node id in `file`). */
  overlayEditingId: string | null;
  /** Code component open in its editor. */
  componentEditorFile: string | null;
  /** The CMS surfaces: the full-screen collection editor (item + field) and
   *  the item-list overlay. */
  cms: {
    editorOpen: boolean;
    editorCollection: string | null;
    editorItem: string | null;
    editorField: string | null;
    overlayOpen: boolean;
    overlayCollection: string | null;
  };
}

/** What the resolver needs to know about the target branch. */
export interface BranchReader {
  fileExists(path: string): boolean;
  readFile(path: string): string | null;
}

export function captureEditorLocation(): EditorLocation {
  const store = getDefaultStore();
  return {
    file: store.get(activeFilePathAtom),
    breadcrumb: [...store.get(componentBreadcrumbAtom)],
    overlayEditingId: store.get(overlayEditingIdAtom),
    componentEditorFile: store.get(componentEditorFileAtom),
    cms: {
      editorOpen: store.get(cmsEditorOpenAtom),
      editorCollection: store.get(cmsEditorCollectionAtom),
      editorItem: store.get(cmsEditorExpandedItemAtom),
      editorField: store.get(cmsEditorFocusedFieldAtom),
      overlayOpen: store.get(cmsOverlayOpenAtom),
      overlayCollection: store.get(activeOverlayCollectionAtom),
    },
  };
}

const hasNode = (code: string | null, id: string): boolean => !!code && code.includes(`data-id="${id}"`);

function collectionExists(r: BranchReader, slug: string | null): slug is string {
  return !!slug && r.fileExists(`cms/${slug}.schema.json`);
}

function itemExists(r: BranchReader, slug: string, itemId: string | null): boolean {
  if (!itemId) return false;
  const raw = r.readFile(`cms/${slug}.json`);
  if (!raw) return false;
  try {
    const rows = JSON.parse(raw);
    return Array.isArray(rows) && rows.some((row) => row && typeof row === 'object' && (row as { _id?: unknown })._id === itemId);
  } catch {
    return false;
  }
}

/**
 * The same location on the target branch, part by part: each piece is kept
 * when the branch has it and dropped (to the neutral value) when it does
 * not. `fallbackFile` is where the switch lands when the file itself is
 * gone — the branch's remembered file or its home page.
 */
export function resolveLocationOnBranch(loc: EditorLocation, r: BranchReader, fallbackFile: string): EditorLocation {
  const fileKept = r.fileExists(loc.file);
  const file = fileKept ? loc.file : fallbackFile;
  // The trail only means something above the SAME master, and only whole:
  // a crumb whose file is gone would navigate into nothing.
  const breadcrumb = fileKept && loc.breadcrumb.length > 0 && loc.breadcrumb.every((p) => r.fileExists(p)) ? [...loc.breadcrumb] : [];
  const overlayEditingId = fileKept && loc.overlayEditingId && hasNode(r.readFile(file), loc.overlayEditingId) ? loc.overlayEditingId : null;
  const componentEditorFile = loc.componentEditorFile && r.fileExists(loc.componentEditorFile) ? loc.componentEditorFile : null;

  const editorCollectionKept = loc.cms.editorOpen && collectionExists(r, loc.cms.editorCollection);
  const editorItemKept = editorCollectionKept && itemExists(r, loc.cms.editorCollection as string, loc.cms.editorItem);
  const overlayCollectionKept = loc.cms.overlayOpen && collectionExists(r, loc.cms.overlayCollection);

  const next: EditorLocation = {
    file,
    breadcrumb,
    overlayEditingId,
    componentEditorFile,
    cms: {
      editorOpen: editorCollectionKept,
      editorCollection: editorCollectionKept ? loc.cms.editorCollection : null,
      editorItem: editorItemKept ? loc.cms.editorItem : null,
      // A field only makes sense with its item.
      editorField: editorItemKept ? loc.cms.editorField : null,
      overlayOpen: overlayCollectionKept,
      overlayCollection: overlayCollectionKept ? loc.cms.overlayCollection : null,
    },
  };
  trace.action('branching-location:resolve', { fileKept, breadcrumbKept: breadcrumb.length > 0, overlayKept: !!overlayEditingId, componentEditorKept: !!componentEditorFile, cmsEditorKept: editorCollectionKept, cmsItemKept: editorItemKept, cmsOverlayKept: overlayCollectionKept });
  return next;
}

/** A reader over one branch's map. */
export function branchReader(branchId: string): BranchReader {
  return {
    fileExists: (path) => projectFS.branchFileExists(branchId, path),
    readFile: (path) => projectFS.readBranchFile(branchId, path),
  };
}

/** Everything but the active file — the caller lands the file itself (queue
 *  base, atom, URL) as part of the switch ceremony. */
export function applyEditorLocation(loc: EditorLocation): void {
  const store = getDefaultStore();
  store.set(componentBreadcrumbAtom, loc.breadcrumb);
  store.set(overlayEditingIdAtom, loc.overlayEditingId);
  store.set(componentEditorFileAtom, loc.componentEditorFile);
  store.set(cmsEditorCollectionAtom, loc.cms.editorCollection);
  store.set(cmsEditorExpandedItemAtom, loc.cms.editorItem);
  store.set(cmsEditorFocusedFieldAtom, loc.cms.editorField);
  store.set(cmsEditorOpenAtom, loc.cms.editorOpen);
  store.set(activeOverlayCollectionAtom, loc.cms.overlayCollection);
  store.set(cmsOverlayOpenAtom, loc.cms.overlayOpen);
}
