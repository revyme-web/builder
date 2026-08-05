// history.ts — Project-level undo/redo.
// History snapshots the full ProjectFS (all files) so that ANY operation is undoable:
// style changes, preset tokens, page creation, component extraction, locale changes, CMS, etc.
// Uses diff-based storage: each entry records only the files that changed (old → new values).

import { trace } from '@/shared/debug-trace';
import { projectFS } from '../project/project-fs';
import { settlePendingFanOutForHistory } from './mutation-queue';

const MAX_HISTORY = 100;
const DEBOUNCE_MS = 300; // Group rapid changes (e.g., drag scrubbing)

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single file diff: old content (null = file didn't exist) */
interface FileDiff {
  path: string;
  oldContent: string | null;
  newContent: string | null;
}

/** A history entry: the set of file changes for one undo step, plus the
 *  selection on EITHER side of the change so undo/redo can put the user
 *  back on a node that exists in the restored state (the reference behaviour). */
interface HistoryEntry {
  diffs: FileDiff[];
  /** Selected node ids BEFORE the operation (captured at its start). Undo
   *  restores this — so undoing a paste reselects whatever was selected
   *  before the paste. */
  selBefore: string[];
  /** Selected node ids AFTER the operation (captured once it settles).
   *  Redo restores this. */
  selAfter: string[];
  /** The page/file that was ACTIVE when the operation was made. Undo/redo
   *  navigate here first, so the user always sees the change being un/redone
   *  on the right page (not stuck on whatever page they happen to be on). */
  activeFile: string;
  /** UNDO-side navigation target, for operations that MOVE or DELETE the
   *  active file (template create/assign, page moves): `activeFile` is the
   *  post-op path, which doesn't EXIST in the restored pre-op state — undo
   *  navigating there dead-ends (navigateToFile refuses missing targets) and
   *  strands the user on a ghost file. Set via pushHistoryFileOp; absent for
   *  ordinary same-file edits (undo falls back to `activeFile`). */
  activeFileBefore?: string;
}

// ─── State ──────────────────────────────────────────────────────────────────

let undoStack: HistoryEntry[] = [];
let redoStack: HistoryEntry[] = [];
let lastSnapshot: Map<string, string> = new Map();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
// True when a change is awaiting its debounced snapshot+diff (see pushHistory).
let _historyDirty = false;
/** Selection captured at the START of the current debounce group — i.e.
 *  before the operation ran (before any post-flush `setSelectedIds`).
 *  Becomes the finalized entry's `selBefore`. */
let pendingSelBefore: string[] | null = null;
/** Active file captured at the START of the current debounce group —
 *  becomes the finalized entry's `activeFile`. */
let pendingActiveFile: string | null = null;

// Callback to restore project state (set by React component)
let onRestore: ((snapshot: Map<string, string>) => void) | null = null;
// Callback to bump project version (triggers derived atom re-reads)
let _bumpVersion: (() => void) | null = null;
// Active-file getter (atom-accurate). Used to stamp each entry's `activeFile`.
let _getActiveFile: (() => string) | null = null;
// Selection coordination (set by React component). All read the SAME
// Jotai store the editor uses (main.tsx binds <Provider> to the default
// store, so default == contextual).
let _getSelection: (() => string[]) | null = null;
let _setSelection: ((ids: string[]) => void) | null = null;
let _getNodeIds: (() => Set<string>) | null = null;
/** Navigate the editor to `path`. Returns true if it actually switched
 *  (false when already there / target missing). When it switches, it also
 *  re-derives the new file's restored code, so undo/redo must NOT also run
 *  the same-file `onRestore`. */
let _navigateToFile: ((path: string) => boolean) | null = null;

/** Active file right now, or '' when not wired (tests). */
function liveActiveFile(): string {
  return _getActiveFile ? _getActiveFile() : '';
}

/** Current live selection, or [] when not wired (tests). */
function liveSelection(): string[] {
  return _getSelection ? _getSelection() : [];
}

/** Keep only ids that still exist in the just-restored node map. Stale
 *  ids (e.g. a pasted node that an undo removed) are dropped so the
 *  selection never points at a node that isn't there — which is what
 *  left the Properties panel blank + the overlay frozen. */
function validateSelection(ids: string[]): string[] {
  if (!ids.length) return [];
  const present = _getNodeIds ? _getNodeIds() : null;
  if (!present) return ids;
  return ids.filter((id) => present.has(id));
}

/** Apply a target selection after a restore: drop stale ids, then set.
 *  Always writes (even []) so a now-invalid selection is cleared rather
 *  than left stale. */
function applyRestoredSelection(target: string[]): void {
  if (!_setSelection) return;
  const valid = validateSelection(target);
  _setSelection(valid);
  trace.action('history:restore-selection', { requested: target, applied: valid });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Files that are EDITOR STATE, not design content — never part of history.
 *  `_meta/page-camera.json` is mirrored (debounced) after every pan/zoom; as a
 *  history participant each settled camera write became its OWN entry, so the
 *  user had to press Cmd+Z 2–3 times before anything VISIBLE undid (the first
 *  presses silently "restored" camera JSON — user report 2026-07-27, right
 *  after the template-create flow which navigates and thus moves the camera).
 *  Excluding it also means undo never yanks the camera around. */
function isHistoryIgnoredPath(path: string): boolean {
  return path === '_meta/page-camera.json';
}

/** Compute the diff between two snapshots. Returns only changed files. */
function computeDiffs(before: Map<string, string>, after: Map<string, string>): FileDiff[] {
  const diffs: FileDiff[] = [];
  // Check all files in 'after' — new or modified
  for (const [path, content] of after) {
    if (isHistoryIgnoredPath(path)) continue;
    const old = before.get(path) ?? null;
    if (old !== content) {
      diffs.push({ path, oldContent: old, newContent: content });
    }
  }
  // Check for deleted files (in 'before' but not in 'after')
  for (const [path, content] of before) {
    if (isHistoryIgnoredPath(path)) continue;
    if (!after.has(path)) {
      diffs.push({ path, oldContent: content, newContent: null });
    }
  }
  return diffs;
}

/** Apply diffs in reverse (restore old content) and return the forward diffs for redo */
function applyDiffsReverse(diffs: FileDiff[]): FileDiff[] {
  const forwardDiffs: FileDiff[] = [];
  for (const diff of diffs) {
    // Capture current content for redo
    const currentContent = projectFS.readFile(diff.path);
    forwardDiffs.push({ path: diff.path, oldContent: currentContent, newContent: diff.newContent });
    // Restore old content
    if (diff.oldContent === null) {
      projectFS.deleteFile(diff.path);
    } else {
      projectFS.writeFile(diff.path, diff.oldContent);
    }
  }
  return forwardDiffs;
}

/** Apply diffs forward (restore new content) and return the reverse diffs for undo */
function applyDiffsForward(diffs: FileDiff[]): FileDiff[] {
  const reverseDiffs: FileDiff[] = [];
  for (const diff of diffs) {
    const currentContent = projectFS.readFile(diff.path);
    reverseDiffs.push({ path: diff.path, oldContent: currentContent, newContent: diff.newContent });
    if (diff.newContent === null) {
      projectFS.deleteFile(diff.path);
    } else {
      projectFS.writeFile(diff.path, diff.newContent);
    }
  }
  return reverseDiffs;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Initialize history with the current ProjectFS state */
export function initHistory(
  _code: string,
  onApply: (code: string) => void,
  /** Returns the active file path (so undo can restore the right code) */
  getActiveFile?: () => string,
  /** Bumps the project version atom (so preset/CMS atoms re-read after undo) */
  bumpVersion?: () => void,
  /** Selection + navigation coordination so undo/redo land on the right
   *  page and on a node that exists. */
  selection?: {
    get: () => string[];
    set: (ids: string[]) => void;
    /** Node ids present in the CURRENT (just-restored) node map. */
    getNodeIds: () => Set<string>;
    /** Switch the editor to a file; returns true if it actually switched. */
    navigateToFile?: (path: string) => boolean;
  },
): void {
  undoStack = [];
  redoStack = [];
  lastSnapshot = projectFS.getSnapshot();
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  _historyDirty = false;
  pendingSelBefore = null;
  pendingActiveFile = null;
  _bumpVersion = bumpVersion ?? null;
  _getActiveFile = getActiveFile ?? null;
  _getSelection = selection?.get ?? null;
  _setSelection = selection?.set ?? null;
  _getNodeIds = selection?.getNodeIds ?? null;
  _navigateToFile = selection?.navigateToFile ?? null;
  onRestore = (snapshot) => {
    // The diffs have already been applied to projectFS by applyDiffsReverse/Forward.
    // Read the active file code and notify the caller.
    const activeFile = getActiveFile?.() ?? 'app/page.client.tsx';
    const code = projectFS.readFile(activeFile) ?? '';
    onApply(code);
  };
  trace.action('history:init', { stackSize: 0, fileCount: lastSnapshot.size });
}

/**
 * Push a history snapshot.
 * Debounced — rapid changes (drag, scrub) get grouped into one entry.
 * Call this after mutation queue flush with the new code.
 * Also snapshots the full ProjectFS to catch non-code-file changes.
 */
export function pushHistory(newCode: string): void {
  // Capture the pre-op selection/file on the FIRST push of a debounce group
  // (cheap — just reads the live selection). The EXPENSIVE snapshot + diff is
  // deferred to the debounce timer below.
  if (!_historyDirty && pendingSelBefore === null) {
    pendingSelBefore = liveSelection();
    pendingActiveFile = liveActiveFile();
  }
  _historyDirty = true;

  // DEFER the snapshot + diff. Running `projectFS.getSnapshot()` (copies every
  // file) + `computeDiffs()` (compares them) SYNCHRONOUSLY on every commit cost
  // ~150ms on a 470KB project — the single biggest blocking chunk of a
  // reparent-drop settle. The undo stack only needs the FINAL settled state, so
  // the debounce timer captures it once (rapid drags coalesce). undo()/redo()
  // force `commitPendingHistory()` first so a change is never lost.
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(commitPendingHistory, DEBOUNCE_MS);
}

/** Snapshot + diff + push the pending history entry NOW. Called by the debounce
 *  timer and synchronously by undo()/redo() before they read the stack. */
function commitPendingHistory(): void {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  // A live text-edit session holds the group open: the creation that spawned
  // the session and the content typed into it must seal as ONE entry (undo
  // after creating+typing text removes the whole node, not just its text).
  if (_coalesceHold) return;
  if (!_historyDirty) return;
  _historyDirty = false;

  const currentSnapshot = projectFS.getSnapshot();
  const finalDiffs = computeDiffs(lastSnapshot, currentSnapshot);
  if (finalDiffs.length > 0) {
    undoStack.push({ diffs: finalDiffs, selBefore: pendingSelBefore ?? liveSelection(), selAfter: liveSelection(), activeFile: pendingActiveFile ?? liveActiveFile() });
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    lastSnapshot = currentSnapshot;
    redoStack = [];
    let divergeAt = -1; let oldCtx = ''; let newCtx = '';
    if (finalDiffs.length === 1 && finalDiffs[0].oldContent && finalDiffs[0].newContent) {
      const a = finalDiffs[0].oldContent; const b = finalDiffs[0].newContent;
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) { if (a[i] !== b[i]) { divergeAt = i; break; } }
      if (divergeAt === -1) divergeAt = n;
      oldCtx = JSON.stringify(a.slice(Math.max(0, divergeAt - 40), divergeAt + 40));
      newCtx = JSON.stringify(b.slice(Math.max(0, divergeAt - 40), divergeAt + 40));
    }
    trace.action('history:push', { undoSize: undoStack.length, redoSize: 0, diffCount: finalDiffs.length, paths: finalDiffs.map(d => d.path), oldLen: finalDiffs[0]?.oldContent?.length ?? -1, newLen: finalDiffs[0]?.newContent?.length ?? -1, divergeAt, oldCtx, newCtx });
  }
  pendingSelBefore = null;
  pendingActiveFile = null;
}

// ─── Session coalescing ─────────────────────────────────────────────────────
let _coalesceHold = false;

/** Hold the pending history group open (text-edit session start): every
 *  pushHistory during the hold merges into one entry with whatever was
 *  already pending (e.g. the node creation that spawned the session). */
export function holdHistoryCoalescing(): void {
  _coalesceHold = true;
  trace.action('history:coalesce-hold', {});
}

/** Release the hold (session commit/cancel) — the merged entry seals on the
 *  normal debounce. */
export function releaseHistoryCoalescing(): void {
  if (!_coalesceHold) return;
  _coalesceHold = false;
  trace.action('history:coalesce-release', { dirty: _historyDirty });
  if (_historyDirty) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(commitPendingHistory, DEBOUNCE_MS);
  }
}

/** Force-push without debounce (for discrete operations like pin toggle, node create) */
export function pushHistoryImmediate(newCode: string): void {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  _historyDirty = false; pendingSelBefore = null; pendingActiveFile = null;

  const currentSnapshot = projectFS.getSnapshot();
  const diffs = computeDiffs(lastSnapshot, currentSnapshot);
  if (diffs.length === 0) return;

  const entry: HistoryEntry = { diffs, selBefore: liveSelection(), selAfter: liveSelection(), activeFile: liveActiveFile() };
  undoStack.push(entry);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  lastSnapshot = new Map(currentSnapshot);
  redoStack = [];
  // Immediate push runs synchronously DURING the operation — a creator's
  // post-flush `setSelectedIds([newId])` typically lands later in the same
  // call stack. Refresh `selAfter` on the next microtask so redo reselects
  // the created node, not the pre-op selection.
  queueMicrotask(() => { entry.selAfter = liveSelection(); });
  trace.action('history:push-immediate', { undoSize: undoStack.length, diffCount: diffs.length });
}

/** Seal whatever is pending in the debounce group as its OWN entry, NOW.
 *  Call BEFORE a discrete FS-level operation (template create/assign, page
 *  move) that bypasses the mutation queue — otherwise the operation's file
 *  changes get folded into the pending entry's diff, and undo yanks both. */
export function sealPendingHistory(): void {
  commitPendingHistory();
}

/**
 * Record a discrete FS-level operation (template create/assign/delete, page
 * move) as ONE history entry. These ops write ProjectFS directly — no
 * mutation-queue flush ever calls pushHistory for them, which is how template
 * creation ended up absent from the timeline: Cmd+Z skipped it and undid the
 * edit before it, and the op's diff silently glued itself onto the NEXT
 * entry (user report 2026-07-27).
 *
 * Call AFTER the operation (and any navigation) completes:
 *   sealPendingHistory();       // before the op — pending edits seal separately
 *   …the op + navigation…
 *   pushHistoryFileOp(pathBeforeOp);
 *
 * `activeFileBefore` = where UNDO should land the user — a path that exists in
 * the PRE-op state (the page they were on). The redo-side target is the live
 * active file at push time, which exists in the post-op state.
 */
export function pushHistoryFileOp(activeFileBefore: string): void {
  const sizeBefore = undoStack.length;
  pushHistoryImmediate('');
  // Only stamp when a new entry actually landed (no-diff push is a no-op —
  // stamping the PRIOR entry would corrupt an unrelated edit's undo target).
  if (undoStack.length > sizeBefore) {
    undoStack[undoStack.length - 1].activeFileBefore = activeFileBefore;
    trace.action('history:push-file-op', { activeFileBefore, activeFile: undoStack[undoStack.length - 1].activeFile });
  }
}

/** Sync history when code changes from external source (Monaco typing) */
export function syncHistoryCode(code: string): void {
  pushHistory(code);
}

/** Shared restore tail for undo/redo: navigate to the entry's page (so the
 *  change is actually visible), apply the restored code, then reselect a
 *  validated selection. When navigation happens it re-derives the new file's
 *  code itself, so we skip the same-file `onRestore` to avoid clobbering it
 *  with the previous page's content. */
// Deferred restore-finish (version bump + selection reselect). The sync undo
// path must contain ONLY diffs + the canvas restore (seed-parse + patch
// render): measured 2026-07, the same-origin iframe's render message is only
// serviced once the parent's task backlog drains — and the version bump
// synchronously recomputed nodesAtom against the STALE codeAtom (a ~100ms
// wasted parse of the WRONG code, pre-visual), while the selection pass
// queued another React task ahead of the visual. Deferring both ~34ms (just
// after the restore's 32ms fan-out timer, so setCode lands first) lets the
// canvas revert at the first yield. The fences: an undo/redo that finds the
// stack EMPTY applies the pending finish (finishPendingRestore); one that
// will actually restore SUPERSEDES it (cancelPendingRestore) — running it
// there was the rapid-Cmd+Z glitch, see cancelPendingRestore.
let _restoreFinishTimer: ReturnType<typeof setTimeout> | null = null;
let _restoreFinishFn: (() => void) | null = null;
export function finishPendingRestore(): void {
  if (_restoreFinishTimer !== null) { clearTimeout(_restoreFinishTimer); _restoreFinishTimer = null; }
  const fn = _restoreFinishFn;
  _restoreFinishFn = null;
  fn?.();
}

/** Drop a pending deferred restore-finish WITHOUT running it. Only valid when
 *  a NEW restore is about to run: that restore's own finish bumps the version
 *  against NEWER file state and reselects its own target, so nothing here is
 *  lost. Running the stale finish instead was the rapid-Cmd+Z glitch: its
 *  version bump made codeAtom (a version-gated ProjectFS view) eagerly
 *  recompute to the PREVIOUS restore's code — the new diffs land after this
 *  fence and their own bump is deferred 300ms — and the React pass it
 *  scheduled repainted the canvas one state BACK ~15ms after the new
 *  restore's canvas-first patch (user trace 2026-08-05: every mid-burst
 *  press flipped forward then back, settling only 300ms after the last). */
function cancelPendingRestore(): void {
  if (_restoreFinishTimer !== null) { clearTimeout(_restoreFinishTimer); _restoreFinishTimer = null; }
  if (_restoreFinishFn !== null) trace.action('history:restore-finish-superseded', {});
  _restoreFinishFn = null;
}

function restoreToFileAndSelection(targetFile: string, targetSel: string[]): void {
  let navigated = false;
  if (targetFile && _navigateToFile && targetFile !== liveActiveFile()) {
    navigated = _navigateToFile(targetFile);
  }
  if (!navigated) {
    // Same-page restore — canvas-first: onRestore seeds the node cache +
    // ships the iframe patch render; the version bump + reselect are
    // DEFERRED (see finishPendingRestore above) so nothing React-heavy
    // precedes the visual.
    onRestore?.(lastSnapshot);
    _restoreFinishFn = () => {
      trace.action('history:restore-finish', { targetSel });
      _bumpVersion?.();
      // Reselect (validated against the now-current page's node map, so a
      // removed node never leaves a stale selection).
      applyRestoredSelection(targetSel);
    };
    // PRIMARY trigger: the iframe's renderComplete (Canvas.tsx
    // onRenderComplete → finishPendingRestore) — that's the moment the
    // restore's visual is painted AND the allRects measure has landed, so
    // the reselect's React pass (~105ms — overlay + tool column) can't
    // push the visual late and the overlay positions from fresh rects.
    // Typically ~60-70ms after the keypress (the Framer-parity "selection
    // follows undo instantly" feel, 2026-08-06). This timer is the
    // FALLBACK for renders that never complete (sandbox mid-rebuild,
    // dropped render): 300ms measured as safely after the deferred
    // fan-out (250ms). Fenced: any next undo/redo applies or supersedes
    // the pending finish first.
    _restoreFinishTimer = setTimeout(finishPendingRestore, 300);
    return;
  }
  // Cross-page restore: the navigate already did the heavy switch — keep the
  // original synchronous ordering (bump ran inside the navigate path's
  // switch; selection applies now).
  applyRestoredSelection(targetSel);
}

/** Undo — restore previous project state */
export function undo(): boolean {
  // A drag-drop may have DEFERRED its setCode fan-out (+ pushHistory) — a
  // DROP-kind fan-out is forced NOW so this undo captures the drop, not the
  // state before it; a RESTORE-kind one is cancelled as superseded.
  settlePendingFanOutForHistory();
  // Land any pending debounced change first (snapshot + diff + push).
  commitPendingHistory();

  if (undoStack.length === 0) {
    finishPendingRestore(); // nothing supersedes the pending finish — run it
    return false;
  }
  cancelPendingRestore(); // THIS restore's own finish bumps + reselects

  const entry = undoStack.pop()!;
  // Apply diffs in reverse (restore old content)
  const forwardDiffs = applyDiffsReverse(entry.diffs);
  // Store forward diffs for redo — carry the SAME selection pair + page so
  // redo reselects `selAfter` on the right page and a later undo `selBefore`.
  redoStack.push({ diffs: forwardDiffs, selBefore: entry.selBefore, selAfter: entry.selAfter, activeFile: entry.activeFile, activeFileBefore: entry.activeFileBefore });
  lastSnapshot = projectFS.getSnapshot();

  trace.action('history:undo', { undoSize: undoStack.length, redoSize: redoStack.length, diffCount: entry.diffs.length, paths: entry.diffs.map(d => d.path), activeFile: entry.activeFile, activeFileBefore: entry.activeFileBefore, hasBumpVersion: !!_bumpVersion });
  // Navigate to the page the change belongs to, restore code, reselect the
  // pre-op selection. A file-op entry (move/create/delete) carries the
  // UNDO-side path separately — the post-op `activeFile` doesn't exist in the
  // restored state.
  restoreToFileAndSelection(entry.activeFileBefore ?? entry.activeFile, entry.selBefore);
  return true;
}

/** Redo — restore next project state */
export function redo(): boolean {
  settlePendingFanOutForHistory(); // land a drop fan-out / cancel a restore one (see undo)
  commitPendingHistory(); // land any pending debounced change (may clear redoStack)
  if (redoStack.length === 0) {
    finishPendingRestore(); // nothing supersedes the pending finish — run it
    return false;
  }
  cancelPendingRestore(); // THIS restore's own finish bumps + reselects

  const entry = redoStack.pop()!;
  // Apply diffs forward (restore new content)
  const reverseDiffs = applyDiffsForward(entry.diffs);
  // Store reverse diffs for undo — carry the selection pair + page forward.
  undoStack.push({ diffs: reverseDiffs, selBefore: entry.selBefore, selAfter: entry.selAfter, activeFile: entry.activeFile, activeFileBefore: entry.activeFileBefore });
  lastSnapshot = projectFS.getSnapshot();

  trace.action('history:redo', { undoSize: undoStack.length, redoSize: redoStack.length, diffCount: entry.diffs.length, activeFile: entry.activeFile });
  // Navigate to the page the change belongs to, restore code, reselect the
  // post-op selection (e.g. the re-created node from a redone paste).
  restoreToFileAndSelection(entry.activeFile, entry.selAfter);
  return true;
}

/** Get current stack sizes (for UI indicators) */
export function getHistoryState(): { canUndo: boolean; canRedo: boolean; undoSize: number; redoSize: number } {
  return {
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undoSize: undoStack.length,
    redoSize: redoStack.length,
  };
}
