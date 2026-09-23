// branching/switch-workspace.ts — P8-B: human branch-switch ceremony.
//
// Makes a V2 branch a VISITABLE, EDITABLE workspace: moves the human/canvas
// pointer (activeBranchId) plus every piece of derived state that assumes
// one workspace (queue base, node memo, bridge caches, selection, history
// baseline, remembered file), so canvas, preview, files, caches, routing
// and mutations all represent the newly active branch. The counterpart of
// V1's activateBranch MINUS its sins: no auto-redirect, no FS rebind (V2
// maps share one FS addressed by pointer — rebind is obsolete), no
// heal-on-view (viewing must not dirty a clean branch), no camera move
// (per-file camera persists across branches).
//
// Additive only: no engine behavior changes when nobody switches (the P8
// steady state). Returns null on success, else the human-readable refusal
// (never silent).

import { getDefaultStore } from 'jotai';
import { projectFS } from '@/code/project/project-fs';
import {
  isActiveBranchLocked,
  isAgentWriteOpen,
  isBranchLocked,
  isLockHolderScoped,
} from '@/code/stores/agent-run-lock-store';
import {
  flushNow,
  setForceRender,
  settlePendingFanOutForHistory,
  switchQueueFile,
} from '@/code/mutation/mutation-queue';
import { clearHistoryStacks } from '@/code/mutation/history';
import { clearBridgeReadCaches } from '@/canvas/canvas-bridge';
import { bumpProjectVersion } from '@/code/project/modify-file';
import { triggerAutosave } from '@/backend/autosave';
import {
  activeFilePathAtom,
  syncUrlToPage,
} from '@/code/project/active-file-store';
import { selectedIdsAtom } from '@/code/stores/store';
import { captureEditorLocation, resolveLocationOnBranch, applyEditorLocation, branchReader } from './location';
import { trace } from '@/shared/debug-trace';

/** Remembered file per branch (V1 lastActiveFileByBranch, maps not FS). */
const rememberedFileByBranch = new Map<string, string>();
/** Tests + review UI reset. */
export function clearRememberedBranchFiles(): void {
  rememberedFileByBranch.clear();
}

/** Landing file: remembered, else home page, else first page, else current. */
function defaultFileForBranch(branchId: string, fallback: string): string {
  const files = projectFS.readBranchFiles(branchId);
  if (!files) return fallback;
  if (files.has('app/page.client.tsx')) return 'app/page.client.tsx';
  const pages = [...files.keys()].filter((p) => p.endsWith('page.client.tsx')).sort();
  return pages[0] ?? fallback;
}

/**
 * Switch the human workspace to `branchId` (visit + edit). Full ceremony:
 * guards → remember → settle → pointer → land → reseeds → rebuild → persist.
 */
export function switchBranchFile(branchId: string): string | null {
  const store = getDefaultStore();
  const from = projectFS.getActiveBranchId();
  if (branchId === from) return null;
  if (projectFS.readBranchFiles(branchId) == null) return `Unknown branch "${branchId}".`;
  // Guards (never silent). Scoped-target guard: a branch locked by a holder
  // that is NOT the current scoped run is never entered — landing there
  // would hand the human a base some other holder's writes depend on.
  if (!isAgentWriteOpen() && isBranchLocked(branchId) && !isLockHolderScoped()) {
    return `The agent is editing branch "${branchId}" — switch to it when the run finishes, or stop it from the chat.`;
  }
  // Source guard: leaving is refused ONLY while an UNSCOPED (legacy,
  // queue-base-dependent) holder locks the active branch: moving the base
  // under it would misfile its writes. A scoped (branched) holder addresses
  // explicit scopes and never reads the human base.
  if (!isAgentWriteOpen() && isActiveBranchLocked() && !isLockHolderScoped()) {
    return 'The agent is editing this branch — switch branches when it finishes, or stop it from the chat to take over now.';
  }
  const fromFile = store.get(activeFilePathAtom);
  rememberedFileByBranch.set(from, fromFile);
  // Where the user IS, captured before anything moves (location.ts).
  const location = captureEditorLocation();
  trace.action('branching-switch:start', { from, to: branchId, fromFile });

  // 1. Settle human-context work onto the pre-switch state (scoped: other
  //    branches' groups belong to runs in flight and drain scoped).
  settlePendingFanOutForHistory();
  // NOTE (port): unscoped — see apply.ts. We have not switched the pointer
  // yet, so the pending work IS the branch we are leaving.
  flushNow();

  // 2. Move the pointer (notify pulses coarse subscribers; atoms re-derive
  //    on the bump in step 5).
  const switchErr = projectFS.switchBranch(branchId);
  if (switchErr) return switchErr;

  // 3. Land on the SAME location when the branch has it — page, master +
  //    breadcrumb, overlay, CMS collection / item, code component editor —
  //    and only otherwise on the file remembered for this branch (or its
  //    default). Each piece resolves on its own: a page that exists keeps
  //    you on it even if the overlay you had open was deleted there.
  const remembered = rememberedFileByBranch.get(branchId);
  const fallbackFile =
    remembered && projectFS.branchFileExists(branchId, remembered)
      ? remembered
      : defaultFileForBranch(branchId, fromFile);
  const landing = resolveLocationOnBranch(location, branchReader(branchId), fallbackFile);
  const nextFile = landing.file;
  switchQueueFile(nextFile, { branchId });
  store.set(activeFilePathAtom, nextFile);
  store.set(selectedIdsAtom, []);
  applyEditorLocation(landing);

  // 4. Reset history stacks (see clearHistoryStacks: undo never spans branches).
  clearHistoryStacks();

  // 5. Full rebuild + fresh caches + URL + persist. Same-ids-different-branch
  //    needs the same treatment as same-ids-different-file (switchActiveFile
  //    tail, incl. the confirmed 250ms late-bump floor — do not retune).
  setForceRender();
  bumpProjectVersion();
  clearBridgeReadCaches();
  syncUrlToPage(nextFile);
  triggerAutosave();
  setTimeout(() => {
    setForceRender();
    bumpProjectVersion();
    trace.action('branching-switch:late-bump', { branch: branchId });
  }, 250);

  trace.action('branching-switch:done', { from, to: branchId, file: nextFile });
  return null;
}
