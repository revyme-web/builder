// plugins/sdk-impl/subscribe.ts — atom-backed event streams.
//
// When a plugin calls `revyme.subscribe.selection(handler)`, the host:
//   1. Receives a `subscribe` message with event='selection'.
//   2. Calls `openSubscription('selection', pushFn)` here.
//   3. We attach a jotai store listener; every time the atom changes,
//      `pushFn(payload)` posts an `event` push back to the plugin.
//   4. When the plugin sends `unsubscribe`, the router calls the
//      returned dispose fn, which detaches the listener.
//
// Cold-start emit: subscribers usually want the CURRENT value
// immediately, not just future changes. We push once synchronously
// after attaching so the plugin's handler runs with `[currentIds]` on
// the same tick as the subscribe call resolves.

import { getDefaultStore } from 'jotai';
import { selectedIdsAtom, nodesAtom } from '@/code/stores/store';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { projectVersionAtom } from '@/code/project/project-fs';
import { componentEditorFileAtom } from '@/code/stores/component-editor-store';
import { trace } from '@/shared/debug-trace';

const store = getDefaultStore();

/**
 * Router-side dispatcher. Returns a `dispose` function the router
 * stashes against the plugin's subscription id. When the plugin
 * unsubscribes, router calls `dispose()`.
 *
 * Throws on unknown event ids so plugin authors get a real error
 * instead of a silent dead subscription.
 *
 * Cold-start emit: every subscription pushes the current value once
 * synchronously after attaching so the plugin's handler runs with
 * initial state — matches `useAtomValue` semantics. Skipping the
 * cold-start makes plugins write `getX()` + `subscribe.x` together
 * as a workaround.
 */
export function openSubscription(
  event: string,
  push: (payload: unknown) => void,
): () => void {
  switch (event) {
    case 'selection':
      return openSelectionSubscription(push);
    case 'activePage':
      return openActivePageSubscription(push);
    case 'canvasRoot':
      return openCanvasRootSubscription(push);
    case 'codeFiles':
    case 'colorStyles':
    case 'textStyles':
    case 'customCode':
      // All four ride the projectVersion atom — every projectFS write
      // bumps it, which is a coarse but reliable "anything in the
      // project changed" signal. Plugins re-fetch via the matching
      // read method when the event fires. Per-namespace fine-grained
      // events (only fire when a color style specifically changes)
      // require dedicated atoms; deferred.
      return openProjectVersionSubscription(event, push);
    case 'openCodeFile':
      return openOpenCodeFileSubscription(push);
    default:
      // `text:<nodeId>` — per-node text watch. Needs to update when
      // that specific node's textContent changes, which happens on
      // any nodesAtom change. Filter at push time.
      if (event.startsWith('text:')) {
        return openTextSubscription(event.slice('text:'.length), push);
      }
      // `isAllowedTo:<methods>` — derived from manifest, doesn't
      // change at runtime in Pass 1 (manifest is immutable per
      // session). Cold-emit `true` and never push again.
      if (event.startsWith('isAllowedTo:')) {
        push(true);
        return () => {};
      }
      throw new Error(`Unknown subscription event "${event}"`);
  }
}

function openSelectionSubscription(push: (payload: unknown) => void): () => void {
  // Cold-start: emit current value so the plugin's handler runs with
  // initial state (matches `useAtomValue` semantics). We copy the
  // array each push so the plugin doesn't end up holding a reference
  // to our internal mutable state.
  push([...store.get(selectedIdsAtom)]);
  trace.action('plugin:subscribe.selection:open');
  const unsubscribe = store.sub(selectedIdsAtom, () => {
    push([...store.get(selectedIdsAtom)]);
  });
  return () => {
    trace.action('plugin:subscribe.selection:close');
    unsubscribe();
  };
}

function openActivePageSubscription(push: (payload: unknown) => void): () => void {
  push(store.get(activeFilePathAtom));
  trace.action('plugin:subscribe.activePage:open');
  const unsubscribe = store.sub(activeFilePathAtom, () => {
    push(store.get(activeFilePathAtom));
  });
  return () => {
    trace.action('plugin:subscribe.activePage:close');
    unsubscribe();
  };
}

/**
 * Fires every time the parsed node tree changes (any structural
 * mutation on the active page — add, remove, attribute change). The
 * payload is empty (`null`) — plugins re-fetch what they need via
 * `canvas.*` reads on each tick. Cold-start emits null so plugin
 * handlers run with the initial state-snapshot moment.
 *
 * Useful for live analyzers ("count nodes with no alt text"), tree
 * inspectors that re-render on edits, etc. Plugins that listen here
 * should debounce internally — drag operations fire dozens of mutations
 * per second.
 */
function openCanvasRootSubscription(push: (payload: unknown) => void): () => void {
  push(null);
  trace.action('plugin:subscribe.canvasRoot:open');
  const unsubscribe = store.sub(nodesAtom, () => push(null));
  return () => {
    trace.action('plugin:subscribe.canvasRoot:close');
    unsubscribe();
  };
}

/**
 * Coarse "project changed" subscription — fires for any projectFS
 * write. Plugins re-fetch via the matching read method on each push.
 * Used for `subscribe.codeFiles`, `subscribe.colorStyles`,
 * `subscribe.textStyles`, `subscribe.customCode` until per-namespace
 * fine-grained events land.
 */
function openProjectVersionSubscription(event: string, push: (payload: unknown) => void): () => void {
  // Cold-emit an empty payload — plugins fetch on first tick.
  push([]);
  trace.action(`plugin:subscribe.${event}:open`);
  const unsubscribe = store.sub(projectVersionAtom, () => push([]));
  return () => {
    trace.action(`plugin:subscribe.${event}:close`);
    unsubscribe();
  };
}

/**
 * Stream of the open code-editor file path. Pushes `null` when the
 * editor is closed, the file path when open. Wires to
 * `componentEditorFileAtom` (used by both Code component editor + plugin
 * editor).
 */
function openOpenCodeFileSubscription(push: (payload: unknown) => void): () => void {
  push(store.get(componentEditorFileAtom));
  const unsubscribe = store.sub(componentEditorFileAtom, () => push(store.get(componentEditorFileAtom)));
  return unsubscribe;
}

/**
 * Stream of textContent changes for ONE specific node. Fires on every
 * `nodesAtom` update — most updates won't change THIS node's text, so
 * we filter and only push when the value differs from the previous
 * push.
 */
function openTextSubscription(nodeId: string, push: (payload: unknown) => void): () => void {
  let last = store.get(nodesAtom).get(nodeId)?.textContent ?? '';
  push(last);
  const unsubscribe = store.sub(nodesAtom, () => {
    const cur = store.get(nodesAtom).get(nodeId)?.textContent ?? '';
    if (cur !== last) {
      last = cur;
      push(cur);
    }
  });
  return unsubscribe;
}
