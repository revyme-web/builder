// useSearchActions.ts — Executes the action attached to a search
// result row.
//
// Pattern: every `SearchAction` variant declared in `search-types.ts`
// has a matching branch here. Most actions are one-liners (atom
// write, switchActiveFile, set tool mode); commands are the only
// branch with non-trivial logic and live behind their own switch
// `executeCommand()` so the registry stays declarative.
//
// Called from `useMegaSearch.handleSelect`. NOT a React hook — kept
// as a plain function so it can be invoked from imperative paths
// (paste-URL handler, etc.) later if needed. The conventional `use…`
// prefix is reserved for the wrapper hook in `useMegaSearch.ts`.

import { getDefaultStore } from 'jotai';
import type { SearchAction } from './search-types';
import { paletteFilterAtom } from './palette-store';
import { paletteOpenAtom, paletteQueryAtom } from '@/code/stores/palette-store';
import { toolModeAtom } from '@/code/stores/tool-store';
import { leftPanelAtom } from '@/code/stores/left-panel-store';
import { pendingFileSwitchAtom } from '@/code/stores/store';
import {
  openPluginIdAtom,
  launchedProjectPluginAtom,
} from '@/plugins/registry';
import { launchedCloudPluginAtom } from '@/plugins/cloud-plugins';
import { undo, redo } from '@/code/mutation/history';
import {
  deleteNode,
  toggleLock,
  toggleVisibility,
  wrapInFrame,
  wrapInLayout,
  unfoldChildren,
} from '@/canvas/commands';
import {
  dispatchCopy,
  dispatchPaste,
  dispatchCut,
  dispatchDuplicate,
  dispatchSelectParent,
  dispatchSelectChildren,
  dispatchSelectReplica,
  dispatchGroupSvgs,
} from '@/canvas/canvas-commands-bridge';
import { insertNodes, buildInstanceClipboardNode } from '@/canvas/insertion-bridge';
import { selectedIdsAtom, nodesAtom } from '@/code/stores/store';
import { getContentRoot } from '@/canvas/node-ops';
import {
  zoomIn,
  zoomOut,
  zoomTo100,
  zoomToFit,
  zoomToFitSelection,
} from '@/canvas/transform';
import { createAndOpenProject } from '@/editor/header/menu-builders';
import { shareAsTemplate } from '@/backend/revyme-backend';
import { projectFS } from '@/code/project/project-fs';
import { trace } from '@/shared/debug-trace';
import { toast } from 'sonner';

const store = getDefaultStore();

/**
 * Dispatch the action for a selected search row. Closes the palette
 * unconditionally after execution — the caller (`useMegaSearch`)
 * relies on this so it doesn't have to close itself.
 *
 * Unknown actions trace + toast rather than throwing, so a stale
 * registry entry doesn't crash the palette.
 */
export function executeSearchAction(action: SearchAction): void {
  trace.action('palette:execute', { action });
  switch (action.type) {
    case 'execute-command':
      executeCommand(action.commandId);
      break;
    case 'set-tool-mode':
      store.set(toolModeAtom, action.mode);
      break;
    case 'open-left-panel':
      store.set(leftPanelAtom, action.panelId);
      break;
    case 'switch-active-file':
      // pendingFileSwitchAtom is the cross-component-safe entry point —
      // Canvas.tsx watches it, runs the full switchActiveFile flow
      // (queue flush + selection clear), then resets to null.
      store.set(pendingFileSwitchAtom, action.filePath);
      break;
    case 'insert-library-item': {
      // Components / icon sets / vectors → insert an
      // instance at the selection-aware location via the centralized
      // paste-rule engine. Same routing as Ctrl+V on a node-shaped
      // clipboard: layout-child selected → next sibling, canvas node
      // selected → adjacent canvas node, nothing → visible center.
      const clipboard = buildInstanceClipboardNode(action.filePath, action.elementType);
      const ids = insertNodes(clipboard);
      if (ids.length === 0) {
        toast.error(`Could not insert ${action.elementType}`);
      }
      break;
    }
    case 'launch-plugin':
      launchPlugin(action.pluginTier, action.id);
      break;
    case 'set-palette-filter':
      // "Browse Plugins / Components" rows switch the tab in-place
      // (no close). Clear the query so the marketplace grid starts
      // fresh, and skip the auto-close below — we WANT the palette
      // to stay open on this action.
      store.set(paletteFilterAtom, action.filter);
      store.set(paletteQueryAtom, '');
      return;
    case 'open-url':
      window.open(action.url, action.newTab === false ? '_self' : '_blank', 'noopener,noreferrer');
      break;
    default: {
      // Exhaustive check — TS narrows `action` to `never` if all variants
      // are handled. A new variant added to `SearchAction` without a case
      // here will fail typecheck at this line.
      const _exhaustive: never = action;
      void _exhaustive;
      trace.error('palette:unknown-action', { action });
      toast.error('Unknown action');
    }
  }
  // Always close after dispatch so the user doesn't have to ESC.
  store.set(paletteOpenAtom, false);
}

function launchPlugin(tier: 'project' | 'installed' | 'cloud', id: string) {
  // Clear the other two atoms before setting the target — each
  // `PluginRuntimeWindow` mounts based on which atom is non-null,
  // and the host has a defensive guard, but belt-and-suspenders.
  switch (tier) {
    case 'project':
      store.set(openPluginIdAtom, null);
      store.set(launchedCloudPluginAtom, null);
      store.set(launchedProjectPluginAtom, id);
      break;
    case 'installed':
      store.set(launchedProjectPluginAtom, null);
      store.set(launchedCloudPluginAtom, null);
      store.set(openPluginIdAtom, id);
      break;
    case 'cloud':
      store.set(openPluginIdAtom, null);
      store.set(launchedProjectPluginAtom, null);
      store.set(launchedCloudPluginAtom, id);
      break;
  }
}

/**
 * Execute a command id. Each branch here MUST have a matching entry
 * in `search-registry.ts`'s `COMMANDS` array — same id on both sides.
 *
 * Commands that need the canvas content root (delete, toggleLock,
 * wrap, etc.) read it via `getContentRoot()` and bail gracefully
 * when it's not mounted (a no-selection or pre-mount edge case).
 */
function executeCommand(commandId: string): void {
  const contentEl = getContentRoot();
  const nodes = store.get(nodesAtom);
  const selected = store.get(selectedIdsAtom);
  const first = selected[0];

  switch (commandId) {
    // File / project
    case 'new-project':
      createAndOpenProject();
      break;
    case 'create-remix-link':
      // Upload the current projectFS snapshot, copy the user-facing
      // remix URL (`<host>/r/<hash>`) to clipboard, show a toast.
      // Same URL also pastes into the dashboard "Submit Template"
      // form — one link, two uses.
      void (async () => {
        try {
          const files: Record<string, string> = {};
          projectFS.getSnapshot().forEach((v, k) => { files[k] = v; });
          if (Object.keys(files).length === 0) {
            toast.error('Project is empty');
            return;
          }
          // Pass the current website id so the backend can check
          // `is_remix` + inherit the parent template's lineage. Without
          // it the new draft is treated as a fresh original — fine for
          // never-remixed projects, wrong for remix-of-remix.
          const { getProjectId } = await import('@/backend/project-id');
          const result = await shareAsTemplate({
            name: 'Untitled',
            files,
            source_website_id: getProjectId(),
          });
          await navigator.clipboard.writeText(result.share_url).catch(() => {});
          toast.success('Remix link copied');
          trace.action('palette:create-remix-link', { hash: result.hash });
        } catch (err) {
          trace.error('palette:create-remix-link-failed', { error: String(err) });
          toast.error((err as Error).message || 'Could not create remix link');
        }
      })();
      break;

    // Editing
    case 'undo': undo(); break;
    case 'redo': redo(); break;
    // Clipboard ops route through the canvas-commands-bridge so they
    // execute the same code path the keyboard shortcut uses (with
    // post-paste mouseDown rebinding etc.). The bridge no-ops if
    // Canvas hasn't mounted — defensive but expected to be live by
    // the time the palette can be opened.
    case 'copy':
      dispatchCopy();
      if (selected.length > 0) {
        toast.success(`Copied ${selected.length} ${selected.length === 1 ? 'node' : 'nodes'}`);
      }
      break;
    case 'paste':     dispatchPaste(); break;
    case 'cut':       dispatchCut(); break;
    case 'duplicate': dispatchDuplicate(); break;
    case 'delete':
      if (selected.length > 0 && contentEl) deleteNode(selected, contentEl);
      break;

    // Visibility / state toggles — operate on first selected only
    // (matches the keyboard shortcut's behaviour in shortcuts.ts).
    case 'toggle-lock':
      if (first && contentEl) toggleLock(first, contentEl, nodes);
      break;
    case 'toggle-visibility':
      if (first && contentEl) toggleVisibility(first, contentEl, nodes);
      break;

    // Structure
    case 'wrap-in-frame':
      if (selected.length > 0 && contentEl) wrapInFrame(selected, nodes, contentEl);
      break;
    case 'wrap-in-layout':
      if (selected.length > 0 && contentEl) wrapInLayout(selected, nodes, contentEl);
      break;
    case 'unfold-children':
      if (first && contentEl) unfoldChildren(first, nodes, contentEl);
      break;
    case 'group-svgs': dispatchGroupSvgs(); break;

    // Zoom
    case 'zoom-in': zoomIn(); break;
    case 'zoom-out': zoomOut(); break;
    case 'zoom-to-fit': {
      const root = contentEl;
      if (root) zoomToFit(root, true);
      break;
    }
    case 'zoom-to-selection':
      if (contentEl) zoomToFitSelection(contentEl, selected, true);
      break;
    case 'zoom-100': zoomTo100(); break;

    // Selection nav — dispatches via canvas-commands-bridge so the
    // helpers see the live refs Canvas.tsx wires on mount.
    case 'select-parent':   dispatchSelectParent(); break;
    case 'select-children': dispatchSelectChildren(); break;
    case 'select-replica':  dispatchSelectReplica(); break;

    default:
      trace.error('palette:unknown-command', { commandId });
      toast.error(`Unknown command: ${commandId}`);
  }
}
